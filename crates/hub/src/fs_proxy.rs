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
    let send_ok = {
        let mut pending = inner.pending_responses.write().await;
        pending.insert(req_id.clone(), PendingResponse {
            tx: resp_tx,
            agent_id: params.agent_id.clone(),
            session_id: Some(session.principal_id.clone()),
            desired_roots: None,
            desired_collections: None,
        });
        inner.agents.send_to_agent(&params.agent_id, msg)
    };

    drop(inner);
    if !send_ok {
        cleanup_pending(&state, &req_id).await;
        return error_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "backend_offline",
            "Failed to send request to agent",
            true,
        );
    }

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
    let send_ok = {
        let mut pending = inner.pending_responses.write().await;
        pending.insert(req_id.clone(), PendingResponse {
            tx: resp_tx,
            agent_id: params.agent_id.clone(),
            session_id: Some(session.principal_id.clone()),
            desired_roots: None,
            desired_collections: None,
        });
        inner.agents.send_to_agent(&params.agent_id, msg)
    };

    drop(inner);
    if !send_ok {
        cleanup_pending(&state, &req_id).await;
        return error_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "backend_offline",
            "Failed to send request to agent",
            true,
        );
    }

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

struct RawFileTarget {
    agent_id: String,
    root: String,
    path: String,
    session_id: Option<String>,
    preview_token: Option<String>,
}

const RAW_STREAM_CHUNK_BYTES: u64 = 2 * 1024 * 1024;

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
    let raw_permit = match tokio::time::timeout(
        Duration::from_secs(30),
        state.raw_read_semaphore.clone().acquire_owned(),
    )
    .await
    {
        Ok(Ok(permit)) => permit,
        _ => {
            return error_response(
                StatusCode::SERVICE_UNAVAILABLE,
                "hub_overloaded",
                "The server is busy streaming files. Please retry shortly.",
                true,
            );
        }
    };
    let file_size = match request_raw_file_size(&state, &target).await {
        Ok(size) => size,
        Err(resp) => return resp,
    };
    let range = match resolve_byte_range(req.headers().get(header::RANGE), file_size) {
        Ok(range) => range,
        Err(()) => {
            return Response::builder()
                .status(StatusCode::RANGE_NOT_SATISFIABLE)
                .header(header::CONTENT_RANGE, format!("bytes */{}", file_size))
                .header(header::ACCEPT_RANGES, "bytes")
                .body(axum::body::Body::empty())
                .unwrap()
                .into_response();
        }
    };
    let (offset_start, body_len) = range.unwrap_or((0, file_size));
    let file_path = target.path.clone();
    let content_type = guess_content_type(&file_path);
    let disposition = if is_inline_type(content_type) { "inline" } else { "attachment" };
    let filename = file_path.rsplit('/').next().unwrap_or("file");
    // Sanitize filename: remove chars that could break Content-Disposition header
    let safe_filename: String = filename.chars().filter(|c| *c != '"' && *c != '\\' && *c != '\n' && *c != '\r').collect();
    let is_partial = range.is_some();
    let is_head = req.method() == axum::http::Method::HEAD;
    let stream_state = state.clone();
    let stream = async_stream::stream! {
        let _raw_permit = raw_permit;
        let mut sent = 0u64;
        while sent < body_len {
            let remaining = body_len - sent;
            match request_raw_chunk(
                &stream_state,
                &target,
                offset_start + sent,
                remaining.min(RAW_STREAM_CHUNK_BYTES),
            )
            .await
            {
                Ok((chunk, done)) => {
                    if chunk.is_empty() {
                        if !done {
                            tracing::warn!("file_raw_handler: agent returned an empty non-terminal chunk");
                        }
                        break;
                    }
                    let allowed = std::cmp::min(chunk.len() as u64, remaining) as usize;
                    let chunk = if allowed == chunk.len() {
                        chunk
                    } else {
                        chunk[..allowed].to_vec()
                    };
                    if let Some(token) = target.preview_token.as_deref() {
                        if reserve_preview_bytes(&stream_state, token, chunk.len() as u64).await.is_err() {
                            yield Err::<axum::body::Bytes, std::io::Error>(
                                std::io::Error::new(
                                    std::io::ErrorKind::Other,
                                    "HTML preview byte budget exceeded",
                                ),
                            );
                            return;
                        }
                    }
                    sent = sent.saturating_add(chunk.len() as u64);
                    yield Ok::<axum::body::Bytes, std::io::Error>(
                        axum::body::Bytes::from(chunk),
                    );
                    if done {
                        break;
                    }
                }
                Err(err) => {
                    tracing::warn!("file_raw_handler stream failed: {}", err);
                    yield Err::<axum::body::Bytes, std::io::Error>(
                        std::io::Error::new(std::io::ErrorKind::Other, err),
                    );
                    return;
                }
            }
        }
    };
    let body = if is_head {
        axum::body::Body::empty()
    } else {
        axum::body::Body::from_stream(stream)
    };
    let mut builder = Response::builder()
        .status(if is_partial {
            StatusCode::PARTIAL_CONTENT
        } else {
            StatusCode::OK
        })
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CONTENT_LENGTH, body_len)
        .header(header::ACCEPT_RANGES, "bytes")
        .header(
            header::CONTENT_DISPOSITION,
            format!("{}; filename=\"{}\"", disposition, safe_filename),
        );
    if is_partial {
        let end = offset_start.saturating_add(body_len).saturating_sub(1);
        builder = builder.header(
            header::CONTENT_RANGE,
            format!("bytes {}-{}/{}", offset_start, end, file_size),
        );
    }
    let mut resp = builder.body(body).unwrap();
    apply_raw_file_headers(&mut resp, content_type);
    resp.into_response()
}

