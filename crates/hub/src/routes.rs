use axum::extract::{Extension, Path, State};
use axum::http::{header, HeaderMap, HeaderName, HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post, put};
use axum::{Json, Router};
use filebox_protocol::message::HubMessage;
use filebox_protocol::resources::{
    validate_collection_item_path, validate_collection_name, validate_pinned_path,
    CollectionConfig, CollectionItem, DesiredCollections, DesiredResources, FileStat, FsEntryType,
    RootConfig,
};
use rand::Rng;
use tokio::sync::mpsc;
use tower_http::cors::{AllowOrigin, CorsLayer};
use tower_http::services::ServeDir;

use crate::agent_registry::AgentStatus;
use crate::net::client_ip;
use crate::state::{
    AppState, AuthenticatedSession, PendingResponse, PreviewSession,
    PREVIEW_SESSION_MAX_PER_SESSION, PREVIEW_SESSION_MAX_TOTAL, PREVIEW_SESSION_TTL,
};
use crate::{events, fs_proxy, health, ws};

pub fn create_router(state: AppState) -> Router {
    // Public routes (no auth required)
    let public = Router::new()
        .route("/api/health", get(health::health_handler))
        .route("/api/session/exchange", post(session_exchange_handler))
        .route("/ws/agent", get(ws::ws_handler));

    let preview_resources = Router::new().route(
        "/api/preview/{token}/{*resource_path}",
        get(fs_proxy::preview_resource_handler).options(fs_proxy::preview_options_handler),
    );

    // Protected routes (session cookie required)
    let protected = Router::new()
        .route("/api/events", get(events::sse_handler))
        .route("/api/session/logout", post(session_logout_handler))
        .route("/api/agents", get(agents_list_handler))
        .route("/api/agents/{agent_id}", get(agent_detail_handler))
        .route(
            "/api/agents/{agent_id}/resources",
            get(agent_resources_handler),
        )
        .route(
            "/api/agents/{agent_id}/resources",
            put(agent_resources_put_handler),
        )
        .route("/api/agents/{agent_id}/roots", post(add_root_handler))
        .route(
            "/api/agents/{agent_id}/roots/{root_name}",
            patch(patch_root_handler),
        )
        .route(
            "/api/agents/{agent_id}/roots/{root_name}",
            delete(delete_root_handler),
        )
        .route(
            "/api/agents/{agent_id}/collections",
            post(add_collection_handler),
        )
        .route(
            "/api/agents/{agent_id}/collections/{collection_name}",
            patch(patch_collection_handler),
        )
        .route(
            "/api/agents/{agent_id}/collections/{collection_name}",
            delete(delete_collection_handler),
        )
        .route("/api/fs/list", get(fs_proxy::fs_list_handler))
        .route("/api/fs/stat", get(fs_proxy::fs_stat_handler))
        .route("/api/file/raw", get(fs_proxy::file_raw_handler))
        .route("/api/preview/sessions", post(preview_session_create_handler))
        .route("/api/agents/{agent_id}/sys-stats", get(fs_proxy::sys_stats_handler))
        .route("/api/cancel", post(cancel_handler))
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            require_session,
        ));

    // Resolve frontend/dist.
    // Order: FILEBOX_FRONTEND_DIR env → cwd → walk up from binary location.
    let frontend_path = find_frontend_dist().unwrap_or_else(|| {
        eprintln!("[hub] WARNING: frontend/dist not found");
        eprintln!("[hub] Set FILEBOX_FRONTEND_DIR, run from a directory containing frontend/dist,");
        eprintln!("[hub] or place frontend/dist as a sibling of the binary's parent dir.");
        std::path::PathBuf::from("frontend/dist")
    });
    eprintln!("[hub] frontend: {}", frontend_path.display());

    fn find_frontend_dist() -> Option<std::path::PathBuf> {
        // 1. Explicit env override (highest priority)
        if let Ok(p) = std::env::var("FILEBOX_FRONTEND_DIR") {
            let path = std::path::PathBuf::from(&p);
            if path.exists() {
                return Some(path);
            }
            eprintln!(
                "[hub] WARNING: FILEBOX_FRONTEND_DIR={} does not exist, ignoring",
                p
            );
        }

        // 2. Check cwd first (common dev case: run from project root)
        let cwd_candidate = std::path::PathBuf::from("frontend/dist");
        if cwd_candidate.exists() {
            return Some(cwd_candidate);
        }

        // 3. Walk up from binary location, up to 5 levels
        let mut dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
        for _ in 0..5 {
            let candidate = dir.join("frontend/dist");
            if candidate.exists() {
                return Some(candidate);
            }
            if !dir.pop() {
                break;
            }
        }
        None
    }

    let frontend = ServeDir::new(frontend_path);

    // CORS: mirror request origin so credentials work (browsers reject ACAO:* with credentials)
    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::mirror_request())
        .allow_methods([Method::GET, Method::POST, Method::PATCH, Method::PUT, Method::DELETE])
        .allow_headers([header::CONTENT_TYPE, header::COOKIE, header::RANGE])
        .allow_credentials(true);

    let cors_app = Router::new()
        .merge(public)
        .merge(protected)
        .fallback_service(frontend)
        .layer(cors);

    Router::new()
        .merge(preview_resources)
        .merge(cors_app)
        .layer(axum::extract::DefaultBodyLimit::max(1024 * 1024)) // 1MB max request body
        .layer(axum::middleware::from_fn(security_headers))
        .layer(axum::middleware::from_fn(cache_headers))
        .with_state(state)
}

async fn security_headers(
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> Response {
    // HSTS only makes sense over TLS: sending it on a plaintext HTTP response
    // poisons browsers (some engines remember it anyway, especially with
    // includeSubDomains), which then force-upgrade http://127.0.0.1 to https://
    // and break against a hub that only listens on plain HTTP. Only emit HSTS
    // when this request actually arrived over TLS — either directly (scheme
    // https) or behind a reverse proxy that advertised it via X-Forwarded-Proto.
    let is_https = req.uri().scheme_str() == Some("https")
        || req
            .headers()
            .get("x-forwarded-proto")
            .and_then(|v| v.to_str().ok())
            .map(|v| v.eq_ignore_ascii_case("https"))
            .unwrap_or(false);
    let mut resp = next.run(req).await;
    let headers = resp.headers_mut();
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        HeaderName::from_static("x-frame-options"),
        HeaderValue::from_static("DENY"),
    );
    if is_https {
        headers.insert(
            header::STRICT_TRANSPORT_SECURITY,
            HeaderValue::from_static("max-age=31536000; includeSubDomains"),
        );
    }
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("same-origin"),
    );
    if !headers.contains_key(header::CONTENT_SECURITY_POLICY) {
        headers.insert(
            header::CONTENT_SECURITY_POLICY,
            HeaderValue::from_static("frame-ancestors 'none'"),
        );
    }
    resp
}

