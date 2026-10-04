use axum::extract::{Extension, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use crate::state::{AppState, AuthenticatedSession};

// ── Cancel ───────────────────────────────────────────────────────────────────

#[derive(serde::Deserialize)]
pub(crate) struct CancelRequest {
    pub agent_id: String,
    pub req_id: String,
}

pub(crate) async fn cancel_handler(
    State(state): State<AppState>,
    Extension(session): Extension<AuthenticatedSession>,
    Json(req): Json<CancelRequest>,
) -> Response {
    let target = {
        let inner = state.inner.write().await;
        let mut pending = inner.pending_responses.write().await;
        let Some(pending_resp) = pending.get(&req.req_id) else {
            return (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({
                    "error": "request_not_found",
                    "message": "Request not found or already completed",
                    "retryable": false,
                })),
            )
                .into_response();
        };
        if pending_resp.session_id.as_deref() != Some(session.principal_id.as_str()) {
            return (
                StatusCode::FORBIDDEN,
                Json(serde_json::json!({
                    "error": "permission_denied",
                    "message": "Cannot cancel a request owned by another session",
                    "retryable": false,
                })),
            )
                .into_response();
        }
        if pending_resp.agent_id != req.agent_id {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({
                    "error": "invalid_request",
                    "message": "Request does not belong to the selected agent",
                    "retryable": false,
                })),
            )
                .into_response();
        }
        let connection_id = pending_resp.connection_id;
        AppState::mark_request_cancelled_locked(&inner, &req.req_id);
        let pending_resp = pending.remove(&req.req_id).expect("owner just validated");
        drop(pending);
        pending_resp.deliver(serde_json::json!({
            "ok": false, "state": "cancelled", "error": "cancelled",
            "message": "Request cancelled by user",
        }));
        inner.agents.get(&req.agent_id)
            .filter(|a| a.connection_id == connection_id)
            .map(|a| (a.sender.clone(), a.abort_notify.clone()))
    };
    // Release the HTTP waiter before waiting for queue space. The cancellation
    // targets only its captured socket; a replacement must never receive it.
    let agent_notified = match target {
        Some((sender, abort)) => crate::agent_requests::send_cancel(&state, sender, abort, &req.req_id).await,
        None => false,
    };

    Json(serde_json::json!({
        "ok": true,
        "agent_notified": agent_notified,
    }))
    .into_response()
}
