use tracing_subscriber::EnvFilter;

mod config;
mod config_store;
mod connection;
mod content_cache;
mod dir_cache;
mod fs;
mod herdr;
mod office_convert;
mod resources;
mod search;
mod sysinfo;
mod temp_store;
mod terminal;

fn agent_runtime() -> std::io::Result<tokio::runtime::Runtime> {
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
}

fn main() {
    agent_runtime().expect("failed to create agent runtime").block_on(run());
}

async fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().is_some_and(|arg| arg == "--setup-terminal-2fa") {
        let path = match args.as_slice() {
            [_] => std::env::var("FILEBOX_AGENT_CONFIG").unwrap_or_else(|_| "agent.toml".into()),
            [_, flag, path] if flag == "--config" => path.clone(),
            _ => { eprintln!("Usage: agent --setup-terminal-2fa [--config agent.toml]"); std::process::exit(2); }
        };
        if let Err(error) = config::setup_terminal_2fa(std::path::Path::new(&path)) {
            eprintln!("[agent] 2FA setup failed: {error}"); std::process::exit(1);
        }
        return;
    }
    match filebox_updater::parse_command("agent", std::env::args().skip(1)) {
        Ok(filebox_updater::UpdateCommand::Run) => {}
        Ok(filebox_updater::UpdateCommand::Help) => {
            print!("{}", filebox_updater::usage("agent"));
            println!("  --setup-terminal-2fa [--config agent.toml]  Configure terminal 2FA locally");
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
            println!("  --setup-terminal-2fa [--config agent.toml]  Configure terminal 2FA locally");
            std::process::exit(2);
        }
    }

    let config = config::AgentConfig::load();
    tracing::info!("Agent starting, connecting to {}", config.hub_url);

    connection::run_connection_loop(&config).await;
}

#[cfg(test)]
mod runtime_tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn bounded_runtime_keeps_async_tasks_live_during_blocking_work() {
        let runtime = agent_runtime().unwrap();
        assert_eq!(runtime.metrics().num_workers(), 2);
        runtime.block_on(async {
            let mut workers = Vec::new();
            let mut releases = Vec::new();
            for _ in 0..4 {
                let (started_tx, started_rx) = tokio::sync::oneshot::channel();
                let (release_tx, release_rx) = std::sync::mpsc::channel();
                releases.push(release_tx);
                workers.push(tokio::task::spawn_blocking(move || {
                    let _ = started_tx.send(());
                    let _ = release_rx.recv_timeout(Duration::from_secs(5));
                }));
                tokio::time::timeout(Duration::from_secs(2), started_rx).await.unwrap().unwrap();
            }
            let heartbeat = tokio::spawn(async {
                tokio::time::sleep(Duration::from_millis(10)).await;
            });
            let result = tokio::time::timeout(Duration::from_secs(1), heartbeat).await;
            for release in releases {
                let _ = release.send(());
            }
            for worker in workers {
                worker.await.unwrap();
            }
            result.unwrap().unwrap();
        });
    }
}