// Set Cache-Control on frontend static responses. Skips /api/ and /ws/ so the
// existing API/SSE caching semantics are untouched. Only touches 2xx responses;
// errors keep their default headers.
async fn cache_headers(
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> Response {
    let path = req.uri().path().to_string();
    let mut resp = next.run(req).await;
    if !resp.status().is_success() || path.starts_with("/api/") || path.starts_with("/ws/") {
        return resp;
    }
    // index.html must always be revalidated so a stale cached copy can never
    // reference hashed JS that has been removed by a newer deployment.
    // /assets/* filenames are content-hashed by Vite, so immutable is safe.
    let cc = if path == "/" || path.ends_with(".html") {
        "no-cache, must-revalidate"
    } else if path.starts_with("/assets/") {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    };
    if let Ok(v) = HeaderValue::from_str(cc) {
        resp.headers_mut().insert(header::CACHE_CONTROL, v);
    }
    resp
}

// ── Session Middleware ─────────────────────────────────────────────────────

async fn require_session(
    State(state): State<AppState>,
    mut req: axum::extract::Request,
    next: axum::middleware::Next,
) -> Response {
    let is_logout = req.uri().path() == "/api/session/logout";
    if req
        .headers()
        .get(header::ORIGIN)
        .and_then(|v| v.to_str().ok())
        == Some("null")
    {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({
                "error": "permission_denied",
                "message": "Sandboxed previews cannot call Filebox control APIs",
                "retryable": false,
            })),
        )
            .into_response();
    }

    let session_id = session_cookie(req.headers());

    let Some(sid) = session_id else {
        return (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({
                "error": "unauthorized",
                "message": "No session cookie. Please login first.",
                "retryable": false,
            })),
        )
            .into_response();
    };

    let rotated_cookie = {
        let mut inner = state.inner.write().await;
        let session_result = if is_logout {
            inner.sessions.get_session(&sid).cloned().map(|s| (s, None))
        } else {
            inner.sessions.get_session_rotating(&sid)
        };
        match session_result {
            Some((session, rotated)) => {
                req.extensions_mut().insert(AuthenticatedSession {
                    id: session.session_id.clone(),
                });
                rotated.map(|(new_id, max_age)| session_cookie_header(&new_id, max_age, state.secure_cookies))
            }
            None => {
                return (
                    StatusCode::UNAUTHORIZED,
                    Json(serde_json::json!({
                        "error": "session_expired",
                        "message": "Session expired or invalid. Please login again.",
                        "retryable": false,
                    })),
                )
                    .into_response();
            }
        }
    };

    let mut resp = next.run(req).await;
    if let Some(cookie) = rotated_cookie {
        resp.headers_mut().append(header::SET_COOKIE, cookie);
    }
    resp
}

fn session_cookie(headers: &HeaderMap) -> Option<String> {
    let cookies = headers
        .get(header::COOKIE)
        .and_then(|v| v.to_str().ok())
        ?;

    cookie_value(cookies, "__Host-filebox_session")
        .or_else(|| cookie_value(cookies, "filebox_session"))
}

fn cookie_value(cookies: &str, name: &str) -> Option<String> {
    let prefix = format!("{}=", name);
    cookies.split(';').find_map(|c| {
        c.trim()
            .strip_prefix(&prefix)
            .map(|sid| sid.to_string())
    })
}

fn session_cookie_header(session_id: &str, max_age: u64, secure: bool) -> HeaderValue {
    let name = if secure { "__Host-filebox_session" } else { "filebox_session" };
    let secure_flag = if secure { "; Secure" } else { "" };
    HeaderValue::from_str(&format!(
        "{}={}; HttpOnly{}; SameSite=Strict; Path=/; Max-Age={}",
        name, session_id, secure_flag, max_age
    ))
    .unwrap()
}

fn clear_session_cookie_headers(secure: bool) -> [HeaderValue; 2] {
    let secure_flag = if secure { "; Secure" } else { "" };
    let host_header = HeaderValue::from_str(&format!(
        "__Host-filebox_session=; HttpOnly{}; SameSite=Strict; Path=/; Max-Age=0",
        secure_flag
    )).unwrap();
    let plain_header = HeaderValue::from_str(&format!(
        "filebox_session=; HttpOnly{}; SameSite=Strict; Path=/; Max-Age=0",
        secure_flag
    )).unwrap();
    [host_header, plain_header]
}

// ── Session ──────────────────────────────────────────────────────────────────

#[derive(serde::Deserialize)]
struct SessionExchangeRequest {
    username: String,
    password: String,
    remember: Option<bool>,
}

async fn session_exchange_handler(
    State(state): State<AppState>,
    axum::extract::ConnectInfo(addr): axum::extract::ConnectInfo<std::net::SocketAddr>,
    headers: axum::http::HeaderMap,
    Json(req): Json<SessionExchangeRequest>,
) -> Response {
    let ip = client_ip(&headers, addr);

    // Rate limit check
    if let Err(remaining) = state.rate_limiter.check(&ip) {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            Json(serde_json::json!({
                "error": "too_many_requests",
                "message": format!("Too many login attempts. Try again in {} seconds.", remaining),
                "retryable": true,
            })),
        )
            .into_response();
    }

    let mut inner = state.inner.write().await;

    if !inner.sessions.validate_login(&req.username, &req.password) {
        drop(inner);
        state.rate_limiter.record_failure(&ip);
        tracing::warn!(target: "audit", ip = %ip, user = %req.username, "login_failed");
        return (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({
                "error": "invalid_credentials",
                "message": "Invalid username or password",
                "retryable": false,
            })),
        )
            .into_response();
    }

    let remember = req.remember.unwrap_or(false);
    let (session, ttl) = inner.sessions.create_session(&req.username, remember);
    let session_id = session.session_id.clone();
    drop(inner);

    // Clear rate limit on successful login
    state.rate_limiter.clear(&ip);

    tracing::info!(target: "audit", ip = %ip, user = %req.username, "login_success");

    let mut resp = (
        StatusCode::OK,
        Json(serde_json::json!({
            "ok": true,
            "permissions": session.permissions,
        })),
    )
        .into_response();
    resp.headers_mut()
        .append(header::SET_COOKIE, session_cookie_header(&session_id, ttl, state.secure_cookies));
    resp
}