async fn request_raw_file_size(
    state: &AppState,
    target: &RawFileTarget,
) -> Result<u64, Response> {
    let req_id = format!("file_stat_{}", Uuid::new_v4());
    let value = request_raw_agent(
        state,
        target,
        req_id.clone(),
        HubMessage::FsStatRequest {
            req_id,
            root: target.root.clone(),
            path: target.path.clone(),
        },
        Duration::from_secs(30),
    )
    .await
    .map_err(|message| {
        tracing::warn!("raw file stat request failed: {}", message);
        error_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "file_stat_error",
            "Could not check the file before streaming",
            true,
        )
    })?;
    if let Some(err) = value["error"].as_str() {
        tracing::warn!("Agent rejected raw file stat: {}", err);
        if err.starts_with("agent_overloaded") {
            return Err(error_response(
                StatusCode::SERVICE_UNAVAILABLE,
                "agent_overloaded",
                "The agent is busy with file requests. Please retry shortly.",
                true,
            ));
        }
        return Err(error_response(
            StatusCode::BAD_REQUEST,
            "file_unavailable",
            "The file is unavailable or cannot be accessed",
            false,
        ));
    }
    if value["stat"]["denied"].as_bool().unwrap_or(false) {
        return Err(error_response(
            StatusCode::FORBIDDEN,
            "path_denied",
            "Access denied",
            false,
        ));
    }
    if value["stat"]["entry_type"].as_str() != Some("file") {
        return Err(error_response(
            StatusCode::BAD_REQUEST,
            "file_unavailable",
            "The selected path is not a readable file",
            false,
        ));
    }
    value["stat"]["size"].as_u64().ok_or_else(|| {
        error_response(
            StatusCode::BAD_GATEWAY,
            "file_stat_error",
            "Agent returned an invalid file size",
            true,
        )
    })
}

