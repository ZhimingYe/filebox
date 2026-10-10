use axum::extract::{Extension, State, Path};
use axum::http::{header, HeaderMap, HeaderValue};
use crate::preview_doc;
use super::*;
use super::{middleware::*, preview::*, resources::*};
use crate::state::{AuthenticatedSession, GetAccessPurpose, GetAccessToken, PreviewSession, PREVIEW_SESSION_MAX_TOTAL, PREVIEW_SESSION_TTL, GET_ACCESS_TOKEN_TTL_EVENTS, GET_ACCESS_TOKEN_TTL_FILE};
use filebox_protocol::message::HubMessage;
use filebox_protocol::resources::{RootConfig, FileStat, FsEntryType, DesiredResources};
use tokio::sync::mpsc;
use filebox_protocol::message::AgentMessage;
use filebox_protocol::resources::Capabilities;
use std::sync::Arc;
use tokio::sync::Notify;
use tower::ServiceExt;

fn test_preview(session_id: &str, created_at: std::time::Instant) -> PreviewSession {
    PreviewSession {
        session_id: session_id.to_string(),
        agent_id: "agent".to_string(),
        root: "root".to_string(),
        base_path: "".to_string(),
        absolute_base_url: "http://localhost".to_string(),
        created_at,
        expires_at: created_at + PREVIEW_SESSION_TTL,
        requests_served: 0,
        bytes_served: 0,
    }
}

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

async fn register_preview_agent(
    state: &AppState,
    tx: mpsc::Sender<HubMessage>,
) {
    let mut inner = state.inner.write().await;
    inner.agents.register(
        "agent".to_string(),
        "MockAgent".to_string(),
        tx,
        Arc::new(Notify::new()),
        0,
        vec![RootConfig {
            name: "root".to_string(),
            path: "/tmp".to_string(),
            enabled: true,
            pinned_folders: vec![],
        }],
        0,
        vec![],
        Capabilities::default(),
        None,
    );
}

async fn send_agent_value(state: &AppState, req_id: &str, value: serde_json::Value) {
    let pending_arc = state.inner.read().await.pending_responses.clone();
    let mut pending = pending_arc.write().await;
    if let Some(pending) = pending.remove(req_id) {
        let _ = pending.tx.send(value).await;
    }
}

fn html_file_stat(path: &str) -> FileStat {
    FileStat {
        path: path.to_string(),
        entry_type: FsEntryType::File,
        size: 128,
        modified: None,
        permissions: None,
        denied: false,
    }
}