async fn session_logout_handler(
    State(state): State<AppState>,
    Extension(session): Extension<AuthenticatedSession>,
    headers: HeaderMap,
    axum::extract::ConnectInfo(addr): axum::extract::ConnectInfo<std::net::SocketAddr>,
) -> Response {
    let ip = client_ip(&headers, addr);
    let mut inner = state.inner.write().await;
    inner.sessions.remove(&session.id);
    let preview_sessions = inner.preview_sessions.clone();
    drop(inner);
    {
        let mut previews = preview_sessions.write().await;
        previews.retain(|_, preview| preview.session_id != session.id);
    }

    tracing::info!(target: "audit", ip = %ip, "logout");

    let mut resp = (
        StatusCode::OK,
        Json(serde_json::json!({ "ok": true })),
    )
        .into_response();
    for cookie in clear_session_cookie_headers(state.secure_cookies) {
        resp.headers_mut().append(header::SET_COOKIE, cookie);
    }
    resp
}

// ── Sandboxed HTML Preview Sessions ─────────────────────────────────────────

#[derive(serde::Deserialize)]
struct PreviewSessionCreateRequest {
    agent_id: String,
    root: String,
    path: String,
}

#[derive(serde::Serialize)]
struct PreviewSessionCreateResponse {
    base_url: String,
    expires_in_sec: u64,
}

async fn preview_session_create_handler(
    State(state): State<AppState>,
    Extension(session): Extension<AuthenticatedSession>,
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
    if !is_html_preview_path(&file_path) {
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
        &session.id,
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
        &session.id,
        &req.agent_id,
        &req.root,
        &file_path,
    )
    .await
    {
        return resp;
    }

    let now = std::time::Instant::now();
    let token = generate_preview_token();
    let expires_at = now + PREVIEW_SESSION_TTL;
    let preview = PreviewSession {
        session_id: session.id.clone(),
        agent_id: req.agent_id.clone(),
        root: req.root.clone(),
        base_path: base_path.clone(),
        created_at: now,
        expires_at,
        requests_served: 0,
        bytes_served: 0,
    };

    {
        let now = std::time::Instant::now();
        let mut previews = preview_sessions.write().await;
        previews.retain(|_, preview| preview.expires_at > now);
        prune_preview_sessions_for_insert(&mut previews, &session.id);
        previews.insert(token.clone(), preview);
    }

    Json(PreviewSessionCreateResponse {
        base_url: preview_base_url(&token, &base_path),
        expires_in_sec: PREVIEW_SESSION_TTL.as_secs(),
    })
    .into_response()
}

async fn request_preview_stat(
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

async fn request_preview_read_probe(
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

async fn request_agent_once(
    state: &AppState,
    session_id: &str,
    agent_id: &str,
    req_id: String,
    msg: HubMessage,
) -> Result<serde_json::Value, Response> {
    let (resp_tx, mut resp_rx) = mpsc::channel(1);
    let send_ok = {
        let inner = state.inner.read().await;
        let mut pending = inner.pending_responses.write().await;
        pending.insert(
            req_id.clone(),
            PendingResponse {
                tx: resp_tx,
                agent_id: agent_id.to_string(),
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

    let cleanup = PendingRequestCleanup::new(state.clone(), req_id.clone());
    let resp = tokio::time::timeout(std::time::Duration::from_secs(30), resp_rx.recv()).await;
    cleanup.cleanup().await;
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

async fn cleanup_pending_request(state: &AppState, req_id: &str) {
    let pending = state.inner.read().await.pending_responses.clone();
    let mut pending = pending.write().await;
    pending.remove(req_id);
}

struct PendingRequestCleanup {
    state: AppState,
    req_id: String,
    active: bool,
}

impl PendingRequestCleanup {
    fn new(state: AppState, req_id: String) -> Self {
        Self {
            state,
            req_id,
            active: true,
        }
    }

    async fn cleanup(mut self) {
        cleanup_pending_request(&self.state, &self.req_id).await;
        self.active = false;
    }
}

impl Drop for PendingRequestCleanup {
    fn drop(&mut self) {
        if !self.active {
            return;
        }
        let state = self.state.clone();
        let req_id = self.req_id.clone();
        tokio::spawn(async move {
            cleanup_pending_request(&state, &req_id).await;
        });
    }
}

fn preview_invalid_response(message: &str) -> Response {
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

fn normalize_preview_file_path(raw: &str) -> Option<String> {
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

fn preview_base_path(file_path: &str) -> String {
    file_path
        .rsplit_once('/')
        .map(|(base, _)| base.to_string())
        .unwrap_or_default()
}

fn preview_base_url(token: &str, base_path: &str) -> String {
    if base_path.is_empty() {
        format!("/api/preview/{}/", token)
    } else {
        format!("/api/preview/{}/{}/", token, percent_encode_path(base_path))
    }
}

fn percent_encode_path(path: &str) -> String {
    path.split('/')
        .map(percent_encode_path_component)
        .collect::<Vec<_>>()
        .join("/")
}

fn percent_encode_path_component(component: &str) -> String {
    let mut encoded = String::new();
    for byte in component.as_bytes() {
        match *byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                encoded.push(*byte as char);
            }
            _ => {
                use std::fmt::Write;
                let _ = write!(encoded, "%{:02X}", byte);
            }
        }
    }
    encoded
}

fn is_html_preview_path(path: &str) -> bool {
    path.rsplit('.')
        .next()
        .map(|ext| matches!(ext.to_ascii_lowercase().as_str(), "html" | "htm"))
        .unwrap_or(false)
}

fn generate_preview_token() -> String {
    let mut rng = rand::rng();
    let mut bytes = [0u8; 32];
    rng.fill(&mut bytes);
    hex::encode(bytes)
}

fn prune_preview_sessions_for_insert(
    previews: &mut std::collections::HashMap<String, PreviewSession>,
    session_id: &str,
) {
    prune_oldest_preview_sessions(
        previews,
        |preview| preview.session_id == session_id,
        PREVIEW_SESSION_MAX_PER_SESSION.saturating_sub(1),
    );
    prune_oldest_preview_sessions(
        previews,
        |_| true,
        PREVIEW_SESSION_MAX_TOTAL.saturating_sub(1),
    );
}

fn prune_oldest_preview_sessions<F>(
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

// ── Cancel ───────────────────────────────────────────────────────────────────

#[derive(serde::Deserialize)]
struct CancelRequest {
    agent_id: String,
    req_id: String,
}

async fn cancel_handler(
    State(state): State<AppState>,
    Extension(session): Extension<AuthenticatedSession>,
    Json(req): Json<CancelRequest>,
) -> Response {
    let pending_arc = {
        let inner = state.inner.read().await;
        inner.pending_responses.clone()
    };
    {
        let pending = pending_arc.read().await;
        let Some(pending_resp) = pending.get(&req.req_id) else {
            return (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({
                    "error": "request_not_found",
                    "message": "Request not found or already completed",
                    "retryable": false,
                })),
            )
                .into_response();
        };
        if pending_resp.session_id.as_deref() != Some(session.id.as_str()) {
            return (
                StatusCode::FORBIDDEN,
                Json(serde_json::json!({
                    "error": "permission_denied",
                    "message": "Cannot cancel a request owned by another session",
                    "retryable": false,
                })),
            )
                .into_response();
        }
        if pending_resp.agent_id != req.agent_id {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({
                    "error": "invalid_request",
                    "message": "Request does not belong to the selected agent",
                    "retryable": false,
                })),
            )
                .into_response();
        }
    }

    let inner = state.inner.read().await;
    let msg = filebox_protocol::message::HubMessage::Cancel {
        req_id: req.req_id.clone(),
    };
    if inner.agents.send_to_agent(&req.agent_id, msg) {
        // Also clean up pending response
        let mut pending = pending_arc.write().await;
        if let Some(p) = pending.remove(&req.req_id) {
            let _ = p.tx.send(serde_json::json!({
                "ok": false,
                "state": "cancelled",
                "error": "cancelled",
                "message": "Request cancelled by user",
            })).await;
        }
        Json(serde_json::json!({ "ok": true })).into_response()
    } else {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({
                "error": "backend_offline",
                "message": "Agent is offline",
                "retryable": true,
            })),
        )
            .into_response()
    }
}

// ── Agents ───────────────────────────────────────────────────────────────────

async fn agents_list_handler(State(state): State<AppState>) -> Json<serde_json::Value> {
    let inner = state.inner.read().await;
    let agents = inner.agents.list_all();
    Json(serde_json::to_value(&agents).unwrap_or_default())
}

async fn agent_detail_handler(
    State(state): State<AppState>,
    Path(agent_id): Path<String>,
) -> Response {
    let inner = state.inner.read().await;
    match inner.agents.get(&agent_id) {
        Some(agent) => {
            Json(serde_json::to_value(&agent.to_info()).unwrap_or_default()).into_response()
        }
        None => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({
                "error": "not_found",
                "message": format!("Agent {} not found", agent_id),
                "retryable": false,
            })),
        )
            .into_response(),
    }
}

