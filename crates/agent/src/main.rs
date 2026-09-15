use tracing_subscriber::EnvFilter;

mod config;
mod config_store;
mod connection;
mod content_cache;
mod dir_cache;
mod fs;
mod office_convert;
mod priority;
mod resources;
mod search;
mod sysinfo;
mod temp_store;

/// Tokio async workers. The agent is a WS relay, not a CPU farm: one worker
/// per HPC core (the `#[tokio::main]` default) just adds 64–128 runnable
/// threads that compete with the job for CFS slices. Two is the floor so
/// the reader and writer tasks can run together.
const DEFAULT_WORKER_THREADS: usize = 4;
const MIN_WORKER_THREADS: usize = 2;
const MAX_WORKER_THREADS: usize = 8;

/// Blocking pool: file reads (32) + dir lists (4) + search/office/stats/fills.
/// The Tokio default of 512 would flood a loaded node with idle OS threads.
const DEFAULT_BLOCKING_THREADS: usize = 64;
const MIN_BLOCKING_THREADS: usize = 16;
const MAX_BLOCKING_THREADS: usize = 256;

fn main() {
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
            let runtime = agent_runtime(false);
            runtime.block_on(async {
                match filebox_updater::run_update(filebox_updater::Product::Agent, request).await {
                    Ok(outcome) if outcome.installed => {
                        eprintln!(
                            "[agent] updated from v{} to v{} using {}",
                            outcome.current_version, outcome.target_version, outcome.source_url
                        );
                        eprintln!("[agent] restart the agent service to use the new binary.");
                    }
                    Ok(outcome) => {
                        eprintln!("[agent] already at release v{}", outcome.current_version);
                    }
                    Err(error) => {
                        eprintln!("[agent] update failed: {error}");
                        std::process::exit(1);
                    }
                }
            });
            return;
        }
        Err(error) => {
            eprintln!("[agent] {error}");
            eprintln!();
            print!("{}", filebox_updater::usage("agent"));
            std::process::exit(2);
        }
    }

    // Boost before the runtime spawns workers so they inherit the niceness.
    priority::apply_at_startup();

    let config = config::AgentConfig::load();
    tracing::info!("Agent starting, connecting to {}", config.hub_url);

    agent_runtime(true).block_on(connection::run_connection_loop(&config));
}

fn agent_runtime(boost_threads: bool) -> tokio::runtime::Runtime {
    let worker_threads = worker_thread_count();
    let blocking_threads = blocking_thread_count();
    tracing::info!(
        worker_threads,
        blocking_threads,
        boost_threads,
        "Starting compact Tokio runtime"
    );
    let mut builder = tokio::runtime::Builder::new_multi_thread();
    builder
        .enable_all()
        .worker_threads(worker_threads)
        .max_blocking_threads(blocking_threads)
        .thread_name("filebox-agent");
    if boost_threads {
        builder.on_thread_start(priority::apply_current_thread);
    }
    builder.build().expect("failed to start agent runtime")
}

fn worker_thread_count() -> usize {
    let configured = env_usize("FILEBOX_AGENT_WORKER_THREADS", DEFAULT_WORKER_THREADS)
        .clamp(MIN_WORKER_THREADS, MAX_WORKER_THREADS);
    let cores = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(DEFAULT_WORKER_THREADS)
        .max(MIN_WORKER_THREADS);
    configured.min(cores)
}

fn blocking_thread_count() -> usize {
    env_usize("FILEBOX_AGENT_MAX_BLOCKING_THREADS", DEFAULT_BLOCKING_THREADS)
        .clamp(MIN_BLOCKING_THREADS, MAX_BLOCKING_THREADS)
}

fn env_usize(name: &str, default: usize) -> usize {
    std::env::var(name)
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(default)
}
