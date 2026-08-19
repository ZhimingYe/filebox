use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use tokio::sync::{mpsc, Notify, Semaphore};
use tokio::task::JoinSet;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;

use filebox_protocol::message::{AgentMessage, HubMessage};
use filebox_protocol::resources::{Capabilities, RootConfig};

use crate::config::AgentConfig;
use crate::content_cache::ContentCache;
use crate::dir_cache::DirCache;
use crate::resources::ResourceManager;
use crate::sysinfo::StatsCache;

/// User roots plus the synthetic temp-upload root (when enabled). The temp
/// root is appended for read-side resolution only — it is never persisted
/// into the desired set. A user root with the same name takes precedence.
fn roots_with_temp(
    mgr: &ResourceManager,
    temp_store: Option<&Arc<crate::temp_store::TempStore>>,
) -> Vec<RootConfig> {
    let mut roots = mgr.roots().to_vec();
    if let Some(store) = temp_store {
        if !roots.iter().any(|r| r.name == store.name()) {
            roots.push(RootConfig {
                name: store.name().to_string(),
                path: store.upload_dir_str(),
                enabled: true,
                pinned_folders: Vec::new(),
            });
        }
    }
    roots
}

/// At most one workspace search at a time — large trees are expensive and
/// must not pile up under load. Additional requests get a fast busy error.
const MAX_SEARCH_INFLIGHT: usize = 1;

/// File reads can block indefinitely in a kernel filesystem call (notably on
/// unhealthy NFS/FUSE mounts). Keep both the actively blocking set and the
/// waiting set bounded so file traffic cannot consume the Tokio blocking pool
/// or grow memory without limit. The queue accommodates a burst well above the
/// Hub's 96 concurrent raw streams without turning normal PDF traffic into a
/// historical/request-count quota.
const FS_WORKER_CONCURRENCY: usize = 32;
const FS_MAX_INFLIGHT: usize = 256;
const DIR_LIST_WORKER_CONCURRENCY: usize = 4;
const DIR_LIST_MAX_INFLIGHT: usize = 32;

struct FsCancellation {
    cancelled: Arc<AtomicBool>,
    notify: Notify,
}

impl FsCancellation {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            cancelled: Arc::new(AtomicBool::new(false)),
            notify: Notify::new(),
        })
    }

    fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
        self.notify.notify_one();
    }

    fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }
}

type FsCancellationMap = Arc<Mutex<HashMap<String, Arc<FsCancellation>>>>;

// ── Timeouts and tunables ─────────────────────────────────────────────────
//
// Designed for very flaky networks (NAT timeouts, wireless drops, HPC
// interconnect hiccups). The agent must detect a dead hub quickly and
// reconnect without manual intervention.

/// Hard cap on TCP connect + TLS handshake + WS upgrade. Without this, a
/// black-holed route can hang `connect_async` indefinitely.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// How long to wait for the hub's AuthResult before giving up.
const AUTH_TIMEOUT: Duration = Duration::from_secs(10);

/// If the hub sends nothing (no Ping, no Heartbeat, no message) for this
/// window, consider the connection dead and reconnect. Hub normally pings
/// every 15s, so 45s = 3 missed pings. This is the key defense against
/// silently-dropped TCP (NAT expiry, half-open after sleep): without an
/// application-level liveness check the agent would otherwise wait forever
/// on `read.next()`.
const NO_MESSAGE_TIMEOUT: Duration = Duration::from_secs(45);

/// Per-write timeout. A blocked write would otherwise stall the entire
/// `tokio::select!` loop (including the read-side liveness check), so
/// every WS write is bounded.
const WS_WRITE_TIMEOUT: Duration = Duration::from_secs(10);

/// Best-effort grace period for sending a Close frame before tearing down.
/// Close lets the hub detect our disconnect immediately instead of waiting
/// for a TCP timeout.
const CLOSE_SEND_TIMEOUT: Duration = Duration::from_secs(2);

/// A connection that lasted at least this long is considered "stable" —
/// the next attempt resets backoff to 1s. A connection that flaps faster
/// keeps growing its backoff to avoid hammering a broken hub.
const STABLE_CONNECTION_THRESHOLD: Duration = Duration::from_secs(30);

const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(15);

/// Translate a user-facing hub URL (http/https/ws/wss) into a WebSocket URL
/// ending in /ws/agent.
fn build_ws_url(hub_url: &str) -> String {
    let trimmed = hub_url.trim_end_matches('/');
    let (scheme, rest) = if let Some(rest) = trimmed.strip_prefix("https://") {
        ("wss://", rest)
    } else if let Some(rest) = trimmed.strip_prefix("http://") {
        ("ws://", rest)
    } else if let Some(rest) = trimmed.strip_prefix("wss://") {
        ("wss://", rest)
    } else if let Some(rest) = trimmed.strip_prefix("ws://") {
        ("ws://", rest)
    } else {
        ("ws://", trimmed)
    };
    format!("{}{}/ws/agent", scheme, rest)
}

fn stats_ttl() -> Duration {
    let secs = std::env::var("FILEBOX_AGENT_STATS_TTL_SECS")
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(15);
    Duration::from_secs(secs.max(1))
}

/// Send a WS message with a write timeout. Returns false on timeout or
/// error — caller should treat the connection as dead and reconnect.
async fn send_with_timeout<W>(write: &mut W, msg: Message) -> bool
where
    W: SinkExt<Message> + Unpin,
{
    match tokio::time::timeout(WS_WRITE_TIMEOUT, write.send(msg)).await {
        Ok(Ok(_)) => true,
        Ok(Err(_)) => {
            tracing::warn!("WS write failed");
            false
        }
        Err(_) => {
            tracing::warn!("WS write timed out after {}s", WS_WRITE_TIMEOUT.as_secs());
            false
        }
    }
}

/// Serialize and send an agent message. Returns false when the write fails
/// or times out — the connection loop must reconnect instead of continuing
/// as if the hub received the response.
async fn send_agent_message<W>(write: &mut W, msg: &AgentMessage) -> bool
where
    W: SinkExt<Message> + Unpin,
{
    let text = match serde_json::to_string(msg) {
        Ok(text) => text,
        Err(error) => {
            tracing::error!("Failed to serialize agent message: {}", error);
            return false;
        }
    };
    send_with_timeout(write, Message::Text(text.into())).await
}