async fn agent_resources_handler(
    State(state): State<AppState>,
    Path(agent_id): Path<String>,
) -> Response {
    let inner = state.inner.read().await;
    match inner.agents.get(&agent_id) {
        Some(agent) => {
            Json(serde_json::to_value(&agent.to_resource_revision()).unwrap_or_default())
                .into_response()
        }
        None => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({
                "error": "not_found",
                "message": format!("Agent {} not found", agent_id),
                "retryable": false,
            })),
        )
            .into_response(),
    }
}

async fn agent_resources_put_handler(
    State(state): State<AppState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path(agent_id): Path<String>,
    Json(value): Json<serde_json::Value>,
) -> Response {
    // Parse to a Value first so we can detect whether each root EXPLICITLY
    // carried a pinned_folders key. Backward-compat: a legacy automation /
    // recovery script that omits the field must NOT wipe existing pins (the
    // struct's #[serde(default)] would otherwise turn a missing field into an
    // empty vec and clear them). Here we inherit the agent's current pins for
    // any root whose JSON object omits the key; an explicit `[]` still clears.
    let desired = match reconcile_put_pins(&state, &agent_id, value).await {
        Ok(d) => d,
        Err(resp) => return resp,
    };

    tracing::info!(
        target: "audit",
        session = %session.id,
        agent_id = %agent_id,
        roots = desired.roots.len(),
        "resources_put_requested"
    );
    apply_desired_state(state, agent_id, desired, session.id).await
}

/// Reconcile a whole-state PUT body so that a root whose JSON object OMITS the
/// `pinned_folders` key inherits the agent's current pins for that root (by
/// name), while an explicit value (including `[]`) is honored as-is. This
/// preserves legacy clients that predate the field; without it, serde's default
/// would silently clear pins on every such PUT.
async fn reconcile_put_pins(
    state: &AppState,
    agent_id: &str,
    mut value: serde_json::Value,
) -> Result<DesiredResources, Response> {
    // Snapshot existing pins by root name (for inheritance).
    let existing_pins: std::collections::HashMap<String, Vec<String>> = {
        let inner = state.inner.read().await;
        inner
            .agents
            .get(agent_id)
            .map(|a| {
                a.roots
                    .iter()
                    .map(|r| (r.name.clone(), r.pinned_folders.clone()))
                    .collect()
            })
            .unwrap_or_default()
    };

    if let Some(roots) = value.get_mut("roots").and_then(|r| r.as_array_mut()) {
        for root in roots.iter_mut() {
            let obj = match root.as_object_mut() {
                Some(o) => o,
                None => continue,
            };
            if obj.contains_key("pinned_folders") {
                continue; // explicit (incl. []) — honor it
            }
            // Missing key → inherit current pins for this root name, if any.
            if let Some(name) = obj.get("name").and_then(|n| n.as_str()) {
                if let Some(pins) = existing_pins.get(name) {
                    obj.insert(
                        "pinned_folders".to_string(),
                        serde_json::to_value(pins).unwrap_or(serde_json::Value::Array(vec![])),
                    );
                }
            }
        }
    }

    match serde_json::from_value::<DesiredResources>(value) {
        Ok(d) => Ok(d),
        Err(e) => Err((
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": "invalid_body",
                "message": format!("Invalid desired resources: {}", e),
                "retryable": false,
            })),
        )
            .into_response()),
    }
}

// ── Root Management ──────────────────────────────────────────────────────────

#[derive(serde::Deserialize)]
struct AddRootRequest {
    name: String,
    path: String,
    enabled: Option<bool>,
}

