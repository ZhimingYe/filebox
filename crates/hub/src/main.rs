use tracing_subscriber::EnvFilter;

mod agent_registry;
mod auth;
mod config;
mod events;
mod fs_proxy;
mod health;
mod routes;
mod state;
mod ws;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env())
        .init();

    let config = config::HubConfig::load();
    let state = state::AppState::new(&config);

    // Spawn background heartbeat task
    let heartbeat_state = state.clone();
    tokio::spawn(heartbeat_loop(heartbeat_state));

    // Spawn session cleanup task
    let cleanup_state = state.clone();
    tokio::spawn(session_cleanup_loop(cleanup_state));

    let app = routes::create_router(state);

    let listener = tokio::net::TcpListener::bind(&config.listen_addr)
        .await
        .expect("failed to bind");

    eprintln!("[hub] listening on {}", config.listen_addr);
    axum::serve(listener, app.into_make_service_with_connect_info::<std::net::SocketAddr>())
        .await
        .expect("server error");
}

async fn heartbeat_loop(state: state::AppState) {
    let mut interval = tokio::time::interval(std::time::Duration::from_secs(15));
    loop {
        interval.tick().await;

        let mut inner = state.inner.write().await;

        // Update agent statuses based on heartbeat timing
        inner.agents.update_heartbeats();

        // Get list of online agent IDs to ping
        let agent_ids: Vec<String> = inner
            .agents
            .list_all()
            .iter()
            .filter(|a| a.status != "offline")
            .map(|a| a.id.clone())
            .collect();

        // Send ping to each online agent
        for agent_id in &agent_ids {
            inner.agents.send_ping(agent_id);
        }
    }
}

async fn session_cleanup_loop(state: state::AppState) {
    let mut interval = tokio::time::interval(std::time::Duration::from_secs(300));
    loop {
        interval.tick().await;
        let mut inner = state.inner.write().await;
        inner.sessions.remove_expired();
    }
}