#[tokio::test]
async fn preview_resource_route_does_not_mirror_third_party_origin() {
    let app = create_router(AppState::new(&test_config(), true));
    let response = app
        .oneshot(
            axum::http::Request::builder()
                .uri("/api/preview/missing/index.js")
                .header(header::ORIGIN, "https://evil.example")
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    assert_eq!(
        response.headers().get(header::ACCESS_CONTROL_ALLOW_ORIGIN),
        Some(&HeaderValue::from_static("null"))
    );
}

#[tokio::test]
async fn regular_api_routes_still_mirror_request_origin() {
    let app = create_router(AppState::new(&test_config(), true));
    let origin = HeaderValue::from_static("https://app.example");
    let response = app
        .oneshot(
            axum::http::Request::builder()
                .uri("/api/health")
                .header(header::ORIGIN, origin.clone())
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.headers().get(header::ACCESS_CONTROL_ALLOW_ORIGIN),
        Some(&origin)
    );
}

#[test]
fn access_token_from_query_decodes_and_ignores_other_params() {
    assert_eq!(
        access_token_from_query("agent_id=a&access_token=ab%2Fcd&root=r").as_deref(),
        Some("ab/cd")
    );
    assert_eq!(access_token_from_query("csrf=nope&foo=bar"), None);
}

#[test]
fn query_param_matches_axum_form_urlencoded_decoding() {
    // `+` → space (www-form-urlencoded), same as serde_urlencoded / axum Query.
    assert_eq!(
        query_param("path=%2Ffoo%2Bbar%2Fbaz", "path").as_deref(),
        Some("/foo+bar/baz")
    );
    assert_eq!(
        query_param("path=/a+b/c", "path").as_deref(),
        Some("/a b/c")
    );
    // Malformed % sequences: form_urlencoded leaves them as literal text.
    assert_eq!(
        query_param("path=%ZZ/x", "path").as_deref(),
        Some("%ZZ/x")
    );
    // Empty values are skipped (no token / no scope field).
    assert_eq!(query_param("access_token=&root=r", "access_token"), None);
}

#[test]
fn csrf_tokens_equal_rejects_mismatch_and_empty() {
    assert!(csrf_tokens_equal(Some("abcd"), Some("abcd")));
    assert!(!csrf_tokens_equal(Some("abcd"), Some("abce")));
    assert!(!csrf_tokens_equal(Some("abc"), Some("abcd")));
    assert!(!csrf_tokens_equal(None, Some("abcd")));
    assert!(!csrf_tokens_equal(Some(""), Some("")));
}

#[tokio::test]
async fn protected_route_rejects_session_without_csrf() {
    let state = AppState::new(&test_config(), false);
    let (session, _) = {
        let mut inner = state.inner.write().await;
        inner.sessions.create_session("admin", false)
    };
    let app = create_router(state);
    let response = app
        .oneshot(
            axum::http::Request::builder()
                .uri("/api/agents")
                .header(
                    header::COOKIE,
                    format!("filebox_session_0={}", session.session_id),
                )
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(v["error"], "csrf_denied");
}

#[tokio::test]
async fn protected_route_accepts_csrf_header() {
    let state = AppState::new(&test_config(), false);
    let (session, _) = {
        let mut inner = state.inner.write().await;
        inner.sessions.create_session("admin", false)
    };
    let app = create_router(state);
    let response = app
        .oneshot(
            axum::http::Request::builder()
                .uri("/api/agents")
                .header(
                    header::COOKIE,
                    format!("filebox_session_0={}", session.session_id),
                )
                .header("x-csrf-token", session.csrf_token.clone())
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
}

#[tokio::test]
async fn protected_route_rejects_csrf_in_query_without_header() {
    let state = AppState::new(&test_config(), false);
    let (session, _) = {
        let mut inner = state.inner.write().await;
        inner.sessions.create_session("admin", false)
    };
    let app = create_router(state);
    let response = app
        .oneshot(
            axum::http::Request::builder()
                .uri(format!("/api/agents?csrf={}", session.csrf_token))
                .header(
                    header::COOKIE,
                    format!("filebox_session_0={}", session.session_id),
                )
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn events_accepts_scoped_access_token_without_csrf_header() {
    let state = AppState::new(&test_config(), false);
    let (session, _) = {
        let mut inner = state.inner.write().await;
        inner.sessions.create_session("admin", false)
    };
    let token = "a".repeat(64);
    {
        let now = std::time::Instant::now();
        let tokens = state.inner.read().await.get_access_tokens.clone();
        let mut map = tokens.write().await;
        map.insert(
            token.clone(),
            GetAccessToken {
                session_id: session.session_id.clone(),
                principal_id: session.principal_id.clone(),
                purpose: GetAccessPurpose::Events,
                agent_id: None,
                root: None,
                path: None,
                expires_at: now + GET_ACCESS_TOKEN_TTL_EVENTS,
                requests_served: 0,
            },
        );
    }
    let app = create_router(state);
    let response = app
        .oneshot(
            axum::http::Request::builder()
                .uri(format!("/api/events?access_token={token}"))
                .header(
                    header::COOKIE,
                    format!("filebox_session_0={}", session.session_id),
                )
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
}

#[tokio::test]
async fn protected_route_rejects_wrong_csrf_even_with_valid_session() {
    let state = AppState::new(&test_config(), false);
    let (session, _) = {
        let mut inner = state.inner.write().await;
        inner.sessions.create_session("admin", false)
    };
    let app = create_router(state);
    let response = app
        .oneshot(
            axum::http::Request::builder()
                .uri("/api/agents")
                .header(
                    header::COOKIE,
                    format!("filebox_session_0={}", session.session_id),
                )
                .header("x-csrf-token", "0".repeat(session.csrf_token.len()))
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn expired_access_token_does_not_rotate_past_half_life_session() {
    // Regression: claim used to run AFTER refresh. A failed access-token
    // claim on a half-life session retired the cookie id without Set-Cookie.
    use std::time::{SystemTime, UNIX_EPOCH};
    let state = AppState::new(&test_config(), false);
    let session_id = "half-life-sid".to_string();
    let principal_id = "half-life-principal".to_string();
    let csrf = "c".repeat(64);
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();
    {
        let mut inner = state.inner.write().await;
        inner.sessions.sessions_insert_for_test(crate::auth::Session {
            session_id: session_id.clone(),
            principal_id: principal_id.clone(),
            csrf_token: csrf,
            username: "admin".to_string(),
            permissions: vec!["view_files".to_string()],
            created_at: now.saturating_sub(80),
            expires_at: now + 20,
            ttl_secs: 100,
        });
    }
    let app = create_router(state.clone());
    let response = app
        .oneshot(
            axum::http::Request::builder()
                .uri("/api/events?access_token=deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef")
                .header(header::COOKIE, format!("filebox_session_0={session_id}"))
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    let set_cookie = response
        .headers()
        .get_all(header::SET_COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .any(|v| v.contains("filebox_session_0="));
    assert!(
        !set_cookie,
        "failed access-token claim must not emit a rotated session cookie"
    );
    let inner = state.inner.read().await;
    assert!(
        inner.sessions.get_session(&session_id).is_some(),
        "original cookie id must still be live (no rotation on failed claim)"
    );
    assert!(inner.sessions.rotation_grace_is_empty_for_test());
}

#[tokio::test]
async fn file_raw_accepts_scoped_access_token_without_csrf_header() {
    let state = AppState::new(&test_config(), false);
    let (session, _) = {
        let mut inner = state.inner.write().await;
        inner.sessions.create_session("admin", false)
    };
    let token = "b".repeat(64);
    {
        let now = std::time::Instant::now();
        let tokens = state.inner.read().await.get_access_tokens.clone();
        let mut map = tokens.write().await;
        map.insert(
            token.clone(),
            GetAccessToken {
                session_id: session.session_id.clone(),
                principal_id: session.principal_id.clone(),
                purpose: GetAccessPurpose::FileRaw,
                agent_id: Some("missing".to_string()),
                root: Some("r".to_string()),
                path: Some("/a.txt".to_string()),
                expires_at: now + GET_ACCESS_TOKEN_TTL_FILE,
                requests_served: 0,
            },
        );
    }
    // No agent → past access-token gate we expect backend_offline, not csrf_denied.
    let app = create_router(state);
    let response = app
        .oneshot(
            axum::http::Request::builder()
                .uri(format!(
                    "/api/file/raw?agent_id=missing&root=r&path=/a.txt&access_token={token}"
                ))
                .header(
                    header::COOKIE,
                    format!("filebox_session_0={}", session.session_id),
                )
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_ne!(response.status(), StatusCode::FORBIDDEN);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let text = String::from_utf8_lossy(&body);
    assert!(
        !text.contains("csrf_denied") && !text.contains("access_token_invalid"),
        "file/raw with access_token should pass auth gate: {text}"
    );
}

#[tokio::test]
async fn access_token_mint_and_use_for_events() {
    let state = AppState::new(&test_config(), false);
    let (session, _) = {
        let mut inner = state.inner.write().await;
        inner.sessions.create_session("admin", false)
    };
    let app = create_router(state);
    let mint = app
        .clone()
        .oneshot(
            axum::http::Request::builder()
                .method(Method::POST)
                .uri("/api/access-tokens")
                .header(
                    header::COOKIE,
                    format!("filebox_session_0={}", session.session_id),
                )
                .header("x-csrf-token", session.csrf_token.clone())
                .header(header::CONTENT_TYPE, "application/json")
                .body(axum::body::Body::from(r#"{"purpose":"events"}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(mint.status(), StatusCode::OK);
    let mint_body = axum::body::to_bytes(mint.into_body(), usize::MAX)
        .await
        .unwrap();
    let mint_json: serde_json::Value = serde_json::from_slice(&mint_body).unwrap();
    let token = mint_json["token"].as_str().expect("token");
    assert_eq!(token.len(), 64);

    let response = app
        .oneshot(
            axum::http::Request::builder()
                .uri(format!("/api/events?access_token={token}"))
                .header(
                    header::COOKIE,
                    format!("filebox_session_0={}", session.session_id),
                )
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
}

#[tokio::test]
async fn file_access_tokens_allow_seventy_distinct_pdf_views() {
    let state = AppState::new(&test_config(), false);
    let (session, _) = {
        let mut inner = state.inner.write().await;
        inner.sessions.create_session("admin", false)
    };
    let (tx, _rx) = mpsc::channel(256);
    register_preview_agent(&state, tx).await;
    let app = create_router(state.clone());

    for index in 0..70 {
        let response = app
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .method(Method::POST)
                    .uri("/api/access-tokens")
                    .header(
                        header::COOKIE,
                        format!("filebox_session_0={}", session.session_id),
                    )
                    .header("x-csrf-token", session.csrf_token.clone())
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(axum::body::Body::from(format!(
                        r#"{{"purpose":"file_raw","agent_id":"agent","root":"root","path":"/document-{index}.pdf"}}"#
                    )))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            StatusCode::OK,
            "PDF token mint {index} should not hit a cumulative user quota"
        );
    }

    let tokens = state.inner.read().await.get_access_tokens.clone();
    assert_eq!(tokens.read().await.len(), 70);
}

#[tokio::test]
async fn file_raw_access_token_rejects_wrong_path_scope() {
    let state = AppState::new(&test_config(), false);
    let (session, _) = {
        let mut inner = state.inner.write().await;
        inner.sessions.create_session("admin", false)
    };
    let token = "c".repeat(64);
    {
        let now = std::time::Instant::now();
        let tokens = state.inner.read().await.get_access_tokens.clone();
        let mut map = tokens.write().await;
        map.insert(
            token.clone(),
            GetAccessToken {
                session_id: session.session_id.clone(),
                principal_id: session.principal_id.clone(),
                purpose: GetAccessPurpose::FileRaw,
                agent_id: Some("a".to_string()),
                root: Some("r".to_string()),
                path: Some("/allowed.txt".to_string()),
                expires_at: now + GET_ACCESS_TOKEN_TTL_FILE,
                requests_served: 0,
            },
        );
    }
    let app = create_router(state);
    let response = app
        .oneshot(
            axum::http::Request::builder()
                .uri(format!(
                    "/api/file/raw?agent_id=a&root=r&path=/other.txt&access_token={token}"
                ))
                .header(
                    header::COOKIE,
                    format!("filebox_session_0={}", session.session_id),
                )
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(v["error"], "access_token_invalid");
}

#[tokio::test]
async fn events_access_token_rejected_on_file_raw() {
    let state = AppState::new(&test_config(), false);
    let (session, _) = {
        let mut inner = state.inner.write().await;
        inner.sessions.create_session("admin", false)
    };
    let token = "d".repeat(64);
    {
        let now = std::time::Instant::now();
        let tokens = state.inner.read().await.get_access_tokens.clone();
        let mut map = tokens.write().await;
        map.insert(
            token.clone(),
            GetAccessToken {
                session_id: session.session_id.clone(),
                principal_id: session.principal_id.clone(),
                purpose: GetAccessPurpose::Events,
                agent_id: None,
                root: None,
                path: None,
                expires_at: now + GET_ACCESS_TOKEN_TTL_EVENTS,
                requests_served: 0,
            },
        );
    }
    let app = create_router(state);
    let response = app
        .oneshot(
            axum::http::Request::builder()
                .uri(format!(
                    "/api/file/raw?agent_id=a&root=r&path=/a.txt&access_token={token}"
                ))
                .header(
                    header::COOKIE,
                    format!("filebox_session_0={}", session.session_id),
                )
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(v["error"], "access_token_invalid");
}

#[tokio::test]
async fn file_raw_access_token_does_not_exhaust_on_range_count() {
    let state = AppState::new(&test_config(), false);
    let (session, _) = {
        let mut inner = state.inner.write().await;
        inner.sessions.create_session("admin", false)
    };
    let token = "e".repeat(64);
    {
        let now = std::time::Instant::now();
        let tokens = state.inner.read().await.get_access_tokens.clone();
        let mut map = tokens.write().await;
        map.insert(
            token.clone(),
            GetAccessToken {
                session_id: session.session_id.clone(),
                principal_id: session.principal_id.clone(),
                purpose: GetAccessPurpose::FileRaw,
                agent_id: Some("a".to_string()),
                root: Some("r".to_string()),
                path: Some("/a.txt".to_string()),
                expires_at: now + GET_ACCESS_TOKEN_TTL_FILE,
                requests_served: u32::MAX,
            },
        );
    }
    let app = create_router(state);
    let response = app
        .oneshot(
            axum::http::Request::builder()
                .uri(format!(
                    "/api/file/raw?agent_id=a&root=r&path=/a.txt&access_token={token}"
                ))
                .header(
                    header::COOKIE,
                    format!("filebox_session_0={}", session.session_id),
                )
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_ne!(response.status(), StatusCode::TOO_MANY_REQUESTS);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_ne!(v["error"], "access_token_exhausted");
}

#[tokio::test]
async fn logout_clears_get_access_tokens_for_session() {
    let state = AppState::new(&test_config(), false);
    let (session, _) = {
        let mut inner = state.inner.write().await;
        inner.sessions.create_session("admin", false)
    };
    let token = "f".repeat(64);
    {
        let now = std::time::Instant::now();
        let tokens = state.inner.read().await.get_access_tokens.clone();
        let mut map = tokens.write().await;
        map.insert(
            token.clone(),
            GetAccessToken {
                session_id: session.session_id.clone(),
                principal_id: session.principal_id.clone(),
                purpose: GetAccessPurpose::Events,
                agent_id: None,
                root: None,
                path: None,
                expires_at: now + GET_ACCESS_TOKEN_TTL_EVENTS,
                requests_served: 0,
            },
        );
    }
    let app = create_router(state.clone());
    let mut req = axum::http::Request::builder()
        .method(Method::POST)
        .uri("/api/session/logout")
        .header(
            header::COOKIE,
            format!("filebox_session_0={}", session.session_id),
        )
        .header("x-csrf-token", session.csrf_token.clone())
        .body(axum::body::Body::empty())
        .unwrap();
    // logout handler extracts ConnectInfo for audit logging.
    req.extensions_mut().insert(axum::extract::ConnectInfo(
        std::net::SocketAddr::from(([127, 0, 0, 1], 12345)),
    ));
    let logout = app.oneshot(req).await.unwrap();
    assert_eq!(logout.status(), StatusCode::OK);
    let tokens = state.inner.read().await.get_access_tokens.clone();
    let map = tokens.read().await;
    assert!(!map.contains_key(&token));
}

#[tokio::test]
async fn logout_revokes_only_its_principals_terminal_attachments() {
    let state = AppState::new(&test_config(), false);
    let (session, _) = state.inner.write().await.sessions.create_session("admin", false);
    let revoked = Arc::new(tokio::sync::Notify::new());
    let other_revoked = Arc::new(tokio::sync::Notify::new());
    let (tx, mut rx) = tokio::sync::mpsc::channel(1);
    tx.try_send(serde_json::json!({ "type": "output", "data": "queued" })).unwrap();
    {
        let mut terminals = state.terminal_sessions.lock().unwrap();
        for (id, principal, notify) in [
            ("mine", session.principal_id.clone(), revoked.clone()),
            ("other", "other-principal".into(), other_revoked.clone()),
        ] {
            terminals.insert(id.into(), crate::terminal_proxy::TerminalSessionEntry {
                agent_id: "a".into(), connection_id: 1, principal_id: principal, revoked: notify,
                username: "admin".into(), ip: "127.0.0.1".into(), user_agent: String::new(), tx: tx.clone(),
            });
        }
    }
    let mut req = axum::http::Request::builder().method(Method::POST).uri("/api/session/logout")
        .header(header::COOKIE, format!("filebox_session_0={}", session.session_id))
        .header("x-csrf-token", &session.csrf_token).body(axum::body::Body::empty()).unwrap();
    req.extensions_mut().insert(axum::extract::ConnectInfo(
        std::net::SocketAddr::from(([127, 0, 0, 1], 12345)),
    ));
    assert_eq!(create_router(state.clone()).oneshot(req).await.unwrap().status(), StatusCode::OK);
    tokio::time::timeout(std::time::Duration::from_secs(1), revoked.notified()).await.unwrap();
    assert!(tokio::time::timeout(std::time::Duration::from_millis(10), other_revoked.notified()).await.is_err());
    let terminals = state.terminal_sessions.lock().unwrap();
    assert!(!terminals.contains_key("mine"));
    assert!(terminals.contains_key("other"));
    // Immediate notification did not require consuming queued output.
    assert_eq!(rx.try_recv().unwrap()["data"], "queued");
}

#[test]
fn csrf_cookie_header_sets_secure_host_prefix_in_prod() {
    let header = csrf_cookie_header("abc123", 60, true, 0);
    let value = header.to_str().unwrap();
    assert!(value.starts_with("__Host-filebox_csrf_0=abc123"));
    assert!(value.contains("Secure"));
    assert!(value.contains("SameSite=Strict"));
    assert!(value.contains("Path=/"));
    assert!(!value.contains("HttpOnly"));
}

#[test]
fn csrf_cookie_header_omits_secure_in_dev() {
    let header = csrf_cookie_header("abc123", 60, false, 0);
    let value = header.to_str().unwrap();
    assert!(value.starts_with("filebox_csrf_0=abc123"));
    assert!(!value.contains("Secure"));
    assert!(!value.contains("HttpOnly"));
}

#[test]
fn cookie_names_are_suffixed_with_listen_port() {
    assert_eq!(session_cookie_name(false, 3000), "filebox_session_3000");
    assert_eq!(session_cookie_name(true, 3001), "__Host-filebox_session_3001");
    assert_eq!(csrf_cookie_name(false, 8080), "filebox_csrf_8080");
    assert_eq!(csrf_cookie_name(true, 8081), "__Host-filebox_csrf_8081");
}

#[test]
fn session_cookie_header_keeps_security_attrs_with_port_suffix() {
    let header = session_cookie_header("sid", 3600, true, 8443);
    let value = header.to_str().unwrap();
    assert!(value.starts_with("__Host-filebox_session_8443=sid"));
    assert!(value.contains("HttpOnly"));
    assert!(value.contains("Secure"));
    assert!(value.contains("SameSite=Strict"));
    assert!(value.contains("Path=/"));
    assert!(value.contains("Max-Age=3600"));
}

#[test]
fn different_ports_produce_distinct_cookie_names() {
    assert_ne!(
        session_cookie_name(false, 3000),
        session_cookie_name(false, 3001)
    );
}

#[tokio::test]
async fn workspace_search_requires_session_cookie() {
    // Unauthenticated callers must not reach the search proxy — even with a
    // well-formed body and a known-looking agent id.
    let app = create_router(AppState::new(&test_config(), true));
    let response = app
        .oneshot(
            axum::http::Request::builder()
                .method(Method::POST)
                .uri("/api/agents/any-agent/workspace-search")
                .header(header::CONTENT_TYPE, "application/json")
                .body(axum::body::Body::from(
                    r#"{"mode":"content","root":"r","path":"/","query":"x"}"#,
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    let body = axum::body::to_bytes(response.into_body(), 1024).await.unwrap();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["error"], "unauthorized");
}

#[tokio::test]
async fn workspace_search_rejects_invalid_session_cookie() {
    let app = create_router(AppState::new(&test_config(), true));
    let response = app
        .oneshot(
            axum::http::Request::builder()
                .method(Method::POST)
                .uri("/api/agents/any-agent/workspace-search")
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::COOKIE, "filebox_session_0=forged-session-id")
                .body(axum::body::Body::from(
                    r#"{"mode":"find","root":"r","path":"/","query":""}"#,
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    let body = axum::body::to_bytes(response.into_body(), 1024).await.unwrap();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["error"], "session_expired");
}

#[tokio::test]
async fn cancel_requires_session_cookie() {
    let app = create_router(AppState::new(&test_config(), true));
    let response = app
        .oneshot(
            axum::http::Request::builder()
                .method(Method::POST)
                .uri("/api/cancel")
                .header(header::CONTENT_TYPE, "application/json")
                .body(axum::body::Body::from(
                    r#"{"agent_id":"any-agent","req_id":"req_1"}"#,
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    let body = axum::body::to_bytes(response.into_body(), 1024).await.unwrap();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["error"], "unauthorized");
}

#[tokio::test]
async fn patch_root_rejects_pin_against_legacy_agent() {
    // P1 capability gate: a legacy agent (no pinned_folders capability)
    // would silently drop pin data and reply "applied", fooling the hub +
    // UI into thinking pins persisted. patch_root must reject any pin-touching
    // PATCH against such an agent with 400 unsupported_feature instead. We
    // register an agent with Capabilities::default() (pinned_folders=false)
    // and assert a pin_add returns the gated error.
    let state = AppState::new(&test_config(), true);
    {
        let (tx, _rx) = mpsc::channel::<HubMessage>(256);
        let mut inner = state.inner.write().await;
        inner.agents.register(
            "legacy-agent".to_string(),
            "Legacy".to_string(),
            tx,
            Arc::new(Notify::new()),
            1,
            vec![RootConfig {
                name: "demo".to_string(),
                path: "/tmp".to_string(),
                enabled: true,
                pinned_folders: vec![],
            }],
        0,
        vec![],
        Capabilities::default(), // pinned_folders = false
        None,
        );
    }

    let response = patch_root_handler(
        State(state.clone()),
        test_session(),
        Path(("legacy-agent".to_string(), "demo".to_string())),
        Json(PatchRootRequest {
            enabled: None,
            name: None,
            path: None,
            pinned_folders: None,
            pin_add: Some("/sub".to_string()),
            pin_remove: None,
        }),
    )
    .await;

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(v["error"], "unsupported_feature");
}

#[tokio::test]
async fn patch_root_rejects_unpin_all_against_legacy_agent() {
    // Same gate, but for a non-empty pinned_folders array (replace-whole-
    // array mode). An explicit `[]` (unpin-all) is treated as a no-op
    // success against a legacy agent (there's nothing to lose), so only a
    // NON-empty array triggers the gate.
    let state = AppState::new(&test_config(), true);
    {
        let (tx, _rx) = mpsc::channel::<HubMessage>(256);
        let mut inner = state.inner.write().await;
        inner.agents.register(
            "legacy-agent".to_string(),
            "Legacy".to_string(),
            tx,
            Arc::new(Notify::new()),
            1,
            vec![RootConfig {
                name: "demo".to_string(),
                path: "/tmp".to_string(),
                enabled: true,
                pinned_folders: vec![],
            }],
        0,
        vec![],
        Capabilities::default(),
        None,
        );
    }

    // Non-empty array → rejected (legacy agent can't persist these).
    let response = patch_root_handler(
        State(state.clone()),
        test_session(),
        Path(("legacy-agent".to_string(), "demo".to_string())),
        Json(PatchRootRequest {
            enabled: None,
            name: None,
            path: None,
            pinned_folders: Some(vec!["/a".to_string(), "/b".to_string()]),
            pin_add: None,
            pin_remove: None,
        }),
    )
    .await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}

#[test]
fn preview_file_path_normalizes_without_allowing_escape() {
    assert_eq!(
        normalize_preview_file_path("/reports/run1/./index.HTML"),
        Some("reports/run1/index.HTML".to_string())
    );
    assert!(normalize_preview_file_path("../secret.html").is_none());
    assert!(normalize_preview_file_path("reports\\secret.html").is_none());
}

#[test]
fn preview_base_path_uses_html_parent_directory() {
    assert_eq!(preview_base_path("reports/run1/index.html"), "reports/run1");
    assert_eq!(preview_base_path("index.html"), "");
}

#[tokio::test]
async fn preview_session_create_requires_agent_stat_success() {
    let state = AppState::new(&test_config(), true);
    let (tx, mut rx) = mpsc::channel::<HubMessage>(256);
    let state_for_agent = state.clone();
    let agent_handle = tokio::spawn(async move {
        if let Some(HubMessage::FsStatRequest { req_id, .. }) = rx.recv().await {
            let response = AgentMessage::FsStatResponse {
                req_id: req_id.clone(),
                stat: None,
                error: Some("missing".to_string()),
            };
            send_agent_value(&state_for_agent, &req_id, serde_json::to_value(response).unwrap()).await;
        }
    });
    register_preview_agent(&state, tx).await;

    let response = preview_session_create_handler(
        State(state.clone()),
        test_session(),
        HeaderMap::new(),
        Json(PreviewSessionCreateRequest {
            agent_id: "agent".to_string(),
            root: "root".to_string(),
            path: "missing.html".to_string(),
        }),
    )
    .await;

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let preview_sessions = state.inner.read().await.preview_sessions.clone();
    assert!(preview_sessions.read().await.is_empty());

    agent_handle.abort();
}

#[tokio::test]
async fn preview_session_create_verifies_read_before_issuing_token() {
    let state = AppState::new(&test_config(), true);
    let (tx, mut rx) = mpsc::channel::<HubMessage>(256);
    let state_for_agent = state.clone();
    let agent_handle = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            match msg {
                HubMessage::FsStatRequest { req_id, path, .. } => {
                    let response = AgentMessage::FsStatResponse {
                        req_id: req_id.clone(),
                        stat: Some(html_file_stat(&path)),
                        error: None,
                    };
                    send_agent_value(&state_for_agent, &req_id, serde_json::to_value(response).unwrap()).await;
                }
                HubMessage::FileReadRequest { req_id, length, .. } => {
                    assert_eq!(length, Some(0));
                    let response = AgentMessage::FileChunk {
                        req_id: req_id.clone(),
                        offset: 0,
                        data: vec![],
                        done: true,
                        error: None,
                        file_size: None,
                        modified: None,
                    };
                    send_agent_value(&state_for_agent, &req_id, serde_json::to_value(response).unwrap()).await;
                    break;
                }
                _ => {}
            }
        }
    });
    register_preview_agent(&state, tx).await;

    let response = preview_session_create_handler(
        State(state.clone()),
        test_session(),
        HeaderMap::new(),
        Json(PreviewSessionCreateRequest {
            agent_id: "agent".to_string(),
            root: "root".to_string(),
            path: "reports/run 1/index.html".to_string(),
        }),
    )
    .await;

    assert_eq!(response.status(), StatusCode::OK);
    let bytes = axum::body::to_bytes(response.into_body(), 4096)
        .await
        .unwrap();
    let body = String::from_utf8(bytes.to_vec()).unwrap();
    assert!(body.contains("/api/preview/"), "body: {}", body);
    assert!(body.contains("/reports/run%201/"), "body: {}", body);
    let preview_sessions = state.inner.read().await.preview_sessions.clone();
    let previews = preview_sessions.read().await;
    assert_eq!(previews.len(), 1);
    assert_eq!(previews.values().next().unwrap().base_path, "reports/run 1");

    agent_handle.abort();
}

#[test]
fn preview_session_only_accepts_html_extensions() {
    assert!(preview_doc::is_html_path("report.HTML"));
    assert!(preview_doc::is_html_path("report.htm"));
    assert!(!preview_doc::is_html_path("report.md"));
    assert!(!preview_doc::is_html_path("report"));
}

#[test]
fn preview_pruning_is_global_memory_bound_not_user_activity_quota() {
    let base = std::time::Instant::now();
    let mut previews = std::collections::HashMap::new();
    for i in 0..(PREVIEW_SESSION_MAX_TOTAL + 5) {
        previews.insert(
            format!("s1-{}", i),
            test_preview("s1", base + std::time::Duration::from_millis(i as u64)),
        );
    }

    prune_preview_sessions_for_insert(&mut previews);

    assert_eq!(previews.len(), PREVIEW_SESSION_MAX_TOTAL - 1);
    assert!(previews.contains_key(&format!("s1-{}", PREVIEW_SESSION_MAX_TOTAL + 4)));
    assert!(!previews.contains_key("s1-0"));
}

#[tokio::test]
async fn abandoned_resource_waiter_keeps_accepted_intent_for_replay() {
    let state = AppState::new(&test_config(), false);
    let (agent_tx, mut agent_rx) = mpsc::channel(8);
    register_preview_agent(&state, agent_tx).await;
    let desired = DesiredResources { roots: vec![RootConfig {
        name: "new-root".into(), path: "/new-root".into(), enabled: true, pinned_folders: vec![],
    }] };
    let task = tokio::spawn(apply_desired_state(state.clone(), "agent".into(), desired.clone(), "principal".into()));
    let req_id = match tokio::time::timeout(std::time::Duration::from_secs(1), agent_rx.recv()).await.unwrap().unwrap() {
        HubMessage::ResourcesSetDesired { req_id, roots, .. } => { assert_eq!(roots, desired.roots); req_id }
        other => panic!("unexpected request {other:?}"),
    };
    task.abort();
    let _ = task.await;
    tokio::time::timeout(std::time::Duration::from_secs(1), async {
        while state.inner.read().await.pending_responses.read().await.contains_key(&req_id) { tokio::task::yield_now().await; }
    }).await.unwrap();
    let inner = state.inner.read().await;
    let agent = inner.agents.get("agent").unwrap();
    assert_eq!(agent.pending_update.as_ref().unwrap().roots, desired.roots);
    assert_eq!(agent.pending_resource_request.as_deref(), Some(req_id.as_str()));
    assert_eq!(agent.roots[0].name, "root", "last good applied roots must survive a dropped waiter");
    assert!(agent_rx.try_recv().is_err(), "accepted configuration changes must not be cancelled with a dropped HTTP waiter");
}