async fn add_root_handler(
    State(state): State<AppState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path(agent_id): Path<String>,
    Json(req): Json<AddRootRequest>,
) -> Response {
    // Validate root name
    if req.name.is_empty() || req.name.len() > 128 || req.name.contains('/') || req.name.contains('\\') || req.name.contains('\0') {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": "invalid_root_name",
                "message": "Root name must be non-empty, max 128 chars, and contain no slashes",
                "retryable": false,
            })),
        ).into_response();
    }

    // Validate path is not empty
    if req.path.is_empty() || req.path.len() > 4096 {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": "invalid_root_path",
                "message": "Root path must be non-empty and max 4096 chars",
                "retryable": false,
            })),
        ).into_response();
    }

    let inner = state.inner.read().await;
    let agent = match inner.agents.get(&agent_id) {
        Some(a) => a,
        None => {
            return (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({"error": "not_found", "message": "Agent not found", "retryable": false})),
            ).into_response();
        }
    };

    let mut roots = agent.roots.clone();
    if roots.iter().any(|r| r.name == req.name) {
        return (
            StatusCode::CONFLICT,
            Json(serde_json::json!({
                "error": "resource_name_conflict",
                "message": format!("Root '{}' already exists", req.name),
                "retryable": false,
            })),
        )
            .into_response();
    }

    roots.push(RootConfig {
        name: req.name,
        path: req.path,
        enabled: req.enabled.unwrap_or(true),
        pinned_folders: vec![],
    });

    drop(inner);

    tracing::info!(
        target: "audit",
        session = %session.id,
        agent_id = %agent_id,
        root = %roots.last().map(|r| r.name.as_str()).unwrap_or(""),
        "root_add_requested"
    );

    apply_desired_state(state, agent_id, DesiredResources { roots }, session.id).await
}

#[derive(serde::Deserialize)]
struct PatchRootRequest {
    enabled: Option<bool>,
    name: Option<String>,
    path: Option<String>,
    /// Replace the whole pinned-folders array (relative paths within the
    /// root). `None` = leave untouched; `Some(vec)` = set to exactly that.
    pinned_folders: Option<Vec<String>>,
    /// Single-item delta: add this path to pinned_folders if absent. Mutually
    /// atomic with `pinned_folders` and `pin_remove`. The pin/unpin UI uses
    /// these instead of sending the whole array, so rapid clicks or two tabs
    /// editing the same root can't clobber each other (last-array-wins would).
    pin_add: Option<String>,
    /// Single-item delta: remove this path from pinned_folders if present.
    pin_remove: Option<String>,
}

async fn patch_root_handler(
    State(state): State<AppState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path((agent_id, root_name)): Path<(String, String)>,
    Json(req): Json<PatchRootRequest>,
) -> Response {
    // Validate new name if being renamed
    if let Some(ref name) = req.name {
        if name.is_empty() || name.len() > 128 || name.contains('/') || name.contains('\\') || name.contains('\0') {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({
                    "error": "invalid_root_name",
                    "message": "Root name must be non-empty, max 128 chars, and contain no slashes",
                    "retryable": false,
                })),
            ).into_response();
        }
    }

    let inner = state.inner.read().await;
    let agent = match inner.agents.get(&agent_id) {
        Some(a) => a,
        None => {
            return (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({"error": "not_found", "message": "Agent not found", "retryable": false})),
            ).into_response();
        }
    };

    // Capability gate: a legacy agent that never advertises pinned_folders
    // would silently drop pin data (serde ignores the unknown field) and reply
    // "applied", fooling the hub + UI into thinking pins persisted. Rather than
    // let that happen, reject any PATCH that touches pinned_folders against such
    // an agent with a clear, retryable error. The user upgrades the agent and
    // retries. We treat an explicit `pinned_folders: []` (unpin-all) against a
    // legacy agent as a no-op success instead of an error — the agent already
    // has no pins, so there's nothing to lose, and erroring on an unpin is a
    // confusing UX. A delta (pin_add/pin_remove) is always a hard error though,
    // since it asserts the agent can persist the result.
    let req_touches_pins = req.pin_add.is_some()
        || req.pin_remove.is_some()
        || req.pinned_folders.as_ref().map_or(false, |v| !v.is_empty());
    if req_touches_pins && !agent.capabilities.pinned_folders {
        drop(inner);
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": "unsupported_feature",
                "message": "This agent version does not support pinned folders. Update the agent and retry.",
                "retryable": true,
            })),
        )
            .into_response();
    }

    // Base the patch on the pending desired state when one exists (offline
    // coalescing). Without this, two rapid offline pin_add calls would each
    // clone agent.roots (the LAST APPLIED state, which has no pins yet), apply
    // their single delta, and the second set_pending_update would overwrite the
    // first — losing the earlier pin. Basing off the pending roots makes the
    // deltas chain: pin /a → pending={/a}; pin /b → clone pending ({/a}), add
    // /b → pending={/a,/b}. Online path: pending is None, so we fall back to
    // agent.roots as before.
    let base_roots = agent
        .pending_update
        .as_ref()
        .map(|p| p.roots.clone())
        .unwrap_or_else(|| agent.roots.clone());
    let mut roots = base_roots;
    let root = match roots.iter_mut().find(|r| r.name == root_name) {
        Some(r) => r,
        None => {
            return (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({"error": "not_found", "message": format!("Root '{}' not found", root_name), "retryable": false})),
            ).into_response();
        }
    };

    if let Some(enabled) = req.enabled {
        root.enabled = enabled;
    }
    if let Some(name) = req.name {
        root.name = name;
    }
    if let Some(path) = req.path {
        root.path = path;
    }
    // Pinned folders. Three modes, processed in priority order:
    //   1. pin_add / pin_remove — single-item atomic deltas. The pin/unpin UI
    //      uses these so rapid clicks or two tabs editing the same root can't
    //      lose updates (the alternative — client computing the whole new
    //      array from a snapshot and us replacing it — is racy).
    //   2. pinned_folders — explicit whole-array replace (incl. [] to clear).
    // The delta and replace modes are mutually exclusive by convention; if both
    // are sent, deltas win (applied to the CURRENT server array, ignoring the
    // supplied whole-array value).
    if req.pin_add.is_some() || req.pin_remove.is_some() {
        if let Some(ref add) = req.pin_add {
            if let Err(e) = validate_pinned_path(add) {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({
                        "error": "invalid_pinned_path",
                        "message": format!("Invalid pinned folder path: {}", e),
                        "retryable": false,
                    })),
                )
                    .into_response();
            }
            if !root.pinned_folders.iter().any(|p| p == add) {
                root.pinned_folders.push(add.clone());
            }
        }
        if let Some(ref remove) = req.pin_remove {
            // Validate shape for a clean 400 even on remove (defensive).
            if let Err(e) = validate_pinned_path(remove) {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({
                        "error": "invalid_pinned_path",
                        "message": format!("Invalid pinned folder path: {}", e),
                        "retryable": false,
                    })),
                )
                    .into_response();
            }
            root.pinned_folders.retain(|p| p != remove);
        }
    } else if let Some(ref pins) = req.pinned_folders {
        // Replace-whole-array. Validate shape before mutating so a bad pin
        // rejects cleanly (the agent would re-validate anyway, but failing
        // here gives a synchronous 400 instead of an async rejected-config
        // round trip). Empty vec is a valid "unpin everything" value.
        for p in pins {
            if let Err(e) = validate_pinned_path(p) {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({
                        "error": "invalid_pinned_path",
                        "message": format!("Invalid pinned folder path: {}", e),
                        "retryable": false,
                    })),
                )
                    .into_response();
            }
        }
        root.pinned_folders = pins.clone();
    }

    drop(inner);

    tracing::info!(
        target: "audit",
        session = %session.id,
        agent_id = %agent_id,
        root = %root_name,
        "root_patch_requested"
    );

    apply_desired_state(state, agent_id, DesiredResources { roots }, session.id).await
}

