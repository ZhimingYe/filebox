use super::*;
use tokio::sync::watch;

#[derive(Clone)]
pub(super) struct HerdrSettingsState {
    pub(super) enabled: bool,
    pub(super) locked: bool,
    pub(super) client: Option<Arc<crate::herdr::HerdrClient>>,
}

#[derive(Clone)]
pub(super) struct HerdrSettingsSnapshot {
    pub(super) revision: u64,
    pub(super) req_id: Option<String>,
    pub(super) enabled: bool,
    pub(super) available: bool,
    pub(super) locked: bool,
    pub(super) error: Option<String>,
}

pub(super) struct HerdrSettingsJob {
    pub(super) req_id: String,
    pub(super) enabled: bool,
    pub(super) previous: HerdrSettingsState,
}

// Services and worker limits survive reconnects. Stuck blocking syscalls
// retain permits from the same global bound after transport teardown.
pub(super) struct AgentRuntime {
    pub(super) resource_mgr: ResourceManager,
    pub(super) stable_agent_id: String,
    pub(super) stats_cache: Arc<StatsCache>,
    pub(super) dir_cache: Arc<DirCache>,
    pub(super) content_cache: Arc<ContentCache>,
    pub(super) office_runtime: Option<Arc<crate::office_convert::OfficeRuntime>>,
    pub(super) temp_store: Option<Arc<crate::temp_store::TempStore>>,
    pub(super) fs_workers: Arc<Semaphore>,
    pub(super) dir_list_workers: Arc<Semaphore>,
    pub(super) search_inflight: Arc<AtomicUsize>,
    pub(super) search_cancels: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
    pub(super) terminal_manager: Arc<crate::terminal::TerminalManager>,
    pub(super) upload_workers: Arc<Semaphore>,
    pub(super) config_path: std::path::PathBuf,
    pub(super) herdr_settings: Arc<std::sync::RwLock<HerdrSettingsState>>,
    pub(super) herdr_settings_updates: watch::Sender<HerdrSettingsSnapshot>,
    pub(super) herdr_settings_acks: watch::Sender<u64>,
    pub(super) herdr_admission_gate: Arc<Mutex<()>>,
    pub(super) herdr_settings_tx: mpsc::Sender<HerdrSettingsJob>,
    herdr_settings_rx: Option<mpsc::Receiver<HerdrSettingsJob>>,
    pub(super) herdr_settings_busy: Arc<AtomicBool>,
    pub(super) herdr_inflight: Arc<Semaphore>,
    pub(super) herdr_cancels: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
}

