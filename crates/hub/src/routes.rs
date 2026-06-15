use axum::extract::{Path, State};
use axum::http::{header, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post, put};
use axum::{Json, Router};
use tower_http::cors::{AllowOrigin, CorsLayer};
use tower_http::services::ServeDir;

use filebox_protocol::resources::{DesiredResources, RootConfig};

use crate::agent_registry::AgentStatus;
use crate::state::{AppState, PendingResponse};
use crate::{events, fs_proxy, health, ws};

pub fn create_router(state: AppState) -> Router {
    // Public routes (no auth required)
    let public = Router::new()
        .route("/api/health", get(health::health_handler))
        .route("/api/session/exchange", post(session_exchange_handler))
        .route("/ws/agent", get(ws::ws_handler));

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
        .route("/api/fs/list", get(fs_proxy::fs_list_handler))
        .route("/api/fs/stat", get(fs_proxy::fs_stat_handler))
        .route("/api/file/raw", get(fs_proxy::file_raw_handler))
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
        .allow_headers([header::CONTENT_TYPE, header::COOKIE])
        .allow_credentials(true);

    Router::new()
        .merge(public)
        .merge(protected)
        .fallback_service(frontend)
        .layer(cors)
        .layer(axum::extract::DefaultBodyLimit::max(1024 * 1024)) // 1MB max request body
        .with_state(state)
}

// ── Session Middleware ─────────────────────────────────────────────────────

async fn require_session(
    State(state): State<AppState>,
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> Response {
    // Extract session cookie
    let session_id = req
        .headers()
        .get(header::COOKIE)
        .and_then(|v| v.to_str().ok())
        .and_then(|cookies| {
            cookies.split(';').find_map(|c| {
                let c = c.trim();
                if c.starts_with("filebox_session=") {
                    Some(c[16..].to_string())
                } else {
                    None
                }
            })
        });

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

    let inner = state.inner.read().await;
    if inner.sessions.get_session(&sid).is_none() {
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
    drop(inner);

    next.run(req).await
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
    // Extract client IP (prefer X-Forwarded-For for reverse proxy setups)
    let ip = headers
        .get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(',').next())
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|| addr.ip().to_string());

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

    let cookie = format!(
        "filebox_session={}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age={}",
        session_id, ttl
    );

    (
        StatusCode::OK,
        [(header::SET_COOKIE, cookie)],
        Json(serde_json::json!({
            "ok": true,
            "session_id": session_id,
            "permissions": session.permissions,
        })),
    )
        .into_response()
}

async fn session_logout_handler(State(_state): State<AppState>) -> Response {
    // Clear cookie
    let cookie = "filebox_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0";
    (
        StatusCode::OK,
        [(header::SET_COOKIE, cookie)],
        Json(serde_json::json!({ "ok": true })),
    )
        .into_response()
}

// ── Cancel ───────────────────────────────────────────────────────────────────

#[derive(serde::Deserialize)]
struct CancelRequest {
    agent_id: String,
    req_id: String,
}

async fn cancel_handler(
    State(state): State<AppState>,
    Json(req): Json<CancelRequest>,
) -> Response {
    let inner = state.inner.read().await;
    let msg = filebox_protocol::message::HubMessage::Cancel {
        req_id: req.req_id.clone(),
    };
    if inner.agents.send_to_agent(&req.agent_id, msg) {
        // Also clean up pending response
        let mut pending = inner.pending_responses.write().await;
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
    Path(agent_id): Path<String>,
    Json(desired): Json<DesiredResources>,
) -> Response {
    apply_desired_state(state, agent_id, desired).await
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
    });

    drop(inner);

    apply_desired_state(state, agent_id, DesiredResources { roots }).await
}

#[derive(serde::Deserialize)]
struct PatchRootRequest {
    enabled: Option<bool>,
    name: Option<String>,
    path: Option<String>,
}

async fn patch_root_handler(
    State(state): State<AppState>,
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

    let mut roots = agent.roots.clone();
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

    drop(inner);

    apply_desired_state(state, agent_id, DesiredResources { roots }).await
}

async fn delete_root_handler(
    State(state): State<AppState>,
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

    apply_desired_state(state, agent_id, DesiredResources { roots }).await
}

// ── Helper ───────────────────────────────────────────────────────────────────

async fn apply_desired_state(
    state: AppState,
    agent_id: String,
    desired: DesiredResources,
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

    let next_revision = agent.resource_revision + 1;
    let req_id = format!("res_{}", uuid::Uuid::new_v4());

    // Clone desired state for the message and save for later registry update
    let desired_roots = desired.roots.clone();

    let msg = filebox_protocol::message::HubMessage::ResourcesSetDesired {
        req_id: req_id.clone(),
        desired_revision: next_revision,
        roots: desired.roots,
    };

    let (resp_tx, mut resp_rx) = tokio::sync::mpsc::channel(1);
    {
        let mut pending = inner.pending_responses.write().await;
        pending.insert(
            req_id.clone(),
            PendingResponse {
                tx: resp_tx,
                desired_roots: Some(desired_roots.clone()),
            },
        );
    }

    if !inner.agents.send_to_agent(&agent_id, msg) {
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
            // If the agent applied the resources, update the hub registry directly
            if value.get("state").and_then(|s| s.as_str()) == Some("applied") {
                if let Some(rev) = value.get("resource_revision").and_then(|r| r.as_u64()) {
                    let mut inner = state.inner.write().await;
                    inner.agents.update_resources(
                        &agent_id,
                        rev,
                        desired_roots,
                    );
                }
            }
            // If rejected, store the config error
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
