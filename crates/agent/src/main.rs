use tracing_subscriber::EnvFilter;

mod config;
mod connection;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env())
        .init();

    let config = config::AgentConfig::from_env();
    tracing::info!("Agent starting, connecting to {}", config.hub_url);

    connection::run_connection_loop(&config).await;
}