async fn delete_root_handler(
    State(state): State<AppState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path((agent_id, root_name)): Path<(String, String)>,
) -> Response {
    let inner = state.inner.read().await;
    let agent = match inner.agents.get(&agent_id) {
        Some(a) => a,
        None => {
            return (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({"error": "not_found", "message": "Agent not found", "retryable": false})),
            ).into_response();
        }
    };

    let roots: Vec<RootConfig> = agent.roots.iter().filter(|r| r.name != root_name).cloned().collect();
    if roots.len() == agent.roots.len() {
        return (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"error": "not_found", "message": format!("Root '{}' not found", root_name), "retryable": false})),
        ).into_response();
    }

    drop(inner);

    tracing::info!(
        target: "audit",
        session = %session.id,
        agent_id = %agent_id,
        root = %root_name,
        "root_delete_requested"
    );

    apply_desired_state(state, agent_id, DesiredResources { roots }, session.id).await
}

#[derive(serde::Deserialize)]
struct AddCollectionRequest {
    name: String,
}

async fn add_collection_handler(
    State(state): State<AppState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path(agent_id): Path<String>,
    Json(req): Json<AddCollectionRequest>,
) -> Response {
    if let Err(e) = validate_collection_name(&req.name) {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": "invalid_collection_name",
                "message": e,
                "retryable": false,
            })),
        )
            .into_response();
    }

    let inner = state.inner.read().await;
    let agent = match inner.agents.get(&agent_id) {
        Some(a) => a,
        None => {
            return (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({"error": "not_found", "message": "Agent not found", "retryable": false})),
            ).into_response();
        }
    };

    if !agent.capabilities.collections {
        drop(inner);
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": "unsupported_feature",
                "message": "This agent version does not support collections. Update the agent and retry.",
                "retryable": true,
            })),
        )
            .into_response();
    }

    if agent.collections.iter().any(|c| c.name == req.name) {
        drop(inner);
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": "collection_name_conflict",
                "message": format!("Collection '{}' already exists", req.name),
                "retryable": false,
            })),
        )
            .into_response();
    }

    let base_collections = agent
        .pending_collections_update
        .as_ref()
        .map(|p| p.collections.clone())
        .unwrap_or_else(|| agent.collections.clone());
    let mut collections = base_collections;
    collections.push(CollectionConfig {
        name: req.name.clone(),
        items: vec![],
    });
    drop(inner);

    tracing::info!(
        target: "audit",
        session = %session.id,
        agent_id = %agent_id,
        collection = %req.name,
        "collection_create_requested"
    );

    apply_collections_state(
        state,
        agent_id,
        DesiredCollections { collections },
        session.id,
    )
    .await
}

#[derive(serde::Deserialize)]
struct PatchCollectionRequest {
    rename: Option<String>,
    item_add: Option<CollectionItem>,
    item_remove: Option<CollectionItemRef>,
    items: Option<Vec<CollectionItem>>,
}

#[derive(serde::Deserialize)]
struct CollectionItemRef {
    root: String,
    path: String,
}

fn normalize_collection_path(p: &str) -> String {
    let mut s = p.to_string();
    if !s.starts_with('/') {
        s = format!("/{s}");
    }
    if s.len() > 1 && s.ends_with('/') {
        s = s.trim_end_matches('/').to_string();
    }
    s
}

async fn patch_collection_handler(
    State(state): State<AppState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path((agent_id, collection_name)): Path<(String, String)>,
    Json(req): Json<PatchCollectionRequest>,
) -> Response {
    let inner = state.inner.read().await;
    let agent = match inner.agents.get(&agent_id) {
        Some(a) => a,
        None => {
            return (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({"error": "not_found", "message": "Agent not found", "retryable": false})),
            ).into_response();
        }
    };

    if !agent.capabilities.collections {
        drop(inner);
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": "unsupported_feature",
                "message": "This agent version does not support collections. Update the agent and retry.",
                "retryable": true,
            })),
        )
            .into_response();
    }

    let base_collections = agent
        .pending_collections_update
        .as_ref()
        .map(|p| p.collections.clone())
        .unwrap_or_else(|| agent.collections.clone());
    let mut collections = base_collections;
    let coll_idx = match collections.iter().position(|c| c.name == collection_name) {
        Some(i) => i,
        None => {
            return (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({
                    "error": "not_found",
                    "message": format!("Collection '{}' not found", collection_name),
                    "retryable": false,
                })),
            ).into_response();
        }
    };

    if let Some(ref new_name) = req.rename {
        if let Err(e) = validate_collection_name(new_name) {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({
                    "error": "invalid_collection_name",
                    "message": e,
                    "retryable": false,
                })),
            )
                .into_response();
        }
        if new_name != &collection_name && collections.iter().any(|c| c.name == *new_name) {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({
                    "error": "collection_name_conflict",
                    "message": format!("Collection '{}' already exists", new_name),
                    "retryable": false,
                })),
            )
                .into_response();
        }
        collections[coll_idx].name = new_name.clone();
    }

    let coll = &mut collections[coll_idx];

    if req.item_add.is_some() || req.item_remove.is_some() {
        if let Some(ref add) = req.item_add {
            if let Err(e) = validate_collection_item_path(&add.path) {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({
                        "error": "invalid_collection_path",
                        "message": e,
                        "retryable": false,
                    })),
                )
                    .into_response();
            }
            let norm_path = normalize_collection_path(&add.path);
            if !coll.items.iter().any(|i| i.root == add.root && normalize_collection_path(&i.path) == norm_path) {
                coll.items.push(CollectionItem {
                    root: add.root.clone(),
                    path: norm_path,
                    label: add.label.clone(),
                });
            }
        }
        if let Some(ref remove) = req.item_remove {
            if let Err(e) = validate_collection_item_path(&remove.path) {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({
                        "error": "invalid_collection_path",
                        "message": e,
                        "retryable": false,
                    })),
                )
                    .into_response();
            }
            let norm_path = normalize_collection_path(&remove.path);
            coll.items.retain(|i| !(i.root == remove.root && normalize_collection_path(&i.path) == norm_path));
        }
    } else if let Some(ref items) = req.items {
        for item in items {
            if let Err(e) = validate_collection_item_path(&item.path) {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({
                        "error": "invalid_collection_path",
                        "message": e,
                        "retryable": false,
                    })),
                )
                    .into_response();
            }
        }
        coll.items = items
            .iter()
            .map(|item| CollectionItem {
                root: item.root.clone(),
                path: normalize_collection_path(&item.path),
                label: item.label.clone(),
            })
            .collect();
    }

    drop(inner);

    tracing::info!(
        target: "audit",
        session = %session.id,
        agent_id = %agent_id,
        collection = %collection_name,
        "collection_patch_requested"
    );

    apply_collections_state(
        state,
        agent_id,
        DesiredCollections { collections },
        session.id,
    )
    .await
}

