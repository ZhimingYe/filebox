use std::time::Duration;

use axum::extract::{Extension, Path, Query, State};
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use base64::Engine;
use tokio::sync::mpsc;
use uuid::Uuid;

fn guess_content_type(path: &str) -> &'static str {
    let ext = path.rsplit('.').next().unwrap_or("").to_lowercase();
    match ext.as_str() {
        "pdf" => "application/pdf",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "tiff" | "tif" => "image/tiff",
        "html" | "htm" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" => "application/javascript; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "xml" => "application/xml; charset=utf-8",
        "txt" | "log" | "md" | "csv" | "tsv" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

fn media_type(content_type: &str) -> &str {
    content_type
        .split(';')
        .next()
        .unwrap_or(content_type)
        .trim()
}

fn is_active_content_type(content_type: &str) -> bool {
    matches!(
        media_type(content_type),
        "text/html"
            | "text/css"
            | "image/svg+xml"
            | "application/javascript"
            | "text/javascript"
            | "application/xml"
            | "text/xml"
    )
}

fn is_inline_type(content_type: &str) -> bool {
    let media = media_type(content_type);
    matches!(
        media,
        "application/pdf"
            | "application/json"
            | "image/png"
            | "image/jpeg"
            | "image/gif"
            | "image/webp"
            | "image/bmp"
            | "image/x-icon"
            | "image/tiff"
            | "text/plain"
            | "text/csv"
            | "text/tab-separated-values"
    )
}

use filebox_protocol::message::HubMessage;

use crate::state::{
    AppState, AuthenticatedSession, PendingResponse, PreviewSession,
    PREVIEW_SESSION_MAX_BYTES, PREVIEW_SESSION_MAX_REQUESTS,
};

#[derive(Debug, serde::Deserialize)]
pub struct FsListParams {
    pub agent_id: String,
    pub root: String,
    pub path: String,
    pub limit: Option<u32>,
    pub cursor: Option<String>,
    /// When true, the agent returns only directory entries. Used by the
    /// directory-tree navigator. Old agents ignore the field and return
    /// everything; the tree filters client-side as a fallback.
    #[serde(default)]
    pub dirs_only: Option<bool>,
}

#[derive(Debug, serde::Deserialize)]
pub struct FsStatParams {
    pub agent_id: String,
    pub root: String,
    pub path: String,
}

#[derive(Debug, serde::Deserialize)]
pub struct FileRawParams {
    pub agent_id: String,
    pub root: String,
    pub path: String,
}

pub async fn fs_list_handler(
    State(state): State<AppState>,
    Extension(session): Extension<AuthenticatedSession>,
    Query(params): Query<FsListParams>,
) -> Response {
    let inner = state.inner.read().await;
    let agent = match inner.agents.get(&params.agent_id) {
        Some(a) => a,
        None => {
            return error_response(
                StatusCode::NOT_FOUND,
                "backend_offline",
                &format!("Agent {} not found or offline", params.agent_id),
                true,
            );
        }
    };

    if agent.status == crate::agent_registry::AgentStatus::Offline {
        return error_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "backend_offline",
            &format!("Agent {} is offline", params.agent_id),
            true,
        );
    }

    let req_id = format!("fs_list_{}", Uuid::new_v4());
    let limit = params.limit.unwrap_or(200).min(1000);

    let msg = HubMessage::FsListRequest {
        req_id: req_id.clone(),
        root: params.root,
        path: params.path,
        limit,
        cursor: params.cursor,
        dirs_only: params.dirs_only,
    };

    let (resp_tx, mut resp_rx) = mpsc::channel(1);
    {
        let mut pending = inner.pending_responses.write().await;
        pending.insert(req_id.clone(), PendingResponse {
            tx: resp_tx,
            agent_id: params.agent_id.clone(),
            session_id: Some(session.principal_id.clone()),
            desired_roots: None,
            desired_collections: None,
        });
    }

    if !inner.agents.send_to_agent(&params.agent_id, msg) {
        return error_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "backend_offline",
            "Failed to send request to agent",
            true,
        );
    }

    drop(inner);

    let resp = tokio::time::timeout(Duration::from_secs(30), resp_rx.recv()).await;

    cleanup_pending(&state, &req_id).await;

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

pub async fn fs_stat_handler(
    State(state): State<AppState>,
    Extension(session): Extension<AuthenticatedSession>,
    Query(params): Query<FsStatParams>,
) -> Response {
    let inner = state.inner.read().await;
    let agent = match inner.agents.get(&params.agent_id) {
        Some(a) => a,
        None => {
            return error_response(
                StatusCode::NOT_FOUND,
                "backend_offline",
                &format!("Agent {} not found or offline", params.agent_id),
                true,
            );
        }
    };

    if agent.status == crate::agent_registry::AgentStatus::Offline {
        return error_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "backend_offline",
            &format!("Agent {} is offline", params.agent_id),
            true,
        );
    }

    let req_id = format!("fs_stat_{}", Uuid::new_v4());

    let msg = HubMessage::FsStatRequest {
        req_id: req_id.clone(),
        root: params.root,
        path: params.path,
    };

    let (resp_tx, mut resp_rx) = mpsc::channel(1);
    {
        let mut pending = inner.pending_responses.write().await;
        pending.insert(req_id.clone(), PendingResponse {
            tx: resp_tx,
            agent_id: params.agent_id.clone(),
            session_id: Some(session.principal_id.clone()),
            desired_roots: None,
            desired_collections: None,
        });
    }

    if !inner.agents.send_to_agent(&params.agent_id, msg) {
        return error_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "backend_offline",
            "Failed to send request to agent",
            true,
        );
    }

    drop(inner);

    let resp = tokio::time::timeout(Duration::from_secs(30), resp_rx.recv()).await;

    cleanup_pending(&state, &req_id).await;

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

