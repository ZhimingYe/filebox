use std::time::Duration;

use axum::extract::{Extension, Path, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
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
    MAX_PENDING_RESPONSES,
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
        if pending.len() >= MAX_PENDING_RESPONSES {
            false
        } else {
            pending.insert(req_id.clone(), PendingResponse {
                tx: resp_tx,
                agent_id: params.agent_id.clone(),
                connection_id: agent.connection_id,
                session_id: Some(session.principal_id.clone()),
                desired_roots: None,
                desired_collections: None,
            });
            inner.agents.send_to_agent(&params.agent_id, msg)
        }
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

    let cleanup = PendingResponseCleanup {
        state: state.clone(),
        req_id: req_id.clone(),
        cancel_agent_id: Some(params.agent_id.clone()),
        active: true,
    };
    let resp = tokio::time::timeout(Duration::from_secs(30), resp_rx.recv()).await;
    let cancelled = !matches!(resp, Ok(Some(_)));
    cleanup.finish(cancelled).await;

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
        if pending.len() >= MAX_PENDING_RESPONSES {
            false
        } else {
            pending.insert(req_id.clone(), PendingResponse {
                tx: resp_tx,
                agent_id: params.agent_id.clone(),
                connection_id: agent.connection_id,
                session_id: Some(session.principal_id.clone()),
                desired_roots: None,
                desired_collections: None,
            });
            inner.agents.send_to_agent(&params.agent_id, msg)
        }
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

    let cleanup = PendingResponseCleanup {
        state: state.clone(),
        req_id: req_id.clone(),
        cancel_agent_id: Some(params.agent_id.clone()),
        active: true,
    };
    let resp = tokio::time::timeout(Duration::from_secs(30), resp_rx.recv()).await;
    let cancelled = !matches!(resp, Ok(Some(_)));
    cleanup.finish(cancelled).await;

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

#[derive(Clone)]
struct RawFileTarget {
    agent_id: String,
    root: String,
    path: String,
    session_id: Option<String>,
    preview_token: Option<String>,
}

/// Everything needed to start a raw response body once the file size is
/// known: where the body starts, how long it is, and the first chunk when
/// the no-stat path already fetched it (it enters the producer loop as the
/// first item instead of a fresh request).
struct RawBodyStart {
    file_size: u64,
    initial_modified: Option<String>,
    offset_start: u64,
    body_len: u64,
    is_partial: bool,
    first_chunk: Option<(Vec<u8>, bool)>,
}

/// Bytes requested per Agent round-trip while proxying a raw/preview stream.
/// Matches [`filebox_protocol::message::FILE_CHUNK_MAX_BYTES`] so hub asks and
/// agent clamps stay aligned on slow or jittery links.
const RAW_STREAM_CHUNK_BYTES: u64 = filebox_protocol::message::FILE_CHUNK_MAX_BYTES;

/// Pause between raw-chunk retries while waiting for a flaky agent to recover.
const RAW_CHUNK_RETRY_DELAY: Duration = Duration::from_millis(500);

/// Total wall-clock budget for retrying one raw chunk at the same offset.
const RAW_CHUNK_RETRY_BUDGET: Duration = Duration::from_secs(90);
const RAW_CHUNK_REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
/// A bounded body queue prevents a client that stopped reading from retaining
/// a raw-stream permit forever. The producer fails the body if the consumer
/// does not accept the next item within this interval.
const RAW_DOWNSTREAM_SEND_TIMEOUT: Duration = Duration::from_secs(30);

fn is_raw_chunk_retryable(err: &str) -> bool {
    matches!(
        err,
        "Agent not found or offline"
            | "Agent is offline"
            | "Failed to send request to agent"
            | "Agent did not respond in time"
            | "backend_offline"
            | "Hub pending request limit reached"
    ) || err.starts_with("agent_overloaded")
}

/// Common mapping for an agent refusal on a raw-file request: transport /
/// overload → retryable 503, denied → 403, anything else → 400.
/// (The upfront-stat path additionally checks structured `retryable` flags
/// from the agent's stat response before falling through to this.)
fn raw_file_refusal_response(err: &str) -> Response {
    tracing::warn!("raw file request refused: {}", err);
    if is_raw_chunk_retryable(err) {
        return error_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "backend_offline",
            "Could not read the file",
            true,
        );
    }
    if err.contains("denied") {
        return error_response(
            StatusCode::FORBIDDEN,
            "path_denied",
            "Access denied",
            false,
        );
    }
    error_response(
        StatusCode::BAD_REQUEST,
        "file_unavailable",
        "The file is unavailable or cannot be accessed",
        false,
    )
}

async fn send_raw_body_item(
    tx: &mpsc::Sender<Result<axum::body::Bytes, std::io::Error>>,
    item: Result<axum::body::Bytes, std::io::Error>,
) -> bool {
    matches!(
        tokio::time::timeout(RAW_DOWNSTREAM_SEND_TIMEOUT, tx.send(item)).await,
        Ok(Ok(()))
    )
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

    // Document mode: a navigation request for an HTML file gets the injected
    // document (absolute <base> + CSP meta + anchor fixup), so relative links
    // and #fragment links resolve through this same tokenized route and work
    // inside the sandboxed iframe. Everything else — subresources, HEAD, XHR —
    // stays in raw resource mode.
    let document_base_url = format!(
        "{}{}",
        preview.absolute_base_url,
        crate::preview_doc::preview_base_url(&token, &preview.base_path)
    );
    let is_document_mode =
        is_preview_document_request(req.method(), req.headers(), &path);

    let target = RawFileTarget {
        agent_id: preview.agent_id.clone(),
        root: preview.root.clone(),
        path,
        session_id: Some(preview.session_id.clone()),
        preview_token: Some(token.clone()),
    };
    let mut resp = if is_document_mode {
        serve_preview_document(state.clone(), target, document_base_url).await
    } else {
        serve_raw_file(state.clone(), target, req).await
    };

    // Document-mode successes already carry their own headers; errors keep
    // the standard preview error headers.
    if !is_document_mode || resp.status() != StatusCode::OK {
        apply_preview_headers(&mut resp);
    }
    resp
}

/// Document-mode decision: a GET navigation request for an HTML file.
/// The `Sec-Fetch-Mode` header makes it opt-in — plain GETs (curl, scripts,
/// link prefetches without the header) stay in raw resource mode.
fn is_preview_document_request(
    method: &axum::http::Method,
    headers: &HeaderMap,
    path: &str,
) -> bool {
    method == axum::http::Method::GET
        && sec_fetch_mode_is_document_navigation(headers)
        && crate::preview_doc::is_html_path(path)
}

/// True when the request is a top-level or iframe navigation (browsers send
/// `Sec-Fetch-Mode: navigate` / `nested-navigate` for those).
fn sec_fetch_mode_is_document_navigation(headers: &HeaderMap) -> bool {
    headers
        .get("sec-fetch-mode")
        .and_then(|v| v.to_str().ok())
        .map(|v| {
            v.eq_ignore_ascii_case("navigate") || v.eq_ignore_ascii_case("nested-navigate")
        })
        .unwrap_or(false)
}

pub async fn preview_options_handler() -> Response {
    let mut resp = Response::builder()
        .status(StatusCode::NO_CONTENT)
        .body(axum::body::Body::empty())
        .unwrap();
    apply_preview_headers(&mut resp);
    resp
}

