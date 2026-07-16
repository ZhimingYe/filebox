use tracing_subscriber::EnvFilter;

mod config;
mod config_store;
mod connection;
mod dir_cache;
mod fs;
mod resources;
mod search;
mod sysinfo;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    match filebox_updater::parse_command("agent", std::env::args().skip(1)) {
        Ok(filebox_updater::UpdateCommand::Run) => {}
        Ok(filebox_updater::UpdateCommand::Help) => {
            print!("{}", filebox_updater::usage("agent"));
            return;
        }
        Ok(filebox_updater::UpdateCommand::InitConfig(request)) => {
            if let Err(error) = config::init_interactive(request) {
                eprintln!("[agent] config creation failed: {error}");
                std::process::exit(1);
            }
            return;
        }
        Ok(filebox_updater::UpdateCommand::Update(request)) => {
            match filebox_updater::run_update(filebox_updater::Product::Agent, request).await {
                Ok(outcome) if outcome.installed => {
                    eprintln!(
                        "[agent] updated from v{} to v{} using {}",
                        outcome.current_version, outcome.target_version, outcome.source_url
                    );
                    eprintln!("[agent] restart the agent service to use the new binary.");
                }
                Ok(outcome) => {
                    eprintln!("[agent] already at release v{}", outcome.target_version);
                }
                Err(error) => {
                    eprintln!("[agent] update failed: {error}");
                    std::process::exit(1);
                }
            }
            return;
        }
        Err(error) => {
            eprintln!("[agent] {error}");
            eprintln!();
            print!("{}", filebox_updater::usage("agent"));
            std::process::exit(2);
        }
    }

    let config = config::AgentConfig::load();
    tracing::info!("Agent starting, connecting to {}", config.hub_url);

    connection::run_connection_loop(&config).await;
}
