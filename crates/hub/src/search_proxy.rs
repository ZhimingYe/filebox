use std::time::Duration;

use axum::extract::{Extension, Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use filebox_protocol::message::HubMessage;
use filebox_protocol::search::SearchMode;
use serde::Deserialize;
use tokio::sync::mpsc;
use uuid::Uuid;

use crate::state::{AppState, AuthenticatedSession, PendingResponse};

#[derive(Debug, Deserialize)]
pub struct WorkspaceSearchBody {
    pub mode: SearchMode,
    pub root: String,
    /// Directory within the root to search (rg/fd folder scope).
    #[serde(default)]
    pub path: String,
    pub query: String,
    #[serde(default)]
    pub extensions: Vec<String>,
    #[serde(default)]
    pub max_results: Option<u32>,
    #[serde(default)]
    pub context: Option<u32>,
}

/// Sends Cancel to the agent + clears pending when the HTTP waiter goes away
/// (client abort / timeout) so the agent does not keep burning CPU.
struct CancelOnDrop {
    state: AppState,
    agent_id: String,
    req_id: String,
    armed: bool,
}

impl CancelOnDrop {
    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let state = self.state.clone();
        let agent_id = self.agent_id.clone();
        let req_id = self.req_id.clone();
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn(async move {
                let inner = state.inner.read().await;
                let _ = inner.agents.send_to_agent(
                    &agent_id,
                    HubMessage::Cancel {
                        req_id: req_id.clone(),
                    },
                );
                drop(inner);
                let pending = state.inner.read().await.pending_responses.clone();
                let mut map = pending.write().await;
                map.remove(&req_id);
            });
        }
    }
}

pub async fn workspace_search_handler(
    State(state): State<AppState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path(agent_id): Path<String>,
    Json(body): Json<WorkspaceSearchBody>,
) -> Response {
    if body.root.trim().is_empty() {
        return error_response(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "root is required",
            false,
        );
    }
    if body.root.contains('\0') || body.path.contains('\0') {
        return error_response(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "root/path must not contain NUL",
            false,
        );
    }
    if path_has_dotdot(&body.path) {
        return error_response(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "path must not contain '..'",
            false,
        );
    }
    if body.query.len() > 512 {
        return error_response(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "query exceeds 512 characters",
            false,
        );
    }
    if body.extensions.len() > 64 {
        return error_response(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "too many extensions (max 64)",
            false,
        );
    }
    for ext in &body.extensions {
        if ext.len() > 32 || ext.contains('/') || ext.contains('\\') || ext.contains('\0') {
            return error_response(
                StatusCode::BAD_REQUEST,
                "invalid_request",
                "invalid extension filter",
                false,
            );
        }
    }

    let path = normalize_search_path(&body.path);

    let inner = state.inner.read().await;
    let agent = match inner.agents.get(&agent_id) {
        Some(a) => a,
        None => {
            return error_response(
                StatusCode::NOT_FOUND,
                "backend_offline",
                &format!("Agent {} not found or offline", agent_id),
                true,
            );
        }
    };

    if agent.status == crate::agent_registry::AgentStatus::Offline {
        return error_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "backend_offline",
            &format!("Agent {} is offline", agent_id),
            true,
        );
    }

    if !agent.capabilities.workspace_search {
        return error_response(
            StatusCode::NOT_IMPLEMENTED,
            "unsupported",
            "This agent does not support workspace search — upgrade the agent",
            false,
        );
    }

    let req_id = format!("ws_search_{}", Uuid::new_v4());
    let msg = HubMessage::WorkspaceSearchRequest {
        req_id: req_id.clone(),
        mode: body.mode,
        root: body.root.trim().to_string(),
        path,
        query: body.query,
        extensions: body.extensions,
        max_results: body.max_results,
        context: body.context,
    };

    let (resp_tx, mut resp_rx) = mpsc::channel(1);
    {
        let mut pending = inner.pending_responses.write().await;
        pending.insert(
            req_id.clone(),
            PendingResponse {
                tx: resp_tx,
                agent_id: agent_id.clone(),
                session_id: Some(session.id.clone()),
                desired_roots: None,
                desired_collections: None,
            },
        );
    }

    if !inner.agents.send_to_agent(&agent_id, msg) {
        drop(inner);
        cleanup_pending(&state, &req_id).await;
        return error_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "backend_offline",
            "Failed to send request to agent",
            true,
        );
    }

    drop(inner);

    let mut guard = CancelOnDrop {
        state: state.clone(),
        agent_id: agent_id.clone(),
        req_id: req_id.clone(),
        armed: true,
    };

    let resp = tokio::time::timeout(Duration::from_secs(60), resp_rx.recv()).await;
    cleanup_pending(&state, &req_id).await;

    match resp {
        Ok(Some(value)) => {
            guard.disarm();
            // Compact payload + req_id so the UI can cancel via /api/cancel.
            let result = value.get("result").cloned().unwrap_or(serde_json::Value::Null);
            let error = value.get("error").cloned().unwrap_or(serde_json::Value::Null);
            // Hub cancel injects {state:"cancelled", error:"cancelled"} without result.
            let cancelled = value
                .get("state")
                .and_then(|v| v.as_str())
                == Some("cancelled")
                || error.as_str() == Some("cancelled");
            Json(serde_json::json!({
                "req_id": req_id,
                "result": result,
                "error": if cancelled { serde_json::json!("cancelled") } else { error },
            }))
            .into_response()
        }
        _ => {
            // Timeout: leave guard armed so Drop cancels the agent worker.
            error_response(
                StatusCode::GATEWAY_TIMEOUT,
                "request_timeout",
                "Agent did not respond in time",
                true,
            )
        }
    }
}

fn normalize_search_path(path: &str) -> String {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return "/".to_string();
    }
    if trimmed.starts_with('/') {
        trimmed.to_string()
    } else {
        format!("/{trimmed}")
    }
}

async fn cleanup_pending(state: &AppState, req_id: &str) {
    let pending = state.inner.read().await.pending_responses.clone();
    let mut map = pending.write().await;
    map.remove(req_id);
}

fn path_has_dotdot(path: &str) -> bool {
    path.split(['/', '\\']).any(|part| part == "..")
}

fn error_response(status: StatusCode, error: &str, message: &str, retryable: bool) -> Response {
    (
        status,
        Json(serde_json::json!({
            "error": error,
            "message": message,
            "retryable": retryable,
        })),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::{normalize_search_path, path_has_dotdot};

    #[test]
    fn rejects_dotdot_components_only() {
        assert!(path_has_dotdot("../x"));
        assert!(path_has_dotdot("a/../b"));
        assert!(path_has_dotdot(r"a\..\b"));
        assert!(!path_has_dotdot("a/b"));
        assert!(!path_has_dotdot("foo..bar"));
        assert!(!path_has_dotdot(""));
    }

    #[test]
    fn normalizes_folder_path() {
        assert_eq!(normalize_search_path(""), "/");
        assert_eq!(normalize_search_path("src"), "/src");
        assert_eq!(normalize_search_path("/src/lib"), "/src/lib");
    }
}