fn try_spawn_fs_job<F>(
    tasks: &mut JoinSet<()>,
    admission: &Arc<Semaphore>,
    workers: &Arc<Semaphore>,
    tx: &mpsc::Sender<AgentMessage>,
    req_id: String,
    cancellations: &FsCancellationMap,
    job: F,
    cancelled_response: AgentMessage,
    panic_response: AgentMessage,
) -> bool
where
    F: FnOnce(Arc<AtomicBool>) -> AgentMessage + Send + 'static,
{
    let Ok(admission_permit) = admission.clone().try_acquire_owned() else {
        return false;
    };
    let workers = workers.clone();
    let tx = tx.clone();
    let cancellation = FsCancellation::new();
    if let Ok(mut map) = cancellations.lock() {
        if let Some(previous) = map.insert(req_id.clone(), cancellation.clone()) {
            previous.cancel();
        }
    }
    let cancellations = cancellations.clone();
    tasks.spawn(async move {
        let _admission_permit = admission_permit;
        let worker_permit = if cancellation.is_cancelled() {
            None
        } else {
            tokio::select! {
                permit = workers.acquire_owned() => permit.ok(),
                _ = cancellation.notify.notified() => None,
            }
        };
        let Some(worker_permit) = worker_permit else {
            let _ = tx.send(cancelled_response).await;
            remove_fs_cancellation(&cancellations, &req_id, &cancellation);
            return;
        };
        // Move the permit into the blocking closure. If the WebSocket
        // connection disappears and aborts this async wrapper, a kernel-stuck
        // syscall still owns its global permit until it actually returns.
        let cancel_flag = cancellation.cancelled.clone();
        let cancelled_in_worker = cancelled_response.clone();
        let blocking = tokio::task::spawn_blocking(move || {
            let _worker_permit = worker_permit;
            if cancel_flag.load(Ordering::Acquire) {
                cancelled_in_worker
            } else {
                job(cancel_flag)
            }
        });
        let response = match blocking.await {
            Ok(response) => response,
            Err(join_error) => {
                tracing::error!("File I/O worker failed: {}", join_error);
                panic_response
            }
        };
        let _ = tx.send(response).await;
        remove_fs_cancellation(&cancellations, &req_id, &cancellation);
    });
    true
}

fn remove_fs_cancellation(
    cancellations: &FsCancellationMap,
    req_id: &str,
    expected: &Arc<FsCancellation>,
) {
    if let Ok(mut map) = cancellations.lock() {
        if map
            .get(req_id)
            .is_some_and(|current| Arc::ptr_eq(current, expected))
        {
            map.remove(req_id);
        }
    }
}

pub async fn run_connection_loop(config: &AgentConfig) {
    let ws_url = build_ws_url(&config.hub_url);
    let mut backoff_secs = 1u64;
    let max_backoff = 300u64;

    if let Err(e) = std::fs::create_dir_all(&config.data_dir) {
        tracing::error!("Failed to create data directory {:?}: {}", config.data_dir, e);
        return;
    }

    let mut resource_mgr = ResourceManager::new(config.data_dir.clone());
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

    tracing::info!(
        "Agent ID: {}, data dir: {:?}",
        stable_agent_id,
        config.data_dir
    );

    loop {
        let connect_at = Instant::now();

        run_one_connection(
            &ws_url,
            config,
            &mut resource_mgr,
            &stable_agent_id,
            &stats_cache,
            &dir_cache,
            &content_cache,
            office_runtime.as_ref(),
            temp_store.as_ref(),
            &fs_workers,
            &dir_list_workers,
            &search_inflight,
            &search_cancels,
        )
        .await;

        let conn_duration = connect_at.elapsed();
        let was_stable = conn_duration >= STABLE_CONNECTION_THRESHOLD;

        // Compute sleep duration for THIS retry. A connection that just
        // demonstrated the network is healthy (lasted ≥ threshold) gets a
        // 1s sleep; a flapping connection sleeps the current backoff.
        let base = if was_stable { 1 } else { backoff_secs };
        // Jitter prevents thundering herd when many agents drop at once
        // (e.g., hub restart or network partition healing).
        let jitter = if base > 1 {
            rand::random::<u64>() % (base / 2)
        } else {
            0
        };
        let sleep_secs = base + jitter;

        tracing::info!(
            "Reconnecting in {}s (base={}, jitter={}, last_conn_duration={:?}, stable={})",
            sleep_secs,
            base,
            jitter,
            conn_duration,
            was_stable,
        );

        tokio::time::sleep(Duration::from_secs(sleep_secs)).await;

        // Update backoff for the NEXT unstable iteration: stable resets to 1
        // (so a future flap starts from 1s, not the doubled value), unstable
        // doubles. Without this conditional, every iteration's "always
        // double" would ratchet the backoff up even after stable connections.
        if was_stable {
            backoff_secs = 1;
        } else {
            backoff_secs = (backoff_secs * 2).min(max_backoff);
        }
    }
}

