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
    use crate::agent_registry::AgentStatus;
    use crate::routes::create_router;
    use axum::http::{header, Method, StatusCode};
    use axum::body::Body;
    use filebox_protocol::message::AgentMessage;
    use filebox_protocol::resources::Capabilities;
    use std::sync::Arc;
    use std::time::Duration;
    use tokio::sync::Notify;
    use tower::ServiceExt;

    fn test_config() -> crate::config::HubConfig {
        crate::config::HubConfig {
            listen_addr: "127.0.0.1:0".parse().unwrap(),
            agent_token_hash: "fake-hash".to_string(),
            users: vec![],
        }
    }

    fn test_session() -> Extension<AuthenticatedSession> {
        Extension(AuthenticatedSession {
            id: "test-session".to_string(),
            principal_id: "test-principal".to_string(),
        })
    }

    fn caps_with_office(on: bool) -> Capabilities {
        let mut caps = Capabilities::default();
        caps.office_pdf_preview = on;
        caps
    }

    async fn register_agent(
        state: &AppState,
        agent_id: &str,
        tx: mpsc::UnboundedSender<HubMessage>,
        office: bool,
    ) {
        let mut inner = state.inner.write().await;
        inner.agents.register(
            agent_id.to_string(),
            "MockOffice".to_string(),
            tx,
            Arc::new(Notify::new()),
            0,
            vec![],
            0,
            vec![],
            caps_with_office(office),
        );
    }

    /// Mock agent that answers OfficeConvertRequest with a fixed outcome.
    fn spawn_mock_office_agent(
        state: AppState,
        outcome: MockOfficeOutcome,
    ) -> (mpsc::UnboundedSender<HubMessage>, tokio::task::JoinHandle<()>) {
        let (tx, mut rx) = mpsc::unbounded_channel::<HubMessage>();
        let handle = tokio::spawn(async move {
            while let Some(msg) = rx.recv().await {
                match msg {
                    HubMessage::OfficeConvertRequest { req_id, .. } => {
                        if let MockOfficeOutcome::DelayThen(ref inner, delay) = outcome {
                            tokio::time::sleep(delay).await;
                            deliver_office_response(&state, &req_id, inner).await;
                        } else {
                            deliver_office_response(&state, &req_id, &outcome).await;
                        }
                        break;
                    }
                    HubMessage::Cancel { .. } => {
                        // Convert waiter is completed by cancel_handler directly.
                        break;
                    }
                    _ => {}
                }
            }
        });
        (tx, handle)
    }

    #[derive(Clone)]
    enum MockOfficeOutcome {
        Success,
        Error(&'static str),
        DelayThen(Box<MockOfficeOutcome>, Duration),
    }

    async fn deliver_office_response(state: &AppState, req_id: &str, outcome: &MockOfficeOutcome) {
        let msg = match outcome {
            MockOfficeOutcome::Success => AgentMessage::OfficeConvertResponse {
                req_id: req_id.to_string(),
                cache_key: Some("a".repeat(64)),
                size: Some(1234),
                error: None,
            },
            MockOfficeOutcome::Error(err) => AgentMessage::OfficeConvertResponse {
                req_id: req_id.to_string(),
                cache_key: None,
                size: None,
                error: Some((*err).to_string()),
            },
            MockOfficeOutcome::DelayThen(_, _) => return,
        };
        let value = serde_json::to_value(&msg).unwrap();
        let pending_arc = state.inner.read().await.pending_responses.clone();
        let mut pending = pending_arc.write().await;
        if let Some(p) = pending.remove(req_id) {
            let _ = p.tx.send(value).await;
        }
    }

    async fn call_convert(state: AppState, agent_id: &str, path: &str) -> Response {
        office_convert_handler(
            State(state),
            test_session(),
            Path(agent_id.to_string()),
            Json(OfficeConvertBody {
                root: "docs".into(),
                path: path.into(),
            }),
        )
        .await
    }

    async fn body_json(response: Response) -> (StatusCode, serde_json::Value) {
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024)
            .await
            .unwrap();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap_or_default();
        (status, v)
    }

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

    #[tokio::test]
    async fn office_convert_requires_session_cookie() {
        let app = create_router(AppState::new(&test_config(), true));
        let response = app
            .oneshot(
                axum::http::Request::builder()
                    .method(Method::POST)
                    .uri("/api/agents/any/office-convert")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(r#"{"root":"docs","path":"/a.docx"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn office_convert_rejects_without_capability() {
        let state = AppState::new(&test_config(), true);
        let (tx, _rx) = mpsc::unbounded_channel();
        register_agent(&state, "a1", tx, false).await;
        let (status, v) = body_json(call_convert(state, "a1", "/a.docx").await).await;
        assert_eq!(status, StatusCode::NOT_IMPLEMENTED);
        assert_eq!(v["error"], "unsupported_feature");
    }

    #[tokio::test]
    async fn office_convert_rejects_offline_agent() {
        let state = AppState::new(&test_config(), true);
        let (tx, _rx) = mpsc::unbounded_channel();
        register_agent(&state, "a1", tx, true).await;
        {
            let mut inner = state.inner.write().await;
            inner.agents.get_mut("a1").unwrap().status = AgentStatus::Offline;
        }
        let (status, v) = body_json(call_convert(state, "a1", "/a.docx").await).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(v["error"], "backend_offline");
    }

    #[tokio::test]
    async fn office_convert_rejects_bad_extension_and_dotdot() {
        let state = AppState::new(&test_config(), true);
        let (tx, _rx) = mpsc::unbounded_channel();
        register_agent(&state, "a1", tx, true).await;

        let (status, v) = body_json(call_convert(state.clone(), "a1", "/notes.txt").await).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(v["error"], "unsupported_format");

        let (status, v) = body_json(call_convert(state, "a1", "/../etc/passwd.docx").await).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(v["error"], "invalid_request");
    }

    #[tokio::test]
    async fn office_convert_success_returns_cache_key() {
        let state = AppState::new(&test_config(), true);
        let (tx, handle) = spawn_mock_office_agent(state.clone(), MockOfficeOutcome::Success);
        register_agent(&state, "a1", tx, true).await;
        let (status, v) = body_json(call_convert(state, "a1", "/report.docx").await).await;
        assert_eq!(status, StatusCode::OK);
        assert!(v["error"].is_null());
        assert_eq!(v["cache_key"].as_str().unwrap().len(), 64);
        assert_eq!(v["size"], 1234);
        handle.abort();
    }

    #[tokio::test]
    async fn office_convert_maps_agent_errors() {
        async fn one(err: &'static str) -> (StatusCode, String) {
            let state = AppState::new(&test_config(), true);
            let (tx, handle) =
                spawn_mock_office_agent(state.clone(), MockOfficeOutcome::Error(err));
            register_agent(&state, "a1", tx, true).await;
            let (status, v) = body_json(call_convert(state, "a1", "/a.docx").await).await;
            handle.abort();
            (status, v["error"].as_str().unwrap_or("").to_string())
        }

        let (s, e) = one("cancelled").await;
        assert_eq!(s, StatusCode::OK); // cancelled returns 200 JSON with error field
        assert_eq!(e, "cancelled");

        let (s, e) = one("agent_busy: another office conversion is already running").await;
        assert_eq!(s, StatusCode::CONFLICT);
        assert_eq!(e, "agent_busy");

        let (s, e) = one("timeout").await;
        assert_eq!(s, StatusCode::GATEWAY_TIMEOUT);
        assert_eq!(e, "timeout");

        let (s, e) = one("too_large").await;
        assert_eq!(s, StatusCode::PAYLOAD_TOO_LARGE);
        assert_eq!(e, "too_large");

        let (s, e) = one("denied").await;
        assert_eq!(s, StatusCode::FORBIDDEN);
        assert_eq!(e, "denied");

        let (s, e) = one("convert_failed").await;
        assert_eq!(s, StatusCode::BAD_GATEWAY);
        assert_eq!(e, "convert_failed");
    }

    #[tokio::test]
    async fn office_convert_cancel_completes_waiter() {
        let state = AppState::new(&test_config(), true);
        let (tx, handle) = spawn_mock_office_agent(
            state.clone(),
            MockOfficeOutcome::DelayThen(
                Box::new(MockOfficeOutcome::Success),
                Duration::from_secs(30),
            ),
        );
        register_agent(&state, "a1", tx, true).await;

        let state_for_convert = state.clone();
        let convert_task = tokio::spawn(async move {
            call_convert(state_for_convert, "a1", "/slow.docx").await
        });

        // Wait until pending has an office_convert_* entry.
        let req_id = tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let pending = state.inner.read().await.pending_responses.clone();
                let map = pending.read().await;
                if let Some(id) = map.keys().find(|k| k.starts_with("office_convert_")) {
                    return id.clone();
                }
                drop(map);
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("pending office convert req_id");

        let cancel_resp = crate::routes::cancel_handler(
            State(state.clone()),
            test_session(),
            Json(crate::routes::CancelRequest {
                agent_id: "a1".to_string(),
                req_id,
            }),
        )
        .await;
        let (cancel_status, cancel_body) = body_json(cancel_resp).await;
        assert_eq!(cancel_status, StatusCode::OK);
        assert_eq!(cancel_body["ok"], true);

        let (status, v) = body_json(convert_task.await.unwrap()).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(v["error"], "cancelled");
        handle.abort();
    }
}