// Hub-side accumulated body cap. Agent streams FileChunk in 4MB frames; we
// gather them in memory before returning. This cap prevents a single huge
// file from exhausting Hub memory under concurrent requests.
const HUB_FILE_MAX: usize = 256 * 1024 * 1024;

struct RawFileTarget {
    agent_id: String,
    root: String,
    path: String,
    session_id: Option<String>,
    preview_token: Option<String>,
}

pub async fn file_raw_handler(
    State(state): State<AppState>,
    Extension(session): Extension<AuthenticatedSession>,
    Query(params): Query<FileRawParams>,
    req: axum::extract::Request,
) -> Response {
    serve_raw_file(
        state,
        RawFileTarget {
            agent_id: params.agent_id,
            root: params.root,
            path: params.path,
            session_id: Some(session.principal_id),
            preview_token: None,
        },
        req,
    )
    .await
}

pub async fn preview_resource_handler(
    State(state): State<AppState>,
    Path((token, resource_path)): Path<(String, String)>,
    req: axum::extract::Request,
) -> Response {
    let Some(normalized_resource_path) = normalize_preview_resource_path(&resource_path) else {
        let mut resp = error_response(
            StatusCode::BAD_REQUEST,
            "invalid_preview_path",
            "Invalid preview resource path",
            false,
        );
        apply_preview_headers(&mut resp);
        return resp;
    };

    let preview = match claim_preview_request(&state, &token).await {
        Ok(preview) => preview,
        Err(mut resp) => {
            apply_preview_headers(&mut resp);
            return resp;
        }
    };

    if !owner_session_is_active(&state, &preview).await {
        remove_preview_session(&state, &token).await;
        let mut resp = error_response(
            StatusCode::UNAUTHORIZED,
            "preview_expired",
            "Preview session expired",
            false,
        );
        apply_preview_headers(&mut resp);
        return resp;
    }

    let Some(path) = preview_resource_path_within_base(
        &preview.base_path,
        &normalized_resource_path,
    ) else {
        let mut resp = error_response(
            StatusCode::FORBIDDEN,
            "preview_path_outside_scope",
            "Preview resource is outside the HTML file directory",
            false,
        );
        apply_preview_headers(&mut resp);
        return resp;
    };
    let mut resp = serve_raw_file(
        state.clone(),
        RawFileTarget {
            agent_id: preview.agent_id.clone(),
            root: preview.root.clone(),
            path,
            session_id: Some(preview.session_id.clone()),
            preview_token: Some(token.clone()),
        },
        req,
    )
    .await;

    apply_preview_headers(&mut resp);
    resp
}

pub async fn preview_options_handler() -> Response {
    let mut resp = Response::builder()
        .status(StatusCode::NO_CONTENT)
        .body(axum::body::Body::empty())
        .unwrap();
    apply_preview_headers(&mut resp);
    resp
}