impl AgentRuntime {
    pub(super) async fn new(config: &AgentConfig) -> Self {
        let resource_mgr = ResourceManager::new(config.data_dir.clone());
        let stable_agent_id = resource_mgr.agent_id().to_string();
        let stats_cache: Arc<StatsCache> = StatsCache::new(stats_ttl());
        // Per-directory listing cache. Cuts the O(N)-per-page cost of paginating
        // large directories to O(1) on cache hits (mtime-validated), benefiting
        // both the main file list and the directory tree. Cleared on resource
        // reconfigure inside the connection loop.
        let dir_cache: Arc<DirCache> = DirCache::new();
        // Whole-file content cache for previews / downloads. Small files are read
        // once from storage, then served from memory while (size, mtime) match —
        // shared HPC filesystems (NFS / Lustre) can stall reads for seconds under
        // contention, and re-reading the same file per chunk multiplied that.
        // Cleared on resource reconfigure inside the connection loop.
        let content_cache: Arc<ContentCache> = Arc::new(ContentCache::from_env());
        let office_runtime = crate::office_convert::probe_from_env(&config.data_dir).and_then(
            |office_config| match crate::office_convert::OfficeRuntime::new(office_config) {
                Ok(runtime) => Some(runtime),
                Err(error) => {
                    tracing::warn!(
                        "Office runtime initialization failed: {} — office_pdf_preview disabled",
                        error
                    );
                    None
                }
            },
        );
        // Dedicated temp-upload folder — the ONLY write path in this agent.
        // Absent when the folder cannot be initialized; the capability is then
        // advertised as false and the hub rejects uploads.
        let temp_store = match crate::temp_store::TempStore::new(
            crate::temp_store::TempStoreConfig::from_env(
                &config.data_dir,
                config.temp_dir.as_deref(),
                config.temp_upload_name.as_deref(),
            ),
        ) {
            Ok(store) => Some(Arc::new(store)),
            Err(error) => {
                tracing::warn!("Temp upload folder disabled: {error}");
                None
            }
        };
        if let Some(store) = temp_store.as_ref() {
            tracing::info!(
                "Temp upload folder enabled: {} (max file {} bytes, total quota {} bytes)",
                store.upload_dir_str(),
                store.root_info().max_file_bytes,
                store.root_info().max_total_bytes,
            );
        }
        // Shared across reconnects. A filesystem syscall left behind by a broken
        // WebSocket must continue counting against the same global worker bound.
        let fs_workers = Arc::new(Semaphore::new(FS_WORKER_CONCURRENCY));
        let dir_list_workers = Arc::new(Semaphore::new(DIR_LIST_WORKER_CONCURRENCY));
        let search_inflight = Arc::new(AtomicUsize::new(0));
        let search_cancels: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>> =
            Arc::new(Mutex::new(HashMap::new()));
        // PTYs and anti-replay state live across every transport connection.
        let terminal_manager = Arc::new(crate::terminal::TerminalManager::new(config.terminal_totp_secret.clone()));
        let herdr = crate::herdr::HerdrClient::probe_enabled(config.herdr_enabled).await.map(Arc::new);
        let herdr_settings = Arc::new(std::sync::RwLock::new(HerdrSettingsState {
            enabled: config.herdr_enabled,
            locked: config.herdr_locked,
            client: herdr,
        }));
        let settings_snapshot = snapshot_settings(&herdr_settings, None, None, 0);
        let (herdr_settings_updates, _) = watch::channel(settings_snapshot);
        let (herdr_settings_acks, _) = watch::channel(0);
        let (herdr_settings_tx, herdr_settings_rx) = mpsc::channel(1);

        Self {
            resource_mgr, stable_agent_id, stats_cache, dir_cache, content_cache,
            office_runtime, temp_store, fs_workers, dir_list_workers, search_inflight,
            search_cancels, terminal_manager,
            upload_workers: Arc::new(Semaphore::new(4)),
            config_path: config.config_path.clone(),
            herdr_settings,
            herdr_settings_updates,
            herdr_settings_acks,
            herdr_admission_gate: Arc::new(Mutex::new(())),
            herdr_settings_tx,
            herdr_settings_rx: Some(herdr_settings_rx),
            herdr_settings_busy: Arc::new(AtomicBool::new(false)),
            herdr_inflight: Arc::new(Semaphore::new(2)),
            herdr_cancels: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    #[cfg(test)]
    pub(super) fn for_tests(path: &std::path::Path) -> Self {
        let resource_mgr = ResourceManager::new(path.to_path_buf());
        let (herdr_settings_tx, herdr_settings_rx) = mpsc::channel(1);
        let herdr_settings = Arc::new(std::sync::RwLock::new(HerdrSettingsState {
            enabled: true, locked: false, client: None,
        }));
        let (herdr_settings_updates, _) =
            watch::channel(snapshot_settings(&herdr_settings, None, None, 0));
        let (herdr_settings_acks, _) = watch::channel(0);
        Self {
            stable_agent_id: resource_mgr.agent_id().to_string(), resource_mgr,
            stats_cache: StatsCache::new(Duration::from_secs(60)), dir_cache: DirCache::new(),
            content_cache: Arc::new(ContentCache::new(4096, 4096)),
            office_runtime: None, temp_store: None,
            fs_workers: Arc::new(Semaphore::new(1)), dir_list_workers: Arc::new(Semaphore::new(1)),
            search_inflight: Arc::new(AtomicUsize::new(0)), search_cancels: Arc::new(Mutex::new(HashMap::new())),
            terminal_manager: Arc::new(crate::terminal::TerminalManager::new(None)),
            upload_workers: Arc::new(Semaphore::new(4)),
            config_path: path.join("agent.toml"),
            herdr_settings,
            herdr_settings_updates,
            herdr_settings_acks,
            herdr_admission_gate: Arc::new(Mutex::new(())),
            herdr_settings_tx,
            herdr_settings_rx: Some(herdr_settings_rx),
            herdr_settings_busy: Arc::new(AtomicBool::new(false)),
            herdr_inflight: Arc::new(Semaphore::new(1)),
            herdr_cancels: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub(super) fn start_herdr_settings_worker(&mut self) {
        let Some(receiver) = self.herdr_settings_rx.take() else { return; };
        tokio::spawn(run_herdr_settings_worker(
            receiver,
            self.herdr_settings.clone(),
            self.herdr_settings_busy.clone(),
            self.config_path.clone(),
            self.herdr_settings_updates.clone(),
            self.herdr_settings_acks.subscribe(),
            self.herdr_admission_gate.clone(),
            self.herdr_cancels.clone(),
        ));
    }

    pub(super) fn herdr_state(&self) -> HerdrSettingsState {
        self.herdr_settings.read().unwrap_or_else(|error| error.into_inner()).clone()
    }

    pub(super) fn herdr_capabilities(&self) -> (bool, bool, bool, bool) {
        let state = self.herdr_state();
        (true, state.enabled, state.locked, state.enabled && state.client.is_some())
    }

}

fn snapshot_settings(
    state: &Arc<std::sync::RwLock<HerdrSettingsState>>,
    req_id: Option<String>,
    error: Option<String>,
    revision: u64,
) -> HerdrSettingsSnapshot {
    let state = state.read().unwrap_or_else(|poisoned| poisoned.into_inner());
    HerdrSettingsSnapshot {
        revision,
        req_id,
        enabled: state.enabled,
        available: state.client.is_some(),
        locked: state.locked,
        error,
    }
}

async fn run_herdr_settings_worker(
    mut receiver: mpsc::Receiver<HerdrSettingsJob>,
    state: Arc<std::sync::RwLock<HerdrSettingsState>>,
    busy: Arc<AtomicBool>,
    config_path: std::path::PathBuf,
    updates: watch::Sender<HerdrSettingsSnapshot>,
    mut acknowledgements: watch::Receiver<u64>,
    admission_gate: Arc<Mutex<()>>,
    cancels: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
) {
    while let Some(job) = receiver.recv().await {
        let write_path = config_path.clone();
        let write_result = tokio::task::spawn_blocking(move || {
            crate::config::persist_herdr_enabled(&write_path, job.enabled)
        }).await.unwrap_or(Err(()));
        let error = write_result.err().map(|_| "herdr_settings_write_failed".to_string());
        if error.is_none() {
            let client = if job.enabled {
                crate::herdr::HerdrClient::probe_enabled(true).await.map(Arc::new)
            } else {
                job.previous.client.clone()
            };
            let _admission = admission_gate.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            *state.write().unwrap_or_else(|poisoned| poisoned.into_inner()) = HerdrSettingsState {
                enabled: job.enabled,
                locked: job.previous.locked,
                client,
            };
            if !job.enabled {
                if let Ok(map) = cancels.lock() {
                    for flag in map.values() {
                        flag.store(true, Ordering::Relaxed);
                    }
                }
            }
        }
        let revision = updates.borrow().revision.saturating_add(1);
        updates.send_replace(snapshot_settings(&state, Some(job.req_id), error, revision));
        while *acknowledgements.borrow_and_update() < revision {
            if acknowledgements.changed().await.is_err() {
                break;
            }
        }
        busy.store(false, Ordering::Release);
    }
}

pub(super) async fn forward_herdr_settings(
    mut updates: watch::Receiver<HerdrSettingsSnapshot>,
    acknowledgements: watch::Sender<u64>,
    tx: mpsc::Sender<AgentMessage>,
) {
    let initial = updates.borrow().clone();
    // A fresh runtime already advertised this state in Register. Only replay
    // an initial snapshot when a setting operation has a request id; this also
    // avoids injecting unsolicited responses into unrelated control queues.
    let mut sent_revision = if initial.req_id.is_some() {
        None
    } else {
        Some(initial.revision)
    };
    loop {
        let snapshot = updates.borrow().clone();
        if sent_revision != Some(snapshot.revision) {
            let permit = match tx.reserve().await {
                Ok(permit) => permit,
                Err(_) => return,
            };
            let latest = updates.borrow().clone();
            if latest.revision != snapshot.revision {
                drop(permit);
                continue;
            }
            permit.send(AgentMessage::HerdrSettingsResponse {
                req_id: latest.req_id.clone().unwrap_or_default(),
                enabled: latest.enabled,
                available: latest.available,
                locked: latest.locked,
                error: latest.error.clone(),
            });
            acknowledgements.send_modify(|acknowledged| {
                *acknowledged = (*acknowledged).max(latest.revision);
            });
            sent_revision = Some(snapshot.revision);
        }
        if updates.changed().await.is_err() {
            return;
        }
    }
}