async fn request_raw_chunk(
    state: &AppState,
    target: &RawFileTarget,
    offset: u64,
    length: u64,
) -> Result<(Vec<u8>, bool), String> {
    let req_id = format!("file_{}", Uuid::new_v4());
    let value = request_raw_agent(
        state,
        target,
        req_id.clone(),
        HubMessage::FileReadRequest {
            req_id,
            root: target.root.clone(),
            path: target.path.clone(),
            offset,
            length: Some(length),
        },
        Duration::from_secs(60),
    )
    .await?;
    if let Some(err) = value["error"].as_str() {
        return Err(err.to_string());
    }
    let returned_offset = value["offset"]
        .as_u64()
        .ok_or_else(|| "Agent returned an invalid file chunk offset".to_string())?;
    if returned_offset != offset {
        return Err("Agent returned a mismatched file chunk offset".to_string());
    }
    Ok((
        decode_file_chunk_data(&value["data"])?,
        value["done"].as_bool().unwrap_or(true),
    ))
}

async fn request_raw_agent(
    state: &AppState,
    target: &RawFileTarget,
    req_id: String,
    message: HubMessage,
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    let (resp_tx, mut resp_rx) = mpsc::channel(1);
    let send_ok = {
        let inner = state.inner.read().await;
        let Some(agent) = inner.agents.get(&target.agent_id) else {
            return Err("Agent not found or offline".to_string());
        };
        if agent.status == crate::agent_registry::AgentStatus::Offline {
            return Err("Agent is offline".to_string());
        }
        let mut pending = inner.pending_responses.write().await;
        pending.insert(
            req_id.clone(),
            PendingResponse {
                tx: resp_tx,
                agent_id: target.agent_id.clone(),
                session_id: target.session_id.clone(),
                desired_roots: None,
                desired_collections: None,
            },
        );
        drop(pending);
        inner.agents.send_to_agent(&target.agent_id, message)
    };
    if !send_ok {
        cleanup_pending(state, &req_id).await;
        return Err("Failed to send request to agent".to_string());
    }
    let cleanup = PendingRawCleanup {
        state: state.clone(),
        req_id: req_id.clone(),
        active: true,
    };
    let response = tokio::time::timeout(timeout, resp_rx.recv()).await;
    cleanup.finish().await;
    match response {
        Ok(Some(value)) => Ok(value),
        _ => Err("Agent did not respond in time".to_string()),
    }
}

struct PendingRawCleanup {
    state: AppState,
    req_id: String,
    active: bool,
}

impl PendingRawCleanup {
    async fn finish(mut self) {
        cleanup_pending(&self.state, &self.req_id).await;
        self.active = false;
    }
}

impl Drop for PendingRawCleanup {
    fn drop(&mut self) {
        if !self.active {
            return;
        }
        let state = self.state.clone();
        let req_id = self.req_id.clone();
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn(async move {
                cleanup_pending(&state, &req_id).await;
            });
        }
    }
}