async fn serve_raw_file(
    state: AppState,
    target: RawFileTarget,
    req: axum::extract::Request,
) -> Response {
    // One-shot check that the agent is registered and online. We acquire
    // and release the read guard here so the loop below doesn't hold it
    // across awaits — that would block agent register/unregister for the
    // whole multi-chunk transfer.
    {
        let inner = state.inner.read().await;
        let agent = match inner.agents.get(&target.agent_id) {
            Some(a) => a,
            None => return error_response(
                StatusCode::NOT_FOUND,
                "backend_offline",
                &format!("Agent {} not found or offline", target.agent_id),
                true,
            ),
        };
        if agent.status == crate::agent_registry::AgentStatus::Offline {
            return error_response(
                StatusCode::SERVICE_UNAVAILABLE,
                "backend_offline",
                &format!("Agent {} is offline", target.agent_id),
                true,
            );
        }
    }

    // Parse Range header
    let (offset_start, length_opt) = parse_range_header(req.headers().get(header::RANGE));
    let file_path = target.path.clone();

    // Agent caps each FileChunk at 4MB (crates/agent/src/fs.rs). Loop here
    // and re-request subsequent offsets until done so the browser gets the
    // full file body, not just the first 4MB.
    let mut accumulated: Vec<u8> = Vec::new();
    let mut first_round = true;

    loop {
        let current_offset = offset_start + accumulated.len() as u64;
        // Only the first round honors the Range length; subsequent rounds
        // read until the agent's own cap or EOF.
        let current_length = if first_round { length_opt } else { None };

        let req_id = format!("file_{}", Uuid::new_v4());
        let msg = HubMessage::FileReadRequest {
            req_id: req_id.clone(),
            root: target.root.clone(),
            path: target.path.clone(),
            offset: current_offset,
            length: current_length,
        };

        let (resp_tx, mut resp_rx) = mpsc::channel(1);
        let send_ok = {
            let inner = state.inner.read().await;
            let mut pending = inner.pending_responses.write().await;
            pending.insert(req_id.clone(), PendingResponse {
                tx: resp_tx,
                agent_id: target.agent_id.clone(),
                session_id: target.session_id.clone(),
                desired_roots: None,
                desired_collections: None,
            });
            drop(pending);
            inner.agents.send_to_agent(&target.agent_id, msg)
        };
        // inner dropped here — agent register/unregister can proceed while
        // we await the agent's FileChunk.

        if !send_ok {
            cleanup_pending(&state, &req_id).await;
            return error_response(
                StatusCode::SERVICE_UNAVAILABLE,
                "backend_offline",
                "Failed to send request to agent",
                true,
            );
        }

        let resp = tokio::time::timeout(Duration::from_secs(60), resp_rx.recv()).await;

        cleanup_pending(&state, &req_id).await;

        let value = match resp {
            Ok(Some(v)) => v,
            _ => return error_response(
                StatusCode::GATEWAY_TIMEOUT,
                "request_timeout",
                "Agent did not respond in time",
                true,
            ),
        };

        if let Some(err) = value["error"].as_str() {
            return error_response(
                StatusCode::BAD_REQUEST,
                "file_read_error",
                err,
                false,
            );
        }

        let chunk_data = match decode_file_chunk_data(&value["data"]) {
            Ok(data) => data,
            Err(err) => {
                return error_response(
                    StatusCode::BAD_REQUEST,
                    "file_read_error",
                    &err,
                    false,
                );
            }
        };

        let done = value["done"].as_bool().unwrap_or(true);

        // Dead-loop defense: agent returned no data and didn't mark done.
        if chunk_data.is_empty() && !done {
            tracing::warn!("file_raw_handler: agent returned empty chunk without done; breaking");
            break;
        }

        // Hub memory guard. Check before extend so we don't materialize the
        // oversize body just to throw it away. Returning 413 here surfaces
        // clearly to the browser (image onerror, fetch non-2xx) instead of
        // silently serving a truncated file.
        let projected = accumulated.len() + chunk_data.len();
        if projected > HUB_FILE_MAX {
            tracing::warn!(
                "file_raw_handler: {} would exceed HUB_FILE_MAX ({}); returning 413",
                file_path, HUB_FILE_MAX
            );
            return error_response(
                StatusCode::PAYLOAD_TOO_LARGE,
                "file_too_large",
                &format!(
                    "File exceeds hub-side preview limit of {} bytes",
                    HUB_FILE_MAX
                ),
                false,
            );
        }
        if let Some(token) = target.preview_token.clone() {
            if let Err(resp) = reserve_preview_bytes(&state, &token, chunk_data.len() as u64).await {
                return resp;
            }
        }

        accumulated.extend_from_slice(&chunk_data);

        // Range length satisfied — truncate to exact length and stop.
        if let Some(req_len) = length_opt {
            if (accumulated.len() as u64) >= req_len {
                accumulated.truncate(req_len as usize);
                break;
            }
        }

        if done {
            break;
        }

        first_round = false;
    }

    let data = accumulated;
    let content_type = guess_content_type(&file_path);
    let disposition = if is_inline_type(content_type) { "inline" } else { "attachment" };
    let filename = file_path.rsplit('/').next().unwrap_or("file");
    // Sanitize filename: remove chars that could break Content-Disposition header
    let safe_filename: String = filename.chars().filter(|c| *c != '"' && *c != '\\' && *c != '\n' && *c != '\r').collect();

    if length_opt.is_some() {
        // Partial content response
        if data.is_empty() {
            let resp = Response::builder()
                .status(StatusCode::RANGE_NOT_SATISFIABLE)
                .header(header::CONTENT_RANGE, "bytes */*")
                .body(axum::body::Body::empty())
                .unwrap();
            return resp.into_response();
        }
        let end = offset_start + data.len() as u64 - 1;
        let mut resp = Response::builder()
            .status(StatusCode::PARTIAL_CONTENT)
            .header(header::CONTENT_TYPE, content_type)
            .header(header::CONTENT_LENGTH, data.len())
            .header(header::CONTENT_RANGE, format!("bytes {}-{}/{}", offset_start, end, "*"))
            .header(header::CONTENT_DISPOSITION, format!("{}; filename=\"{}\"", disposition, safe_filename))
            .body(axum::body::Body::from(data))
            .unwrap();
        apply_raw_file_headers(&mut resp, content_type);
        resp.into_response()
    } else {
        let mut resp = Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, content_type)
            .header(header::CONTENT_LENGTH, data.len())
            .header(header::CONTENT_DISPOSITION, format!("{}; filename=\"{}\"", disposition, safe_filename))
            .body(axum::body::Body::from(data))
            .unwrap();
        apply_raw_file_headers(&mut resp, content_type);
        resp.into_response()
    }
}

const RAW_ACTIVE_CONTENT_CSP: &str =
    "sandbox; default-src 'none'; script-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";

fn apply_raw_file_headers(resp: &mut Response, content_type: &str) {
    if is_active_content_type(content_type) {
        resp.headers_mut().insert(
            header::CONTENT_SECURITY_POLICY,
            HeaderValue::from_static(RAW_ACTIVE_CONTENT_CSP),
        );
    }
}