/// Per-chunk failure shared by the streaming raw producer ([`serve_raw_file`])
/// and the buffered document-mode collector ([`collect_raw_file`]).
enum RawChunkFailure {
    FileChanged,
    EmptyChunk,
    OverlongChunk,
}

impl RawChunkFailure {
    fn to_io_error(&self) -> std::io::Error {
        let (kind, message) = match self {
            RawChunkFailure::FileChanged => (
                std::io::ErrorKind::InvalidData,
                "File changed while it was being streamed",
            ),
            RawChunkFailure::EmptyChunk => (
                std::io::ErrorKind::UnexpectedEof,
                "Agent returned an empty raw file chunk",
            ),
            RawChunkFailure::OverlongChunk => (
                std::io::ErrorKind::InvalidData,
                "Agent returned more bytes than requested",
            ),
        };
        std::io::Error::new(kind, message)
    }
}

/// Validates one chunk against the advertised file size / modification and
/// the bytes still expected, so both consumers share one set of rules
/// instead of two copies that drift apart. Does not cover the (async,
/// preview-only) byte budget accounting or the `done`-before-size check,
/// which each caller applies at its own point in the loop.
fn check_raw_chunk(
    chunk: &[u8],
    file_size: u64,
    remaining: u64,
    chunk_file_size: Option<u64>,
    chunk_modified: Option<String>,
    expected_modified: &Option<String>,
) -> Result<(), RawChunkFailure> {
    if let Some(chunk_file_size) = chunk_file_size {
        if chunk_file_size != file_size {
            return Err(RawChunkFailure::FileChanged);
        }
    }
    if expected_modified.is_some() && chunk_modified != *expected_modified {
        return Err(RawChunkFailure::FileChanged);
    }
    if chunk.is_empty() {
        return Err(RawChunkFailure::EmptyChunk);
    }
    if chunk.len() as u64 > remaining {
        return Err(RawChunkFailure::OverlongChunk);
    }
    Ok(())
}

/// Cache-control for regular `/api/file/raw` responses: the browser may
/// store the body but must revalidate (If-None-Match) before every reuse —
/// a repeat preview of an unchanged file costs one stat round trip instead
/// of a full re-transfer over a slow agent link.
const RAW_CACHE_CONTROL: &str = "private, max-age=0, must-revalidate";

/// Strong ETag built from the agent-reported size + mtime. No mtime
/// (filesystem without one) → no ETag → the response has no validator and
/// simply won't be revalidated.
fn etag_for(file_size: u64, modified: Option<&str>) -> Option<String> {
    modified.map(|m| format!("\"{}-{}\"", file_size, m))
}

