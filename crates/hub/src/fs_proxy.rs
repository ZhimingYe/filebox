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
