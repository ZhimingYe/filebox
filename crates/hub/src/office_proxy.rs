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
    /// Optional client-generated ID so Cancel never depends on SSE delivery.
    /// Must be `office_convert_<uuid>`.
    #[serde(default)]
    pub req_id: Option<String>,
    #[serde(default)]
    pub client_nonce: Option<String>,
}

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
    if body.root.len() > 256 || body.path.len() > 4096 {
        return error_response(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "root/path is too long",
            false,
        );
    }
    if body
        .client_nonce
        .as_deref()
        .is_some_and(|nonce| nonce.is_empty() || nonce.len() > 128 || nonce.contains('\0'))
    {
        return error_response(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "client_nonce is invalid",
            false,
        );
    }
    if body
        .req_id
        .as_deref()
        .is_some_and(|req_id| !valid_office_req_id(req_id))
    {
        return error_response(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "req_id must be office_convert_<uuid>",
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
        "doc"
            | "docx"
            | "docm"
            | "ppt"
            | "pptx"
            | "pptm"
            | "xls"
            | "xlsx"
            | "xlsm"
            | "ods"
    ) {
        return error_response(
            StatusCode::BAD_REQUEST,
            "unsupported_format",
            "File type is not supported for Office preview",
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
            "This agent does not support Office preview — configure FILEBOX_AGENT_SOFFICE",
            false,
        );
    }
    if !agent.roots.iter().any(|configured| {
        configured.name == root && configured.enabled
    }) {
        return error_response(
            StatusCode::NOT_FOUND,
            "root_unavailable",
            "Root is no longer available",
            true,
        );
    }
    let hub_wait = Duration::from_secs(
        agent
            .capabilities
            .office_timeout_secs
            .unwrap_or(120)
            .min(60 * 60)
            .saturating_add(60)
            .max(60),
    );

    let req_id = body
        .req_id
        .clone()
        .unwrap_or_else(|| format!("office_convert_{}", Uuid::new_v4()));
    let msg = HubMessage::OfficeConvertRequest {
        req_id: req_id.clone(),
        root,
        path,
    };

    let (resp_tx, mut resp_rx) = mpsc::channel(1);
    let mut duplicate_req_id = false;
    let send_ok = {
        let mut pending = inner.pending_responses.write().await;
        if pending.contains_key(&req_id) {
            duplicate_req_id = true;
            false
        } else {
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
            // Enqueue the conversion while the pending map is still locked so
            // a subsequent Cancel can never overtake this request.
            inner.agents.send_to_agent(&agent_id, msg)
        }
    };

    drop(inner);
    if duplicate_req_id {
        return error_response(
            StatusCode::CONFLICT,
            "invalid_request",
            "An Office conversion with this req_id is already active",
            false,
        );
    }
    let mut guard = CancelOnDrop {
        state: state.clone(),
        agent_id: agent_id.clone(),
        req_id: req_id.clone(),
        armed: true,
    };

    if !send_ok {
        cleanup_pending(&state, &req_id).await;
        guard.disarm();
        return error_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "backend_offline",
            "Failed to send request to agent",
            true,
        );
    }

    // The request is now ordered ahead of any user Cancel on the Agent's
    // single inbound channel. This correlation event still gives the viewer a
    // deterministic req_id even if the Agent's first Progress arrived early.
    state
        .emit_sse(
            "progress",
            serde_json::json!({
                "req_id": req_id,
                "phase": "preparing",
                "processed": 0,
                // Phase markers, not bytes — omit total so UIs don't show "0 B / 3 B".
                "total": null,
                "message": "Preparing preview…",
                "client_nonce": body.client_nonce,
            }),
        )
        .await;

    let resp = tokio::time::timeout(hub_wait, resp_rx.recv()).await;
    cleanup_pending(&state, &req_id).await;

    match resp {
        Ok(Some(value)) => {
            guard.disarm();
            let cache_key = value.get("cache_key").cloned().unwrap_or(serde_json::Value::Null);
            let size = value.get("size").cloned().unwrap_or(serde_json::Value::Null);
            let outputs = value
                .get("outputs")
                .cloned()
                .unwrap_or_else(|| serde_json::json!([]));
            let error = value.get("error").cloned().unwrap_or(serde_json::Value::Null);
            let cancelled = value.get("state").and_then(|v| v.as_str()) == Some("cancelled")
                || error.as_str() == Some("cancelled");

            if cancelled {
                return Json(serde_json::json!({
                    "req_id": req_id,
                    "cache_key": null,
                    "size": null,
                    "outputs": [],
                    "error": "cancelled",
                }))
                .into_response();
            }

            if let Some(err) = error.as_str() {
                let code = match err {
                    "timeout" => "office_timeout",
                    "too_large" => "office_source_too_large",
                    "convert_failed" => "office_convert_failed",
                    legacy if legacy.starts_with("agent_busy") => "agent_busy",
                    "office_source_too_large"
                    | "office_output_too_large"
                    | "denied"
                    | "office_timeout"
                    | "office_unavailable"
                    | "root_unavailable"
                    | "office_source_unavailable"
                    | "office_storage_error"
                    | "office_cache_too_small"
                    | "unsupported_feature"
                    | "unsupported_format"
                    | "office_internal_error"
                    | "office_convert_failed" => err,
                    _ => "office_convert_failed",
                };
                let status = match code {
                    "agent_busy" => StatusCode::CONFLICT,
                    "office_source_too_large" | "office_output_too_large" => {
                        StatusCode::PAYLOAD_TOO_LARGE
                    }
                    "denied" => StatusCode::FORBIDDEN,
                    "office_timeout" => StatusCode::GATEWAY_TIMEOUT,
                    "office_unavailable" => StatusCode::SERVICE_UNAVAILABLE,
                    "root_unavailable" | "office_source_unavailable" => StatusCode::NOT_FOUND,
                    "office_storage_error" | "office_cache_too_small" => {
                        StatusCode::INSUFFICIENT_STORAGE
                    }
                    "unsupported_feature" | "unsupported_format" => StatusCode::BAD_REQUEST,
                    _ => StatusCode::BAD_GATEWAY,
                };
                let message = match code {
                    "agent_busy" => "Another Office preview is currently being prepared. Please retry shortly.",
                    "office_source_too_large" => "This Office document exceeds the Agent's configured conversion limit.",
                    "office_output_too_large" => "The converted preview exceeds the Agent's configured output limit.",
                    "denied" => "Access denied — sensitive file.",
                    "office_timeout" => "Office conversion timed out. The original file is still available.",
                    "office_unavailable" => "Office conversion is temporarily unavailable. The original file is still available.",
                    "root_unavailable" => "This root is no longer available.",
                    "office_source_unavailable" => "The source document is no longer readable.",
                    "office_storage_error" => "The Agent could not store the temporary preview.",
                    "office_cache_too_small" => "The converted preview exceeds the Agent's Office cache budget. Increase FILEBOX_AGENT_OFFICE_CACHE_BYTES.",
                    "unsupported_feature" => "Office preview is not available on this Agent.",
                    "unsupported_format" => "This file type cannot be converted for preview.",
                    "office_internal_error" => "The Office preview worker failed safely. Please retry.",
                    _ => "Office conversion failed. The original file is still available.",
                };
                let retryable = matches!(
                    code,
                    "agent_busy"
                        | "office_timeout"
                        | "office_unavailable"
                        | "office_storage_error"
                        | "office_internal_error"
                        | "office_convert_failed"
                );
                return error_response(status, code, message, retryable);
            }

            Json(serde_json::json!({
                "req_id": req_id,
                "cache_key": cache_key,
                "size": size,
                "outputs": outputs,
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

fn valid_office_req_id(req_id: &str) -> bool {
    req_id
        .strip_prefix("office_convert_")
        .is_some_and(|suffix| Uuid::parse_str(suffix).is_ok())
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
    use filebox_protocol::resources::{Capabilities, RootConfig};
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
            vec![RootConfig {
                name: "docs".to_string(),
                path: "/tmp".to_string(),
                enabled: true,
                pinned_folders: vec![],
            }],
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
                outputs: vec![filebox_protocol::message::OfficePreviewOutput {
                    label: "Document".to_string(),
                    format: "pdf".to_string(),
                    cache_key: "a".repeat(64),
                    size: 1234,
                }],
                error: None,
            },
            MockOfficeOutcome::Error(err) => AgentMessage::OfficeConvertResponse {
                req_id: req_id.to_string(),
                cache_key: None,
                size: None,
                outputs: vec![],
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
        call_convert_with_req(state, agent_id, path, None).await
    }

    async fn call_convert_with_req(
        state: AppState,
        agent_id: &str,
        path: &str,
        req_id: Option<String>,
    ) -> Response {
        office_convert_handler(
            State(state),
            test_session(),
            Path(agent_id.to_string()),
            Json(OfficeConvertBody {
                root: "docs".into(),
                path: path.into(),
                req_id,
                client_nonce: None,
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

    #[test]
    fn validates_client_generated_office_request_ids() {
        let valid = format!("office_convert_{}", Uuid::new_v4());
        assert!(valid_office_req_id(&valid));
        assert!(!valid_office_req_id("office_convert_not-a-uuid"));
        assert!(!valid_office_req_id(&Uuid::new_v4().to_string()));
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
        assert_eq!(v["outputs"][0]["label"], "Document");
        assert_eq!(v["outputs"][0]["format"], "pdf");
        assert_eq!(v["outputs"][0]["size"], 1234);
        handle.abort();
    }

    #[tokio::test]
    async fn office_convert_preserves_client_generated_request_id() {
        let state = AppState::new(&test_config(), true);
        let (tx, handle) = spawn_mock_office_agent(state.clone(), MockOfficeOutcome::Success);
        register_agent(&state, "a1", tx, true).await;
        let req_id = format!("office_convert_{}", Uuid::new_v4());
        let (status, v) = body_json(
            call_convert_with_req(state, "a1", "/report.docx", Some(req_id.clone())).await,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(v["req_id"], req_id);
        handle.abort();
    }

    #[tokio::test]
    async fn office_convert_rejects_duplicate_active_request_id() {
        let state = AppState::new(&test_config(), true);
        let (tx, handle) = spawn_mock_office_agent(
            state.clone(),
            MockOfficeOutcome::DelayThen(
                Box::new(MockOfficeOutcome::Success),
                Duration::from_secs(30),
            ),
        );
        register_agent(&state, "a1", tx, true).await;
        let req_id = format!("office_convert_{}", Uuid::new_v4());
        let first_state = state.clone();
        let first_req_id = req_id.clone();
        let first = tokio::spawn(async move {
            call_convert_with_req(
                first_state,
                "a1",
                "/report.docx",
                Some(first_req_id),
            )
            .await
        });

        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let pending = state.inner.read().await.pending_responses.clone();
                if pending.read().await.contains_key(&req_id) {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("first request registered");

        let (status, v) = body_json(
            call_convert_with_req(
                state.clone(),
                "a1",
                "/report.docx",
                Some(req_id.clone()),
            )
            .await,
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(v["error"], "invalid_request");

        let _ = crate::routes::cancel_handler(
            State(state),
            test_session(),
            Json(crate::routes::CancelRequest {
                agent_id: "a1".to_string(),
                req_id,
            }),
        )
        .await;
        let _ = first.await;
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

        let (s, e) = one("agent_busy").await;
        assert_eq!(s, StatusCode::CONFLICT);
        assert_eq!(e, "agent_busy");

        let (s, e) = one("office_timeout").await;
        assert_eq!(s, StatusCode::GATEWAY_TIMEOUT);
        assert_eq!(e, "office_timeout");

        let (s, e) = one("office_source_too_large").await;
        assert_eq!(s, StatusCode::PAYLOAD_TOO_LARGE);
        assert_eq!(e, "office_source_too_large");

        let (s, e) = one("denied").await;
        assert_eq!(s, StatusCode::FORBIDDEN);
        assert_eq!(e, "denied");

        let (s, e) = one("office_convert_failed").await;
        assert_eq!(s, StatusCode::BAD_GATEWAY);
        assert_eq!(e, "office_convert_failed");

        let (s, e) = one("office_cache_too_small").await;
        assert_eq!(s, StatusCode::INSUFFICIENT_STORAGE);
        assert_eq!(e, "office_cache_too_small");
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

        let req_id = format!("office_convert_{}", Uuid::new_v4());
        let state_for_convert = state.clone();
        let req_for_convert = req_id.clone();
        let convert_task = tokio::spawn(async move {
            call_convert_with_req(
                state_for_convert,
                "a1",
                "/slow.docx",
                Some(req_for_convert),
            )
            .await
        });

        // The client knows req_id without waiting for SSE. Only wait for the
        // POST to be registered so the test deterministically exercises Cancel.
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let pending = state.inner.read().await.pending_responses.clone();
                let map = pending.read().await;
                if map.contains_key(&req_id) {
                    return;
                }
                drop(map);
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("pending client-generated office req_id");

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