/// RFC 9110 If-None-Match matching: `*` matches anything; otherwise a
/// comma-separated list with optional `W/` weak prefixes, whitespace
/// tolerant. We emit strong tags; weak comparison is fine for revalidation.
fn if_none_match_matches(etag: &str, header: &HeaderValue) -> bool {
    let etag = etag.trim_matches('"');
    header
        .to_str()
        .map(|value| {
            value.split(',').any(|candidate| {
                let candidate = candidate.trim();
                candidate == "*"
                    || candidate
                        .strip_prefix("W/")
                        .unwrap_or(candidate)
                        .trim_matches('"')
                        == etag
            })
        })
        .unwrap_or(false)
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

    let is_head = req.method() == axum::http::Method::HEAD;
    let range_header = req.headers().get(header::RANGE).cloned();
    // Conditional revalidation only applies to the regular /api/file/raw
    // route; preview-token resources are always no-store.
    let if_none_match = if target.preview_token.is_none() {
        req.headers().get(header::IF_NONE_MATCH).cloned()
    } else {
        None
    };

    // Range / HEAD / conditional requests need the size before the first
    // byte, so they keep the upfront stat round trip. Plain full GETs skip
    // it — the first chunk itself carries file_size + modified — which
    // halves the agent round trips on the common preview path (and lets the
    // agent's content cache answer the first chunk from memory instantly).
    let needs_size_upfront = is_head || range_header.is_some() || if_none_match.is_some();
    let upfront = if needs_size_upfront {
        match request_raw_file_size(&state, &target).await {
            Ok(size) => Some(size),
            Err(resp) => return resp,
        }
    } else {
        None
    };

    // Conditional GET: unchanged file → 304, no bytes move. Only reachable
    // via the stat path above.
    if let Some((file_size, initial_modified)) = upfront.as_ref() {
        if let Some(etag) = etag_for(*file_size, initial_modified.as_deref()) {
            if let Some(header_value) = if_none_match.as_ref() {
                if if_none_match_matches(&etag, header_value) {
                    drop(raw_permit);
                    return Response::builder()
                        .status(StatusCode::NOT_MODIFIED)
                        .header(header::ETAG, etag)
                        .header(header::CACHE_CONTROL, RAW_CACHE_CONTROL)
                        .body(axum::body::Body::empty())
                        .unwrap()
                        .into_response();
                }
            }
        }
    }

    // Size discovery: stat path (upfront) or first-chunk path (no-stat).
    // Both run under `raw_permit`; the permit is dropped before the body
    // streams so a slow browser never holds one of the 96 slots while it
    // merely pauses between reads.
    let start = if let Some((size, modified)) = upfront {
        let range = match resolve_byte_range(range_header.as_ref(), size) {
            Ok(range) => range,
            Err(()) => {
                drop(raw_permit);
                return Response::builder()
                    .status(StatusCode::RANGE_NOT_SATISFIABLE)
                    .header(header::CONTENT_RANGE, format!("bytes */{}", size))
                    .header(header::ACCEPT_RANGES, "bytes")
                    .body(axum::body::Body::empty())
                    .unwrap()
                    .into_response();
            }
        };
        let (offset_start, body_len) = range.unwrap_or((0, size));
        RawBodyStart {
            file_size: size,
            initial_modified: modified,
            offset_start,
            body_len,
            is_partial: range.is_some(),
            first_chunk: None,
        }
    } else {
        match fetch_first_chunk(&state, &target).await {
            Ok((chunk, done, size, modified)) => RawBodyStart {
                file_size: size,
                initial_modified: modified,
                offset_start: 0,
                body_len: if done { chunk.len() as u64 } else { size },
                is_partial: false,
                first_chunk: Some((chunk, done)),
            },
            Err(resp) => {
                drop(raw_permit);
                return resp;
            }
        }
    };
    drop(raw_permit);

    let RawBodyStart {
        file_size,
        initial_modified,
        offset_start,
        body_len,
        is_partial,
        first_chunk,
    } = start;

    let file_path = target.path.clone();
    let content_type = guess_content_type(&file_path);
    let disposition = if is_inline_type(content_type) { "inline" } else { "attachment" };
    let filename = file_path.rsplit('/').next().unwrap_or("file");
    // Sanitize filename: remove chars that could break Content-Disposition header
    let safe_filename: String = filename.chars().filter(|c| *c != '"' && *c != '\\' && *c != '\n' && *c != '\r').collect();
    let body = if is_head {
        axum::body::Body::empty()
    } else {
        let (body_tx, body_rx) = mpsc::channel(1);
        let producer_state = state.clone();
        let producer_target = target.clone();
        let producer_modified = initial_modified.clone();
        tokio::spawn(async move {
            let mut sent = 0u64;
            let mut first_chunk = first_chunk;
            let expected_modified = producer_modified;
            while sent < body_len {
                // The no-stat flow's first chunk was already fetched (and
                // preview-budgeted) before the response started; it enters
                // the loop as the first item instead of a new request. It
                // carries no per-chunk metadata (agents attach
                // file_size/modified from their own open), so the values
                // captured from that same chunk are supplied here to keep
                // the stream consistent for the shared validator.
                let first = first_chunk.take();
                // The no-stat flow's first chunk was already preview-budgeted
                // inside `fetch_first_chunk`; skip the producer's own reserve
                // for that item so it is counted exactly once.
                let pre_reserved = first.is_some();
                let (chunk, done, chunk_file_size, chunk_modified) =
                    if let Some((chunk, done)) = first {
                        (chunk, done, Some(file_size), expected_modified.clone())
                    } else {
                        let permit = match tokio::time::timeout(
                            Duration::from_secs(30),
                            producer_state.raw_read_semaphore.clone().acquire_owned(),
                        )
                        .await
                        {
                            Ok(Ok(permit)) => permit,
                            _ => {
                                let _ = send_raw_body_item(
                                    &body_tx,
                                    Err(std::io::Error::new(
                                        std::io::ErrorKind::TimedOut,
                                        "Hub raw stream concurrency limit reached",
                                    )),
                                )
                                .await;
                                return;
                            }
                        };
                        let remaining = body_len - sent;
                        let chunk_result = request_raw_chunk_with_retry(
                            &producer_state,
                            &producer_target,
                            offset_start + sent,
                            remaining.min(RAW_STREAM_CHUNK_BYTES),
                        )
                        .await;
                        drop(permit);

                        match chunk_result {
                            Ok(chunk) => chunk,
                            Err(err) => {
                                let _ = send_raw_body_item(
                                    &body_tx,
                                    Err(std::io::Error::new(std::io::ErrorKind::Other, err)),
                                )
                                .await;
                                return;
                            }
                        }
                    };
                if let Err(failure) = check_raw_chunk(
                    &chunk,
                    file_size,
                    body_len - sent,
                    chunk_file_size,
                    chunk_modified,
                    &expected_modified,
                ) {
                    let _ = send_raw_body_item(&body_tx, Err(failure.to_io_error())).await;
                    return;
                }
                if let Some(token) = producer_target.preview_token.as_deref() {
                    if !pre_reserved
                        && reserve_preview_bytes(&producer_state, token, chunk.len() as u64)
                            .await
                            .is_err()
                    {
                        let _ = send_raw_body_item(
                            &body_tx,
                            Err(std::io::Error::new(
                                std::io::ErrorKind::Other,
                                "HTML preview byte budget exceeded",
                            )),
                        )
                        .await;
                        return;
                    }
                }
                sent = sent.saturating_add(chunk.len() as u64);
                let done_early = done && sent != body_len;
                if !send_raw_body_item(
                    &body_tx,
                    Ok(axum::body::Bytes::from(chunk)),
                )
                .await
                {
                    return;
                }
                if done_early {
                    let _ = send_raw_body_item(
                        &body_tx,
                        Err(std::io::Error::new(
                            std::io::ErrorKind::UnexpectedEof,
                            "Agent ended the raw file before the advertised size",
                        )),
                    )
                    .await;
                    return;
                }
            }
            if sent != body_len {
                let _ = send_raw_body_item(
                    &body_tx,
                    Err(std::io::Error::new(
                        std::io::ErrorKind::UnexpectedEof,
                        "Raw file stream ended before Content-Length",
                    )),
                )
                .await;
            }
        });
        let stream = tokio_stream::wrappers::ReceiverStream::new(body_rx);
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
    // Freshness metadata for the browser HTTP cache: a repeat preview of an
    // unchanged file revalidates with a 304 instead of re-transferring the
    // body over the agent link. Preview-token resources stay uncacheable
    // (the caller applies no-store afterwards).
    if target.preview_token.is_none() {
        if let Some(etag) = etag_for(file_size, initial_modified.as_deref()) {
            builder = builder.header(header::ETAG, etag);
        }
        builder = builder.header(header::CACHE_CONTROL, RAW_CACHE_CONTROL);
    }
    let mut resp = builder.body(body).unwrap();
    apply_raw_file_headers(&mut resp, content_type);
    resp.into_response()
}

/// Document-mode preview response: collects the HTML file (bounded by
/// [`crate::preview_doc::PREVIEW_DOCUMENT_MAX_BYTES`]), injects the sandbox
/// guards at the byte level, and returns it with document-mode headers so
/// the iframe can actually render it (no `frame-ancestors`, unlike raw
/// resource responses).
async fn serve_preview_document(
    state: AppState,
    target: RawFileTarget,
    document_base_url: String,
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
            )
        }
    };
    let (file_size, initial_modified) = match request_raw_file_size(&state, &target).await {
        Ok(size) => size,
        Err(resp) => return resp,
    };
    // The whole document is buffered for byte-level injection; the cap keeps
    // that bounded per request (further bounded by the raw-read semaphore).
    if file_size > crate::preview_doc::PREVIEW_DOCUMENT_MAX_BYTES {
        return error_response(
            StatusCode::PAYLOAD_TOO_LARGE,
            "preview_too_large",
            &format!(
                "HTML preview documents are limited to {} bytes",
                crate::preview_doc::PREVIEW_DOCUMENT_MAX_BYTES
            ),
            false,
        );
    }
    // The semaphore bounds Agent round-trips, not response lifetime: drop the
    // upfront permit before the chunked collect re-acquires per chunk.
    drop(raw_permit);

    let raw = match collect_raw_file(&state, &target, file_size, initial_modified).await {
        Ok(raw) => raw,
        Err(resp) => return resp,
    };
    let injected = crate::preview_doc::inject_preview_guards(&raw, &document_base_url);
    let mut resp = Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
        .header(header::CONTENT_LENGTH, injected.len())
        .body(axum::body::Body::from(injected))
        .unwrap();
    apply_preview_document_headers(&mut resp, &document_base_url);
    resp
}

/// Collects a whole file from the agent with the same chunking, retry and
/// file-change detection as [`serve_raw_file`]'s producer, but buffered in
/// memory. Error responses are plain (the caller applies preview headers).
async fn collect_raw_file(
    state: &AppState,
    target: &RawFileTarget,
    file_size: u64,
    initial_modified: Option<String>,
) -> Result<Vec<u8>, Response> {
    let mut bytes = Vec::with_capacity(file_size as usize);
    let mut sent = 0u64;
    let expected_modified = initial_modified;
    while sent < file_size {
        let permit = match tokio::time::timeout(
            Duration::from_secs(30),
            state.raw_read_semaphore.clone().acquire_owned(),
        )
        .await
        {
            Ok(Ok(permit)) => permit,
            _ => {
                return Err(error_response(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "hub_overloaded",
                    "The server is busy streaming files. Please retry shortly.",
                    true,
                ))
            }
        };
        let remaining = file_size - sent;
        let chunk_result = request_raw_chunk_with_retry(
            state,
            target,
            sent,
            remaining.min(RAW_STREAM_CHUNK_BYTES),
        )
        .await;
        drop(permit);

        let (chunk, done, chunk_file_size, chunk_modified) = match chunk_result {
            Ok(chunk) => chunk,
            Err(err) => {
                return Err(error_response(
                    StatusCode::BAD_GATEWAY,
                    "preview_document_error",
                    &format!("Failed to read the HTML document: {}", err),
                    true,
                ))
            }
        };
        if let Err(failure) = check_raw_chunk(
            &chunk,
            file_size,
            remaining,
            chunk_file_size,
            chunk_modified,
            &expected_modified,
        ) {
            return Err(match failure {
                RawChunkFailure::FileChanged => error_response(
                    StatusCode::CONFLICT,
                    "file_changed",
                    "The file changed while it was being read. Please refresh the preview.",
                    false,
                ),
                RawChunkFailure::EmptyChunk => error_response(
                    StatusCode::BAD_GATEWAY,
                    "file_unavailable",
                    "The file could not be read completely",
                    true,
                ),
                RawChunkFailure::OverlongChunk => error_response(
                    StatusCode::BAD_GATEWAY,
                    "invalid_agent_response",
                    "The agent returned more bytes than requested",
                    false,
                ),
            });
        }
        if let Some(token) = target.preview_token.as_deref() {
            if reserve_preview_bytes(state, token, chunk.len() as u64)
                .await
                .is_err()
            {
                return Err(error_response(
                    StatusCode::UNAUTHORIZED,
                    "preview_expired",
                    "Preview session expired or not found",
                    false,
                ));
            }
        }
        bytes.extend_from_slice(&chunk);
        sent = sent.saturating_add(chunk.len() as u64);
        if done && sent != file_size {
            return Err(error_response(
                StatusCode::BAD_GATEWAY,
                "file_unavailable",
                "The file ended before its advertised size",
                true,
            ));
        }
    }
    Ok(bytes)
}

