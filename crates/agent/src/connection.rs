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
/// black-holed route can hang `connect_async` indefinitely. 10s was too
/// tight on a CPU-saturated HPC node (handshakes commonly took 7–11s and
/// the agent flapped). Override: `FILEBOX_AGENT_CONNECT_TIMEOUT_SECS`.
const DEFAULT_CONNECT_TIMEOUT_SECS: u64 = 30;

/// How long to wait for the hub's AuthResult before giving up.
/// Override: `FILEBOX_AGENT_AUTH_TIMEOUT_SECS`.
const DEFAULT_AUTH_TIMEOUT_SECS: u64 = 20;

/// If the hub sends nothing (no Ping, no Heartbeat, no message) for this
/// window, consider the connection dead and reconnect. Hub normally pings
/// every 15s, so 45s = 3 missed pings. This is the key defense against
/// silently-dropped TCP (NAT expiry, half-open after sleep): without an
/// application-level liveness check the agent would otherwise wait forever
/// on `read.next()`.
const NO_MESSAGE_TIMEOUT: Duration = Duration::from_secs(45);

/// Per-write timeout for heartbeats, pongs, and other control frames.
/// A blocked write would otherwise stall the writer (and delay the next
/// heartbeat), so every WS write is bounded.
/// Override: `FILEBOX_AGENT_WS_WRITE_TIMEOUT_SECS`.
const DEFAULT_WS_WRITE_TIMEOUT_SECS: u64 = 20;

/// FileChunk / list / search payloads are JSON+base64. Cancelling a send
/// mid-frame corrupts the socket, so a timeout *must* reconnect — which
/// is why 20s on a 512 KiB frame produced a reconnect loop under load.
/// Frames are now capped at 64 KiB; this bound is the dead-TCP detector,
/// not a "slow HPC" cap. Override: `FILEBOX_AGENT_WS_DATA_WRITE_TIMEOUT_SECS`.
const DEFAULT_DATA_WRITE_TIMEOUT_SECS: u64 = 90;

/// How long the read loop will wait to enqueue a control frame. The writer
/// prefers control over data, so this only blocks if the writer itself is
/// stuck in a send or has died.
const CTRL_ENQUEUE_TIMEOUT: Duration = Duration::from_secs(2);

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
    env_duration_secs("FILEBOX_AGENT_STATS_TTL_SECS", 15, 1, 3600)
}

fn connect_timeout() -> Duration {
    env_duration_secs("FILEBOX_AGENT_CONNECT_TIMEOUT_SECS", DEFAULT_CONNECT_TIMEOUT_SECS, 5, 120)
}

fn auth_timeout() -> Duration {
    env_duration_secs("FILEBOX_AGENT_AUTH_TIMEOUT_SECS", DEFAULT_AUTH_TIMEOUT_SECS, 5, 120)
}

fn ws_write_timeout() -> Duration {
    env_duration_secs(
        "FILEBOX_AGENT_WS_WRITE_TIMEOUT_SECS",
        DEFAULT_WS_WRITE_TIMEOUT_SECS,
        5,
        120,
    )
}

fn data_write_timeout() -> Duration {
    env_duration_secs(
        "FILEBOX_AGENT_WS_DATA_WRITE_TIMEOUT_SECS",
        DEFAULT_DATA_WRITE_TIMEOUT_SECS,
        15,
        300,
    )
}

fn env_duration_secs(name: &str, default: u64, min: u64, max: u64) -> Duration {
    Duration::from_secs(clamp_secs(
        std::env::var(name).ok().and_then(|s| s.parse().ok()),
        default,
        min,
        max,
    ))
}

fn clamp_secs(parsed: Option<u64>, default: u64, min: u64, max: u64) -> u64 {
    parsed.unwrap_or(default).clamp(min, max)
}