fn normalize_preview_resource_path(raw: &str) -> Option<String> {
    if raw.is_empty() || raw.len() > 4096 || raw.contains('\\') || raw.contains('\0') {
        return None;
    }

    let mut parts = Vec::new();
    for part in raw.split('/') {
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

fn preview_resource_path_within_base(base_path: &str, resource_path: &str) -> Option<String> {
    let base = base_path.trim_matches('/');
    if base.is_empty() {
        return Some(resource_path.to_string());
    }
    if resource_path.strip_prefix(base) == Some("") {
        return None;
    }
    if resource_path.starts_with(&format!("{}/", base)) {
        Some(resource_path.to_string())
    } else {
        None
    }
}

async fn claim_preview_request(state: &AppState, token: &str) -> Result<PreviewSession, Response> {
    let preview_sessions = {
        let inner = state.inner.read().await;
        inner.preview_sessions.clone()
    };
    let now = std::time::Instant::now();
    let mut previews = preview_sessions.write().await;
    previews.retain(|_, preview| preview.expires_at > now);

    let Some(preview) = previews.get_mut(token) else {
        return Err(error_response(
            StatusCode::NOT_FOUND,
            "preview_expired",
            "Preview session expired or not found",
            false,
        ));
    };

    if preview.requests_served >= PREVIEW_SESSION_MAX_REQUESTS {
        return Err(error_response(
            StatusCode::TOO_MANY_REQUESTS,
            "preview_budget_exceeded",
            "Preview session request limit exceeded",
            false,
        ));
    }
    if preview.bytes_served >= PREVIEW_SESSION_MAX_BYTES {
        return Err(error_response(
            StatusCode::PAYLOAD_TOO_LARGE,
            "preview_budget_exceeded",
            "Preview session byte limit exceeded",
            false,
        ));
    }

    preview.requests_served = preview.requests_served.saturating_add(1);
    Ok(preview.clone())
}

async fn owner_session_is_active(state: &AppState, preview: &PreviewSession) -> bool {
    let inner = state.inner.read().await;
    // PreviewSession.session_id stores the stable principal id.
    inner
        .sessions
        .get_session_by_principal(&preview.session_id)
        .is_some()
}

async fn remove_preview_session(state: &AppState, token: &str) {
    let preview_sessions = {
        let inner = state.inner.read().await;
        inner.preview_sessions.clone()
    };
    let mut previews = preview_sessions.write().await;
    previews.remove(token);
}

async fn reserve_preview_bytes(state: &AppState, token: &str, bytes: u64) -> Result<(), Response> {
    if bytes == 0 {
        return Ok(());
    }
    let preview_sessions = {
        let inner = state.inner.read().await;
        inner.preview_sessions.clone()
    };
    let now = std::time::Instant::now();
    let mut previews = preview_sessions.write().await;
    previews.retain(|_, preview| preview.expires_at > now);
    let Some(preview) = previews.get_mut(token) else {
        return Err(error_response(
            StatusCode::NOT_FOUND,
            "preview_expired",
            "Preview session expired or not found",
            false,
        ));
    };
    let projected = preview.bytes_served.saturating_add(bytes);
    if projected > PREVIEW_SESSION_MAX_BYTES {
        return Err(error_response(
            StatusCode::PAYLOAD_TOO_LARGE,
            "preview_budget_exceeded",
            "Preview session byte limit exceeded",
            false,
        ));
    }
    preview.bytes_served = projected;
    Ok(())
}

fn apply_preview_headers(resp: &mut Response) {
    let headers = resp.headers_mut();
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static("default-src 'none'; script-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"),
    );
    headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue::from_static("null"));
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        HeaderValue::from_static("GET, HEAD, OPTIONS"),
    );
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        HeaderValue::from_static("Range, Content-Type"),
    );
    headers.insert(header::VARY, HeaderValue::from_static("Origin"));
}

