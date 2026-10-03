use super::*;

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
}

impl AgentRuntime {
    pub(super) fn new(config: &AgentConfig) -> Self {
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

        Self {
            resource_mgr, stable_agent_id, stats_cache, dir_cache, content_cache,
            office_runtime, temp_store, fs_workers, dir_list_workers, search_inflight,
            search_cancels, terminal_manager,
            upload_workers: Arc::new(Semaphore::new(4)),
        }
    }

    #[cfg(test)]
    pub(super) fn for_tests(path: &std::path::Path) -> Self {
        let resource_mgr = ResourceManager::new(path.to_path_buf());
        Self {
            stable_agent_id: resource_mgr.agent_id().to_string(), resource_mgr,
            stats_cache: StatsCache::new(Duration::from_secs(60)), dir_cache: DirCache::new(),
            content_cache: Arc::new(ContentCache::new(4096, 4096)),
            office_runtime: None, temp_store: None,
            fs_workers: Arc::new(Semaphore::new(1)), dir_list_workers: Arc::new(Semaphore::new(1)),
            search_inflight: Arc::new(AtomicUsize::new(0)), search_cancels: Arc::new(Mutex::new(HashMap::new())),
            terminal_manager: Arc::new(crate::terminal::TerminalManager::new(None)),
            upload_workers: Arc::new(Semaphore::new(4)),
        }
    }

}