async fn delete_collection_handler(
    State(state): State<AppState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path((agent_id, collection_name)): Path<(String, String)>,
) -> Response {
    let inner = state.inner.read().await;
    let agent = match inner.agents.get(&agent_id) {
        Some(a) => a,
        None => {
            return (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({"error": "not_found", "message": "Agent not found", "retryable": false})),
            ).into_response();
        }
    };

    if !agent.capabilities.collections {
        drop(inner);
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": "unsupported_feature",
                "message": "This agent version does not support collections. Update the agent and retry.",
                "retryable": true,
            })),
        )
            .into_response();
    }

    let base_collections = agent
        .pending_collections_update
        .as_ref()
        .map(|p| p.collections.clone())
        .unwrap_or_else(|| agent.collections.clone());
    let base_len = base_collections.len();
    let collections: Vec<CollectionConfig> = base_collections
        .into_iter()
        .filter(|c| c.name != collection_name)
        .collect();
    if collections.len() == base_len {
        return (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({
                "error": "not_found",
                "message": format!("Collection '{}' not found", collection_name),
                "retryable": false,
            })),
        )
            .into_response();
    }

    drop(inner);

    tracing::info!(
        target: "audit",
        session = %session.id,
        agent_id = %agent_id,
        collection = %collection_name,
        "collection_delete_requested"
    );

    apply_collections_state(
        state,
        agent_id,
        DesiredCollections { collections },
        session.id,
    )
    .await
}

async fn apply_collections_state(
    state: AppState,
    agent_id: String,
    desired: DesiredCollections,
    session_id: String,
) -> Response {
    let inner = state.inner.read().await;
    let agent = match inner.agents.get(&agent_id) {
        Some(a) => a,
        None => {
            return (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({"error": "not_found", "message": "Agent not found", "retryable": false})),
            )
                .into_response();
        }
    };

    if agent.status == AgentStatus::Offline {
        if !agent.capabilities.collections && !desired.collections.is_empty() {
            drop(inner);
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({
                    "error": "unsupported_feature",
                    "message": "This agent version does not support collections. Update the agent and retry.",
                    "retryable": true,
                })),
            )
                .into_response();
        }
        drop(inner);
        let mut inner = state.inner.write().await;
        inner.agents.set_pending_collections_update(&agent_id, desired);
        return Json(serde_json::json!({
            "ok": true,
            "state": "pending_agent_reconnect",
            "message": "Agent is offline. This change will be applied after it reconnects.",
        }))
        .into_response();
    }

    if !agent.capabilities.collections {
        drop(inner);
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": "unsupported_feature",
                "message": "This agent version does not support collections. Update the agent and retry.",
                "retryable": true,
            })),
        )
            .into_response();
    }

    let next_revision = match agent.collections_revision.checked_add(1) {
        Some(revision) => revision,
        None => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({
                    "error": "revision_overflow",
                    "message": "Collections revision overflow",
                    "retryable": false,
                })),
            )
                .into_response();
        }
    };
    let req_id = format!("col_{}", uuid::Uuid::new_v4());
    let desired_collections = desired.collections.clone();

    let msg = HubMessage::CollectionsSetDesired {
        req_id: req_id.clone(),
        desired_revision: next_revision,
        collections: desired.collections,
    };

    let (resp_tx, mut resp_rx) = tokio::sync::mpsc::channel(1);
    {
        let mut pending = inner.pending_responses.write().await;
        pending.insert(
            req_id.clone(),
            PendingResponse {
                tx: resp_tx,
                agent_id: agent_id.clone(),
                session_id: Some(session_id),
                desired_roots: None,
                desired_collections: Some(desired_collections),
            },
        );
    }

    if !inner.agents.send_to_agent(&agent_id, msg) {
        {
            let mut pending = inner.pending_responses.write().await;
            pending.remove(&req_id);
        }
        drop(inner);
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({
                "error": "backend_offline",
                "message": "Failed to send update to agent",
                "retryable": true,
            })),
        )
            .into_response();
    }

    drop(inner);

    let resp = tokio::time::timeout(std::time::Duration::from_secs(30), resp_rx.recv()).await;

    {
        let inner = state.inner.read().await;
        let mut pending = inner.pending_responses.write().await;
        pending.remove(&req_id);
    }

    match resp {
        Ok(Some(value)) => {
            if value.get("state").and_then(|s| s.as_str()) == Some("rejected") {
                let err_msg = value
                    .get("message")
                    .and_then(|m| m.as_str())
                    .or_else(|| value.get("error").and_then(|e| e.as_str()))
                    .unwrap_or("Collection change rejected")
                    .to_string();
                let mut inner = state.inner.write().await;
                inner.agents.set_config_error(&agent_id, err_msg);
            }
            Json(value).into_response()
        }
        _ => (
            StatusCode::GATEWAY_TIMEOUT,
            Json(serde_json::json!({
                "error": "request_timeout",
                "message": "Timed out waiting for agent to apply collection change",
                "retryable": true,
            })),
        )
            .into_response(),
    }
}

// ── Helper ───────────────────────────────────────────────────────────────────