/// Send a WS message with a write timeout. Returns false on timeout or
/// error — caller should treat the connection as dead and reconnect.
async fn send_with_timeout<W>(write: &mut W, msg: Message, timeout: Duration) -> bool
where
    W: SinkExt<Message> + Unpin,
{
    let nbytes = match &msg {
        Message::Text(text) => text.len(),
        Message::Binary(data) => data.len(),
        _ => 0,
    };
    match tokio::time::timeout(timeout, write.send(msg)).await {
        Ok(Ok(_)) => true,
        Ok(Err(_)) => {
            tracing::warn!("WS write failed ({} bytes)", nbytes);
            false
        }
        Err(_) => {
            tracing::warn!(
                "WS write timed out after {}s ({} bytes)",
                timeout.as_secs(),
                nbytes
            );
            false
        }
    }
}

fn encode_agent_message(msg: &AgentMessage) -> Option<Message> {
    match serde_json::to_string(msg) {
        Ok(text) => Some(Message::Text(text.into())),
        Err(error) => {
            tracing::error!("Failed to serialize agent message: {}", error);
            None
        }
    }
}

fn try_send_encoded(tx: &mpsc::Sender<Message>, msg: &AgentMessage) {
    if let Some(encoded) = encode_agent_message(msg) {
        let _ = tx.try_send(encoded);
    }
}

fn blocking_send_encoded(tx: &mpsc::Sender<Message>, msg: &AgentMessage) {
    if let Some(encoded) = encode_agent_message(msg) {
        let _ = tx.blocking_send(encoded);
    }
}

async fn send_encoded(tx: &mpsc::Sender<Message>, msg: AgentMessage) {
    if let Some(encoded) = encode_agent_message(&msg) {
        let _ = tx.send(encoded).await;
    }
}

/// Push a control frame (Pong, resource apply, overload errors) onto the
/// writer's high-priority queue. File chunks never share this queue, so a
/// preview storm cannot delay heartbeats or pongs.
async fn enqueue_ctrl(tx: &mpsc::Sender<Message>, msg: &AgentMessage) -> bool {
    let Some(encoded) = encode_agent_message(msg) else {
        return false;
    };
    matches!(
        tokio::time::timeout(CTRL_ENQUEUE_TIMEOUT, tx.send(encoded)).await,
        Ok(Ok(()))
    )
}

fn enqueue_ctrl_raw(tx: &mpsc::Sender<Message>, msg: Message) -> bool {
    tx.try_send(msg).is_ok()
}

/// Dedicated sink owner. Heartbeats and control frames are selected with
/// `biased` priority over FileChunks, and JSON encoding of large chunks
/// happens on the blocking pool *before* they reach this task.
async fn run_ws_writer<W>(
    mut write: W,
    mut ctrl_rx: mpsc::Receiver<Message>,
    mut data_rx: mpsc::Receiver<Message>,
) where
    W: SinkExt<Message> + Unpin,
{
    let ctrl_timeout = ws_write_timeout();
    let data_timeout = data_write_timeout();
    let mut send_failed = false;
    let mut ping_interval = tokio::time::interval(HEARTBEAT_INTERVAL);
    ping_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            biased;
            _ = ping_interval.tick() => {
                let heartbeat = Message::Text(
                    serde_json::to_string(&AgentMessage::Heartbeat).unwrap().into(),
                );
                if !send_with_timeout(&mut write, heartbeat, ctrl_timeout).await {
                    tracing::warn!("Heartbeat send failed/timed out, reconnecting");
                    send_failed = true;
                    break;
                }
            }
            msg = ctrl_rx.recv() => {
                let Some(msg) = msg else { break };
                if !send_with_timeout(&mut write, msg, ctrl_timeout).await {
                    tracing::warn!("WS control write failed/timed out, reconnecting");
                    send_failed = true;
                    break;
                }
            }
            msg = data_rx.recv() => {
                let Some(msg) = msg else { break };
                if !send_with_timeout(&mut write, msg, data_timeout).await {
                    tracing::warn!("WS data write failed/timed out, reconnecting");
                    send_failed = true;
                    break;
                }
            }
        }
    }
    // A cancelled in-flight send can leave the sink corrupt; skip Close so
    // reconnect is not delayed by another timeout on a dead socket.
    if !send_failed {
        let _ = tokio::time::timeout(CLOSE_SEND_TIMEOUT, write.send(Message::Close(None))).await;
    }
}

