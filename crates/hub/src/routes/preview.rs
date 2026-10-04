use axum::extract::{Extension, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use filebox_protocol::message::HubMessage;
use filebox_protocol::resources::{FileStat, FsEntryType};
use rand::Rng;
use crate::agent_registry::AgentStatus;
use crate::agent_requests::{cleanup_pending as cleanup_pending_request, PendingResponseCleanup};
use crate::state::{AppState, AuthenticatedSession, PendingResponse, PreviewSession, MAX_PENDING_RESPONSES, PREVIEW_SESSION_MAX_TOTAL, PREVIEW_SESSION_TTL};
use crate::preview_doc;
use super::hub_overloaded_response;

// ── Sandboxed HTML Preview Sessions ─────────────────────────────────────────

#[derive(serde::Deserialize)]
pub(super) struct PreviewSessionCreateRequest {
    pub(super) agent_id: String,
    pub(super) root: String,
    pub(super) path: String,
}

#[derive(serde::Serialize)]
pub(super) struct PreviewSessionCreateResponse {
    base_url: String,
    /// URL of the session's own HTML document (relative, like `base_url`).
    /// The iframe loads this URL so navigation requests hit document mode.
    document_url: String,
    expires_in_sec: u64,
}

pub(super) async fn preview_session_create_handler(
    State(state): State<AppState>,
    Extension(session): Extension<AuthenticatedSession>,
    headers: HeaderMap,
    Json(req): Json<PreviewSessionCreateRequest>,
) -> Response {
    let Some(file_path) = normalize_preview_file_path(&req.path) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": "invalid_preview_path",
                "message": "Invalid HTML preview path",
                "retryable": false,
            })),
        )
            .into_response();
    };
    if !preview_doc::is_html_path(&file_path) {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": "invalid_preview_path",
                "message": "Preview sessions are only available for HTML files",
                "retryable": false,
            })),
        )
            .into_response();
    }

    let base_path = preview_base_path(&file_path);
    let absolute_base_url = preview_doc::absolute_origin_from_request(&headers);

    let preview_sessions = {
        let inner = state.inner.read().await;
        let Some(agent) = inner.agents.get(&req.agent_id) else {
            return (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({
                    "error": "backend_offline",
                    "message": format!("Agent {} not found or offline", req.agent_id),
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
                    "message": format!("Agent {} is offline", req.agent_id),
                    "retryable": true,
                })),
            )
                .into_response();
        }
        if !agent.roots.iter().any(|r| r.name == req.root && r.enabled) {
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
        inner.preview_sessions.clone()
    };

    let stat = match request_preview_stat(
        &state,
        &session.principal_id,
        &req.agent_id,
        &req.root,
        &file_path,
    )
    .await
    {
        Ok(stat) => stat,
        Err(resp) => return resp,
    };
    if stat.denied || stat.entry_type != FsEntryType::File {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": "invalid_preview_path",
                "message": "Preview path must be a readable HTML file",
                "retryable": false,
            })),
        )
            .into_response();
    }
    if let Err(resp) = request_preview_read_probe(
        &state,
        &session.principal_id,
        &req.agent_id,
        &req.root,
        &file_path,
    )
    .await
    {
        return resp;
    }

    let now = std::time::Instant::now();
    {
        let mut previews = preview_sessions.write().await;
        previews.retain(|_, preview| preview.expires_at > now);
        if let Some((token, preview)) = previews.iter().find(|(_, preview)| {
            preview.session_id == session.principal_id
                && preview.agent_id == req.agent_id
                && preview.root == req.root
                && preview.base_path == base_path
        }) {
            let token = token.clone();
            let expires_in_sec = preview
                .expires_at
                .saturating_duration_since(now)
                .as_secs()
                .max(1);
            return Json(PreviewSessionCreateResponse {
                base_url: preview_doc::preview_base_url(&token, &base_path),
                document_url: preview_doc::preview_document_url(&token, &base_path, &file_path),
                expires_in_sec,
            })
            .into_response();
        }
    }

    let token = generate_preview_token();
    let expires_at = now + PREVIEW_SESSION_TTL;
    let preview = PreviewSession {
        // Stable principal — cookie-id rotation must not orphan the 1h preview TTL.
        session_id: session.principal_id.clone(),
        agent_id: req.agent_id.clone(),
        root: req.root.clone(),
        base_path: base_path.clone(),
        absolute_base_url,
        created_at: now,
        expires_at,
        requests_served: 0,
        bytes_served: 0,
    };

    {
        let now = std::time::Instant::now();
        let mut previews = preview_sessions.write().await;
        previews.retain(|_, preview| preview.expires_at > now);
        prune_preview_sessions_for_insert(&mut previews);
        previews.insert(token.clone(), preview);
    }

    Json(PreviewSessionCreateResponse {
        base_url: preview_doc::preview_base_url(&token, &base_path),
        document_url: preview_doc::preview_document_url(&token, &base_path, &file_path),
        expires_in_sec: PREVIEW_SESSION_TTL.as_secs(),
    })
    .into_response()
}

