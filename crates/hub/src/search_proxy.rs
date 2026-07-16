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
        root: body.root,
        path: if body.path.is_empty() {
            "/".to_string()
        } else {
            body.path
        },
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
        return error_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "backend_offline",
            "Failed to send request to agent",
            true,
        );
    }

    drop(inner);

    // Content walks can take longer than sys-stats; keep a firm upper bound.
    let resp = tokio::time::timeout(Duration::from_secs(60), resp_rx.recv()).await;

    {
        let pending = state.inner.read().await.pending_responses.clone();
        let mut map = pending.write().await;
        map.remove(&req_id);
    }

    match resp {
        Ok(Some(value)) => Json(value).into_response(),
        _ => error_response(
            StatusCode::GATEWAY_TIMEOUT,
            "request_timeout",
            "Agent did not respond in time",
            true,
        ),
    }
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
