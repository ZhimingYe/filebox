use tracing_subscriber::EnvFilter;

mod config;
mod routes;
mod state;
mod ws;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env())
        .init();

    let config = config::Config::from_env();
    let state = state::AppState::new(&config);
    let app = routes::create_router(state);

    let listener = tokio::net::TcpListener::bind(&config.listen_addr)
        .await
        .expect("failed to bind");

    tracing::info!("Hub listening on {}", config.listen_addr);
    axum::serve(listener, app).await.expect("server error");
}