/// Open one WebSocket connection, authenticate, register, run the main
/// message loop until something fails. Always returns (caller applies
/// backoff and reconnects).
async fn run_one_connection(
    ws_url: &str,
    config: &AgentConfig,
    resource_mgr: &mut ResourceManager,
    stable_agent_id: &str,
    stats_cache: &Arc<StatsCache>,
    dir_cache: &Arc<DirCache>,
    content_cache: &Arc<ContentCache>,
    office_runtime: Option<&Arc<crate::office_convert::OfficeRuntime>>,
    temp_store: Option<&Arc<crate::temp_store::TempStore>>,
    fs_workers: &Arc<Semaphore>,
    dir_list_workers: &Arc<Semaphore>,
    search_inflight: &Arc<AtomicUsize>,
    search_cancels: &Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
) {
    tracing::info!("Connecting to {}", ws_url);

    // Step 1: Connect with hard timeout. Without this, a black-holed route
    // can leave us hung in DNS/TCP/TLS forever.
    let ws_stream = match tokio::time::timeout(CONNECT_TIMEOUT, connect_async(ws_url)).await {
        Ok(Ok((s, _))) => {
            tracing::info!("Connected to Hub");
            s
        }
        Ok(Err(e)) => {
            tracing::warn!("Connection failed: {}", e);
            return;
        }
        Err(_) => {
            tracing::warn!("Connection timed out after {}s", CONNECT_TIMEOUT.as_secs());
            return;
        }
    };

    let (mut write, mut read) = ws_stream.split();

    // Step 2: Send Auth
    let auth = AgentMessage::Auth {
        token: config.token.clone(),
    };
    let auth_msg = Message::Text(serde_json::to_string(&auth).unwrap().into());
    if !send_with_timeout(&mut write, auth_msg).await {
        tracing::warn!("Failed to send auth");
        return;
    }

    // Step 3: Wait for AuthResult
    let auth_result = tokio::time::timeout(AUTH_TIMEOUT, read.next()).await;
    let assigned_agent_id = match auth_result {
        Ok(Some(Ok(Message::Text(text)))) => match serde_json::from_str::<HubMessage>(&text) {
            Ok(HubMessage::AuthResult {
                success: true,
                agent_id: Some(id),
            }) => {
                tracing::info!("Authenticated as agent {}", id);
                id
            }
            Ok(HubMessage::AuthResult {
                success: false, ..
            }) => {
                tracing::error!("Authentication failed");
                return;
            }
            _ => {
                tracing::warn!("Unexpected auth response: {}", text);
                return;
            }
        },
        _ => {
            tracing::warn!("Timeout or error waiting for auth result");
            return;
        }
    };

    // Step 4: Send Register with persisted resource state
    let (rev, roots) = resource_mgr.current_state();
    let (collections_rev, collections) = resource_mgr.current_collections_state();
    // Advertise pinned_folders support explicitly. Capabilities::default()
    // leaves it false (the legacy-detection sentinel), so a NEW agent must opt
    // in here — this is what lets the hub tell a new agent from a pre-pin
    // agent during a rolling upgrade and avoid pushing pins to one that can't
    // store them.
    let mut capabilities = Capabilities::default();
    capabilities.pinned_folders = true;
    capabilities.collections = true;
    capabilities.workspace_search = true;
    // Temporary runtime degradation is request-scoped, not a capability
    // change. Keeping the configured capability advertised lets a later
    // user-triggered retry recover after Office is reinstalled, without
    // polling or requiring another Agent reconnect.
    capabilities.office_pdf_preview = office_runtime.is_some();
    if let Some(runtime) = office_runtime {
        capabilities.office_max_src_bytes = Some(runtime.config.max_src_bytes);
        capabilities.office_max_pdf_bytes = Some(runtime.config.max_pdf_bytes);
        capabilities.office_timeout_secs = Some(runtime.config.timeout.as_secs());
    }
    // The temp folder is a capability AND a synthetic root. The root never
    // enters the persisted desired set — the hub surfaces it to the UI from
    // the Register payload, and this agent resolves the name specially.
    capabilities.temp_upload = temp_store.is_some();
    let temp_root = temp_store.map(|store| store.root_info());
    let register = AgentMessage::Register {
        agent_id: Some(stable_agent_id.to_string()),
        name: config.agent_name.clone(),
        resource_revision: rev,
        roots,
        capabilities,
        collections_revision: collections_rev,
        collections,
        temp_root,
    };
    let register_msg = Message::Text(serde_json::to_string(&register).unwrap().into());
    if !send_with_timeout(&mut write, register_msg).await {
        tracing::warn!("Failed to send register");
        return;
    }

    tracing::info!(
        "Registered as {} (rev={})",
        config.agent_name,
        resource_mgr.resource_revision()
    );

    // Step 5: Main message loop with liveness timeout.
    let mut ping_interval = tokio::time::interval(HEARTBEAT_INTERVAL);

    // Workspace search / office convert run off the WS loop so heartbeats
    // keep working. Completed responses arrive on worker_rx.
    // Capacity >1 so Progress try_send rarely drops under burst.
    let (search_tx, mut search_rx) = mpsc::channel::<AgentMessage>(32);
    let (office_tx, mut office_rx) = mpsc::channel::<AgentMessage>(32);
    let (stats_tx, mut stats_rx) = mpsc::channel::<AgentMessage>(8);
    let (fs_tx, mut fs_rx) = mpsc::channel::<AgentMessage>(128);
    let (temp_tx, mut temp_rx) = mpsc::channel::<AgentMessage>(16);
    let fs_admission = Arc::new(Semaphore::new(FS_MAX_INFLIGHT));
    let dir_list_admission = Arc::new(Semaphore::new(DIR_LIST_MAX_INFLIGHT));
    let fs_cancellations: FsCancellationMap = Arc::new(Mutex::new(HashMap::new()));
    let mut fs_tasks = JoinSet::new();
    // Active temp-upload sessions: req_id -> chunk queue owned by that
    // session's writer task. The read loop only forwards chunks; the blocking
    // disk I/O happens off the WS loop.
    let mut temp_writers: HashMap<String, mpsc::Sender<(u64, Vec<u8>, bool)>> = HashMap::new();

    loop {
        tokio::select! {
            // Completed (or failed) workspace search — never block the read loop
            // waiting on spawn_blocking for these.
            Some(response) = search_rx.recv() => {
                if !send_agent_message(&mut write, &response).await {
                    tracing::warn!("Failed to send search response, reconnecting");
                    break;
                }
            }
            Some(response) = office_rx.recv() => {
                if !send_agent_message(&mut write, &response).await {
                    tracing::warn!("Failed to send office response, reconnecting");
                    break;
                }
            }
            Some(response) = stats_rx.recv() => {
                if !send_agent_message(&mut write, &response).await {
                    tracing::warn!("Failed to send stats response, reconnecting");
                    break;
                }
            }
            Some(response) = fs_rx.recv() => {
                if !send_agent_message(&mut write, &response).await {
                    tracing::warn!("Failed to send file I/O response, reconnecting");
                    break;
                }
            }
            Some(response) = temp_rx.recv() => {
                if !send_agent_message(&mut write, &response).await {
                    tracing::warn!("Failed to send temp upload response, reconnecting");
                    break;
                }
            }
            Some(result) = fs_tasks.join_next(), if !fs_tasks.is_empty() => {
                if let Err(error) = result {
                    tracing::warn!("File I/O task ended unexpectedly: {}", error);
                }
            }
            // Wrap read.next() in a timeout so a silent half-open TCP is
            // detected within NO_MESSAGE_TIMEOUT rather than waiting for the
            // OS's TCP keepalive (~2 hours on default Linux).
            msg = tokio::time::timeout(NO_MESSAGE_TIMEOUT, read.next()) => {
                match msg {
                    Err(_) => {
                        tracing::warn!(
                            "No message from hub in {}s, reconnecting",
                            NO_MESSAGE_TIMEOUT.as_secs()
                        );
                        break;
                    }
                    Ok(None) => {
                        tracing::info!("Connection stream ended");
                        break;
                    }
                    Ok(Some(Err(e))) => {
                        tracing::info!("Read error: {}", e);
                        break;
                    }
                    Ok(Some(Ok(Message::Text(text)))) => {
                        match serde_json::from_str::<HubMessage>(&text) {
                            Ok(HubMessage::Ping) => {
                                if !send_agent_message(&mut write, &AgentMessage::Pong).await {
                                    tracing::warn!("Failed to send pong, reconnecting");
                                    break;
                                }
                            }
                            Ok(HubMessage::ResourcesSetDesired {
                                req_id,
                                desired_revision,
                                roots,
                            }) => {
                                tracing::info!(
                                    "Received resource update: rev={}, {} roots",
                                    desired_revision,
                                    roots.len()
                                );

                                let response = match resource_mgr.apply_desired(desired_revision, roots) {
                                    Ok(new_rev) => {
                                        // Roots may have changed (path/name/enabled/denylist
                                        // semantics via root config), so cached listings could
                                        // describe the wrong tree. Drop them all — they re-warm
                                        // lazily on the next request. Cheaper and safer than
                                        // trying to invalidate granularly.
                                        dir_cache.clear();
                                        // Same for content: a root's path /
                                        // enabled / denylist semantics may have
                                        // changed, so cached bytes could
                                        // describe the wrong tree.
                                        content_cache.clear();

                                        let update = AgentMessage::ResourcesUpdated {
                                            agent_id: assigned_agent_id.clone(),
                                            resource_revision: new_rev,
                                            roots: resource_mgr.roots().to_vec(),
                                        };
                                        if !send_agent_message(&mut write, &update).await {
                                            tracing::warn!("Failed to send ResourcesUpdated, reconnecting");
                                            break;
                                        }

                                        AgentMessage::ResourcesApplied {
                                            req_id: req_id.clone(),
                                            agent_id: assigned_agent_id.clone(),
                                            resource_revision: new_rev,
                                        }
                                    }
                                    Err(err_msg) => {
                                        tracing::warn!("Resource update rejected: {}", err_msg);
                                        AgentMessage::ResourcesRejected {
                                            req_id: req_id.clone(),
                                            agent_id: assigned_agent_id.clone(),
                                            current_resource_revision: resource_mgr.resource_revision(),
                                            error: "invalid_resource".to_string(),
                                            message: err_msg,
                                        }
                                    }
                                };

                                if !send_agent_message(&mut write, &response).await {
                                    tracing::warn!("Failed to send resource response, reconnecting");
                                    break;
                                }
                            }
                            Ok(HubMessage::CollectionsSetDesired {
                                req_id,
                                desired_revision,
                                collections,
                            }) => {
                                tracing::info!(
                                    "Received collections update: rev={}, {} collections",
                                    desired_revision,
                                    collections.len()
                                );

                                let response = match resource_mgr.apply_collections_desired(
                                    desired_revision,
                                    collections,
                                ) {
                                    Ok(new_rev) => {
                                        let update = AgentMessage::CollectionsUpdated {
                                            agent_id: assigned_agent_id.clone(),
                                            collections_revision: new_rev,
                                            collections: resource_mgr.collections().to_vec(),
                                        };
                                        if !send_agent_message(&mut write, &update).await {
                                            tracing::warn!("Failed to send CollectionsUpdated, reconnecting");
                                            break;
                                        }

                                        AgentMessage::CollectionsApplied {
                                            req_id: req_id.clone(),
                                            agent_id: assigned_agent_id.clone(),
                                            collections_revision: new_rev,
                                        }
                                    }
                                    Err(err_msg) => {
                                        tracing::warn!("Collections update rejected: {}", err_msg);
                                        AgentMessage::CollectionsRejected {
                                            req_id: req_id.clone(),
                                            agent_id: assigned_agent_id.clone(),
                                            current_collections_revision: resource_mgr
                                                .collections_revision(),
                                            error: "invalid_collection".to_string(),
                                            message: err_msg,
                                        }
                                    }
                                };

                                if !send_agent_message(&mut write, &response).await {
                                    tracing::warn!("Failed to send collections response, reconnecting");
                                    break;
                                }
                            }
                            Ok(HubMessage::FsListRequest { req_id, root, path, limit, cursor, dirs_only }) => {
                                tracing::debug!("FS list: root={}, path={}, dirs_only={:?}", root, path, dirs_only);
                                let roots_vec = roots_with_temp(resource_mgr, temp_store);
                                let dirs_only_flag = dirs_only.unwrap_or(false);
                                let cache_clone = dir_cache.clone();
                                let rid = req_id.clone();
                                let panic_response = AgentMessage::FsListResponse {
                                    req_id: rid,
                                    items: vec![],
                                    next_cursor: None,
                                    error: Some("agent_internal_error".to_string()),
                                };
                                let cancelled_response = AgentMessage::FsListResponse {
                                    req_id: req_id.clone(),
                                    items: vec![],
                                    next_cursor: None,
                                    error: Some("request_cancelled".to_string()),
                                };
                                let job_req_id = req_id.clone();
                                let accepted = try_spawn_fs_job(
                                    &mut fs_tasks,
                                    &dir_list_admission,
                                    dir_list_workers,
                                    &fs_tx,
                                    req_id.clone(),
                                    &fs_cancellations,
                                    move |cancelled| match cache_clone.list_with_cancel(
                                        &roots_vec, &root, &path, limit as usize,
                                        cursor.as_deref(), dirs_only_flag, &cancelled,
                                    ) {
                                        Ok((items, next_cursor)) => AgentMessage::FsListResponse {
                                            req_id: job_req_id,
                                            items,
                                            next_cursor,
                                            error: None,
                                        },
                                        Err(e) => AgentMessage::FsListResponse {
                                            req_id: job_req_id,
                                            items: vec![],
                                            next_cursor: None,
                                            error: Some(e),
                                        },
                                    },
                                    cancelled_response,
                                    panic_response,
                                );
                                if !accepted {
                                    let response = AgentMessage::FsListResponse {
                                        req_id,
                                        items: vec![],
                                        next_cursor: None,
                                        error: Some(
                                            "agent_overloaded: file I/O queue is full".to_string(),
                                        ),
                                    };
                                    if !send_agent_message(&mut write, &response).await {
                                        tracing::warn!("Failed to send fs list overload response, reconnecting");
                                        break;
                                    }
                                }
                            }
                            Ok(HubMessage::FsStatRequest { req_id, root, path }) => {
                                tracing::debug!("FS stat: root={}, path={}", root, path);
                                let roots_vec = roots_with_temp(resource_mgr, temp_store);
                                let runtime = office_runtime.cloned();
                                let rid = req_id.clone();
                                let panic_response = AgentMessage::FsStatResponse {
                                    req_id: rid,
                                    stat: None,
                                    error: Some("agent_internal_error".to_string()),
                                };
                                let cancelled_response = AgentMessage::FsStatResponse {
                                    req_id: req_id.clone(),
                                    stat: None,
                                    error: Some("request_cancelled".to_string()),
                                };
                                let job_req_id = req_id.clone();
                                let accepted = try_spawn_fs_job(
                                    &mut fs_tasks,
                                    &fs_admission,
                                    fs_workers,
                                    &fs_tx,
                                    req_id.clone(),
                                    &fs_cancellations,
                                    move |cancelled| {
                                        if cancelled.load(Ordering::Acquire) {
                                            return AgentMessage::FsStatResponse {
                                                req_id: job_req_id.clone(),
                                                stat: None,
                                                error: Some("request_cancelled".to_string()),
                                            };
                                        }
                                        if let Some(cache) =
                                            crate::office_convert::parse_cache_virtual_path(&path)
                                        {
                                            match runtime {
                                                Some(rt) => match crate::office_convert::stat_cache(
                                                    &rt.config.office_dir,
                                                    &roots_vec,
                                                    &root,
                                                    &cache,
                                                ) {
                                                    Ok(size) => AgentMessage::FsStatResponse {
                                                        req_id: job_req_id,
                                                        stat: Some(
                                                            filebox_protocol::resources::FileStat {
                                                                path,
                                                                entry_type:
                                                                    filebox_protocol::resources::FsEntryType::File,
                                                                size,
                                                                modified: None,
                                                                permissions: None,
                                                                denied: false,
                                                            },
                                                        ),
                                                        error: None,
                                                    },
                                                    Err(e) => AgentMessage::FsStatResponse {
                                                        req_id: job_req_id,
                                                        stat: None,
                                                        error: Some(e),
                                                    },
                                                },
                                                None => AgentMessage::FsStatResponse {
                                                    req_id: job_req_id,
                                                    stat: None,
                                                    error: Some("office_unavailable".to_string()),
                                                },
                                            }
                                        } else {
                                            match crate::fs::stat_file(&roots_vec, &root, &path) {
                                                Ok(stat) => AgentMessage::FsStatResponse {
                                                    req_id: job_req_id,
                                                    stat: Some(stat),
                                                    error: None,
                                                },
                                                Err(e) => AgentMessage::FsStatResponse {
                                                    req_id: job_req_id,
                                                    stat: None,
                                                    error: Some(e),
                                                },
                                            }
                                        }
                                    },
                                    cancelled_response,
                                    panic_response,
                                );
                                if !accepted {
                                    let response = AgentMessage::FsStatResponse {
                                        req_id,
                                        stat: None,
                                        error: Some(
                                            "agent_overloaded: file I/O queue is full".to_string(),
                                        ),
                                    };
                                    if !send_agent_message(&mut write, &response).await {
                                        tracing::warn!("Failed to send fs stat overload response, reconnecting");
                                        break;
                                    }
                                }
                            }
                            Ok(HubMessage::FileReadRequest { req_id, root, path, offset, length }) => {
                                tracing::debug!("FS read: root={}, path={}, offset={}, len={:?}", root, path, offset, length);
                                let roots_vec = roots_with_temp(resource_mgr, temp_store);
                                let runtime = office_runtime.cloned();
                                let content_cache_ref = content_cache.clone();
                                let rid = req_id.clone();
                                let panic_response = AgentMessage::FileChunk {
                                    req_id: rid,
                                    offset: 0,
                                    data: vec![],
                                    done: true,
                                    error: Some("agent_internal_error".to_string()),
                                    file_size: None,
                                    modified: None,
                                };
                                let cancelled_response = AgentMessage::FileChunk {
                                    req_id: req_id.clone(),
                                    offset,
                                    data: vec![],
                                    done: true,
                                    error: Some("request_cancelled".to_string()),
                                    file_size: None,
                                    modified: None,
                                };
                                let job_req_id = req_id.clone();
                                let accepted = try_spawn_fs_job(
                                    &mut fs_tasks,
                                    &fs_admission,
                                    fs_workers,
                                    &fs_tx,
                                    req_id.clone(),
                                    &fs_cancellations,
                                    move |cancelled| {
                                        if cancelled.load(Ordering::Acquire) {
                                            return AgentMessage::FileChunk {
                                                req_id: job_req_id.clone(),
                                                offset,
                                                data: vec![],
                                                done: true,
                                                error: Some("request_cancelled".to_string()),
                                                file_size: None,
                                                modified: None,
                                            };
                                        }
                                        let read_result = if let Some(cache) =
                                            crate::office_convert::parse_cache_virtual_path(&path)
                                        {
                                            match runtime {
                                                Some(rt) => crate::office_convert::read_cache_range(
                                                    &rt.config.office_dir,
                                                    &roots_vec,
                                                    &root,
                                                    &cache,
                                                    offset,
                                                    length,
                                                )
                                                .map(|(data, done, file_len)| {
                                                    crate::fs::FileReadRange {
                                                        data,
                                                        done,
                                                        file_size: Some(file_len),
                                                        modified: None,
                                                    }
                                                }),
                                                None => Err("office_unavailable".to_string()),
                                            }
                                        } else {
                                            crate::fs::read_file_range_with_metadata(
                                                &roots_vec,
                                                &root,
                                                &path,
                                                offset,
                                                length,
                                                Some(&content_cache_ref),
                                            )
                                        };
                                        if cancelled.load(Ordering::Acquire) {
                                            return AgentMessage::FileChunk {
                                                req_id: job_req_id.clone(),
                                                offset,
                                                data: vec![],
                                                done: true,
                                                error: Some("request_cancelled".to_string()),
                                                file_size: None,
                                                modified: None,
                                            };
                                        }
                                        match read_result {
                                            Ok(result) => AgentMessage::FileChunk {
                                                req_id: job_req_id,
                                                offset,
                                                data: result.data,
                                                done: result.done,
                                                error: None,
                                                file_size: result.file_size,
                                                modified: result.modified,
                                            },
                                            Err(e) => AgentMessage::FileChunk {
                                                req_id: job_req_id,
                                                offset: 0,
                                                data: vec![],
                                                done: true,
                                                error: Some(e),
                                                file_size: None,
                                                modified: None,
                                            },
                                        }
                                    },
                                    cancelled_response,
                                    panic_response,
                                );
                                if !accepted {
                                    let response = AgentMessage::FileChunk {
                                        req_id,
                                        offset: 0,
                                        data: vec![],
                                        done: true,
                                        error: Some(
                                            "agent_overloaded: file I/O queue is full".to_string(),
                                        ),
                                        file_size: None,
                                        modified: None,
                                    };
                                    if !send_agent_message(&mut write, &response).await {
                                        tracing::warn!("Failed to send file read overload response, reconnecting");
                                        break;
                                    }
                                }
                            }
                            Ok(HubMessage::Cancel { req_id }) => {
                                tracing::debug!("Cancel request: {}", req_id);
                                if let Ok(map) = fs_cancellations.lock() {
                                    if let Some(cancellation) = map.get(&req_id) {
                                        cancellation.cancel();
                                    }
                                }
                                if let Ok(map) = search_cancels.lock() {
                                    if let Some(flag) = map.get(&req_id) {
                                        flag.store(true, Ordering::Relaxed);
                                    }
                                }
                                if let Some(rt) = office_runtime {
                                    rt.request_cancel(&req_id);
                                }
                                if let Some(store) = temp_store {
                                    store.cancel(&req_id);
                                }
                                // Drop the session's chunk queue so its writer
                                // task wakes from blocking_recv and exits.
                                temp_writers.remove(&req_id);
                            }
                            Ok(HubMessage::SysStatsRequest { req_id }) => {
                                tracing::debug!("Sys stats request");
                                let stats_cache = Arc::clone(stats_cache);
                                let tx = stats_tx.clone();
                                tokio::spawn(async move {
                                    let stats = stats_cache.get().await;
                                    let response = AgentMessage::SysStatsResponse {
                                        req_id,
                                        stats: Some((*stats).clone()),
                                        error: None,
                                    };
                                    let _ = tx.send(response).await;
                                });
                            }
                            Ok(HubMessage::WorkspaceSearchRequest {
                                req_id,
                                mode,
                                root,
                                path,
                                query,
                                extensions,
                                max_results,
                                context,
                                ignore,
                                max_depth,
                            }) => {
                                tracing::debug!(
                                    "Workspace search: mode={:?} root={} path={} query_len={}",
                                    mode,
                                    root,
                                    path,
                                    query.len()
                                );
                                // Atomic slot take — avoid TOCTOU where two
                                // concurrent requests both pass a load() check.
                                let prev = search_inflight.fetch_add(1, Ordering::AcqRel);
                                if prev >= MAX_SEARCH_INFLIGHT {
                                    search_inflight.fetch_sub(1, Ordering::AcqRel);
                                    let busy = AgentMessage::WorkspaceSearchResponse {
                                        req_id,
                                        result: None,
                                        error: Some(
                                            "agent_busy: another search is already running"
                                                .to_string(),
                                        ),
                                    };
                                    if !send_agent_message(&mut write, &busy).await {
                                        tracing::warn!("Failed to send search busy response, reconnecting");
                                        break;
                                    }
                                    continue;
                                }

                                let cancel = Arc::new(AtomicBool::new(false));
                                if let Ok(mut map) = search_cancels.lock() {
                                    map.insert(req_id.clone(), cancel.clone());
                                }

                                let roots_vec = roots_with_temp(resource_mgr, temp_store);
                                let tx = search_tx.clone();
                                let progress_tx = search_tx.clone();
                                let inflight = search_inflight.clone();
                                let cancels = search_cancels.clone();
                                let rid = req_id.clone();
                                let rid_for_progress = req_id.clone();
                                let on_progress: Arc<dyn Fn(u64, u64) + Send + Sync> =
                                    Arc::new(move |scanned, hits| {
                                        let msg = AgentMessage::Progress {
                                            req_id: rid_for_progress.clone(),
                                            phase: "search".to_string(),
                                            processed: scanned,
                                            total: None,
                                            message: Some(format!(
                                                "Scanned {scanned} files · {hits} hits"
                                            )),
                                        };
                                        // Non-blocking: drop progress if the
                                        // outbound queue is full so search
                                        // never stalls waiting on the WS loop.
                                        let _ = progress_tx.try_send(msg);
                                    });
                                let params = crate::search::SearchParams {
                                    mode,
                                    root,
                                    path,
                                    query,
                                    extensions,
                                    max_results,
                                    context,
                                    ignore,
                                    max_depth,
                                    cancel: Some(cancel),
                                    on_progress: Some(on_progress),
                                };
                                // Fire-and-forget worker — WS loop stays free
                                // for heartbeats, FS ops, and Cancel.
                                tokio::task::spawn_blocking(move || {
                                    let _ = tx.try_send(AgentMessage::Progress {
                                        req_id: rid.clone(),
                                        phase: "search".to_string(),
                                        processed: 0,
                                        total: None,
                                        message: Some("Starting search…".to_string()),
                                    });
                                    let outcome = std::panic::catch_unwind(
                                        std::panic::AssertUnwindSafe(|| {
                                            crate::search::run_search(&roots_vec, params)
                                        }),
                                    );
                                    let response = match outcome {
                                        Ok(Ok(result)) => AgentMessage::WorkspaceSearchResponse {
                                            req_id: rid.clone(),
                                            result: Some(result),
                                            error: None,
                                        },
                                        Ok(Err(e)) => AgentMessage::WorkspaceSearchResponse {
                                            req_id: rid.clone(),
                                            result: None,
                                            error: Some(e),
                                        },
                                        Err(_) => {
                                            tracing::error!(
                                                "Workspace search worker panicked for {}",
                                                rid
                                            );
                                            AgentMessage::WorkspaceSearchResponse {
                                                req_id: rid.clone(),
                                                result: None,
                                                error: Some("agent_internal_error".to_string()),
                                            }
                                        }
                                    };
                                    if let Ok(mut map) = cancels.lock() {
                                        map.remove(&rid);
                                    }
                                    inflight.fetch_sub(1, Ordering::AcqRel);
                                    // After WS teardown drops search_rx this
                                    // returns immediately; while the loop is
                                    // alive it must deliver the terminal msg.
                                    let _ = tx.blocking_send(response);
                                });
                            }
                            Ok(HubMessage::OfficeConvertRequest {
                                req_id,
                                root,
                                path,
                                force,
                            }) => {
                                tracing::debug!(
                                    "Office convert: root={} path={}",
                                    root,
                                    path
                                );
                                let Some(rt) = office_runtime.cloned() else {
                                    let resp = AgentMessage::OfficeConvertResponse {
                                        req_id,
                                        cache_key: None,
                                        size: None,
                                        outputs: vec![],
                                        error: Some("unsupported_feature".to_string()),
                                    };
                                    if !send_agent_message(&mut write, &resp).await {
                                        tracing::warn!("Failed to send office unsupported response, reconnecting");
                                        break;
                                    }
                                    continue;
                                };
                                let lease = match rt.reserve_job(&req_id) {
                                    Ok(lease) => lease,
                                    Err(error) => {
                                        let resp = AgentMessage::OfficeConvertResponse {
                                            req_id,
                                            cache_key: None,
                                            size: None,
                                            outputs: vec![],
                                            error: Some(error),
                                        };
                                        if !send_agent_message(&mut write, &resp).await {
                                            tracing::warn!("Failed to send office overload response, reconnecting");
                                            break;
                                        }
                                        continue;
                                    }
                                };
                                let roots_vec = roots_with_temp(resource_mgr, temp_store);
                                let tx = office_tx.clone();
                                let progress_tx = office_tx.clone();
                                let rid = req_id.clone();
                                let rid_for_progress = req_id.clone();
                                let on_progress: crate::office_convert::ProgressFn =
                                    Arc::new(move |phase, processed, message| {
                                        let msg = AgentMessage::Progress {
                                            req_id: rid_for_progress.clone(),
                                            phase: phase.to_string(),
                                            processed,
                                            // Phase index only — not a byte total.
                                            total: None,
                                            message,
                                        };
                                        let _ = progress_tx.try_send(msg);
                                    });
                                let worker_timeout =
                                    rt.config.timeout.saturating_add(Duration::from_secs(5));
                                let rt_for_timeout = rt.clone();
                                let worker = tokio::task::spawn_blocking(move || {
                                    let _ = tx.try_send(AgentMessage::Progress {
                                        req_id: rid.clone(),
                                        phase: "preparing".to_string(),
                                        processed: 0,
                                        total: None,
                                        message: Some("Preparing preview…".to_string()),
                                    });
                                    let outcome =
                                        crate::office_convert::run_convert_reserved_with_options(
                                            rt.as_ref(),
                                            &roots_vec,
                                            &rid,
                                            &root,
                                            &path,
                                            lease,
                                            force,
                                            Some(on_progress),
                                        );
                                    match outcome {
                                        Ok(r) => {
                                            let legacy_pdf = r
                                                .outputs
                                                .first()
                                                .is_some_and(|output| output.format == "pdf");
                                            AgentMessage::OfficeConvertResponse {
                                                req_id: rid.clone(),
                                                cache_key: legacy_pdf
                                                    .then_some(r.cache_key),
                                                size: legacy_pdf.then_some(r.size),
                                                outputs: r.outputs,
                                                error: None,
                                            }
                                        }
                                        Err(e) => AgentMessage::OfficeConvertResponse {
                                            req_id: rid.clone(),
                                            cache_key: None,
                                            size: None,
                                            outputs: vec![],
                                            error: Some(e),
                                        },
                                    }
                                });
                                let terminal_tx = office_tx.clone();
                                let terminal_req_id = req_id.clone();
                                tokio::spawn(async move {
                                    let response =
                                        match tokio::time::timeout(worker_timeout, worker).await {
                                        Ok(Ok(response)) => response,
                                        Ok(Err(join_error)) => {
                                            tracing::error!(
                                                "Office worker failed for {}: {}",
                                                terminal_req_id,
                                                join_error
                                            );
                                            AgentMessage::OfficeConvertResponse {
                                                req_id: terminal_req_id,
                                                cache_key: None,
                                                size: None,
                                                outputs: vec![],
                                                error: Some("office_internal_error".to_string()),
                                            }
                                        }
                                        Err(_) => {
                                            // A kernel-stuck filesystem read cannot be force-
                                            // cancelled in-process. Still finish the protocol
                                            // request on time and set the cooperative flag; the
                                            // bounded blocking pool isolates any lingering syscall.
                                            rt_for_timeout.request_cancel(&terminal_req_id);
                                            AgentMessage::OfficeConvertResponse {
                                                req_id: terminal_req_id,
                                                cache_key: None,
                                                size: None,
                                                outputs: vec![],
                                                error: Some("office_timeout".to_string()),
                                            }
                                        }
                                    };
                                    let _ = terminal_tx.send(response).await;
                                });
                            }
                            Ok(HubMessage::TempUploadBegin { req_id, name, total_size }) => {
                                tracing::debug!(
                                    "Temp upload begin: name={}, total={}",
                                    name,
                                    total_size
                                );
                                let Some(store) = temp_store.cloned() else {
                                    let response = AgentMessage::TempUploadResponse {
                                        req_id,
                                        name: None,
                                        size: None,
                                        error: Some("temp_unavailable".to_string()),
                                    };
                                    if !send_agent_message(&mut write, &response).await {
                                        tracing::warn!("Failed to send temp upload response, reconnecting");
                                        break;
                                    }
                                    continue;
                                };
                                if let Err(error) = store.begin(&req_id, &name, total_size) {
                                    let response = AgentMessage::TempUploadResponse {
                                        req_id,
                                        name: None,
                                        size: None,
                                        error: Some(error),
                                    };
                                    if !send_agent_message(&mut write, &response).await {
                                        tracing::warn!("Failed to send temp upload response, reconnecting");
                                        break;
                                    }
                                    continue;
                                }
                                // Spawn a dedicated writer for this session: it
                                // owns the chunk queue and does the blocking
                                // disk I/O (writes, flush, collision-prone
                                // publish) off the WS read loop, so heartbeats
                                // and other traffic keep flowing during
                                // slow-storage uploads.
                                let (chunk_tx, chunk_rx) =
                                    mpsc::channel::<(u64, Vec<u8>, bool)>(16);
                                temp_writers.insert(req_id.clone(), chunk_tx);
                                let tx = temp_tx.clone();
                                let rid = req_id.clone();
                                tokio::task::spawn_blocking(move || {
                                    let mut rx = chunk_rx;
                                    let response = loop {
                                        let Some((offset, data, done)) = rx.blocking_recv()
                                        else {
                                            // Channel closed (cancel or connection
                                            // teardown) before a terminal chunk —
                                            // nothing to respond.
                                            return;
                                        };
                                        match store.write_chunk(&rid, offset, &data, done) {
                                            Ok(None) => continue,
                                            Ok(Some((name, size))) => {
                                                break AgentMessage::TempUploadResponse {
                                                    req_id: rid,
                                                    name: Some(name),
                                                    size: Some(size),
                                                    error: None,
                                                };
                                            }
                                            // `temp_no_session` means a terminal
                                            // response was already sent (Begin
                                            // failed or the session was
                                            // cancelled) — never double-respond.
                                            Err(error) if error == "temp_no_session" => return,
                                            Err(error) => {
                                                break AgentMessage::TempUploadResponse {
                                                    req_id: rid,
                                                    name: None,
                                                    size: None,
                                                    error: Some(error),
                                                };
                                            }
                                        }
                                    };
                                    // After WS teardown drops temp_rx this
                                    // returns immediately; while the loop is
                                    // alive it must deliver the terminal msg.
                                    let _ = tx.blocking_send(response);
                                });
                            }
                            Ok(HubMessage::TempUploadChunk { req_id, offset, data, done }) => {
                                let Some(tx) = temp_writers.get(&req_id) else {
                                    // `temp_no_session` semantics: a terminal
                                    // response was already sent or the session
                                    // was cancelled — nothing to reply.
                                    continue;
                                };
                                let _ = tx.send((offset, data, done)).await;
                                if done {
                                    temp_writers.remove(&req_id);
                                }
                            }
                            Ok(HubMessage::TempCleanupRequest { req_id }) => {
                                tracing::debug!("Temp cleanup request");
                                let store = temp_store.cloned();
                                let rid = req_id.clone();
                                let panic_response = AgentMessage::TempCleanupResponse {
                                    req_id: rid.clone(),
                                    removed: 0,
                                    freed_bytes: 0,
                                    error: Some("agent_internal_error".to_string()),
                                };
                                let cancelled_response = AgentMessage::TempCleanupResponse {
                                    req_id: req_id.clone(),
                                    removed: 0,
                                    freed_bytes: 0,
                                    error: Some("request_cancelled".to_string()),
                                };
                                let accepted = try_spawn_fs_job(
                                    &mut fs_tasks,
                                    &fs_admission,
                                    fs_workers,
                                    &fs_tx,
                                    req_id.clone(),
                                    &fs_cancellations,
                                    move |cancelled| match store {
                                        Some(store) => match store.cleanup(Some(&cancelled)) {
                                            Ok((removed, freed_bytes)) => {
                                                AgentMessage::TempCleanupResponse {
                                                    req_id: rid.clone(),
                                                    removed,
                                                    freed_bytes,
                                                    error: None,
                                                }
                                            }
                                            Err(error) => AgentMessage::TempCleanupResponse {
                                                req_id: rid.clone(),
                                                removed: 0,
                                                freed_bytes: 0,
                                                error: Some(error),
                                            },
                                        },
                                        None => AgentMessage::TempCleanupResponse {
                                            req_id: rid.clone(),
                                            removed: 0,
                                            freed_bytes: 0,
                                            error: Some("temp_unavailable".to_string()),
                                        },
                                    },
                                    cancelled_response,
                                    panic_response,
                                );
                                if !accepted {
                                    let response = AgentMessage::TempCleanupResponse {
                                        req_id,
                                        removed: 0,
                                        freed_bytes: 0,
                                        error: Some(
                                            "agent_overloaded: file I/O queue is full".to_string(),
                                        ),
                                    };
                                    if !send_agent_message(&mut write, &response).await {
                                        tracing::warn!("Failed to send temp cleanup overload response, reconnecting");
                                        break;
                                    }
                                }
                            }
                            Ok(HubMessage::Error { message }) => {
                                tracing::warn!("Hub error: {}", message);
                            }
                            Err(e) => {
                                tracing::debug!("Failed to parse hub message: {}", e);
                            }
                            _ => {}
                        }
                    }
                    Ok(Some(Ok(Message::Ping(data)))) => {
                        if !send_with_timeout(&mut write, Message::Pong(data)).await {
                            tracing::warn!("Failed to send protocol pong, reconnecting");
                            break;
                        }
                    }
                    Ok(Some(Ok(Message::Close(_)))) => {
                        tracing::info!("Hub closed connection");
                        break;
                    }
                    _ => {}
                }
            }
            _ = ping_interval.tick() => {
                let heartbeat = Message::Text(
                    serde_json::to_string(&AgentMessage::Heartbeat).unwrap().into(),
                );
                if !send_with_timeout(&mut write, heartbeat).await {
                    tracing::warn!("Heartbeat send failed/timed out, reconnecting");
                    break;
                }
            }
        }
    }

    // Abort any in-flight search / office workers before teardown.
    if let Ok(map) = search_cancels.lock() {
        for flag in map.values() {
            flag.store(true, Ordering::Relaxed);
        }
    }
    if let Some(rt) = office_runtime {
        rt.cancel_all();
    }
    if let Some(store) = temp_store {
        store.cancel_all();
    }
    fs_tasks.abort_all();
    // Drop the search result receiver so a worker blocked on
    // `blocking_send` (channel full of Progress after the read loop
    // stopped polling) unblocks immediately instead of hanging forever.
    drop(search_rx);
    drop(office_rx);
    drop(stats_rx);
    drop(fs_rx);
    drop(temp_rx);

    // Best-effort Close frame so the hub can run cleanup immediately instead
    // of waiting for TCP timeout. Ignore errors — we're tearing down anyway.
    let _ = tokio::time::timeout(CLOSE_SEND_TIMEOUT, write.send(Message::Close(None))).await;
    tracing::info!("Disconnected from Hub");
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use filebox_protocol::message::AgentMessage;
    use tokio::sync::{mpsc, Semaphore};
    use tokio::task::JoinSet;

    use super::{build_ws_url, try_spawn_fs_job};

    #[test]
    fn translates_https_to_wss() {
        assert_eq!(
            build_ws_url("https://hub.example.com"),
            "wss://hub.example.com/ws/agent"
        );
    }

    #[test]
    fn translates_http_to_ws() {
        assert_eq!(
            build_ws_url("http://192.168.1.10:3000"),
            "ws://192.168.1.10:3000/ws/agent"
        );
    }

    #[test]
    fn passes_through_wss_and_ws() {
        assert_eq!(
            build_ws_url("wss://hub.example.com"),
            "wss://hub.example.com/ws/agent"
        );
        assert_eq!(
            build_ws_url("ws://hub.local:3000"),
            "ws://hub.local:3000/ws/agent"
        );
    }

    #[test]
    fn strips_trailing_slash() {
        assert_eq!(
            build_ws_url("https://hub.example.com/"),
            "wss://hub.example.com/ws/agent"
        );
    }

    #[test]
    fn falls_back_to_ws_without_scheme() {
        assert_eq!(build_ws_url("hub.example.com:3000"), "ws://hub.example.com:3000/ws/agent");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn file_jobs_bound_queue_and_blocking_concurrency() {
        let admission = Arc::new(Semaphore::new(6));
        let workers = Arc::new(Semaphore::new(2));
        let (tx, mut rx) = mpsc::channel(8);
        let mut tasks = JoinSet::new();
        let active = Arc::new(AtomicUsize::new(0));
        let max_active = Arc::new(AtomicUsize::new(0));
        let cancellations = Arc::new(Mutex::new(HashMap::new()));

        for index in 0..6 {
            let active = active.clone();
            let max_active = max_active.clone();
            assert!(try_spawn_fs_job(
                &mut tasks,
                &admission,
                &workers,
                &tx,
                format!("job-{index}"),
                &cancellations,
                move |_| {
                    let now = active.fetch_add(1, Ordering::AcqRel) + 1;
                    max_active.fetch_max(now, Ordering::AcqRel);
                    std::thread::sleep(Duration::from_millis(20));
                    active.fetch_sub(1, Ordering::AcqRel);
                    AgentMessage::Pong
                },
                AgentMessage::Pong,
                AgentMessage::Pong,
            ));
        }
        assert!(
            !try_spawn_fs_job(
                &mut tasks,
                &admission,
                &workers,
                &tx,
                "overflow".to_string(),
                &cancellations,
                |_| AgentMessage::Pong,
                AgentMessage::Pong,
                AgentMessage::Pong,
            ),
            "the admission bound must reject work instead of spawning an unbounded waiter"
        );

        for _ in 0..6 {
            assert!(matches!(rx.recv().await, Some(AgentMessage::Pong)));
        }
        while tasks.join_next().await.is_some() {}
        assert!(
            max_active.load(Ordering::Acquire) <= 2,
            "blocking filesystem concurrency exceeded its worker bound"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn blocked_file_job_keeps_global_worker_permit_after_wrapper_abort() {
        let admission = Arc::new(Semaphore::new(1));
        let workers = Arc::new(Semaphore::new(1));
        let (tx, _rx) = mpsc::channel(1);
        let mut tasks = JoinSet::new();
        let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
        let cancellations = Arc::new(Mutex::new(HashMap::new()));

        assert!(try_spawn_fs_job(
            &mut tasks,
            &admission,
            &workers,
            &tx,
            "blocked".to_string(),
            &cancellations,
            move |_| {
                let _ = release_rx.recv();
                AgentMessage::Pong
            },
            AgentMessage::Pong,
            AgentMessage::Pong,
        ));
        tokio::time::timeout(Duration::from_secs(1), async {
            while workers.available_permits() != 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();

        tasks.abort_all();
        while tasks.join_next().await.is_some() {}
        assert_eq!(
            workers.available_permits(),
            0,
            "aborting a connection wrapper must not forget a stuck filesystem syscall"
        );

        release_tx.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(1), async {
            while workers.available_permits() != 1 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn queued_file_job_is_released_without_running_after_cancel() {
        let admission = Arc::new(Semaphore::new(1));
        let workers = Arc::new(Semaphore::new(1));
        let held_worker = workers.clone().acquire_owned().await.unwrap();
        let (tx, mut rx) = mpsc::channel(1);
        let mut tasks = JoinSet::new();
        let cancellations = Arc::new(Mutex::new(HashMap::new()));
        let ran = Arc::new(AtomicUsize::new(0));
        let ran_in_job = ran.clone();

        assert!(try_spawn_fs_job(
            &mut tasks,
            &admission,
            &workers,
            &tx,
            "cancel-me".to_string(),
            &cancellations,
            move |_| {
                ran_in_job.fetch_add(1, Ordering::AcqRel);
                AgentMessage::Pong
            },
            AgentMessage::Heartbeat,
            AgentMessage::Pong,
        ));

        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                let cancellation = cancellations
                    .lock()
                    .ok()
                    .and_then(|map| map.get("cancel-me").cloned());
                if let Some(cancellation) = cancellation {
                    cancellation.cancel();
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();

        assert!(matches!(rx.recv().await, Some(AgentMessage::Heartbeat)));
        while tasks.join_next().await.is_some() {}
        assert_eq!(ran.load(Ordering::Acquire), 0);
        assert_eq!(admission.available_permits(), 1);
        drop(held_worker);
    }
}