/// First-chunk size discovery for plain full GETs: the agent's first
/// FileChunk carries `file_size` + `modified`, so the upfront stat round
/// trip can be skipped. Single attempt — a retry storm here would leave the
/// browser waiting ~90s for its first byte; the frontend retries whole
/// requests instead, and the agent's content cache makes each retry
/// cheaper. Runs under the caller's `raw_permit`.
async fn fetch_first_chunk(
    state: &AppState,
    target: &RawFileTarget,
) -> Result<(Vec<u8>, bool, u64, Option<String>), Response> {
    let (chunk, done, chunk_file_size, chunk_modified) = match request_raw_chunk(
        state,
        target,
        0,
        RAW_STREAM_CHUNK_BYTES,
        Duration::from_secs(30),
    )
    .await
    {
        Ok(chunk) => chunk,
        Err(err) => return Err(raw_file_refusal_response(&err)),
    };
    // Prefer the agent-supplied size; if a virtual path (e.g. the agent's
    // office-cache) cannot self-describe, a done chunk at offset 0 already
    // holds the entire file, so its length IS the size.
    let Some(size) = chunk_file_size.or_else(|| done.then(|| chunk.len() as u64)) else {
        return Err(error_response(
            StatusCode::BAD_GATEWAY,
            "file_stat_error",
            "Agent returned a file chunk without a file size",
            true,
        ));
    };
    // A done-but-empty first chunk is a legitimately empty file; a non-done
    // empty chunk is a protocol violation.
    if chunk.is_empty() && !done {
        return Err(error_response(
            StatusCode::BAD_GATEWAY,
            "file_stat_error",
            "Agent returned an empty file chunk without EOF",
            true,
        ));
    }
    if let Some(token) = target.preview_token.as_deref() {
        if reserve_preview_bytes(state, token, chunk.len() as u64)
            .await
            .is_err()
        {
            return Err(error_response(
                StatusCode::NOT_FOUND,
                "preview_expired",
                "Preview session expired or not found",
                false,
            ));
        }
    }
    Ok((chunk, done, size, chunk_modified))
}

async fn request_raw_file_size(
    state: &AppState,
    target: &RawFileTarget,
) -> Result<(u64, Option<String>), Response> {
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
        if err == "backend_offline"
            || value["retryable"].as_bool() == Some(true)
            || err.starts_with("agent_overloaded")
        {
            let code = err.split(':').next().unwrap_or(err);
            return Err(error_response(
                StatusCode::SERVICE_UNAVAILABLE,
                code,
                "Could not check the file before streaming",
                true,
            ));
        }
        // Not transport-level: let the shared refusal mapper classify it
        // (denied -> 403, anything else -> 400) so both raw paths agree.
        return Err(raw_file_refusal_response(err));
    }
    if value["stat"]["denied"].as_bool().unwrap_or(false) {
        return Err(raw_file_refusal_response("denied"));
    }
    if value["stat"]["entry_type"].as_str() != Some("file") {
        return Err(error_response(
            StatusCode::BAD_REQUEST,
            "file_unavailable",
            "The selected path is not a readable file",
            false,
        ));
    }
    let size = value["stat"]["size"].as_u64().ok_or_else(|| {
        error_response(
            StatusCode::BAD_GATEWAY,
            "file_stat_error",
            "Agent returned an invalid file size",
            true,
        )
    })?;
    Ok((size, value["stat"]["modified"].as_str().map(str::to_string)))
}

async fn request_raw_chunk_with_retry(
    state: &AppState,
    target: &RawFileTarget,
    offset: u64,
    length: u64,
) -> Result<(Vec<u8>, bool, Option<u64>, Option<String>), String> {
    let deadline = tokio::time::Instant::now() + RAW_CHUNK_RETRY_BUDGET;
    let mut attempt = 0u32;
    let mut last_err: Option<String> = None;
    loop {
        if tokio::time::Instant::now() >= deadline {
            return Err(last_err.unwrap_or_else(|| {
                "Raw chunk retry budget exhausted".to_string()
            }));
        }
        attempt += 1;
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        let attempt_timeout = remaining.min(RAW_CHUNK_REQUEST_TIMEOUT);
        match request_raw_chunk(state, target, offset, length, attempt_timeout).await {
            Ok(chunk) => return Ok(chunk),
            Err(err) if is_raw_chunk_retryable(&err) => {
                last_err = Some(err.clone());
                let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
                if remaining.is_zero() {
                    return Err(last_err.unwrap());
                }
                let base_delay = if err.starts_with("agent_overloaded") {
                    RAW_CHUNK_RETRY_DELAY.saturating_mul(2u32.saturating_pow(attempt.min(4) - 1))
                } else {
                    RAW_CHUNK_RETRY_DELAY
                };
                let jitter = if base_delay > Duration::from_millis(1) {
                    Duration::from_millis(
                        rand::random::<u64>() % (base_delay.as_millis() as u64 / 2).max(1),
                    )
                } else {
                    Duration::ZERO
                };
                tracing::warn!(
                    "raw chunk offset={} attempt={} failed: {}, retrying",
                    offset,
                    attempt,
                    err
                );
                tokio::time::sleep((base_delay + jitter).min(remaining)).await;
            }
            Err(err) => return Err(err),
        }
    }
}

