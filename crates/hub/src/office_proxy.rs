use std::time::Duration;

use axum::extract::{Extension, Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use filebox_protocol::message::HubMessage;
use serde::Deserialize;
use tokio::sync::mpsc;
use uuid::Uuid;

use crate::state::{AppState, AuthenticatedSession, PendingResponse};

#[derive(Debug, Deserialize)]
pub struct OfficeConvertBody {
    pub root: String,
    pub path: String,
}

/// Soft ceiling: agent default timeout is 120s; leave headroom for WS/proxy.
const HUB_OFFICE_WAIT_SECS: u64 = 3 * 60;

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

pub async fn office_convert_handler(
    State(state): State<AppState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path(agent_id): Path<String>,
    Json(body): Json<OfficeConvertBody>,
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

    let path = normalize_office_path(&body.path);
    let root = body.root.trim().to_string();

    let ext = std::path::Path::new(&path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !matches!(
        ext.as_str(),
        "doc" | "docx" | "docm" | "ppt" | "pptx" | "pptm" | "xls" | "xlsx" | "xlsm"
    ) {
        return error_response(
            StatusCode::BAD_REQUEST,
            "unsupported_format",
            "File type is not supported for Office PDF preview",
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

    if !agent.capabilities.office_pdf_preview {
        return error_response(
            StatusCode::NOT_IMPLEMENTED,
            "unsupported_feature",
            "This agent does not support Office PDF preview — configure FILEBOX_AGENT_SOFFICE",
            false,
        );
    }

    let req_id = format!("office_convert_{}", Uuid::new_v4());
    let msg = HubMessage::OfficeConvertRequest {
        req_id: req_id.clone(),
        root,
        path,
    };

    let (resp_tx, mut resp_rx) = mpsc::channel(1);
    {
        let mut pending = inner.pending_responses.write().await;
        pending.insert(
            req_id.clone(),
            PendingResponse {
                tx: resp_tx,
                agent_id: agent_id.clone(),
                session_id: Some(session.principal_id.clone()),
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

    state
        .emit_sse(
            "progress",
            serde_json::json!({
                "req_id": req_id,
                "phase": "preparing",
                "processed": 0,
                "total": 3,
                "message": "Office conversion started",
            }),
        )
        .await;

    let mut guard = CancelOnDrop {
        state: state.clone(),
        agent_id: agent_id.clone(),
        req_id: req_id.clone(),
        armed: true,
    };

    let resp = tokio::time::timeout(Duration::from_secs(HUB_OFFICE_WAIT_SECS), resp_rx.recv()).await;
    cleanup_pending(&state, &req_id).await;

    match resp {
        Ok(Some(value)) => {
            guard.disarm();
            let cache_key = value.get("cache_key").cloned().unwrap_or(serde_json::Value::Null);
            let size = value.get("size").cloned().unwrap_or(serde_json::Value::Null);
            let error = value.get("error").cloned().unwrap_or(serde_json::Value::Null);
            let cancelled = value.get("state").and_then(|v| v.as_str()) == Some("cancelled")
                || error.as_str() == Some("cancelled");

            if cancelled {
                return Json(serde_json::json!({
                    "req_id": req_id,
                    "cache_key": null,
                    "size": null,
                    "error": "cancelled",
                }))
                .into_response();
            }

            if let Some(err) = error.as_str() {
                let status = match err {
                    "agent_busy: another office conversion is already running"
                    | "agent_busy" => StatusCode::CONFLICT,
                    "too_large" => StatusCode::PAYLOAD_TOO_LARGE,
                    "denied" => StatusCode::FORBIDDEN,
                    "timeout" => StatusCode::GATEWAY_TIMEOUT,
                    "unsupported_feature" | "unsupported_format" => StatusCode::BAD_REQUEST,
                    _ => StatusCode::BAD_GATEWAY,
                };
                let code = if err.starts_with("agent_busy") {
                    "agent_busy"
                } else {
                    err
                };
                return error_response(status, code, err, matches!(code, "agent_busy" | "timeout"));
            }

            Json(serde_json::json!({
                "req_id": req_id,
                "cache_key": cache_key,
                "size": size,
                "error": null,
            }))
            .into_response()
        }
        _ => error_response(
            StatusCode::GATEWAY_TIMEOUT,
            "request_timeout",
            "Agent did not respond in time",
            true,
        ),
    }
}

fn normalize_office_path(path: &str) -> String {
    let trimmed = path.trim();
    if trimmed.is_empty() || trimmed == "." || trimmed == "./" {
        return "/".to_string();
    }
    let trimmed = trimmed.strip_prefix("./").unwrap_or(trimmed);
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
    use super::*;

    #[test]
    fn normalizes_office_path() {
        assert_eq!(normalize_office_path("report.docx"), "/report.docx");
        assert_eq!(normalize_office_path("/a/b.pptx"), "/a/b.pptx");
        assert_eq!(normalize_office_path(""), "/");
    }

    #[test]
    fn rejects_dotdot() {
        assert!(path_has_dotdot("../secret.doc"));
        assert!(path_has_dotdot("/a/../b.xls"));
        assert!(!path_has_dotdot("/folder/report.docx"));
    }
}
