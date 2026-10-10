use axum::extract::State;
use axum::Json;

use crate::state::AppState;

pub async fn health_handler(State(state): State<AppState>) -> Json<serde_json::Value> {
    let inner = state.inner.read().await;

    let uptime = inner.start_time.elapsed().as_secs();

    Json(serde_json::json!({
        "hub": {
            "status": "ok",
            "version": env!("CARGO_PKG_VERSION"),
            "uptime_sec": uptime,
            // Opaque cookie-name suffix for the SPA (not a secret; derived so
            // the frontend can read the port-isolated CSRF cookie without
            // embedding listen-port digits in cookie names).
            "cookie_suffix": state.cookie_suffix,
        }
    }))
}
