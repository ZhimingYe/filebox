use axum::{extract::{Path, State}, http::StatusCode, response::{IntoResponse, Response}, Json};
use filebox_protocol::{forwards::{validate_forwards, ForwardConfig}, message::HubMessage};
use crate::{agent_registry::AgentStatus, state::AppState};

pub(super) async fn list(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    let inner = state.inner.read().await;
    let Some(agent) = inner.agents.get(&id) else { return StatusCode::NOT_FOUND.into_response(); };
    if !agent.capabilities.port_forward { return unsupported(); }
    Json(serde_json::json!({
        "forwards": agent.pending_forwards.as_ref().map(|(_, f)| f).unwrap_or(&agent.forwards),
        "forwards_revision": agent.forwards_revision, "pending": agent.pending_forwards.is_some(),
    })).into_response()
}

pub(super) async fn add(State(state): State<AppState>, Path(id): Path<String>, Json(entry): Json<ForwardConfig>) -> Response {
    update(state, id, Some(entry), None, None).await
}

#[derive(serde::Deserialize)]
pub(super) struct RemoveForward { port: u16 }

pub(super) async fn remove(State(state): State<AppState>, Path(id): Path<String>, Json(entry): Json<RemoveForward>) -> Response {
    update(state, id, None, Some(entry.port), None).await
}

#[derive(serde::Deserialize)]
pub(super) struct PatchForward { port: u16, keep_prefix: bool }

pub(super) async fn patch(State(state): State<AppState>, Path(id): Path<String>, Json(entry): Json<PatchForward>) -> Response {
    update(state, id, None, None, Some(entry)).await
}

fn unsupported() -> Response {
    (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "unsupported_feature"}))).into_response()
}

async fn update(state: AppState, id: String, add: Option<ForwardConfig>, remove: Option<u16>, patch: Option<PatchForward>) -> Response {
    let _guard = state.lock_resource_update(&id).await;
    let mut inner = state.inner.write().await;
    let Some(agent) = inner.agents.get_mut(&id) else { return StatusCode::NOT_FOUND.into_response(); };
    if !agent.capabilities.port_forward { return unsupported(); }
    let mut forwards = agent.pending_forwards.as_ref().map(|(_, f)| f.clone()).unwrap_or_else(|| agent.forwards.clone());
    if let Some(entry) = add { forwards.push(entry); }
    if let Some(port) = remove {
        let old_len = forwards.len();
        forwards.retain(|f| f.port != port);
        if old_len == forwards.len() { return StatusCode::NOT_FOUND.into_response(); }
    }
    if let Some(entry) = patch {
        let Some(forward) = forwards.iter_mut().find(|f| f.port == entry.port) else { return StatusCode::NOT_FOUND.into_response(); };
        forward.keep_prefix = entry.keep_prefix;
    }
    if let Err(message) = validate_forwards(&forwards) {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "invalid_forward", "message": message}))).into_response();
    }
    let Some(desired_revision) = agent.forwards_desired_revision.max(agent.forwards_revision).checked_add(1) else {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    };
    let req_id = format!("fwd_{}", uuid::Uuid::new_v4());
    agent.forwards_desired_revision = desired_revision;
    let offline = agent.status == AgentStatus::Offline;
    agent.pending_forwards = Some((req_id.clone(), forwards.clone()));
    if let Some(port) = remove { state.tunnels.cancel_forward(&id, port); }
    let connection_id = agent.connection_id;
    if !offline && !inner.agents.send_to_agent(&id, HubMessage::ForwardsSetDesired { req_id: req_id.clone(), desired_revision, forwards }) {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    }
    if offline {
        return Json(serde_json::json!({"ok": true, "state": "pending_agent_reconnect"})).into_response();
    }
    let mut changes = inner.sse_tx.subscribe();
    drop(inner);
    let wait = async {
        loop {
            let inner = state.inner.read().await;
            let Some(agent) = inner.agents.get(&id) else { return StatusCode::SERVICE_UNAVAILABLE.into_response(); };
            if agent.connection_id != connection_id || agent.status == AgentStatus::Offline {
                return Json(serde_json::json!({"ok": true, "state": "pending_agent_reconnect"})).into_response();
            }
            if agent.pending_forwards.as_ref().is_none_or(|(request, _)| request != &req_id) {
                return Json(serde_json::json!({"ok": agent.forwards_revision >= desired_revision,
                    "state": if agent.forwards_revision >= desired_revision { "applied" } else { "rejected" },
                    "forwards_revision": agent.forwards_revision, "message": agent.last_config_error,
                })).into_response();
            }
            drop(inner);
            let _ = changes.recv().await;
        }
    };
    tokio::time::timeout(std::time::Duration::from_secs(30), wait).await
        .unwrap_or_else(|_| StatusCode::GATEWAY_TIMEOUT.into_response())
}