async fn request_raw_chunk(
    state: &AppState,
    target: &RawFileTarget,
    offset: u64,
    length: u64,
    timeout: Duration,
) -> Result<(Vec<u8>, bool, Option<u64>, Option<String>), String> {
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
        timeout,
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
    let data = decode_file_chunk_data(&value["data"])?;
    // Keep rolling upgrades compatible with the historical 4 MiB agent
    // limit, but reject arbitrary payloads before they can be accepted into
    // the raw response path. Current agents and Hub requests use 512 KiB.
    const MAX_ACCEPTED_AGENT_CHUNK_BYTES: usize = 4 * 1024 * 1024;
    if data.len() > MAX_ACCEPTED_AGENT_CHUNK_BYTES {
        return Err("Agent returned an oversized file chunk".to_string());
    }
    if data.len() as u64 > length {
        return Err("Agent returned more bytes than requested".to_string());
    }
    Ok((
        data,
        value["done"].as_bool().unwrap_or(true),
        value["file_size"].as_u64(),
        value["modified"].as_str().map(str::to_string),
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
        let connection_id = agent.connection_id;
        let mut pending = inner.pending_responses.write().await;
        if pending.len() >= MAX_PENDING_RESPONSES {
            return Err("Hub pending request limit reached".to_string());
        }
        pending.insert(
            req_id.clone(),
            PendingResponse {
                tx: resp_tx,
                agent_id: target.agent_id.clone(),
                connection_id,
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
    let cleanup = PendingResponseCleanup {
        state: state.clone(),
        req_id: req_id.clone(),
        cancel_agent_id: Some(target.agent_id.clone()),
        active: true,
    };
    let response = tokio::time::timeout(timeout, resp_rx.recv()).await;
    let cancelled = !matches!(response, Ok(Some(_)));
    cleanup.finish(cancelled).await;
    match response {
        Ok(Some(value)) => Ok(value),
        _ => Err("Agent did not respond in time".to_string()),
    }
}

struct PendingResponseCleanup {
    state: AppState,
    req_id: String,
    cancel_agent_id: Option<String>,
    active: bool,
}

impl PendingResponseCleanup {
    async fn finish(mut self, cancel: bool) {
        if cancel {
            if let Some(agent_id) = self.cancel_agent_id.as_deref() {
                send_cancel(&self.state, agent_id, &self.req_id).await;
            }
        }
        cleanup_pending(&self.state, &self.req_id).await;
        self.active = false;
    }
}

impl Drop for PendingResponseCleanup {
    fn drop(&mut self) {
        if !self.active {
            return;
        }
        let state = self.state.clone();
        let req_id = self.req_id.clone();
        let cancel_agent_id = self.cancel_agent_id.clone();
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn(async move {
                if let Some(agent_id) = cancel_agent_id {
                    send_cancel(&state, &agent_id, &req_id).await;
                }
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

/// Headers for document-mode responses. Unlike resource mode there is no
/// `frame-ancestors` / `X-Frame-Options`: the document must be embeddable in
/// the sandboxed preview iframe and in the blob new-window wrapper, both of
/// which have opaque origins. The injected CSP meta enforces the same
/// resource policy from inside the document. The `x-filebox-preview-document`
/// sentinel lets the global [`crate::routes::security_headers`] layer keep
/// its blanket `X-Frame-Options: DENY` for everything else while allowing
/// this one opt-out.
fn apply_preview_document_headers(resp: &mut Response, base_url: &str) {
    let headers = resp.headers_mut();
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_str(&crate::preview_doc::preview_document_csp(base_url)).unwrap(),
    );
    headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue::from_static("null"));
    headers.insert(header::VARY, HeaderValue::from_static("Origin"));
    headers.insert(
        axum::http::HeaderName::from_static("x-filebox-preview-document"),
        HeaderValue::from_static("1"),
    );
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
        if pending.len() >= MAX_PENDING_RESPONSES {
            false
        } else {
            pending.insert(req_id.clone(), PendingResponse {
                tx: resp_tx,
                agent_id: agent_id.clone(),
                connection_id: agent.connection_id,
                session_id: Some(session.principal_id.clone()),
                desired_roots: None,
                desired_collections: None,
            });
            inner.agents.send_to_agent(&agent_id, msg)
        }
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

    let cleanup = PendingResponseCleanup {
        state: state.clone(),
        req_id: req_id.clone(),
        cancel_agent_id: None,
        active: true,
    };
    let resp = tokio::time::timeout(Duration::from_secs(10), resp_rx.recv()).await;
    cleanup.finish(false).await;

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

async fn send_cancel(state: &AppState, agent_id: &str, req_id: &str) {
    let inner = state.inner.read().await;
    let _ = inner.agents.send_to_agent(
        agent_id,
        HubMessage::Cancel {
            req_id: req_id.to_string(),
        },
    );
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

    /// mtime the mock agents advertise, matching what a real agent reports
    /// for a stable file.
    const MOCK_MODIFIED: &str = "2026-01-01T00:00:00+00:00";

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
            absolute_base_url: "http://localhost".to_string(),
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

    #[tokio::test]
    async fn pending_response_cleanup_removes_abandoned_request() {
        let state = AppState::new(&test_config(), true);
        let req_id = "abandoned-request".to_string();
        let (tx, _rx) = mpsc::channel(1);
        let pending = state.inner.read().await.pending_responses.clone();
        pending.write().await.insert(
            req_id.clone(),
            PendingResponse {
                tx,
                agent_id: "agent".to_string(),
                connection_id: 1,
                session_id: None,
                desired_roots: None,
                desired_collections: None,
            },
        );

        drop(PendingResponseCleanup {
            state: state.clone(),
            req_id: req_id.clone(),
            cancel_agent_id: None,
            active: true,
        });

        tokio::time::timeout(Duration::from_secs(1), async {
            while pending.read().await.contains_key(&req_id) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("abandoned pending response should be cleaned up");
    }

    #[tokio::test]
    async fn pending_response_cleanup_cancels_abandoned_agent_work() {
        let state = AppState::new(&test_config(), true);
        let (agent_tx, mut agent_rx) = mpsc::channel(256);
        register_mock_agent(&state, "a1", agent_tx).await;
        let req_id = "abandoned-fs-request".to_string();
        let (tx, _rx) = mpsc::channel(1);
        let pending = state.inner.read().await.pending_responses.clone();
        pending.write().await.insert(
            req_id.clone(),
            PendingResponse {
                tx,
                agent_id: "a1".to_string(),
                connection_id: 1,
                session_id: None,
                desired_roots: None,
                desired_collections: None,
            },
        );

        drop(PendingResponseCleanup {
            state: state.clone(),
            req_id: req_id.clone(),
            cancel_agent_id: Some("a1".to_string()),
            active: true,
        });

        let message = tokio::time::timeout(Duration::from_secs(1), agent_rx.recv())
            .await
            .expect("cancel should reach the agent")
            .expect("agent channel should stay open");
        assert!(matches!(
            message,
            HubMessage::Cancel { req_id: cancelled } if cancelled == req_id
        ));
    }

    // ── file_raw_handler multi-chunk loop ───────────────────────────────────
    //
    // Mock-agent harness: spin up a tokio task that consumes FileReadRequest
    // from the channel and injects matching FileChunk values through
    // pending_responses, mirroring ws.rs:341-355. Lets us test the
    // accumulate-until-done loop without a real WebSocket.

    #[test]
    fn is_raw_chunk_retryable_classifies_transport_errors() {
        assert!(is_raw_chunk_retryable("Agent is offline"));
        assert!(is_raw_chunk_retryable("backend_offline"));
        assert!(is_raw_chunk_retryable("agent_overloaded: queue full"));
        assert!(!is_raw_chunk_retryable("Access denied: sensitive file"));
        assert!(!is_raw_chunk_retryable(
            "Agent returned a mismatched file chunk offset"
        ));
    }

    #[tokio::test]
    async fn file_raw_handler_retries_transient_chunk_failure_at_same_offset() {
        use std::collections::HashSet;
        use std::sync::{Arc, Mutex};

        let state = AppState::new(&test_config(), true);
        let chunk = filebox_protocol::message::FILE_CHUNK_MAX_BYTES;
        let file_total = chunk * 2;
        let fail_once = Arc::new(Mutex::new(HashSet::from([chunk])));
        let (tx, agent_handle) = spawn_flaky_file_agent(
            state.clone(),
            "a1",
            file_total,
            chunk,
            fail_once,
        );
        register_mock_agent(&state, "a1", tx).await;

        let params = FileRawParams {
            agent_id: "a1".to_string(),
            root: "test".to_string(),
            path: "flaky.bin".to_string(),
        };
        let response = file_raw_handler(
            State(state.clone()),
            test_session(),
            Query(params),
            build_raw_request(None),
        )
        .await;

        assert_eq!(response.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(response.into_body(), file_total as usize + 1024)
            .await
            .unwrap();
        assert_eq!(bytes.len(), file_total as usize);
        assert!(bytes.iter().all(|&b| b == 0xAB));

        agent_handle.abort();
    }

    #[tokio::test]
    async fn file_raw_handler_accepts_done_first_chunk_without_file_size() {
        // The agent's office-cache virtual path never self-describes chunks
        // (file_size: None). The no-stat first-chunk path must fall back to
        // the chunk length when the chunk is done (offset 0 → whole file).
        let state = AppState::new(&test_config(), true);
        let file_total = 4096u64;
        let (tx, agent_handle) = spawn_no_size_file_agent(state.clone(), "a1", file_total);
        register_mock_agent(&state, "a1", tx).await;

        let params = FileRawParams {
            agent_id: "a1".to_string(),
            root: "test".to_string(),
            path: "office.csv".to_string(),
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
            response.headers().get(header::CONTENT_LENGTH).unwrap(),
            &hv(&file_total.to_string())
        );
        let bytes = axum::body::to_bytes(response.into_body(), file_total as usize + 1024)
            .await
            .unwrap();
        assert_eq!(bytes.len(), file_total as usize);
        assert!(bytes.iter().all(|&b| b == 0xCD));

        agent_handle.abort();
    }

    #[tokio::test]
    async fn file_raw_handler_rejects_undone_chunk_without_file_size() {
        // A non-done chunk with no size is a protocol violation: the hub
        // cannot know the body length, so it must fail with a retryable 502.
        let state = AppState::new(&test_config(), true);
        let chunk = filebox_protocol::message::FILE_CHUNK_MAX_BYTES;
        let file_total = chunk * 2;
        let (tx, agent_handle) = spawn_no_size_file_agent(state.clone(), "a1", file_total);
        register_mock_agent(&state, "a1", tx).await;

        let params = FileRawParams {
            agent_id: "a1".to_string(),
            root: "test".to_string(),
            path: "mystery.bin".to_string(),
        };
        let response = file_raw_handler(
            State(state.clone()),
            test_session(),
            Query(params),
            build_raw_request(None),
        )
        .await;

        assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
        let body = axum::body::to_bytes(response.into_body(), 8192).await.unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["error"], "file_stat_error");

        agent_handle.abort();
    }

    fn test_config() -> crate::config::HubConfig {
        crate::config::HubConfig {
            listen_addr: "127.0.0.1:0".parse().unwrap(),
            agent_token_hash: "fake-hash".to_string(),
            users: vec![],
        }
    }

    // ── preview document mode ───────────────────────────────────────────────

    #[test]
    fn document_mode_requires_navigation_header_and_html_path() {
        let get = axum::http::Method::GET;
        let head = axum::http::Method::HEAD;
        let mut nested = HeaderMap::new();
        nested.insert("sec-fetch-mode", hv("nested-navigate"));
        let mut top = HeaderMap::new();
        top.insert("sec-fetch-mode", hv("navigate"));
        let mut subresource = HeaderMap::new();
        subresource.insert("sec-fetch-mode", hv("no-cors"));

        assert!(is_preview_document_request(&get, &nested, "dir/test.html"));
        assert!(is_preview_document_request(&get, &top, "test.htm"));
        assert!(!is_preview_document_request(&head, &nested, "test.html"));
        assert!(!is_preview_document_request(&get, &subresource, "test.html"));
        assert!(!is_preview_document_request(&get, &HeaderMap::new(), "test.html"));
        assert!(!is_preview_document_request(&get, &nested, "test.css"));
    }

    async fn active_principal_id(state: &AppState) -> String {
        let mut inner = state.inner.write().await;
        let (session, _) = inner.sessions.create_session("admin", false);
        session.principal_id
    }

    async fn insert_preview_session(state: &AppState, token: &str, agent_id: &str, principal_id: &str) {
        let now = std::time::Instant::now();
        let preview = PreviewSession {
            session_id: principal_id.to_string(),
            agent_id: agent_id.to_string(),
            root: "test".to_string(),
            base_path: "".to_string(),
            absolute_base_url: "http://localhost".to_string(),
            created_at: now,
            expires_at: now + std::time::Duration::from_secs(3600),
            requests_served: 0,
            bytes_served: 0,
        };
        let preview_sessions = state.inner.read().await.preview_sessions.clone();
        preview_sessions.write().await.insert(token.to_string(), preview);
    }

    fn build_preview_request(
        method: &str,
        sec_fetch_mode: Option<&str>,
        uri: &str,
    ) -> axum::extract::Request {
        let mut builder = axum::http::Request::builder().method(method).uri(uri);
        if let Some(mode) = sec_fetch_mode {
            builder = builder.header("sec-fetch-mode", mode);
        }
        builder.body(axum::body::Body::empty()).unwrap()
    }

    #[tokio::test]
    async fn preview_navigation_gets_injected_document_without_frame_ancestors() {
        let state = AppState::new(&test_config(), true);
        let (tx, agent_handle) = spawn_mock_file_agent(state.clone(), "a1", 64, 64);
        register_mock_agent(&state, "a1", tx).await;
        let principal = active_principal_id(&state).await;
        insert_preview_session(&state, "tok", "a1", &principal).await;

        let response = preview_resource_handler(
            State(state.clone()),
            Path(("tok".to_string(), "test.html".to_string())),
            build_preview_request("GET", Some("nested-navigate"), "/api/preview/tok/test.html"),
        )
        .await;

        assert_eq!(response.status(), StatusCode::OK);
        let csp = response
            .headers()
            .get(header::CONTENT_SECURITY_POLICY)
            .unwrap()
            .to_str()
            .unwrap()
            .to_string();
        assert!(csp.contains("script-src 'unsafe-inline'"), "csp: {csp}");
        assert!(!csp.contains("frame-ancestors"), "csp: {csp}");
        // Sentinel that lets the global security_headers layer skip its
        // blanket X-Frame-Options: DENY for this response.
        assert_eq!(
            response.headers().get("x-filebox-preview-document").unwrap(),
            "1"
        );
        let bytes = axum::body::to_bytes(response.into_body(), 64 * 1024)
            .await
            .unwrap();
        let html = String::from_utf8_lossy(&bytes);
        assert!(html.starts_with("<meta charset=\"utf-8\">"), "{html}");
        assert!(html.contains(
            "<base href=\"http://localhost/api/preview/tok/\" target=\"_self\">"
        ));
        assert!(html.contains("scrollIntoView"));

        agent_handle.abort();
    }

    #[tokio::test]
    async fn preview_plain_get_stays_raw_with_locked_down_csp() {
        let state = AppState::new(&test_config(), true);
        let (tx, agent_handle) = spawn_mock_file_agent(state.clone(), "a1", 64, 64);
        register_mock_agent(&state, "a1", tx).await;
        let principal = active_principal_id(&state).await;
        insert_preview_session(&state, "tok", "a1", &principal).await;

        let response = preview_resource_handler(
            State(state.clone()),
            Path(("tok".to_string(), "test.html".to_string())),
            build_preview_request("GET", None, "/api/preview/tok/test.html"),
        )
        .await;

        assert_eq!(response.status(), StatusCode::OK);
        let csp = response
            .headers()
            .get(header::CONTENT_SECURITY_POLICY)
            .unwrap()
            .to_str()
            .unwrap()
            .to_string();
        assert!(csp.contains("frame-ancestors 'none'"), "csp: {csp}");
        assert!(response.headers().get("x-filebox-preview-document").is_none());
        let bytes = axum::body::to_bytes(response.into_body(), 64 * 1024)
            .await
            .unwrap();
        // Raw mock bytes (0xAB filler) — no injection.
        assert_eq!(bytes.len(), 64);
        assert!(bytes.iter().all(|&b| b == 0xAB));

        agent_handle.abort();
    }

    #[tokio::test]
    async fn preview_head_stays_raw_even_with_navigation_header() {
        let state = AppState::new(&test_config(), true);
        let (tx, agent_handle) = spawn_mock_file_agent(state.clone(), "a1", 64, 64);
        register_mock_agent(&state, "a1", tx).await;
        let principal = active_principal_id(&state).await;
        insert_preview_session(&state, "tok", "a1", &principal).await;

        let response = preview_resource_handler(
            State(state.clone()),
            Path(("tok".to_string(), "test.html".to_string())),
            build_preview_request("HEAD", Some("nested-navigate"), "/api/preview/tok/test.html"),
        )
        .await;

        assert_eq!(response.status(), StatusCode::OK);
        let csp = response
            .headers()
            .get(header::CONTENT_SECURITY_POLICY)
            .unwrap()
            .to_str()
            .unwrap()
            .to_string();
        assert!(csp.contains("frame-ancestors 'none'"), "csp: {csp}");
        let body = axum::body::to_bytes(response.into_body(), 1024).await.unwrap();
        assert!(body.is_empty());

        agent_handle.abort();
    }

    #[tokio::test]
    async fn preview_document_mode_rejects_oversized_documents() {
        let state = AppState::new(&test_config(), true);
        let oversized = crate::preview_doc::PREVIEW_DOCUMENT_MAX_BYTES + 1;
        let (tx, agent_handle) = spawn_mock_file_agent(state.clone(), "a1", oversized, 4096);
        register_mock_agent(&state, "a1", tx).await;
        let principal = active_principal_id(&state).await;
        insert_preview_session(&state, "tok", "a1", &principal).await;

        let response = preview_resource_handler(
            State(state.clone()),
            Path(("tok".to_string(), "huge.html".to_string())),
            build_preview_request("GET", Some("navigate"), "/api/preview/tok/huge.html"),
        )
        .await;

        assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
        let body = axum::body::to_bytes(response.into_body(), 4096).await.unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["error"], "preview_too_large");

        agent_handle.abort();
    }

    /// Spawn a mock agent that simulates `file_total` bytes delivered in
    /// `chunk_cap`-sized frames. Returns the agent's sender (for the
    /// registry) and the join handle (so the test can await/cleanup).
    fn spawn_mock_file_agent(
        state: AppState,
        agent_id: &str,
        file_total: u64,
        chunk_cap: u64,
    ) -> (mpsc::Sender<HubMessage>, tokio::task::JoinHandle<()>) {
        let (tx, mut rx) = mpsc::channel::<HubMessage>(256);
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
                            // Match the mtime the chunk responses advertise,
                            // like a real agent reporting a stable file.
                            modified: Some(MOCK_MODIFIED.to_string()),
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
                    // Real agents self-describe every chunk with the file's
                    // size + mtime; the mocks must do the same.
                    file_size: Some(file_total),
                    modified: Some(MOCK_MODIFIED.to_string()),
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

    fn spawn_flaky_file_agent(
        state: AppState,
        agent_id: &str,
        file_total: u64,
        chunk_cap: u64,
        fail_once_offsets: Arc<std::sync::Mutex<std::collections::HashSet<u64>>>,
    ) -> (mpsc::Sender<HubMessage>, tokio::task::JoinHandle<()>) {
        let (tx, mut rx) = mpsc::channel::<HubMessage>(256);
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
                            // Match the mtime the chunk responses advertise,
                            // like a real agent reporting a stable file.
                            modified: Some(MOCK_MODIFIED.to_string()),
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
                let should_fail_once = fail_once_offsets
                    .lock()
                    .ok()
                    .is_some_and(|mut offsets| offsets.remove(&offset));
                if should_fail_once {
                    let chunk = AgentMessage::FileChunk {
                        req_id: req_id.clone(),
                        offset,
                        data: vec![],
                        done: true,
                        error: Some("backend_offline".to_string()),
                        file_size: None,
                        modified: None,
                    };
                    let value = serde_json::to_value(&chunk).unwrap();
                    let pending_arc = state.inner.read().await.pending_responses.clone();
                    let mut pending = pending_arc.write().await;
                    if let Some(p) = pending.remove(&req_id) {
                        let _ = p.tx.send(value).await;
                    }
                    continue;
                }
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
                    // Real agents self-describe every chunk with the file's
                    // size + mtime; the mocks must do the same.
                    file_size: Some(file_total),
                    modified: Some(MOCK_MODIFIED.to_string()),
                };
                let value = serde_json::to_value(&chunk).unwrap();
                let pending_arc = state.inner.read().await.pending_responses.clone();
                let mut pending = pending_arc.write().await;
                if let Some(p) = pending.remove(&req_id) {
                    let _ = p.tx.send(value).await;
                }
            }
            let _ = agent_id_owned;
        });
        (tx, handle)
    }

    /// Mock agent that never self-describes chunks (`file_size: None`),
    /// mirroring the real agent's office-cache virtual path. Serves the
    /// whole file from offset 0 in one done chunk.
    fn spawn_no_size_file_agent(
        state: AppState,
        agent_id: &str,
        file_total: u64,
    ) -> (mpsc::Sender<HubMessage>, tokio::task::JoinHandle<()>) {
        let (tx, mut rx) = mpsc::channel::<HubMessage>(256);
        let agent_id_owned = agent_id.to_string();
        let handle = tokio::spawn(async move {
            while let Some(msg) = rx.recv().await {
                let HubMessage::FileReadRequest { req_id, offset, length, .. } = msg else {
                    continue;
                };
                let remaining = file_total.saturating_sub(offset);
                let to_read = length.unwrap_or(remaining).min(remaining);
                let data = vec![0xCDu8; to_read as usize];
                let done = offset + to_read >= file_total;
                let chunk = AgentMessage::FileChunk {
                    req_id: req_id.clone(),
                    offset,
                    data,
                    done,
                    error: None,
                    file_size: None,
                    modified: None,
                };
                let value = serde_json::to_value(&chunk).unwrap();
                let pending_arc = state.inner.read().await.pending_responses.clone();
                let mut pending = pending_arc.write().await;
                if let Some(p) = pending.remove(&req_id) {
                    let _ = p.tx.send(value).await;
                }
            }
            let _ = agent_id_owned;
        });
        (tx, handle)
    }

    async fn register_mock_agent(state: &AppState, agent_id: &str, tx: mpsc::Sender<HubMessage>) {
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
            None,
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
        // File larger than one chunk → agent returns multiple FileChunks that
        // the handler must coalesce into one HTTP body.
        let state = AppState::new(&test_config(), true);
        let chunk = filebox_protocol::message::FILE_CHUNK_MAX_BYTES;
        let file_total: u64 = chunk * 2 + chunk / 2;
        let (tx, agent_handle) =
            spawn_mock_file_agent(state.clone(), "a1", file_total, chunk);
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
            spawn_mock_file_agent(
                state.clone(),
                "a1",
                1024 * 1024,
                filebox_protocol::message::FILE_CHUNK_MAX_BYTES,
            );
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
            spawn_mock_file_agent(
                state.clone(),
                "a1",
                1024 * 1024,
                filebox_protocol::message::FILE_CHUNK_MAX_BYTES,
            );
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
            spawn_mock_file_agent(
                state.clone(),
                "a1",
                128,
                filebox_protocol::message::FILE_CHUNK_MAX_BYTES,
            );
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
            spawn_mock_file_agent(
                state.clone(),
                "a1",
                2,
                filebox_protocol::message::FILE_CHUNK_MAX_BYTES,
            );
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
        let (tx, agent_handle) = spawn_mock_file_agent(
            state.clone(),
            "a1",
            file_total,
            filebox_protocol::message::FILE_CHUNK_MAX_BYTES,
        );
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
        // Dead-loop defense: if agent returns empty data + done=false as the
        // very first chunk, the handler must reject it (502) instead of
        // re-requesting forever. No upfront stat happens on a plain full GET,
        // so the mock only ever sees the FileReadRequest.
        let state = AppState::new(&test_config(), true);
        let (tx, mut rx) = mpsc::channel::<HubMessage>(256);
        let state_for_agent = state.clone();
        let agent_handle = tokio::spawn(async move {
            if let Some(msg) = rx.recv().await {
                if let HubMessage::FileReadRequest { req_id, offset, .. } = msg {
                    let chunk = AgentMessage::FileChunk {
                        req_id: req_id.clone(),
                        offset,
                        data: vec![],
                        done: false,
                        error: None,
                        file_size: Some(100),
                        modified: Some(MOCK_MODIFIED.to_string()),
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

        assert_eq!(
            response.status(),
            StatusCode::BAD_GATEWAY,
            "a first chunk that is empty without EOF must be rejected up front"
        );

        agent_handle.abort();
    }

    #[tokio::test]
    async fn file_raw_handler_serves_small_file_without_upfront_stat() {
        // The no-stat path: a plain full GET must be served entirely from
        // the first FileChunk (size + mtime + bytes), with no FsStatRequest
        // round trip at all — this is what removes one agent RTT (and one
        // storage hit) from every preview.
        let state = AppState::new(&test_config(), true);
        let (tx, mut rx) = mpsc::channel::<HubMessage>(256);
        let state_for_agent = state.clone();
        let stat_seen = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let stat_seen_agent = stat_seen.clone();
        let agent_handle = tokio::spawn(async move {
            while let Some(msg) = rx.recv().await {
                match msg {
                    HubMessage::FsStatRequest { .. } => {
                        stat_seen_agent.store(true, std::sync::atomic::Ordering::SeqCst);
                        // Deliberately never answer — the handler must not
                        // depend on this request on the full-GET path.
                    }
                    HubMessage::FileReadRequest { req_id, offset, length, .. } => {
                        let data = if offset == 0 {
                            vec![0x42u8; length.unwrap_or(512 * 1024).min(100) as usize]
                        } else {
                            vec![]
                        };
                        let done = offset as usize + data.len() >= 100;
                        let chunk = AgentMessage::FileChunk {
                            req_id: req_id.clone(),
                            offset,
                            data,
                            done,
                            error: None,
                            file_size: Some(100),
                            modified: Some(MOCK_MODIFIED.to_string()),
                        };
                        let value = serde_json::to_value(&chunk).unwrap();
                        let pending_arc =
                            state_for_agent.inner.read().await.pending_responses.clone();
                        let mut pending = pending_arc.write().await;
                        if let Some(p) = pending.remove(&req_id) {
                            let _ = p.tx.send(value).await;
                        }
                    }
                    _ => {}
                }
            }
        });
        register_mock_agent(&state, "a1", tx).await;

        let params = FileRawParams {
            agent_id: "a1".to_string(),
            root: "test".to_string(),
            path: "small.bin".to_string(),
        };
        let response = file_raw_handler(
            State(state.clone()),
            test_session(),
            Query(params),
            build_raw_request(None),
        )
        .await;

        assert_eq!(response.status(), StatusCode::OK);
        assert!(
            !stat_seen.load(std::sync::atomic::Ordering::SeqCst),
            "a plain full GET must not issue an upfront FsStatRequest"
        );
        assert_eq!(
            response.headers().get(header::CONTENT_LENGTH).unwrap().to_str().unwrap(),
            "100"
        );
        let etag = response
            .headers()
            .get(header::ETAG)
            .unwrap()
            .to_str()
            .unwrap()
            .to_string();
        assert_eq!(etag, format!("\"100-{}\"", MOCK_MODIFIED));
        let bytes = axum::body::to_bytes(response.into_body(), 1024).await.unwrap();
        assert_eq!(bytes.len(), 100);
        assert!(bytes.iter().all(|&b| b == 0x42));

        agent_handle.abort();
    }

    #[tokio::test]
    async fn file_raw_handler_returns_304_on_matching_if_none_match() {
        // Revalidation: the browser sends the stored ETag back; an unchanged
        // file must answer 304 with an empty body instead of re-transferring
        // the whole file over the agent link.
        let state = AppState::new(&test_config(), true);
        let file_total: u64 = 512 * 1024;
        let (tx, agent_handle) =
            spawn_mock_file_agent(state.clone(), "a1", file_total, 512 * 1024);
        register_mock_agent(&state, "a1", tx).await;

        let params = FileRawParams {
            agent_id: "a1".to_string(),
            root: "test".to_string(),
            path: "big.bin".to_string(),
        };
        let first = file_raw_handler(
            State(state.clone()),
            test_session(),
            Query(FileRawParams {
                agent_id: "a1".to_string(),
                root: "test".to_string(),
                path: "big.bin".to_string(),
            }),
            build_raw_request(None),
        )
        .await;
        assert_eq!(first.status(), StatusCode::OK);
        let etag = first
            .headers()
            .get(header::ETAG)
            .unwrap()
            .to_str()
            .unwrap()
            .to_string();
        let cache_control = first
            .headers()
            .get(header::CACHE_CONTROL)
            .unwrap()
            .to_str()
            .unwrap()
            .to_string();
        assert!(cache_control.contains("must-revalidate"));
        // Drain the first body so the mock agent isn't blocked.
        axum::body::to_bytes(first.into_body(), file_total as usize + 1024)
            .await
            .unwrap();

        let mut conditional = build_raw_request(None);
        *conditional.headers_mut() =
            HeaderMap::from_iter([(
                header::IF_NONE_MATCH,
                HeaderValue::from_str(&etag).unwrap(),
            )]);
        let second = file_raw_handler(
            State(state.clone()),
            test_session(),
            Query(params),
            conditional,
        )
        .await;
        assert_eq!(second.status(), StatusCode::NOT_MODIFIED);
        assert_eq!(
            second.headers().get(header::ETAG).unwrap().to_str().unwrap(),
            etag
        );
        let body = axum::body::to_bytes(second.into_body(), 1024).await.unwrap();
        assert!(body.is_empty(), "a 304 must carry no body");

        agent_handle.abort();
    }
}
