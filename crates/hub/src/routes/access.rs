use crate::agent_registry::AgentStatus;
use axum::extract::{Extension, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use rand::Rng;
use crate::state::{AppState, AuthenticatedSession, GetAccessPurpose, GetAccessToken, GET_ACCESS_TOKEN_MAX_TOTAL, GET_ACCESS_TOKEN_TTL_EVENTS, GET_ACCESS_TOKEN_TTL_FILE};

// ── Short-lived GET access tokens (downloads / SSE / PDF ranges) ────────────

#[derive(serde::Deserialize)]
pub(super) struct AccessTokenCreateRequest {
    purpose: String,
    agent_id: Option<String>,
    root: Option<String>,
    path: Option<String>,
}

pub(super) async fn access_token_create_handler(
    State(state): State<AppState>,
    Extension(session): Extension<AuthenticatedSession>,
    Json(req): Json<AccessTokenCreateRequest>,
) -> Response {
    let purpose = match req.purpose.as_str() {
        "file_raw" => GetAccessPurpose::FileRaw,
        "events" => GetAccessPurpose::Events,
        _ => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({
                    "error": "invalid_request",
                    "message": "purpose must be file_raw or events",
                    "retryable": false,
                })),
            )
                .into_response();
        }
    };

    let (agent_id, root, path, ttl) = match purpose {
        GetAccessPurpose::FileRaw => {
            let agent_id = req.agent_id.unwrap_or_default();
            let root = req.root.unwrap_or_default();
            let path = req.path.unwrap_or_default();
            if agent_id.is_empty() || root.is_empty() || path.is_empty() {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({
                        "error": "invalid_request",
                        "message": "file_raw tokens require agent_id, root, and path",
                        "retryable": false,
                    })),
                )
                    .into_response();
            }
            if path.contains('\0') || path.contains('\\') || path_has_dotdot(&path) {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({
                        "error": "invalid_request",
                        "message": "invalid path",
                        "retryable": false,
                    })),
                )
                    .into_response();
            }
            {
                let inner = state.inner.read().await;
                let Some(agent) = inner.agents.get(&agent_id) else {
                    return (
                        StatusCode::NOT_FOUND,
                        Json(serde_json::json!({
                            "error": "backend_offline",
                            "message": "Agent not found or offline",
                            "retryable": true,
                        })),
                    )
                        .into_response();
                };
                if agent.status == AgentStatus::Offline {
                    return (
                        StatusCode::SERVICE_UNAVAILABLE,
                        Json(serde_json::json!({
                            "error": "backend_offline",
                            "message": "Agent is offline",
                            "retryable": true,
                        })),
                    )
                        .into_response();
                }
                if !agent.roots.iter().any(|r| r.name == root && r.enabled) {
                    return (
                        StatusCode::NOT_FOUND,
                        Json(serde_json::json!({
                            "error": "root_unavailable",
                            "message": "Root is no longer available",
                            "retryable": true,
                        })),
                    )
                        .into_response();
                }
            }
            (
                Some(agent_id),
                Some(root),
                Some(path),
                GET_ACCESS_TOKEN_TTL_FILE,
            )
        }
        GetAccessPurpose::Events => (None, None, None, GET_ACCESS_TOKEN_TTL_EVENTS),
    };

    let now = std::time::Instant::now();
    let reuse_until = now + std::time::Duration::from_secs(60);
    let mut token = generate_access_token();
    let record = GetAccessToken {
        session_id: session.id.clone(),
        principal_id: session.principal_id.clone(),
        purpose,
        agent_id,
        root,
        path,
        expires_at: now + ttl,
        requests_served: 0,
    };

    let tokens = {
        let inner = state.inner.read().await;
        inner.get_access_tokens.clone()
    };
    {
        let mut map = tokens.write().await;
        map.retain(|_, t| t.expires_at > now);

        // Reuse an existing scoped bearer. Re-mounting a PDF, clicking the
        // same download repeatedly, or adding another SSE subscriber must not
        // consume a cumulative per-user budget.
        if let Some((existing, existing_record)) = map.iter().find(|(_, existing)| {
            existing.principal_id == record.principal_id
                && existing.purpose == record.purpose
                && existing.agent_id == record.agent_id
                && existing.root == record.root
                && existing.path == record.path
                && existing.expires_at > reuse_until
        }) {
            token = existing.clone();
            let remaining = existing_record.expires_at.saturating_duration_since(now);
            return Json(serde_json::json!({
                "token": token,
                "expires_in_sec": remaining.as_secs(),
            }))
            .into_response();
        }

        // This is a memory bound, not a user activity quota. If the global
        // store is full, retire the bearer nearest expiry instead of rejecting
        // an ordinary file view/download.
        while map.len() >= GET_ACCESS_TOKEN_MAX_TOTAL {
            let Some(oldest) = map
                .iter()
                .min_by_key(|(_, existing)| existing.expires_at)
                .map(|(key, _)| key.clone())
            else {
                break;
            };
            map.remove(&oldest);
        }
        map.insert(token.clone(), record);
    }

    Json(serde_json::json!({
        "token": token,
        "expires_in_sec": ttl.as_secs(),
    }))
    .into_response()
}

pub(super) fn generate_access_token() -> String {
    let mut rng = rand::rng();
    let mut bytes = [0u8; 32];
    rng.fill(&mut bytes);
    hex::encode(bytes)
}

pub(super) fn path_has_dotdot(path: &str) -> bool {
    path.split('/').any(|seg| seg == "..")
}
