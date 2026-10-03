use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use tokio::sync::{mpsc, Notify, Semaphore};
use tokio::task::JoinSet;
use tokio_tungstenite::connect_async_with_config;
use tokio_tungstenite::tungstenite::Message;

use filebox_protocol::message::{AgentMessage, HubMessage};
use filebox_protocol::resources::{Capabilities, RootConfig};

use crate::config::AgentConfig;
use crate::content_cache::ContentCache;
use crate::dir_cache::DirCache;
use crate::resources::ResourceManager;
use crate::sysinfo::StatsCache;

mod runtime;
mod handshake;
mod session;
use runtime::AgentRuntime;
use session::{ConnectionSession, DisconnectReason};

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

/// Per-write timeout. Bound stalled sockets in the independent writer;
/// short loss bursts still have time for TCP retransmission to recover.
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

const CONTROL_QUEUE_CAPACITY: usize = 32;
// Resource/collection updates emit Updated + Applied; all other branches
// emit at most one control frame. Only the receive loop produces these frames.
const CONTROL_REPLY_SLOTS: usize = 2;

// A connection owns its writer, including when its parent future is dropped.
struct ConnectionWriter(tokio::task::JoinHandle<()>);

impl Drop for ConnectionWriter {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// Each response class has a bounded queue. Round-robin polling prevents a
/// backlog of file chunks from sitting ahead of directory/control responses.
/// Only this task waits on socket writes; the receiver can still handle Cancel.
async fn run_connection_writer<W>(
    mut write: W,
    control: mpsc::Receiver<Message>,
    responses: Vec<mpsc::Receiver<AgentMessage>>,
) where
    W: SinkExt<Message> + Unpin,
{
    let control = futures_util::stream::unfold(control, |mut rx| async {
        rx.recv().await.map(|msg| (Ok(msg), rx))
    }).boxed();
    let mut streams = vec![control];
    for rx in responses {
        streams.push(futures_util::stream::unfold(rx, |mut rx| async {
            rx.recv().await.map(|msg| {
                (serde_json::to_string(&msg).map(|text| Message::Text(text.into())), rx)
            })
        }).boxed());
    }
    let mut messages = futures_util::stream::select_all(streams);
    while let Some(message) = messages.next().await {
        let message = match message {
            Ok(message) => message,
            Err(error) => {
                tracing::error!("Failed to serialize agent message: {}", error);
                break;
            }
        };
        let closing = matches!(message, Message::Close(_));
        if !send_with_timeout(&mut write, message).await || closing {
            break;
        }
    }
}

fn queue_frame(tx: &mpsc::Sender<Message>, message: Message) -> bool {
    // The receive loop waits for CONTROL_REPLY_SLOTS before reading another
    // request, so ordinary congestion cannot reach this failure path.
    if tx.try_send(message).is_err() {
        tracing::warn!("Agent control queue closed or reply-slot invariant violated");
        return false;
    }
    true
}

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

/// Queue a control response without blocking incoming requests on socket I/O.
fn queue_agent_message(tx: &mpsc::Sender<Message>, msg: &AgentMessage) -> bool {
    let text = match serde_json::to_string(msg) {
        Ok(text) => text,
        Err(error) => {
            tracing::error!("Failed to serialize agent message: {}", error);
            return false;
        }
    };
    queue_frame(tx, Message::Text(text.into()))
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

    let mut runtime = AgentRuntime::new(config);

    tracing::info!(
        "Agent ID: {}, data dir: {:?}",
        runtime.stable_agent_id,
        config.data_dir
    );

    loop {
        let connect_at = Instant::now();

        let reason = run_one_connection(&ws_url, config, &mut runtime).await;
        tracing::info!(?reason, "Disconnected from Hub");

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

/// One transport generation; session Drop also cleans up a cancelled future.
async fn run_one_connection(
    ws_url: &str,
    config: &AgentConfig,
    runtime: &mut AgentRuntime,
) -> DisconnectReason {
    let (write, mut read, assigned_agent_id) = match handshake::connect_and_register(ws_url, config, runtime).await {
        Ok(connection) => connection,
        Err(reason) => return reason,
    };
    let mut session = ConnectionSession::new(runtime, write, assigned_agent_id);
    let reason = session.drive(&mut read).await;
    session.shutdown().await;
    reason
}

#[cfg(test)]
#[path = "connection_transport_tests.rs"]
mod transport_tests;

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
