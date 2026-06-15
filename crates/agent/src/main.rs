use tracing_subscriber::EnvFilter;

mod config;
mod config_store;
mod connection;
mod fs;
mod resources;
mod sysinfo;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    let config = config::AgentConfig::load();
    tracing::info!("Agent starting, connecting to {}", config.hub_url);

    connection::run_connection_loop(&config).await;
}