async fn apply_desired_state(
    state: AppState,
    agent_id: String,
    desired: DesiredResources,
    session_id: String,
) -> Response {
    let inner = state.inner.read().await;
    let agent = match inner.agents.get(&agent_id) {
        Some(a) => a,
        None => {
            return (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({"error": "not_found", "message": "Agent not found", "retryable": false})),
            )
                .into_response();
        }
    };

    if agent.status == AgentStatus::Offline {
        // Capability gate for the offline path: a legacy agent (no
        // pinned_folders capability) would never persist pin data, so queuing a
        // pending update that carries pins is a lie — on reconnect the hub
        // strips the pins before pushing, but then the registry mirror still
        // holds them and the agent never does, so the UI shows pins that aren't
        // real. Reject up front instead. (patch_root already gates this for the
        // common pin flow; this catches PUT /resources and any future caller.)
        if !agent.capabilities.pinned_folders
            && desired.roots.iter().any(|r| !r.pinned_folders.is_empty())
        {
            drop(inner);
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({
                    "error": "unsupported_feature",
                    "message": "This agent version does not support pinned folders. Update the agent and retry.",
                    "retryable": true,
                })),
            )
                .into_response();
        }
        drop(inner);
        let mut inner = state.inner.write().await;
        inner.agents.set_pending_update(&agent_id, desired);
        return Json(serde_json::json!({
            "ok": true,
            "state": "pending_agent_reconnect",
            "message": "Agent is offline. This change will be applied after it reconnects.",
        }))
        .into_response();
    }

    let next_revision = match agent.resource_revision.checked_add(1) {
        Some(revision) => revision,
        None => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({
                    "error": "revision_overflow",
                    "message": "Resource revision overflow",
                    "retryable": false,
                })),
            )
                .into_response();
        }
    };
    let req_id = format!("res_{}", uuid::Uuid::new_v4());

    // Hub mirror of the desired set (including pins). Wired to the agent
    // after stripping pins for legacy agents; the WS Applied handler merges
    // this with agent-expanded paths so `~/…` does not stick in the registry.
    let desired_roots = desired.roots.clone();

    // Rolling-upgrade safety: if this agent doesn't advertise the
    // pinned_folders capability, strip pins from what we send over the wire so
    // a legacy agent can't reply "applied" while silently dropping pin data.
    // The hub's own mirror (desired_roots, reconciled on Applied) keeps the
    // real pins; they re-apply once the agent is upgraded.
    let agent_supports_pins = agent.capabilities.pinned_folders;
    let wire_roots = if agent_supports_pins {
        desired.roots
    } else {
        tracing::warn!(
            "Agent {} does not advertise pinned_folders capability; stripping pin data from ResourcesSetDesired",
            agent_id
        );
        desired
            .roots
            .into_iter()
            .map(|mut r| {
                r.pinned_folders.clear();
                r
            })
            .collect::<Vec<_>>()
    };

    let msg = filebox_protocol::message::HubMessage::ResourcesSetDesired {
        req_id: req_id.clone(),
        desired_revision: next_revision,
        roots: wire_roots,
    };

    let (resp_tx, mut resp_rx) = tokio::sync::mpsc::channel(1);
    {
        let mut pending = inner.pending_responses.write().await;
        pending.insert(
            req_id.clone(),
            PendingResponse {
                tx: resp_tx,
                agent_id: agent_id.clone(),
                session_id: Some(session_id),
                desired_roots: Some(desired_roots),
                desired_collections: None,
            },
        );
    }

    if !inner.agents.send_to_agent(&agent_id, msg) {
        // P1 fix: the timeout-cleanup below is unreachable via this early
        // return, so we must drop the pending_responses entry here too —
        // otherwise a half-dead connection on every pin/unpin would leak an
        // entry forever (the map is unbounded).
        {
            let mut pending = inner.pending_responses.write().await;
            pending.remove(&req_id);
        }
        drop(inner);
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({
                "error": "backend_offline",
                "message": "Failed to send update to agent",
                "retryable": true,
            })),
        )
            .into_response();
    }

    drop(inner);

    let resp = tokio::time::timeout(std::time::Duration::from_secs(30), resp_rx.recv()).await;

    // Clean up pending entry if still present
    {
        let inner = state.inner.read().await;
        let mut pending = inner.pending_responses.write().await;
        pending.remove(&req_id);
    }

    match resp {
        Ok(Some(value)) => {
            // On "applied", the WS handler already updated the registry from
            // ResourcesUpdated + ResourcesApplied (agent-expanded paths,
            // reconciled pins). Re-applying `desired_roots` here would clobber
            // absolute paths back to pre-expansion forms such as `~/docs`.
            // On "rejected", store the config error (WS may also have set it).
            if value.get("state").and_then(|s| s.as_str()) == Some("rejected") {
                let err_msg = value.get("message")
                    .and_then(|m| m.as_str())
                    .or_else(|| value.get("error").and_then(|e| e.as_str()))
                    .unwrap_or("Config rejected")
                    .to_string();
                let mut inner = state.inner.write().await;
                inner.agents.set_config_error(&agent_id, err_msg);
            }
            Json(value).into_response()
        }
        _ => (
            StatusCode::GATEWAY_TIMEOUT,
            Json(serde_json::json!({
                "error": "request_timeout",
                "message": "Agent did not respond in time",
                "retryable": true,
            })),
        )
            .into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
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
        })
    }

    async fn register_preview_agent(
        state: &AppState,
        tx: mpsc::UnboundedSender<HubMessage>,
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
            let (tx, _rx) = mpsc::unbounded_channel::<HubMessage>();
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
            let (tx, _rx) = mpsc::unbounded_channel::<HubMessage>();
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

    #[test]
    fn preview_base_url_includes_encoded_html_parent_directory() {
        assert_eq!(preview_base_url("tok", ""), "/api/preview/tok/");
        assert_eq!(
            preview_base_url("tok", "reports/run 1/#figures"),
            "/api/preview/tok/reports/run%201/%23figures/"
        );
    }

    #[tokio::test]
    async fn preview_session_create_requires_agent_stat_success() {
        let state = AppState::new(&test_config(), true);
        let (tx, mut rx) = mpsc::unbounded_channel::<HubMessage>();
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
        let (tx, mut rx) = mpsc::unbounded_channel::<HubMessage>();
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
        assert!(is_html_preview_path("report.HTML"));
        assert!(is_html_preview_path("report.htm"));
        assert!(!is_html_preview_path("report.md"));
        assert!(!is_html_preview_path("report"));
    }

    #[test]
    fn preview_pruning_keeps_per_session_token_count_bounded() {
        let base = std::time::Instant::now();
        let mut previews = std::collections::HashMap::new();
        for i in 0..(PREVIEW_SESSION_MAX_PER_SESSION + 5) {
            previews.insert(
                format!("s1-{}", i),
                test_preview("s1", base + std::time::Duration::from_millis(i as u64)),
            );
        }
        previews.insert("s2-keep".to_string(), test_preview("s2", base));

        prune_preview_sessions_for_insert(&mut previews, "s1");

        let s1_count = previews
            .values()
            .filter(|preview| preview.session_id == "s1")
            .count();
        assert_eq!(s1_count, PREVIEW_SESSION_MAX_PER_SESSION - 1);
        assert!(previews.contains_key("s2-keep"));
        assert!(!previews.contains_key("s1-0"));
    }
}