fn try_spawn_fs_job<F>(
    tasks: &mut JoinSet<()>,
    admission: &Arc<Semaphore>,
    workers: &Arc<Semaphore>,
    tx: &mpsc::Sender<Message>,
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
            if let Some(msg) = encode_agent_message(&cancelled_response) {
                let _ = tx.send(msg).await;
            }
            remove_fs_cancellation(&cancellations, &req_id, &cancellation);
            return;
        };
        // Move the permit into the blocking closure. If the WebSocket
        // connection disappears and aborts this async wrapper, a kernel-stuck
        // syscall still owns its global permit until it actually returns.
        // Serialize on this same blocking thread so the WS writer never
        // JSON-encodes a 512 KiB FileChunk on an async worker.
        let cancel_flag = cancellation.cancelled.clone();
        let cancelled_in_worker = cancelled_response.clone();
        let blocking = tokio::task::spawn_blocking(move || {
            let _worker_permit = worker_permit;
            let response = if cancel_flag.load(Ordering::Acquire) {
                cancelled_in_worker
            } else {
                job(cancel_flag)
            };
            encode_agent_message(&response)
        });
        match blocking.await {
            Ok(Some(msg)) => {
                let _ = tx.send(msg).await;
            }
            Ok(None) => {
                tracing::error!("File I/O worker produced an unserializable response");
            }
            Err(join_error) => {
                tracing::error!("File I/O worker failed: {}", join_error);
                if let Some(msg) = encode_agent_message(&panic_response) {
                    let _ = tx.send(msg).await;
                }
            }
        }
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
    let connect_to = connect_timeout();
    let ws_stream = match tokio::time::timeout(connect_to, connect_async(ws_url)).await {
        Ok(Ok((s, _))) => {
            tracing::info!("Connected to Hub");
            s
        }
        Ok(Err(e)) => {
            tracing::warn!("Connection failed: {}", e);
            return;
        }
        Err(_) => {
            tracing::warn!("Connection timed out after {}s", connect_to.as_secs());
            return;
        }
    };

    let (mut write, mut read) = ws_stream.split();
    let ctrl_timeout = ws_write_timeout();

    // Step 2: Send Auth
    let auth = AgentMessage::Auth {
        token: config.token.clone(),
    };
    let auth_msg = Message::Text(serde_json::to_string(&auth).unwrap().into());
    if !send_with_timeout(&mut write, auth_msg, ctrl_timeout).await {
        tracing::warn!("Failed to send auth");
        return;
    }

    // Step 3: Wait for AuthResult
    let auth_result = tokio::time::timeout(auth_timeout(), read.next()).await;
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
    if !send_with_timeout(&mut write, register_msg, data_write_timeout()).await {
        tracing::warn!("Failed to send register");
        return;
    }

    tracing::info!(
        "Registered as {} (rev={})",
        config.agent_name,
        resource_mgr.resource_revision()
    );

    // Step 5: Split the sink onto a dedicated writer so FileChunk JSON never
    // stalls heartbeats or the read-side liveness timer. Control frames
    // (Pong, apply, overload) preempt data; workers encode before enqueue.
    let (ctrl_tx, ctrl_rx) = mpsc::channel::<Message>(64);
    let (data_tx, data_rx) = mpsc::channel::<Message>(128);
    let (writer_fail_tx, mut writer_fail_rx) = mpsc::channel::<()>(1);
    let mut writer = tokio::spawn(async move {
        run_ws_writer(write, ctrl_rx, data_rx).await;
        let _ = writer_fail_tx.try_send(());
    });

    // Workspace search / office convert run off the WS loop so heartbeats
    // keep working. Completed responses go straight to the data queue.
    // Capacity >1 so Progress try_send rarely drops under burst.
    let search_tx = data_tx.clone();
    let office_tx = data_tx.clone();
    let stats_tx = data_tx.clone();
    let fs_tx = data_tx.clone();
    let temp_tx = data_tx.clone();
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
            _ = writer_fail_rx.recv() => {
                tracing::warn!("WS writer stopped, reconnecting");
                break;
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
                                if !enqueue_ctrl(&ctrl_tx, &AgentMessage::Pong).await {
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
                                        if !enqueue_ctrl(&ctrl_tx, &update).await {
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

                                if !enqueue_ctrl(&ctrl_tx, &response).await {
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
                                        if !enqueue_ctrl(&ctrl_tx, &update).await {
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

                                if !enqueue_ctrl(&ctrl_tx, &response).await {
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
                                    if !enqueue_ctrl(&ctrl_tx, &response).await {
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
                                    if !enqueue_ctrl(&ctrl_tx, &response).await {
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
                                                Some(cancelled.as_ref()),
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
                                    if !enqueue_ctrl(&ctrl_tx, &response).await {
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
                                    send_encoded(&tx, response).await;
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
                                    if !enqueue_ctrl(&ctrl_tx, &busy).await {
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
                                        try_send_encoded(&progress_tx, &msg);
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
                                    try_send_encoded(&tx, &AgentMessage::Progress {
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
                                    // After WS teardown aborts the writer this
                                    // returns immediately; while the loop is
                                    // alive it must deliver the terminal msg.
                                    blocking_send_encoded(&tx, &response);
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
                                    if !enqueue_ctrl(&ctrl_tx, &resp).await {
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
                                        if !enqueue_ctrl(&ctrl_tx, &resp).await {
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
                                        try_send_encoded(&progress_tx, &msg);
                                    });
                                let worker_timeout =
                                    rt.config.timeout.saturating_add(Duration::from_secs(5));
                                let rt_for_timeout = rt.clone();
                                let worker = tokio::task::spawn_blocking(move || {
                                    try_send_encoded(&tx, &AgentMessage::Progress {
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
                                    send_encoded(&terminal_tx, response).await;
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
                                    if !enqueue_ctrl(&ctrl_tx, &response).await {
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
                                    if !enqueue_ctrl(&ctrl_tx, &response).await {
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
                                    // After WS teardown aborts the writer this
                                    // returns immediately; while the loop is
                                    // alive it must deliver the terminal msg.
                                    blocking_send_encoded(&tx, &response);
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
                                    if !enqueue_ctrl(&ctrl_tx, &response).await {
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
                        if !enqueue_ctrl_raw(&ctrl_tx, Message::Pong(data)) {
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
    drop(search_tx);
    drop(office_tx);
    drop(stats_tx);
    drop(fs_tx);
    drop(temp_tx);
    drop(data_tx);
    drop(ctrl_tx);
    // Closed queues make the writer send Close. Abort only if a write is
    // still stuck past the Close grace period.
    tokio::select! {
        _ = &mut writer => {}
        _ = tokio::time::sleep(CLOSE_SEND_TIMEOUT) => {
            writer.abort();
            let _ = writer.await;
        }
    }
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
    use tokio_tungstenite::tungstenite::Message;

    use super::{build_ws_url, encode_agent_message, run_ws_writer, try_spawn_fs_job};

    fn recv_agent_message(msg: Option<Message>) -> AgentMessage {
        match msg {
            Some(Message::Text(text)) => serde_json::from_str(&text).expect("agent json"),
            other => panic!("expected text agent message, got {other:?}"),
        }
    }

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

    #[test]
    fn clamp_secs_defaults_and_bounds() {
        assert_eq!(super::clamp_secs(None, 30, 5, 120), 30);
        assert_eq!(super::clamp_secs(Some(0), 30, 5, 120), 5);
        assert_eq!(super::clamp_secs(Some(7), 30, 5, 120), 7);
        assert_eq!(super::clamp_secs(Some(999), 30, 5, 120), 120);
    }

    #[test]
    fn encode_agent_message_round_trips_pong() {
        let encoded = encode_agent_message(&AgentMessage::Pong).unwrap();
        assert!(matches!(
            recv_agent_message(Some(encoded)),
            AgentMessage::Pong
        ));
    }

    struct RecordingSink {
        tx: tokio::sync::mpsc::UnboundedSender<Message>,
    }

    impl futures_util::Sink<Message> for RecordingSink {
        type Error = std::convert::Infallible;

        fn poll_ready(
            self: std::pin::Pin<&mut Self>,
            _cx: &mut std::task::Context<'_>,
        ) -> std::task::Poll<Result<(), Self::Error>> {
            std::task::Poll::Ready(Ok(()))
        }

        fn start_send(
            self: std::pin::Pin<&mut Self>,
            item: Message,
        ) -> Result<(), Self::Error> {
            let _ = self.tx.send(item);
            Ok(())
        }

        fn poll_flush(
            self: std::pin::Pin<&mut Self>,
            _cx: &mut std::task::Context<'_>,
        ) -> std::task::Poll<Result<(), Self::Error>> {
            std::task::Poll::Ready(Ok(()))
        }

        fn poll_close(
            self: std::pin::Pin<&mut Self>,
            _cx: &mut std::task::Context<'_>,
        ) -> std::task::Poll<Result<(), Self::Error>> {
            std::task::Poll::Ready(Ok(()))
        }
    }

    #[tokio::test]
    async fn writer_sends_control_ahead_of_queued_data() {
        let (out_tx, mut out_rx) = tokio::sync::mpsc::unbounded_channel();
        let sink = RecordingSink { tx: out_tx };
        let (ctrl_tx, ctrl_rx) = mpsc::channel(4);
        let (data_tx, data_rx) = mpsc::channel(4);
        let writer = tokio::spawn(run_ws_writer(sink, ctrl_rx, data_rx));

        ctrl_tx
            .try_send(encode_agent_message(&AgentMessage::Pong).unwrap())
            .unwrap();
        data_tx
            .try_send(encode_agent_message(&AgentMessage::FileChunk {
                req_id: "chunk".to_string(),
                offset: 0,
                data: vec![1, 2, 3],
                done: true,
                error: None,
                file_size: Some(3),
                modified: None,
            }).unwrap())
            .unwrap();

        let mut saw_pong = false;
        let mut saw_chunk = false;
        for _ in 0..4 {
            let frame = tokio::time::timeout(Duration::from_secs(1), out_rx.recv())
                .await
                .expect("writer should emit promptly")
                .expect("writer should emit a frame");
            match recv_agent_message(Some(frame)) {
                AgentMessage::Heartbeat => {}
                AgentMessage::Pong => {
                    assert!(!saw_chunk, "control Pong must be written before a queued FileChunk");
                    saw_pong = true;
                }
                AgentMessage::FileChunk { req_id, .. } if req_id == "chunk" => {
                    saw_chunk = true;
                }
                other => panic!("unexpected frame {other:?}"),
            }
            if saw_pong && saw_chunk {
                break;
            }
        }
        assert!(saw_pong, "control Pong was never written");
        assert!(saw_chunk, "FileChunk was never written");
        drop(ctrl_tx);
        drop(data_tx);
        let _ = tokio::time::timeout(Duration::from_secs(1), writer).await;
    }

    #[tokio::test]
    async fn writer_sends_close_when_queues_drop() {
        let (out_tx, mut out_rx) = tokio::sync::mpsc::unbounded_channel();
        let sink = RecordingSink { tx: out_tx };
        let (ctrl_tx, ctrl_rx) = mpsc::channel(4);
        let (data_tx, data_rx) = mpsc::channel(4);
        let writer = tokio::spawn(run_ws_writer(sink, ctrl_rx, data_rx));
        drop(ctrl_tx);
        drop(data_tx);
        let mut saw_close = false;
        while let Ok(Some(frame)) =
            tokio::time::timeout(Duration::from_secs(1), out_rx.recv()).await
        {
            if matches!(frame, Message::Close(_)) {
                saw_close = true;
                break;
            }
        }
        assert!(saw_close, "writer must send Close after both queues drop");
        let _ = tokio::time::timeout(Duration::from_secs(1), writer).await;
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
            assert!(matches!(recv_agent_message(rx.recv().await), AgentMessage::Pong));
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

        assert!(matches!(
            recv_agent_message(rx.recv().await),
            AgentMessage::Heartbeat
        ));
        while tasks.join_next().await.is_some() {}
        assert_eq!(ran.load(Ordering::Acquire), 0);
        assert_eq!(admission.available_permits(), 1);
        drop(held_worker);
    }
}