pub async fn sys_stats_handler(
    State(state): State<AppState>,
    Extension(session): Extension<AuthenticatedSession>,
    axum::extract::Path(agent_id): axum::extract::Path<String>,
) -> Response {
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

    let req_id = format!("sys_stats_{}", Uuid::new_v4());

    let msg = HubMessage::SysStatsRequest {
        req_id: req_id.clone(),
    };

    let (resp_tx, mut resp_rx) = mpsc::channel(1);
    {
        let mut pending = inner.pending_responses.write().await;
        pending.insert(req_id.clone(), PendingResponse {
            tx: resp_tx,
            agent_id: agent_id.clone(),
            session_id: Some(session.principal_id.clone()),
            desired_roots: None,
            desired_collections: None,
        });
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

    let resp = tokio::time::timeout(Duration::from_secs(10), resp_rx.recv()).await;

    cleanup_pending(&state, &req_id).await;

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

fn parse_range_header(value: Option<&axum::http::HeaderValue>) -> (u64, Option<u64>) {
    let Some(val) = value else {
        return (0, None);
    };

    let Ok(s) = val.to_str() else {
        return (0, None);
    };

    // Parse "bytes=START-END" or "bytes=START-". RFC 7233 specifies the
    // range unit as a case-insensitive token ("bytes"), so accept any case
    // variation of the prefix.
    let s = s.trim();
    let Some(prefix) = s.get(..6) else {
        return (0, None);
    };
    if !prefix.eq_ignore_ascii_case("bytes=") {
        return (0, None);
    }

    let range = &s[6..];
    if range.contains(',') {
        return (0, None);
    }
    let Some((start_raw, end_raw)) = range.split_once('-') else {
        return (0, None);
    };
    if start_raw.is_empty() || end_raw.contains('-') {
        return (0, None);
    }

    let Ok(start) = start_raw.parse::<u64>() else {
        return (0, None);
    };
    let length = if end_raw.is_empty() {
        None
    } else {
        let Ok(end) = end_raw.parse::<u64>() else {
            return (start, None);
        };
        if end < start {
            return (0, None);
        }
        Some(end - start + 1)
    };

    (start, length)
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

fn decode_file_chunk_data(value: &serde_json::Value) -> Result<Vec<u8>, String> {
    if let Some(encoded) = value.as_str() {
        return base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .map_err(|e| format!("Invalid file chunk data: {}", e));
    }

    // Backward compatibility for agents that still send JSON number arrays.
    if let Some(arr) = value.as_array() {
        return arr
            .iter()
            .map(|v| {
                v.as_u64()
                    .and_then(|n| u8::try_from(n).ok())
                    .ok_or_else(|| "Invalid legacy file chunk byte".to_string())
            })
            .collect();
    }

    Ok(Vec::new())
}

async fn cleanup_pending(state: &AppState, req_id: &str) {
    let pending = state.inner.read().await.pending_responses.clone();
    let mut map = pending.write().await;
    map.remove(req_id);
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;
    use filebox_protocol::message::AgentMessage;
    use filebox_protocol::resources::Capabilities;
    use std::sync::Arc;
    use tokio::sync::Notify;

    fn hv(val: &str) -> HeaderValue {
        HeaderValue::from_str(val).unwrap()
    }

    // ── parse_range_header ───────────────────────────────────────────────────

    #[test]
    fn parse_range_none_returns_zero_offset_no_length() {
        let (offset, length) = parse_range_header(None);
        assert_eq!(offset, 0);
        assert!(length.is_none());
    }

    #[test]
    fn parse_range_start_only_returns_open_ended() {
        let h = hv("bytes=100-");
        let (offset, length) = parse_range_header(Some(&h));
        assert_eq!(offset, 100);
        assert!(length.is_none());
    }

    #[test]
    fn parse_range_start_end_returns_length_inclusive() {
        // bytes=0-99 means 100 bytes
        let h = hv("bytes=0-99");
        let (offset, length) = parse_range_header(Some(&h));
        assert_eq!(offset, 0);
        assert_eq!(length, Some(100));
    }

    #[test]
    fn parse_range_with_arbitrary_offset_and_end() {
        // bytes=200-299 means 100 bytes
        let h = hv("bytes=200-299");
        let (offset, length) = parse_range_header(Some(&h));
        assert_eq!(offset, 200);
        assert_eq!(length, Some(100));
    }

    #[test]
    fn parse_range_rejects_non_bytes_prefix() {
        let h = hv("items=0-100");
        let (offset, length) = parse_range_header(Some(&h));
        assert_eq!(offset, 0);
        assert!(length.is_none());
    }

    #[test]
    fn parse_range_accepts_uppercase_bytes_prefix() {
        // RFC 7233: range unit is case-insensitive. Must accept "BYTES=",
        // "Bytes=", etc., not just lowercase.
        let h = hv("BYTES=100-199");
        let (offset, length) = parse_range_header(Some(&h));
        assert_eq!(offset, 100);
        assert_eq!(length, Some(100));
    }

    #[test]
    fn parse_range_accepts_mixed_case_bytes_prefix() {
        let h = hv("Bytes=0-");
        let (offset, length) = parse_range_header(Some(&h));
        assert_eq!(offset, 0);
        assert!(length.is_none());
    }

    #[test]
    fn parse_range_rejects_short_header_without_six_byte_prefix() {
        // Fewer than 6 bytes — must not panic on slicing.
        let h = hv("abc");
        let (offset, length) = parse_range_header(Some(&h));
        assert_eq!(offset, 0);
        assert!(length.is_none());
    }

    #[test]
    fn parse_range_rejects_malformed_format() {
        // Too many parts
        let h = hv("bytes=1-2-3");
        let (offset, length) = parse_range_header(Some(&h));
        assert_eq!(offset, 0);
        assert!(length.is_none());
    }

    #[test]
    fn parse_range_with_invalid_start_falls_back_to_zero() {
        let h = hv("bytes=abc-");
        let (offset, _length) = parse_range_header(Some(&h));
        assert_eq!(offset, 0);
    }

    #[test]
    fn parse_range_with_invalid_end_yields_no_length() {
        let h = hv("bytes=0-xyz");
        let (offset, length) = parse_range_header(Some(&h));
        assert_eq!(offset, 0);
        assert!(length.is_none());
    }

    #[test]
    fn parse_range_rejects_end_before_start() {
        let h = hv("bytes=20-10");
        let (offset, length) = parse_range_header(Some(&h));
        assert_eq!(offset, 0);
        assert!(length.is_none());
    }

    #[test]
    fn parse_range_rejects_suffix_range() {
        let h = hv("bytes=-500");
        let (offset, length) = parse_range_header(Some(&h));
        assert_eq!(offset, 0);
        assert!(length.is_none());
    }

    #[test]
    fn parse_range_rejects_multi_range() {
        let h = hv("bytes=0-99,200-299");
        let (offset, length) = parse_range_header(Some(&h));
        assert_eq!(offset, 0);
        assert!(length.is_none());
    }

    #[test]
    fn parse_range_handles_extra_whitespace() {
        let h = hv("  bytes=10-20  ");
        let (offset, length) = parse_range_header(Some(&h));
        assert_eq!(offset, 10);
        assert_eq!(length, Some(11));
    }

    #[test]
    fn parse_range_invalid_header_value_falls_back_to_defaults() {
        // Build a HeaderValue containing bytes that aren't visible ASCII — to_str() fails
        let bad = HeaderValue::from_bytes(b"bytes=\xff-").unwrap();
        let (offset, length) = parse_range_header(Some(&bad));
        assert_eq!(offset, 0);
        assert!(length.is_none());
    }

    // ── guess_content_type ───────────────────────────────────────────────────

    #[test]
    fn content_type_pdf() {
        assert_eq!(guess_content_type("doc.pdf"), "application/pdf");
    }

    #[test]
    fn content_type_image_variants() {
        assert_eq!(guess_content_type("a.png"), "image/png");
        assert_eq!(guess_content_type("a.jpg"), "image/jpeg");
        assert_eq!(guess_content_type("a.jpeg"), "image/jpeg");
        assert_eq!(guess_content_type("a.gif"), "image/gif");
        assert_eq!(guess_content_type("a.webp"), "image/webp");
        assert_eq!(guess_content_type("a.svg"), "image/svg+xml");
        assert_eq!(guess_content_type("a.bmp"), "image/bmp");
        assert_eq!(guess_content_type("a.ico"), "image/x-icon");
        assert_eq!(guess_content_type("a.tiff"), "image/tiff");
        assert_eq!(guess_content_type("a.tif"), "image/tiff");
    }

    #[test]
    fn content_type_text_and_code() {
        assert_eq!(guess_content_type("a.txt"), "text/plain; charset=utf-8");
        assert_eq!(guess_content_type("a.log"), "text/plain; charset=utf-8");
        assert_eq!(guess_content_type("a.md"), "text/plain; charset=utf-8");
        assert_eq!(guess_content_type("a.csv"), "text/plain; charset=utf-8");
        assert_eq!(guess_content_type("a.html"), "text/html; charset=utf-8");
        assert_eq!(guess_content_type("a.htm"), "text/html; charset=utf-8");
        assert_eq!(guess_content_type("a.css"), "text/css; charset=utf-8");
        assert_eq!(guess_content_type("a.js"), "application/javascript; charset=utf-8");
        assert_eq!(guess_content_type("a.mjs"), "application/javascript; charset=utf-8");
        assert_eq!(guess_content_type("a.json"), "application/json; charset=utf-8");
        assert_eq!(guess_content_type("a.xml"), "application/xml; charset=utf-8");
    }

    #[test]
    fn content_type_case_insensitive_extension() {
        assert_eq!(guess_content_type("PHOTO.PNG"), "image/png");
        assert_eq!(guess_content_type("Doc.PDF"), "application/pdf");
        assert_eq!(guess_content_type("INDEX.HTML"), "text/html; charset=utf-8");
    }

    #[test]
    fn content_type_unknown_extension_is_octet_stream() {
        assert_eq!(guess_content_type("archive.zip"), "application/octet-stream");
        assert_eq!(guess_content_type("data.dat"), "application/octet-stream");
    }

    #[test]
    fn content_type_file_without_extension_is_octet_stream() {
        assert_eq!(guess_content_type("README"), "application/octet-stream");
    }

    #[test]
    fn content_type_uses_last_extension_for_double_dot() {
        // .tar.gz → gz is the last extension; we don't have a mapping for gz,
        // so this should fall back to octet-stream.
        assert_eq!(guess_content_type("file.tar.gz"), "application/octet-stream");
    }

    #[test]
    fn content_type_handles_paths_with_directories() {
        assert_eq!(
            guess_content_type("dir/subdir/file.pdf"),
            "application/pdf"
        );
    }

    // ── is_inline_type ───────────────────────────────────────────────────────

    #[test]
    fn inline_type_images_are_inline() {
        assert!(is_inline_type("image/png"));
        assert!(is_inline_type("image/jpeg"));
        assert!(!is_inline_type("image/svg+xml"));
    }

    #[test]
    fn inline_type_text_is_inline() {
        assert!(is_inline_type("text/plain; charset=utf-8"));
        assert!(!is_inline_type("text/html; charset=utf-8"));
        assert!(!is_inline_type("text/css; charset=utf-8"));
    }

    #[test]
    fn inline_type_pdf_json_xml_js_are_inline() {
        assert!(is_inline_type("application/pdf"));
        assert!(is_inline_type("application/json"));
        assert!(!is_inline_type("application/xml"));
        assert!(!is_inline_type("application/javascript"));
    }

    #[test]
    fn active_content_types_are_detected() {
        assert!(is_active_content_type("text/html; charset=utf-8"));
        assert!(is_active_content_type("image/svg+xml"));
        assert!(is_active_content_type("application/javascript; charset=utf-8"));
        assert!(!is_active_content_type("application/json; charset=utf-8"));
        assert!(!is_active_content_type("application/pdf"));
    }

    #[test]
    fn inline_type_octet_stream_is_not_inline() {
        assert!(!is_inline_type("application/octet-stream"));
        assert!(!is_inline_type("application/zip"));
    }

    #[test]
    fn decode_file_chunk_data_accepts_base64_string() {
        let value = serde_json::Value::String("3q2+7w==".to_string());
        assert_eq!(
            decode_file_chunk_data(&value).unwrap(),
            vec![0xde, 0xad, 0xbe, 0xef]
        );
    }

    #[test]
    fn decode_file_chunk_data_accepts_legacy_byte_array() {
        let value = serde_json::json!([222, 173, 190, 239]);
        assert_eq!(
            decode_file_chunk_data(&value).unwrap(),
            vec![0xde, 0xad, 0xbe, 0xef]
        );
    }

    #[test]
    fn decode_file_chunk_data_rejects_invalid_legacy_byte() {
        let value = serde_json::json!([256]);
        assert!(decode_file_chunk_data(&value).is_err());
    }

    #[test]
    fn preview_resource_path_normalizes_relative_segments() {
        assert_eq!(
            normalize_preview_resource_path("./report_files//plot.js"),
            Some("report_files/plot.js".to_string())
        );
    }

    #[test]
    fn preview_resource_path_rejects_escape_segments() {
        assert!(normalize_preview_resource_path("../secret.txt").is_none());
        assert!(normalize_preview_resource_path("report_files/../../secret.txt").is_none());
        assert!(normalize_preview_resource_path("report_files\\plot.js").is_none());
    }

    #[test]
    fn preview_resource_scope_allows_paths_under_base_path() {
        assert_eq!(
            preview_resource_path_within_base("reports/run1", "reports/run1/report_files/plot.js"),
            Some("reports/run1/report_files/plot.js".to_string())
        );
        assert_eq!(
            preview_resource_path_within_base("", "report_files/plot.js"),
            Some("report_files/plot.js".to_string())
        );
    }

    #[test]
    fn preview_resource_scope_rejects_paths_outside_base_path() {
        assert!(preview_resource_path_within_base("reports/run1", "reports/shared/plot.js").is_none());
        assert!(preview_resource_path_within_base("reports/run1", "reports/run10/plot.js").is_none());
        assert!(preview_resource_path_within_base("reports/run1", "reports/run1").is_none());
    }

    #[tokio::test]
    async fn preview_byte_reservation_rejects_projected_over_budget() {
        let state = AppState::new(&test_config(), true);
        let token = "preview-token".to_string();
        let now = std::time::Instant::now();
        let preview = PreviewSession {
            session_id: "session".to_string(),
            agent_id: "agent".to_string(),
            root: "root".to_string(),
            base_path: "".to_string(),
            created_at: now,
            expires_at: now + std::time::Duration::from_secs(60),
            requests_served: 0,
            bytes_served: PREVIEW_SESSION_MAX_BYTES - 1,
        };
        let preview_sessions = state.inner.read().await.preview_sessions.clone();
        preview_sessions.write().await.insert(token.clone(), preview);

        assert!(reserve_preview_bytes(&state, &token, 1).await.is_ok());
        assert!(reserve_preview_bytes(&state, &token, 1).await.is_err());
    }

    // ── file_raw_handler multi-chunk loop ───────────────────────────────────
    //
    // Mock-agent harness: spin up a tokio task that consumes FileReadRequest
    // from the channel and injects matching FileChunk values through
    // pending_responses, mirroring ws.rs:341-355. Lets us test the
    // accumulate-until-done loop without a real WebSocket.

    fn test_config() -> crate::config::HubConfig {
        crate::config::HubConfig {
            listen_addr: "127.0.0.1:0".parse().unwrap(),
            agent_token_hash: "fake-hash".to_string(),
            users: vec![],
        }
    }

    /// Spawn a mock agent that simulates `file_total` bytes delivered in
    /// `chunk_cap`-sized frames. Returns the agent's sender (for the
    /// registry) and the join handle (so the test can await/cleanup).
    fn spawn_mock_file_agent(
        state: AppState,
        agent_id: &str,
        file_total: u64,
        chunk_cap: u64,
    ) -> (mpsc::UnboundedSender<HubMessage>, tokio::task::JoinHandle<()>) {
        let (tx, mut rx) = mpsc::unbounded_channel::<HubMessage>();
        let agent_id_owned = agent_id.to_string();
        let handle = tokio::spawn(async move {
            while let Some(msg) = rx.recv().await {
                let HubMessage::FileReadRequest { req_id, offset, length, .. } = msg else {
                    continue;
                };
                let remaining = file_total.saturating_sub(offset);
                let to_read = length
                    .unwrap_or(chunk_cap)
                    .min(chunk_cap)
                    .min(remaining);
                let data = vec![0xABu8; to_read as usize];
                let done = offset + to_read >= file_total;
                let chunk = AgentMessage::FileChunk {
                    req_id: req_id.clone(),
                    offset,
                    data,
                    done,
                    error: None,
                };
                let value = serde_json::to_value(&chunk).unwrap();
                let pending_arc = state.inner.read().await.pending_responses.clone();
                let mut pending = pending_arc.write().await;
                if let Some(p) = pending.remove(&req_id) {
                    let _ = p.tx.send(value).await;
                }
                if done {
                    break;
                }
            }
            let _ = agent_id_owned; // silence unused warning
        });
        (tx, handle)
    }

    async fn register_mock_agent(state: &AppState, agent_id: &str, tx: mpsc::UnboundedSender<HubMessage>) {
        let mut inner = state.inner.write().await;
        inner.agents.register(
            agent_id.to_string(),
            "MockAgent".to_string(),
            tx,
            Arc::new(Notify::new()),
            0,
            vec![],
            0,
            vec![],
            Capabilities::default(),
        );
    }

    fn build_raw_request(range: Option<&str>) -> axum::extract::Request {
        let mut builder = axum::http::Request::builder()
            .method("GET")
            .uri("http://test/api/file/raw");
        if let Some(r) = range {
            builder = builder.header("range", r);
        }
        builder.body(axum::body::Body::empty()).unwrap()
    }

    fn test_session() -> Extension<AuthenticatedSession> {
        Extension(AuthenticatedSession {
            id: "test-session".to_string(),
            principal_id: "test-principal".to_string(),
        })
    }

    #[tokio::test]
    async fn file_raw_handler_accumulates_multi_chunk_responses() {
        // 5MB file with 4MB agent-side cap → must produce 2 chunks
        // (4MB + 1MB) that the handler should coalesce into one body.
        let state = AppState::new(&test_config(), true);
        let file_total: u64 = 5 * 1024 * 1024;
        let (tx, agent_handle) =
            spawn_mock_file_agent(state.clone(), "a1", file_total, 4 * 1024 * 1024);
        register_mock_agent(&state, "a1", tx).await;

        let params = FileRawParams {
            agent_id: "a1".to_string(),
            root: "test".to_string(),
            path: "big.bin".to_string(),
        };
        let response = file_raw_handler(
            State(state.clone()),
            test_session(),
            Query(params),
            build_raw_request(None),
        )
        .await;

        assert_eq!(response.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(response.into_body(), 10 * 1024 * 1024)
            .await
            .unwrap();
        assert_eq!(bytes.len(), file_total as usize);
        // All bytes came from our mock (0xAB filler).
        assert!(bytes.iter().all(|&b| b == 0xAB));

        agent_handle.abort();
    }

    #[tokio::test]
    async fn file_raw_handler_honors_range_header() {
        // 1MB file but request only 10 bytes via Range — single chunk,
        // handler should truncate and return PARTIAL_CONTENT.
        let state = AppState::new(&test_config(), true);
        let (tx, agent_handle) =
            spawn_mock_file_agent(state.clone(), "a1", 1024 * 1024, 4 * 1024 * 1024);
        register_mock_agent(&state, "a1", tx).await;

        let params = FileRawParams {
            agent_id: "a1".to_string(),
            root: "test".to_string(),
            path: "r.bin".to_string(),
        };
        let response = file_raw_handler(
            State(state.clone()),
            test_session(),
            Query(params),
            build_raw_request(Some("bytes=0-9")),
        )
        .await;

        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        let content_range = response
            .headers()
            .get(header::CONTENT_RANGE)
            .unwrap()
            .to_str()
            .unwrap()
            .to_string();
        assert!(content_range.starts_with("bytes 0-9/"), "got: {}", content_range);
        let bytes = axum::body::to_bytes(response.into_body(), 1024)
            .await
            .unwrap();
        assert_eq!(bytes.len(), 10);

        agent_handle.abort();
    }

    #[tokio::test]
    async fn file_raw_handler_serves_active_content_as_attachment_with_csp() {
        let state = AppState::new(&test_config(), true);
        let (tx, agent_handle) =
            spawn_mock_file_agent(state.clone(), "a1", 128, 4 * 1024 * 1024);
        register_mock_agent(&state, "a1", tx).await;

        let params = FileRawParams {
            agent_id: "a1".to_string(),
            root: "test".to_string(),
            path: "report.html".to_string(),
        };
        let response = file_raw_handler(
            State(state.clone()),
            test_session(),
            Query(params),
            build_raw_request(None),
        )
        .await;

        assert_eq!(response.status(), StatusCode::OK);
        let disposition = response
            .headers()
            .get(header::CONTENT_DISPOSITION)
            .unwrap()
            .to_str()
            .unwrap();
        assert!(disposition.starts_with("attachment;"), "got: {}", disposition);
        let csp = response
            .headers()
            .get(header::CONTENT_SECURITY_POLICY)
            .unwrap()
            .to_str()
            .unwrap();
        assert!(csp.contains("sandbox"), "got: {}", csp);

        agent_handle.abort();
    }

    #[tokio::test]
    async fn file_raw_handler_returns_416_for_empty_range_body() {
        let state = AppState::new(&test_config(), true);
        let (tx, agent_handle) =
            spawn_mock_file_agent(state.clone(), "a1", 2, 4 * 1024 * 1024);
        register_mock_agent(&state, "a1", tx).await;

        let params = FileRawParams {
            agent_id: "a1".to_string(),
            root: "test".to_string(),
            path: "tiny.bin".to_string(),
        };
        let response = file_raw_handler(
            State(state.clone()),
            test_session(),
            Query(params),
            build_raw_request(Some("bytes=10-20")),
        )
        .await;

        assert_eq!(response.status(), StatusCode::RANGE_NOT_SATISFIABLE);

        agent_handle.abort();
    }

    #[tokio::test]
    async fn file_raw_handler_returns_413_when_exceeding_hub_max() {
        // File larger than HUB_FILE_MAX (256MB) must fail with 413 instead
        // of silently truncating. Mock claims a 300MB file and would happily
        // emit chunks forever; the handler must bail on the first chunk that
        // would push accumulated past the cap.
        let state = AppState::new(&test_config(), true);
        let file_total: u64 = (HUB_FILE_MAX as u64) + 1024 * 1024;
        let (tx, agent_handle) =
            spawn_mock_file_agent(state.clone(), "a1", file_total, 4 * 1024 * 1024);
        register_mock_agent(&state, "a1", tx).await;

        let params = FileRawParams {
            agent_id: "a1".to_string(),
            root: "test".to_string(),
            path: "huge.bin".to_string(),
        };
        let response = file_raw_handler(
            State(state.clone()),
            test_session(),
            Query(params),
            build_raw_request(None),
        )
        .await;

        assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
        // Body is the JSON error envelope, not image bytes.
        let bytes = axum::body::to_bytes(response.into_body(), 4096)
            .await
            .unwrap();
        let body = String::from_utf8(bytes.to_vec()).unwrap();
        assert!(body.contains("file_too_large"), "body: {}", body);

        agent_handle.abort();
    }

    #[tokio::test]
    async fn file_raw_handler_breaks_on_empty_chunk_without_done() {
        // Dead-loop defense: if agent returns empty data + done=false, the
        // handler must stop instead of infinitely re-requesting.
        let state = AppState::new(&test_config(), true);
        let (tx, mut rx) = mpsc::unbounded_channel::<HubMessage>();
        let state_for_agent = state.clone();
        let agent_handle = tokio::spawn(async move {
            // Reply once with an empty non-terminal chunk, then stop
            // responding. The handler should break, not spin.
            if let Some(msg) = rx.recv().await {
                if let HubMessage::FileReadRequest { req_id, offset, .. } = msg {
                    let chunk = AgentMessage::FileChunk {
                        req_id: req_id.clone(),
                        offset,
                        data: vec![],
                        done: false,
                        error: None,
                    };
                    let value = serde_json::to_value(&chunk).unwrap();
                    let pending_arc = state_for_agent.inner.read().await.pending_responses.clone();
                    let mut pending = pending_arc.write().await;
                    if let Some(p) = pending.remove(&req_id) {
                        let _ = p.tx.send(value).await;
                    }
                }
            }
        });
        register_mock_agent(&state, "a1", tx).await;

        let params = FileRawParams {
            agent_id: "a1".to_string(),
            root: "test".to_string(),
            path: "weird.bin".to_string(),
        };
        let response = file_raw_handler(
            State(state.clone()),
            test_session(),
            Query(params),
            build_raw_request(None),
        )
        .await;

        assert_eq!(response.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(response.into_body(), 1024)
            .await
            .unwrap();
        assert!(bytes.is_empty(), "expected empty body after dead-loop break");

        agent_handle.abort();
    }
}
