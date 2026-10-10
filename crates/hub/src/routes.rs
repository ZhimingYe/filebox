use axum::http::{header, HeaderName, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post, put};
use axum::{Json, Router};
use tower_http::cors::{AllowOrigin, CorsLayer};
use tower_http::services::{ServeDir, ServeFile};
use crate::state::AppState;
use crate::{events, fs_proxy, health, ws};

pub fn create_router(state: AppState) -> Router {
    // Public routes (no auth required)
    let public = Router::new()
        .route("/api/health", get(health::health_handler))
        .route("/api/pow/challenge", get(pow_challenge_handler))
        .route("/api/session/exchange", post(session_exchange_handler))
        .route("/ws/agent", get(ws::ws_handler));

    let preview_resources = Router::new().route(
        "/api/preview/{token}/{*resource_path}",
        get(fs_proxy::preview_resource_handler).options(fs_proxy::preview_options_handler),
    );

    // Browser terminal WS: outside the protected group (browsers cannot set
    // CSRF headers on a WS upgrade); the handler authenticates the 2FA ticket
    // and session cookie itself.
    let terminal_ws = Router::new().route(
        "/api/agents/{agent_id}/terminal/ws",
        get(crate::terminal_proxy::terminal_ws_handler),
    );

    // Protected routes (session cookie required)
    let protected = Router::new()
        .route("/api/events", get(events::sse_handler))
        .route("/api/session/logout", post(session_logout_handler))
        .route("/api/audit/logins", get(login_audit_handler))
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
        .route("/api/access-tokens", post(access_token_create_handler))
        .route("/api/agents/{agent_id}/sys-stats", get(fs_proxy::sys_stats_handler))
        .route(
            "/api/agents/{agent_id}/workspace-search",
            post(crate::search_proxy::workspace_search_handler),
        )
        .route(
            "/api/agents/{agent_id}/office-convert",
            post(crate::office_proxy::office_convert_handler),
        )
        // Temp-folder uploads: body limit overridden per-route (the global
        // router limit is 1 MB; uploads may be up to the hub's 64 MiB cap).
        .route(
            "/api/agents/{agent_id}/temp-upload",
            post(crate::temp_proxy::temp_upload_handler)
                .layer(axum::extract::DefaultBodyLimit::max(
                    crate::temp_proxy::TEMP_UPLOAD_MAX_BODY_BYTES,
                )),
        )
        .route(
            "/api/agents/{agent_id}/temp-cleanup",
            post(crate::temp_proxy::temp_cleanup_handler),
        )
        .route(
            "/api/agents/{agent_id}/terminal/ticket",
            post(crate::terminal_proxy::terminal_ticket_handler),
        )
        .route(
            "/api/agents/{agent_id}/terminals",
            get(crate::terminal_proxy::terminals_list_handler),
        )
        .route(
            "/api/agents/{agent_id}/terminals/{req_id}",
            delete(crate::terminal_proxy::terminal_kill_handler),
        )
        .route("/api/cancel", post(cancel_handler))
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            require_session,
        ));

    // Resolve frontend/dist (classic SPA at /).
    // Order: FILEBOX_FRONTEND_DIR env → cwd → walk up from binary location.
    let frontend_path = find_static_dist(
        "FILEBOX_FRONTEND_DIR",
        "frontend/dist",
        "frontend",
    )
    .unwrap_or_else(|| {
        eprintln!("[hub] WARNING: frontend/dist not found");
        eprintln!("[hub] Set FILEBOX_FRONTEND_DIR, run from a directory containing frontend/dist,");
        eprintln!("[hub] or place frontend/dist as a sibling of the binary's parent dir.");
        std::path::PathBuf::from("frontend/dist")
    });
    eprintln!("[hub] frontend: {}", frontend_path.display());

    // Optional experimental neo SPA at /neo (independent package: neo_frontend/).
    // Missing dist is fine — /neo then 404s; classic / is unchanged.
    let neo_path = find_static_dist(
        "FILEBOX_NEO_FRONTEND_DIR",
        "neo_frontend/dist",
        "neo frontend",
    );
    match &neo_path {
        Some(p) => eprintln!("[hub] neo frontend: {}", p.display()),
        None => eprintln!(
            "[hub] neo frontend: not found (optional; build neo_frontend/dist or set FILEBOX_NEO_FRONTEND_DIR)"
        ),
    }

    fn find_static_dist(
        env_key: &str,
        relative: &str,
        label: &str,
    ) -> Option<std::path::PathBuf> {
        // 1. Explicit env override (highest priority)
        if let Ok(p) = std::env::var(env_key) {
            let path = std::path::PathBuf::from(&p);
            if path.exists() {
                return Some(path);
            }
            eprintln!(
                "[hub] WARNING: {env_key}={p} does not exist, ignoring ({label})"
            );
        }

        // 2. Check cwd first (common dev case: run from project root)
        let cwd_candidate = std::path::PathBuf::from(relative);
        if cwd_candidate.exists() {
            return Some(cwd_candidate);
        }

        // 3. Walk up from binary location, up to 5 levels
        let mut dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
        for _ in 0..5 {
            let candidate = dir.join(relative);
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
        .allow_headers([
            header::CONTENT_TYPE,
            header::COOKIE,
            header::RANGE,
            HeaderName::from_static("x-csrf-token"),
        ])
        .allow_credentials(true);

    // Classic SPA remains the catch-all fallback. Nest /neo first so it never
    // falls through into frontend/dist (which has no neo assets).
    let mut cors_app = Router::new().merge(public).merge(protected);
    if let Some(neo_path) = neo_path {
        let neo_index = neo_path.join("index.html");
        let neo = ServeDir::new(neo_path)
            .append_index_html_on_directories(true)
            .fallback(ServeFile::new(neo_index));
        cors_app = cors_app.nest_service("/neo", neo);
    }
    let cors_app = cors_app.fallback_service(frontend).layer(cors);

    Router::new()
        .merge(preview_resources)
        .merge(terminal_ws)
        .merge(cors_app)
        .layer(axum::extract::DefaultBodyLimit::max(1024 * 1024)) // 1MB max request body
        .layer(axum::middleware::from_fn(security_headers))
        .layer(axum::middleware::from_fn(cache_headers))
        .with_state(state)
}

fn hub_overloaded_response() -> Response {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        Json(serde_json::json!({
            "error": "hub_overloaded",
            "message": "The Hub is busy waiting for Agent responses. Retry shortly.",
            "retryable": true,
        })),
    )
        .into_response()
}

// Route assembly stays here; each feature owns its handlers and validation.
mod middleware;
mod session;
mod access;
mod preview;
mod cancel;
mod resources;
mod collections;

pub(crate) use middleware::session_cookie;
use middleware::{security_headers, cache_headers, require_session};
use session::{pow_challenge_handler, session_exchange_handler, session_logout_handler, login_audit_handler};
use access::access_token_create_handler;
use preview::preview_session_create_handler;
pub(crate) use cancel::cancel_handler;
#[cfg(test)]
pub(crate) use cancel::CancelRequest;
use resources::{agents_list_handler, agent_detail_handler, agent_resources_handler, agent_resources_put_handler,
    add_root_handler, patch_root_handler, delete_root_handler};
use collections::{add_collection_handler, patch_collection_handler, delete_collection_handler};

#[cfg(test)]
mod tests;