fn resolve_byte_range(
    header_value: Option<&HeaderValue>,
    file_size: u64,
) -> Result<Option<(u64, u64)>, ()> {
    let Some(raw) = header_value
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
    else {
        return Ok(None);
    };
    let Some((unit, spec)) = raw.split_once('=') else {
        return Ok(None);
    };
    if !unit.eq_ignore_ascii_case("bytes") || spec.contains(',') {
        return Ok(None);
    }
    let Some((start_raw, end_raw)) = spec.trim().split_once('-') else {
        return Ok(None);
    };
    if file_size == 0 {
        return Err(());
    }
    if start_raw.is_empty() {
        let suffix = end_raw.parse::<u64>().map_err(|_| ())?;
        if suffix == 0 {
            return Err(());
        }
        let length = suffix.min(file_size);
        return Ok(Some((file_size - length, length)));
    }
    let start = start_raw.parse::<u64>().map_err(|_| ())?;
    if start >= file_size {
        return Err(());
    }
    let end = if end_raw.is_empty() {
        file_size - 1
    } else {
        end_raw.parse::<u64>().map_err(|_| ())?.min(file_size - 1)
    };
    if end < start {
        return Err(());
    }
    Ok(Some((start, end - start + 1)))
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
    preview.bytes_served = preview.bytes_served.saturating_add(bytes);
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
    let send_ok = {
        let mut pending = inner.pending_responses.write().await;
        pending.insert(req_id.clone(), PendingResponse {
            tx: resp_tx,
            agent_id: agent_id.clone(),
            session_id: Some(session.principal_id.clone()),
            desired_roots: None,
            desired_collections: None,
        });
        inner.agents.send_to_agent(&agent_id, msg)
    };

    drop(inner);
    if !send_ok {
        cleanup_pending(&state, &req_id).await;
        return error_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "backend_offline",
            "Failed to send request to agent",
            true,
        );
    }

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
    use filebox_protocol::resources::{Capabilities, FileStat, FsEntryType};
    use std::sync::Arc;
    use tokio::sync::Notify;
    use tokio::task::JoinSet;

    fn hv(val: &str) -> HeaderValue {
        HeaderValue::from_str(val).unwrap()
    }

    // ── resolve_byte_range ───────────────────────────────────────────────────

    #[test]
    fn resolve_range_none_returns_full_response() {
        assert_eq!(resolve_byte_range(None, 1_000), Ok(None));
    }

    #[test]
    fn resolve_range_start_only_uses_real_file_size() {
        let h = hv("bytes=100-");
        assert_eq!(resolve_byte_range(Some(&h), 1_000), Ok(Some((100, 900))));
    }

    #[test]
    fn resolve_range_start_end_is_inclusive() {
        let h = hv("bytes=0-99");
        assert_eq!(resolve_byte_range(Some(&h), 1_000), Ok(Some((0, 100))));
    }

    #[test]
    fn resolve_range_clamps_end_to_real_file_size() {
        let h = hv("bytes=900-2000");
        assert_eq!(resolve_byte_range(Some(&h), 1_000), Ok(Some((900, 100))));
    }

    #[test]
    fn resolve_range_supports_suffix() {
        let h = hv("bytes=-500");
        assert_eq!(resolve_byte_range(Some(&h), 1_000), Ok(Some((500, 500))));
    }

    #[test]
    fn resolve_range_suffix_larger_than_file_returns_whole_file() {
        let h = hv("bytes=-2000");
        assert_eq!(resolve_byte_range(Some(&h), 1_000), Ok(Some((0, 1_000))));
    }

    #[test]
    fn resolve_range_accepts_case_insensitive_unit() {
        let h = hv("BYTES=100-199");
        assert_eq!(resolve_byte_range(Some(&h), 1_000), Ok(Some((100, 100))));
    }

    #[test]
    fn resolve_range_ignores_unknown_or_multi_range_units() {
        let other = hv("items=0-100");
        let multi = hv("bytes=0-99,200-299");
        assert_eq!(resolve_byte_range(Some(&other), 1_000), Ok(None));
        assert_eq!(resolve_byte_range(Some(&multi), 1_000), Ok(None));
    }

    #[test]
    fn resolve_range_rejects_unsatisfiable_or_malformed_ranges() {
        for raw in [
            "bytes=1000-",
            "bytes=20-10",
            "bytes=-0",
            "bytes=abc-",
            "bytes=0-xyz",
            "bytes=1-2-3",
        ] {
            let h = hv(raw);
            assert_eq!(resolve_byte_range(Some(&h), 1_000), Err(()), "{raw}");
        }
    }

    #[test]
    fn resolve_range_handles_extra_whitespace() {
        let h = hv("  bytes=10-20  ");
        assert_eq!(resolve_byte_range(Some(&h), 1_000), Ok(Some((10, 11))));
    }

    #[test]
    fn resolve_range_invalid_header_value_is_ignored() {
        let bad = HeaderValue::from_bytes(b"bytes=\xff-").unwrap();
        assert_eq!(resolve_byte_range(Some(&bad), 1_000), Ok(None));
    }

    #[test]
    fn resolve_range_rejects_any_range_for_empty_file() {
        let h = hv("bytes=0-");
        assert_eq!(resolve_byte_range(Some(&h), 0), Err(()));
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
    async fn preview_byte_accounting_does_not_block_large_html_documents() {
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
            bytes_served: u64::MAX - 1,
        };
        let preview_sessions = state.inner.read().await.preview_sessions.clone();
        preview_sessions.write().await.insert(token.clone(), preview);

        assert!(reserve_preview_bytes(&state, &token, 1).await.is_ok());
        assert!(reserve_preview_bytes(&state, &token, 1).await.is_ok());
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
                if let HubMessage::FsStatRequest { req_id, path, .. } = msg {
                    let stat = AgentMessage::FsStatResponse {
                        req_id: req_id.clone(),
                        stat: Some(FileStat {
                            path,
                            entry_type: FsEntryType::File,
                            size: file_total,
                            modified: None,
                            permissions: None,
                            denied: false,
                        }),
                        error: None,
                    };
                    let value = serde_json::to_value(&stat).unwrap();
                    let pending_arc = state.inner.read().await.pending_responses.clone();
                    let mut pending = pending_arc.write().await;
                    if let Some(p) = pending.remove(&req_id) {
                        let _ = p.tx.send(value).await;
                    }
                    continue;
                }
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
        assert_eq!(content_range, "bytes 0-9/1048576");
        let bytes = axum::body::to_bytes(response.into_body(), 1024)
            .await
            .unwrap();
        assert_eq!(bytes.len(), 10);

        agent_handle.abort();
    }

    #[tokio::test]
    async fn seventy_concurrent_pdf_ranges_stream_without_activity_quota() {
        let state = AppState::new(&test_config(), true);
        let (tx, agent_handle) =
            spawn_mock_file_agent(state.clone(), "a1", 1024 * 1024, 4 * 1024 * 1024);
        register_mock_agent(&state, "a1", tx).await;
        let mut requests = JoinSet::new();

        for index in 0..70 {
            let state = state.clone();
            requests.spawn(async move {
                let response = file_raw_handler(
                    State(state),
                    test_session(),
                    Query(FileRawParams {
                        agent_id: "a1".to_string(),
                        root: "test".to_string(),
                        path: format!("document-{index}.pdf"),
                    }),
                    build_raw_request(Some("bytes=0-1023")),
                )
                .await;
                assert_eq!(
                    response.status(),
                    StatusCode::PARTIAL_CONTENT,
                    "PDF {index} should obtain a Range response"
                );
                let bytes = axum::body::to_bytes(response.into_body(), 2048)
                    .await
                    .unwrap();
                assert_eq!(bytes.len(), 1024);
            });
        }

        while let Some(result) = requests.join_next().await {
            result.unwrap();
        }
        assert_eq!(
            state.raw_read_semaphore.available_permits(),
            96,
            "all raw-stream permits must be released after the responses finish"
        );
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
    async fn file_raw_handler_accepts_files_larger_than_old_buffer_cap() {
        // Large files are streamed; their total size is no longer a Hub
        // allocation and must not be rejected by the old 256 MiB buffer cap.
        let state = AppState::new(&test_config(), true);
        let file_total: u64 = 257 * 1024 * 1024;
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

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response
                .headers()
                .get(header::CONTENT_LENGTH)
                .unwrap()
                .to_str()
                .unwrap(),
            file_total.to_string()
        );
        assert_eq!(response.headers().get(header::ACCEPT_RANGES).unwrap(), "bytes");

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
            // First answer the mandatory stat, then reply once with an empty
            // non-terminal chunk. The stream should stop, not spin.
            if let Some(HubMessage::FsStatRequest { req_id, path, .. }) = rx.recv().await {
                let stat = AgentMessage::FsStatResponse {
                    req_id: req_id.clone(),
                    stat: Some(FileStat {
                        path,
                        entry_type: FsEntryType::File,
                        size: 100,
                        modified: None,
                        permissions: None,
                        denied: false,
                    }),
                    error: None,
                };
                let value = serde_json::to_value(&stat).unwrap();
                let pending_arc = state_for_agent.inner.read().await.pending_responses.clone();
                let mut pending = pending_arc.write().await;
                if let Some(p) = pending.remove(&req_id) {
                    let _ = p.tx.send(value).await;
                }
            }
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