pub(super) async fn request_preview_stat(
    state: &AppState,
    session_id: &str,
    agent_id: &str,
    root: &str,
    path: &str,
) -> Result<FileStat, Response> {
    let req_id = format!("preview_stat_{}", uuid::Uuid::new_v4());
    let msg = HubMessage::FsStatRequest {
        req_id: req_id.clone(),
        root: root.to_string(),
        path: path.to_string(),
    };
    let value = request_agent_once(state, session_id, agent_id, req_id, msg).await?;
    if let Some(err) = value["error"].as_str() {
        return Err(preview_invalid_response(err));
    }
    let Some(stat_value) = value.get("stat").filter(|v| !v.is_null()) else {
        return Err(preview_invalid_response("Preview path not found"));
    };
    serde_json::from_value::<FileStat>(stat_value.clone())
        .map_err(|_| preview_invalid_response("Invalid stat response from agent"))
}

pub(super) async fn request_preview_read_probe(
    state: &AppState,
    session_id: &str,
    agent_id: &str,
    root: &str,
    path: &str,
) -> Result<(), Response> {
    let req_id = format!("preview_read_{}", uuid::Uuid::new_v4());
    let msg = HubMessage::FileReadRequest {
        req_id: req_id.clone(),
        root: root.to_string(),
        path: path.to_string(),
        offset: 0,
        length: Some(0),
    };
    let value = request_agent_once(state, session_id, agent_id, req_id, msg).await?;
    if let Some(err) = value["error"].as_str() {
        return Err(preview_invalid_response(err));
    }
    Ok(())
}

pub(super) async fn request_agent_once(
    state: &AppState,
    session_id: &str,
    agent_id: &str,
    req_id: String,
    msg: HubMessage,
) -> Result<serde_json::Value, Response> {
    let (resp_tx, mut resp_rx, response_owner) = crate::agent_requests::response_channel();
    let send_ok = {
        let inner = state.inner.read().await;
        let Some(agent) = inner.agents.get(agent_id) else {
            return Err((
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({
                    "error": "backend_offline",
                    "message": format!("Agent {} not found or offline", agent_id),
                    "retryable": true,
                })),
            )
                .into_response());
        };
        let connection_id = agent.connection_id;
        let mut pending = inner.pending_responses.write().await;
        if pending.len() >= MAX_PENDING_RESPONSES {
            return Err(hub_overloaded_response());
        }
        pending.insert(
            req_id.clone(),
            PendingResponse {
                tx: resp_tx,
                agent_id: agent_id.to_string(),
                connection_id,
                session_id: Some(session_id.to_string()),
                desired_roots: None,
                desired_collections: None,
            },
        );
        drop(pending);
        inner.agents.send_to_agent(agent_id, msg)
    };

    if !send_ok {
        cleanup_pending_request(state, &req_id).await;
        return Err((
            StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({
                "error": "backend_offline",
                "message": "Failed to send request to agent",
                "retryable": true,
            })),
        )
        .into_response());
    }

    let cleanup = PendingResponseCleanup::new(state.clone(), req_id.clone(), Some(agent_id.to_string()), response_owner);
    let resp = tokio::time::timeout(std::time::Duration::from_secs(30), resp_rx.recv()).await;
    cleanup.finish(!matches!(resp, Ok(Some(_)))).await;
    match resp {
        Ok(Some(value)) => Ok(value),
        _ => Err((
            StatusCode::GATEWAY_TIMEOUT,
            Json(serde_json::json!({
                "error": "request_timeout",
                "message": "Agent did not respond in time",
                "retryable": true,
            })),
        )
            .into_response()),
    }
}

pub(super) fn preview_invalid_response(message: &str) -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(serde_json::json!({
            "error": "invalid_preview_path",
            "message": message,
            "retryable": false,
        })),
    )
        .into_response()
}

pub(super) fn normalize_preview_file_path(raw: &str) -> Option<String> {
    if raw.is_empty() || raw.len() > 4096 || raw.contains('\\') || raw.contains('\0') {
        return None;
    }

    let mut parts = Vec::new();
    for part in raw.trim_start_matches('/').split('/') {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            return None;
        }
        parts.push(part);
    }

    if parts.is_empty() {
        None
    } else {
        Some(parts.join("/"))
    }
}

pub(super) fn preview_base_path(file_path: &str) -> String {
    file_path
        .rsplit_once('/')
        .map(|(base, _)| base.to_string())
        .unwrap_or_default()
}

pub(super) fn generate_preview_token() -> String {
    let mut rng = rand::rng();
    let mut bytes = [0u8; 32];
    rng.fill(&mut bytes);
    hex::encode(bytes)
}

pub(super) fn prune_preview_sessions_for_insert(
    previews: &mut std::collections::HashMap<String, PreviewSession>,
) {
    prune_oldest_preview_sessions(
        previews,
        |_| true,
        PREVIEW_SESSION_MAX_TOTAL.saturating_sub(1),
    );
}

pub(super) fn prune_oldest_preview_sessions<F>(
    previews: &mut std::collections::HashMap<String, PreviewSession>,
    should_count: F,
    max_remaining: usize,
) where
    F: Fn(&PreviewSession) -> bool,
{
    loop {
        let count = previews
            .values()
            .filter(|preview| should_count(preview))
            .count();
        if count <= max_remaining {
            break;
        }
        let oldest_key = previews
            .iter()
            .filter(|(_, preview)| should_count(preview))
            .min_by_key(|(_, preview)| preview.created_at)
            .map(|(token, _)| token.clone());
        let Some(token) = oldest_key else {
            break;
        };
        previews.remove(&token);
    }
}
