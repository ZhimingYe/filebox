use tracing_subscriber::EnvFilter;

mod agent_registry;
mod auth;
mod config;
mod events;
mod fs_proxy;
mod health;
mod net;
mod routes;
mod search_proxy;
mod state;
mod ws;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    match filebox_updater::parse_command("hub", std::env::args().skip(1)) {
        Ok(filebox_updater::UpdateCommand::Run) => {}
        Ok(filebox_updater::UpdateCommand::Help) => {
            print!("{}", filebox_updater::usage("hub"));
            return;
        }
        Ok(filebox_updater::UpdateCommand::InitConfig(request)) => {
            if let Err(error) = config::init_interactive(request) {
                eprintln!("[hub] config creation failed: {error}");
                std::process::exit(1);
            }
            return;
        }
        Ok(filebox_updater::UpdateCommand::Update(request)) => {
            match filebox_updater::run_update(filebox_updater::Product::Hub, request).await {
                Ok(outcome) if outcome.installed => {
                    eprintln!(
                        "[hub] updated from v{} to v{} using {}",
                        outcome.current_version, outcome.target_version, outcome.source_url
                    );
                    eprintln!("[hub] restart the hub service to use the new binary and frontend bundle.");
                }
                Ok(outcome) => {
                    eprintln!("[hub] already at release v{}", outcome.target_version);
                }
                Err(error) => {
                    eprintln!("[hub] update failed: {error}");
                    std::process::exit(1);
                }
            }
            return;
        }
        Err(error) => {
            eprintln!("[hub] {error}");
            eprintln!();
            print!("{}", filebox_updater::usage("hub"));
            std::process::exit(2);
        }
    }

    let config = config::HubConfig::load();
    let dev_mode = std::env::var("FILEBOX_DEV_MODE")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false);
    let state = state::AppState::new(&config, !dev_mode);

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
