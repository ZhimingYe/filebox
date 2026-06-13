use axum::Router;
use axum::routing::get;
use tower_http::cors::CorsLayer;
use tower_http::services::ServeDir;

use crate::state::AppState;
use crate::ws;

pub fn create_router(state: AppState) -> Router {
    let api = Router::new()
        .route("/api/health", get(health_handler))
        .route("/api/agents", get(agents_handler))
        .route("/ws/agent", get(ws::ws_handler));

    let frontend = ServeDir::new("frontend/dist");

    Router::new()
        .merge(api)
        .fallback_service(frontend)
        .layer(CorsLayer::permissive())
        .with_state(state)
}

async fn health_handler() -> axum::Json<serde_json::Value> {
    axum::Json(serde_json::json!({ "status": "ok" }))
}

async fn agents_handler() -> axum::Json<serde_json::Value> {
    axum::Json(serde_json::json!([]))
}
