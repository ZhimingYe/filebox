use std::time::Duration;

use axum::extract::{Query, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
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

fn is_inline_type(content_type: &str) -> bool {
    content_type.starts_with("image/")
        || content_type.starts_with("text/")
        || content_type == "application/pdf"
        || content_type == "application/json"
        || content_type == "application/javascript"
        || content_type == "application/xml"
}

use filebox_protocol::message::HubMessage;

use crate::state::{AppState, PendingResponse};

#[derive(Debug, serde::Deserialize)]
pub struct FsListParams {
    pub agent_id: String,
    pub root: String,
    pub path: String,
    pub limit: Option<u32>,
    pub cursor: Option<String>,
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
    };

    let (resp_tx, mut resp_rx) = mpsc::channel(1);
    {
        let mut pending = inner.pending_responses.write().await;
        pending.insert(req_id.clone(), PendingResponse {
            tx: resp_tx,
            desired_roots: None,
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
            desired_roots: None,
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

pub async fn file_raw_handler(
    State(state): State<AppState>,
    Query(params): Query<FileRawParams>,
    req: axum::extract::Request,
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

    // Parse Range header
    let (offset, length) = parse_range_header(req.headers().get(header::RANGE));

    let req_id = format!("file_{}", Uuid::new_v4());
    let file_path = params.path.clone();

    let msg = HubMessage::FileReadRequest {
        req_id: req_id.clone(),
        root: params.root,
        path: params.path,
        offset,
        length,
    };

    let (resp_tx, mut resp_rx) = mpsc::channel(1);
    {
        let mut pending = inner.pending_responses.write().await;
        pending.insert(req_id.clone(), PendingResponse {
            tx: resp_tx,
            desired_roots: None,
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

    let resp = tokio::time::timeout(Duration::from_secs(60), resp_rx.recv()).await;

    cleanup_pending(&state, &req_id).await;

    match resp {
        Ok(Some(value)) => {
            // Extract data from the FileChunk response
            let data = value["data"].as_array().map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_u64().map(|n| n as u8))
                    .collect::<Vec<u8>>()
            }).unwrap_or_default();

            let error = value["error"].as_str();

            if let Some(err) = error {
                return error_response(
                    StatusCode::BAD_REQUEST,
                    "file_read_error",
                    err,
                    false,
                );
            }

            let content_type = guess_content_type(&file_path);
            let disposition = if is_inline_type(content_type) { "inline" } else { "attachment" };
            let filename = file_path.rsplit('/').next().unwrap_or("file");
            // Sanitize filename: remove chars that could break Content-Disposition header
            let safe_filename: String = filename.chars().filter(|c| *c != '"' && *c != '\\' && *c != '\n' && *c != '\r').collect();

            if length.is_some() {
                // Partial content response
                let end = offset + data.len() as u64 - 1;
                let resp = Response::builder()
                    .status(StatusCode::PARTIAL_CONTENT)
                    .header(header::CONTENT_TYPE, content_type)
                    .header(header::CONTENT_LENGTH, data.len())
                    .header(header::CONTENT_RANGE, format!("bytes {}-{}/{}", offset, end, "*"))
                    .header(header::CONTENT_DISPOSITION, format!("{}; filename=\"{}\"", disposition, safe_filename))
                    .body(axum::body::Body::from(data))
                    .unwrap();
                resp.into_response()
            } else {
                let resp = Response::builder()
                    .status(StatusCode::OK)
                    .header(header::CONTENT_TYPE, content_type)
                    .header(header::CONTENT_LENGTH, data.len())
                    .header(header::CONTENT_DISPOSITION, format!("{}; filename=\"{}\"", disposition, safe_filename))
                    .body(axum::body::Body::from(data))
                    .unwrap();
                resp.into_response()
            }
        }
        _ => error_response(
            StatusCode::GATEWAY_TIMEOUT,
            "request_timeout",
            "Agent did not respond in time",
            true,
        ),
    }
}

pub async fn sys_stats_handler(
    State(state): State<AppState>,
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
            desired_roots: None,
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

    // Parse "bytes=START-END" or "bytes=START-"
    let s = s.trim();
    if !s.starts_with("bytes=") {
        return (0, None);
    }

    let range = &s[6..];
    let parts: Vec<&str> = range.split('-').collect();
    if parts.len() != 2 {
        return (0, None);
    }

    let start: u64 = parts[0].parse().unwrap_or(0);
    let length = if parts[1].is_empty() {
        None
    } else {
        parts[1].parse::<u64>().ok().map(|end| end - start + 1)
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

async fn cleanup_pending(state: &AppState, req_id: &str) {
    let pending = state.inner.read().await.pending_responses.clone();
    let mut map = pending.write().await;
    map.remove(req_id);
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

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
        assert!(is_inline_type("image/svg+xml"));
    }

    #[test]
    fn inline_type_text_is_inline() {
        assert!(is_inline_type("text/plain; charset=utf-8"));
        assert!(is_inline_type("text/html; charset=utf-8"));
        assert!(is_inline_type("text/css; charset=utf-8"));
    }

    #[test]
    fn inline_type_pdf_json_xml_js_are_inline() {
        assert!(is_inline_type("application/pdf"));
        assert!(is_inline_type("application/json"));
        assert!(is_inline_type("application/xml"));
        assert!(is_inline_type("application/javascript"));
    }

    #[test]
    fn inline_type_octet_stream_is_not_inline() {
        assert!(!is_inline_type("application/octet-stream"));
        assert!(!is_inline_type("application/zip"));
    }
}
