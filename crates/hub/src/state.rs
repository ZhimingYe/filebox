use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{broadcast, mpsc, RwLock};

use filebox_protocol::resources::{CollectionConfig, DesiredResources, RootConfig};

use crate::agent_registry::AgentRegistry;
use crate::auth::SessionStore;
use crate::config::HubConfig;

pub struct PendingResponse {
    pub tx: mpsc::Sender<serde_json::Value>,
    pub agent_id: String,
    /// Connection that accepted this request. Disconnect cleanup matches on
    /// this id so a superseded socket cannot fail a newer connection's waiters.
    pub connection_id: u64,
    pub session_id: Option<String>,
    pub desired_roots: Option<Vec<RootConfig>>,
    pub desired_collections: Option<Vec<CollectionConfig>>,
}

/// Upper bound for requests waiting on an Agent response. The outbound Agent
/// queue is bounded too, but HTTP requests can outlive a queued message while
/// a filesystem or Office operation is blocked.
pub const MAX_PENDING_RESPONSES: usize = 4096;
const CANCELLED_REQUEST_TTL: Duration = Duration::from_secs(5 * 60);

#[derive(Clone, Debug)]
pub struct PreviewSession {
    pub session_id: String,
    pub agent_id: String,
    pub root: String,
    pub base_path: String,
    /// Absolute origin (`scheme://host`) captured at session creation. The
    /// document-mode injector uses it to build the absolute `<base>` href and
    /// CSP sources, which a relative base cannot express.
    pub absolute_base_url: String,
    pub created_at: Instant,
    pub expires_at: Instant,
    pub requests_served: u32,
    pub bytes_served: u64,
}

pub const PREVIEW_SESSION_TTL: Duration = Duration::from_secs(60 * 60);
pub const PREVIEW_SESSION_MAX_TOTAL: usize = 1024;

/// Short-lived bearer for headerless GETs (downloads, PDF range fetches, SSE).
/// Minted under CSRF; consumed via `access_token` query — never the CSRF secret.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GetAccessPurpose {
    FileRaw,
    Events,
}

#[derive(Clone, Debug)]
pub struct GetAccessToken {
    /// Cookie id observed at mint time (diagnostics). Ownership uses `principal_id`.
    #[allow(dead_code)]
    pub session_id: String,
    pub principal_id: String,
    pub purpose: GetAccessPurpose,
    pub agent_id: Option<String>,
    pub root: Option<String>,
    pub path: Option<String>,
    pub expires_at: Instant,
    pub requests_served: u32,
}

/// Scoped to one file and still bound to the live browser session. One hour
/// avoids forcing a complex/large PDF to remount while the user is reading.
pub const GET_ACCESS_TOKEN_TTL_FILE: Duration = Duration::from_secs(60 * 60);
/// EventSource reconnects remint before expiry; keep this long enough that a
/// healthy tab is not forced through mint storms, but short enough that a
/// leaked URL dies reasonably fast.
pub const GET_ACCESS_TOKEN_TTL_EVENTS: Duration = Duration::from_secs(30 * 60);
/// PDF.js issues many Range requests against the same URL.
///
/// `requests_served` is diagnostic only. Normal PDF range traffic must not
/// turn into a user-visible authorization failure.
pub const GET_ACCESS_TOKEN_MAX_TOTAL: usize = 4_096;

#[derive(Clone)]
pub struct AuthenticatedSession {
    /// Live cookie session id (logout remove / Set-Cookie tracking).
    pub id: String,
    /// Stable across cookie-id rotations (cancel, preview, SSE, access tokens).
    pub principal_id: String,
}

/// Simple in-memory rate limiter for login attempts.
/// Tracks failed attempts per IP and enforces a cooldown after too many failures.
pub struct LoginRateLimiter {
    attempts: std::sync::Mutex<HashMap<String, (u32, Instant)>>,
    max_attempts: u32,
    cooldown: std::time::Duration,
}

impl LoginRateLimiter {
    pub fn new(max_attempts: u32, cooldown: std::time::Duration) -> Self {
        Self {
            attempts: std::sync::Mutex::new(HashMap::new()),
            max_attempts,
            cooldown,
        }
    }

    /// Returns `Ok(())` if the request is allowed, `Err(seconds_remaining)` if rate-limited.
    pub fn check(&self, ip: &str) -> Result<(), u64> {
        let mut map = self.attempts.lock().unwrap();
        if let Some((count, last)) = map.get(ip) {
            if *count >= self.max_attempts {
                let elapsed = last.elapsed();
                if elapsed < self.cooldown {
                    let remaining = (self.cooldown - elapsed).as_secs().max(1);
                    return Err(remaining);
                }
                // Cooldown expired, reset
                map.remove(ip);
            }
        }
        Ok(())
    }

    /// Record a failed login attempt for the given IP.
    pub fn record_failure(&self, ip: &str) {
        let mut map = self.attempts.lock().unwrap();
        let entry = map.entry(ip.to_string()).or_insert((0, Instant::now()));
        entry.0 += 1;
        entry.1 = Instant::now();
    }

    /// Clear attempts for an IP (called on successful login).
    pub fn clear(&self, ip: &str) {
        let mut map = self.attempts.lock().unwrap();
        map.remove(ip);
    }
}

#[derive(Clone)]
pub struct AppState {
    pub inner: Arc<RwLock<AppStateInner>>,
    pub rate_limiter: Arc<LoginRateLimiter>,
    pub ws_rate_limiter: Arc<LoginRateLimiter>,
    /// Login audit trail (success / failure / rate-limit / logout), persisted
    /// as JSONL next to the hub config. Write failures degrade to in-memory
    /// only — auditing never fails a login.
    pub audit: Arc<crate::audit::LoginAuditLog>,
    /// Login proof-of-work challenges (self-hosted effort check).
    pub pow: Arc<crate::pow::PowStore>,
    /// Per-IP bound on how often a client may fetch fresh challenges.
    pub pow_rate_limiter: Arc<LoginRateLimiter>,
    /// Bounds simultaneous streamed raw responses by actual concurrency,
    /// independent of how many files a user has viewed historically.
    pub raw_read_semaphore: Arc<tokio::sync::Semaphore>,
    /// Serializes full desired-resource rewrites per Agent. Resource updates
    /// carry a revision and a complete root set, so overlapping rewrites for
    /// one Agent would otherwise race while unrelated Agents should proceed.
    resource_update_locks: Arc<
        tokio::sync::Mutex<
            std::collections::HashMap<String, Arc<tokio::sync::Mutex<()>>>,
        >,
    >,
    pub secure_cookies: bool,
}

#[derive(Clone, Debug, serde::Serialize)]
pub struct SseEvent {
    pub id: u64,
    pub event: String,
    pub data: serde_json::Value,
}

pub struct AppStateInner {
    pub sessions: SessionStore,
    pub agents: AgentRegistry,
    pub start_time: Instant,
    /// Pending responses from agents keyed by req_id
    pub pending_responses: Arc<RwLock<std::collections::HashMap<String, PendingResponse>>>,
    /// Tombstones prevent a late response for a cancelled request id from
    /// being delivered to a new Office request that reuses the id.
    pub cancelled_request_ids: Arc<std::sync::Mutex<HashMap<String, Instant>>>,
    /// Short-lived, directory-scoped bearer tokens for sandboxed HTML previews.
    pub preview_sessions: Arc<RwLock<std::collections::HashMap<String, PreviewSession>>>,
    /// Short-lived GET bearers for `/api/file/raw` and `/api/events` (no CSRF in URLs).
    pub get_access_tokens: Arc<RwLock<std::collections::HashMap<String, GetAccessToken>>>,
    /// Broadcast channel for SSE events
    pub sse_tx: broadcast::Sender<SseEvent>,
    pub sse_history: Arc<RwLock<VecDeque<SseEvent>>>,
    pub sse_next_id: Arc<AtomicU64>,
}

impl AppState {
    pub async fn lock_resource_update(
        &self,
        agent_id: &str,
    ) -> tokio::sync::OwnedMutexGuard<()> {
        let lock = {
            let mut locks = self.resource_update_locks.lock().await;
            locks
                .entry(agent_id.to_string())
                .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
                .clone()
        };
        lock.lock_owned().await
    }

    pub async fn emit_sse(&self, event: &str, data: serde_json::Value) {
        // Serialize history snapshotting with EventSource subscription setup:
        // a reader must not subscribe between the history snapshot and the
        // broadcast send, otherwise it can receive a duplicate or miss an
        // event during reconnect.
        let inner = self.inner.write().await;
        let id = inner.sse_next_id.fetch_add(1, Ordering::Relaxed);
        let sse_event = SseEvent {
            id,
            event: event.to_string(),
            data,
        };
        {
            let mut history = inner.sse_history.write().await;
            history.push_back(sse_event.clone());
            while history.len() > 256 {
                history.pop_front();
            }
        }
        let _ = inner.sse_tx.send(sse_event);
    }

    pub fn new(config: &HubConfig, secure_cookies: bool) -> Self {
        let (sse_tx, _) = broadcast::channel(256);
        Self {
            inner: Arc::new(RwLock::new(AppStateInner {
                sessions: SessionStore::from_config(config),
                agents: AgentRegistry::new(),
                start_time: Instant::now(),
                pending_responses: Arc::new(RwLock::new(std::collections::HashMap::new())),
                cancelled_request_ids: Arc::new(std::sync::Mutex::new(HashMap::new())),
                preview_sessions: Arc::new(RwLock::new(std::collections::HashMap::new())),
                get_access_tokens: Arc::new(RwLock::new(std::collections::HashMap::new())),
                sse_tx,
                sse_history: Arc::new(RwLock::new(VecDeque::with_capacity(256))),
                sse_next_id: Arc::new(AtomicU64::new(1)),
            })),
            rate_limiter: Arc::new(LoginRateLimiter::new(5, std::time::Duration::from_secs(30))),
            // Agent fleets commonly reconnect in cohorts after a hub restart
            // or network partition. Keep this high enough for same-IP NATed
            // agents while still bounding unauthenticated WS auth attempts.
            ws_rate_limiter: Arc::new(LoginRateLimiter::new(300, std::time::Duration::from_secs(30))),
            audit: Arc::new(crate::audit::LoginAuditLog::load(crate::audit::default_path(
                secure_cookies,
            ))),
            pow: Arc::new(crate::pow::PowStore::new(
                crate::pow::difficulty_from_env(),
            )),
            // Humans only need a handful of challenges per minute; this cap
            // just stops the public challenge endpoint from being a memory pump.
            pow_rate_limiter: Arc::new(LoginRateLimiter::new(30, Duration::from_secs(60))),
            // 70 rapid PDF opens must fit without becoming a user-visible
            // rate limit. Memory remains bounded because each stream asks the
            // Agent for at most FILE_CHUNK_MAX_BYTES at a time.
            raw_read_semaphore: Arc::new(tokio::sync::Semaphore::new(96)),
            resource_update_locks: Arc::new(tokio::sync::Mutex::new(
                std::collections::HashMap::new(),
            )),
            secure_cookies,
        }
    }

    /// Fail pending responses owned by a specific agent connection. Used when
    /// a socket closes so HTTP handlers stop waiting on their own 30–60s
    /// timeouts without touching waiters accepted by a newer reconnect.
    pub async fn fail_pending_for_connection(
        &self,
        agent_id: &str,
        connection_id: u64,
    ) -> usize {
        let pending_arc = {
            let inner = self.inner.read().await;
            inner.pending_responses.clone()
        };
        let error = agent_disconnect_pending_error();
        let mut pending = pending_arc.write().await;
        let keys: Vec<String> = pending
            .iter()
            .filter(|(_, resp)| {
                resp.agent_id == agent_id && resp.connection_id == connection_id
            })
            .map(|(key, _)| key.clone())
            .collect();
        let mut victims = Vec::with_capacity(keys.len());
        for key in keys {
            if let Some(resp) = pending.remove(&key) {
                victims.push((key, resp));
            }
        }
        let count = victims.len();
        drop(pending);
        for (_, resp) in &victims {
            self.requeue_pending_response(resp).await;
        }
        for (req_id, resp) in victims {
            tracing::debug!(
                "Failing pending request {} because agent {} connection {} disconnected",
                req_id,
                agent_id,
                connection_id
            );
            let _ = resp.tx.send(error.clone()).await;
        }
        count
    }

    pub async fn requeue_pending_response(&self, resp: &PendingResponse) {
        let mut inner = self.inner.write().await;
        if let Some(desired) = &resp.desired_roots {
            inner.agents.set_pending_update(
                &resp.agent_id,
                DesiredResources {
                    roots: desired.clone(),
                },
            );
        }
        if let Some(desired) = &resp.desired_collections {
            inner.agents.set_pending_collections_update(
                &resp.agent_id,
                filebox_protocol::resources::DesiredCollections {
                    collections: desired.clone(),
                },
            );
        }
    }

    pub async fn mark_request_cancelled(&self, req_id: &str) {
        let inner = self.inner.read().await;
        let result = inner.cancelled_request_ids.lock();
        if let Ok(mut ids) = result {
            let now = Instant::now();
            ids.retain(|_, marked_at| now.duration_since(*marked_at) < CANCELLED_REQUEST_TTL);
            ids.insert(req_id.to_string(), now);
        };
    }

    pub async fn was_request_recently_cancelled(&self, req_id: &str) -> bool {
        let inner = self.inner.read().await;
        let result = inner.cancelled_request_ids.lock();
        match result {
            Ok(mut ids) => {
                let now = Instant::now();
                ids.retain(|_, marked_at| now.duration_since(*marked_at) < CANCELLED_REQUEST_TTL);
                ids.contains_key(req_id)
            }
            Err(_) => false,
        }
    }
}

/// Error delivered to waiters when an agent disconnects while a request is
/// still pending. Matches the retryable shape used by HTTP handlers.
pub fn agent_disconnect_pending_error() -> serde_json::Value {
    serde_json::json!({
        "error": "backend_offline",
        "message": "Agent disconnected",
        "retryable": true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rate_limiter_allows_first_attempt() {
        let limiter = LoginRateLimiter::new(5, std::time::Duration::from_secs(30));
        assert!(limiter.check("1.2.3.4").is_ok());
    }

    #[test]
    fn rate_limiter_allows_until_threshold_reached() {
        let limiter = LoginRateLimiter::new(3, std::time::Duration::from_secs(30));
        // First 3 failures allowed
        for _ in 0..3 {
            assert!(limiter.check("1.2.3.4").is_ok());
            limiter.record_failure("1.2.3.4");
        }
        // 4th attempt should be blocked
        let result = limiter.check("1.2.3.4");
        assert!(result.is_err());
        let remaining = result.unwrap_err();
        assert!(remaining > 0);
    }

    #[test]
    fn rate_limiter_is_per_ip() {
        let limiter = LoginRateLimiter::new(2, std::time::Duration::from_secs(30));
        for _ in 0..2 {
            limiter.record_failure("1.1.1.1");
        }
        // 1.1.1.1 is blocked
        assert!(limiter.check("1.1.1.1").is_err());
        // 2.2.2.2 is still allowed
        assert!(limiter.check("2.2.2.2").is_ok());
    }

    #[test]
    fn rate_limiter_clears_on_success() {
        let limiter = LoginRateLimiter::new(3, std::time::Duration::from_secs(30));
        for _ in 0..2 {
            limiter.record_failure("1.1.1.1");
        }
        limiter.clear("1.1.1.1");
        // Should be allowed again — counter reset
        assert!(limiter.check("1.1.1.1").is_ok());
    }

    #[test]
    fn rate_limiter_clear_is_safe_for_unknown_ip() {
        let limiter = LoginRateLimiter::new(3, std::time::Duration::from_secs(30));
        limiter.clear("never-seen");
        // Should not panic
    }

    #[test]
    fn rate_limiter_returns_at_least_one_second_remaining() {
        let limiter = LoginRateLimiter::new(1, std::time::Duration::from_secs(60));
        limiter.record_failure("1.1.1.1");
        let remaining = limiter.check("1.1.1.1").unwrap_err();
        assert!(remaining >= 1, "remaining seconds must be at least 1");
    }

    #[test]
    fn rate_limiter_cooldown_expires_after_window() {
        // 1 attempt max, 50ms cooldown — short so test stays fast
        let limiter = LoginRateLimiter::new(1, std::time::Duration::from_millis(50));
        limiter.record_failure("1.1.1.1");
        // First check after threshold should fail
        assert!(limiter.check("1.1.1.1").is_err());

        // Wait out the cooldown
        std::thread::sleep(std::time::Duration::from_millis(70));
        // Now should pass — cooldown expired, counter reset
        assert!(limiter.check("1.1.1.1").is_ok());
    }

    #[test]
    fn rate_limiter_check_without_record_does_not_block() {
        let limiter = LoginRateLimiter::new(3, std::time::Duration::from_secs(30));
        // check() alone without record_failure() should always allow
        for _ in 0..10 {
            assert!(limiter.check("1.1.1.1").is_ok());
        }
    }

    #[test]
    fn rate_limiter_concurrent_threads_serialize_safely() {
        use std::sync::Arc;
        let limiter = Arc::new(LoginRateLimiter::new(100, std::time::Duration::from_secs(30)));
        let mut handles = vec![];
        for i in 0..10 {
            let l = limiter.clone();
            handles.push(std::thread::spawn(move || {
                let ip = format!("10.0.0.{}", i);
                for _ in 0..5 {
                    l.record_failure(&ip);
                }
                // Each IP has exactly 5 failures
                assert!(l.check(&ip).is_ok());
            }));
        }
        for h in handles {
            h.join().unwrap();
        }
    }

    #[test]
    fn app_state_can_be_constructed_from_dev_config() {
        let config = crate::config::HubConfig {
            listen_addr: "127.0.0.1:0".parse().unwrap(),
            agent_token_hash: "fake-hash".to_string(),
            users: vec![crate::config::UserConfig {
                username: "admin".to_string(),
                password_hash: "fake-hash".to_string(),
            }],
        };
        let state = AppState::new(&config, false);
        // Verify the inner state is accessible
        let inner = state.inner.blocking_read();
        assert_eq!(inner.agents.list_all().len(), 0);
        // Verify rate limiter is initialized with default thresholds
        assert!(state.rate_limiter.check("any-ip").is_ok());
        assert!(state.ws_rate_limiter.check("any-ip").is_ok());
        assert!(
            state.raw_read_semaphore.available_permits() >= 70,
            "rapidly opening 70 PDFs must fit below the raw-stream concurrency bound"
        );
    }

    #[test]
    fn app_state_inner_starts_with_no_pending_responses() {
        let config = crate::config::HubConfig {
            listen_addr: "127.0.0.1:0".parse().unwrap(),
            agent_token_hash: "fake-hash".to_string(),
            users: vec![],
        };
        let state = AppState::new(&config, false);
        let pending = state.inner.blocking_read().pending_responses.clone();
        let map = pending.blocking_read();
        assert!(map.is_empty());
    }

    #[tokio::test]
    async fn fail_pending_for_connection_notifies_only_matching_waiters() {
        let config = crate::config::HubConfig {
            listen_addr: "127.0.0.1:0".parse().unwrap(),
            agent_token_hash: "fake-hash".to_string(),
            users: vec![],
        };
        let state = AppState::new(&config, false);
        let (tx_a1, mut rx_a1) = mpsc::channel(1);
        let (tx_a2, mut rx_a2) = mpsc::channel(1);
        {
            let pending = state.inner.read().await.pending_responses.clone();
            let mut map = pending.write().await;
            map.insert(
                "req-a1".to_string(),
                PendingResponse {
                    tx: tx_a1,
                    agent_id: "a1".to_string(),
                    connection_id: 10,
                    session_id: None,
                    desired_roots: None,
                    desired_collections: None,
                },
            );
            map.insert(
                "req-a2".to_string(),
                PendingResponse {
                    tx: tx_a2,
                    agent_id: "a2".to_string(),
                    connection_id: 20,
                    session_id: None,
                    desired_roots: None,
                    desired_collections: None,
                },
            );
        }

        assert_eq!(state.fail_pending_for_connection("a1", 10).await, 1);

        let value = rx_a1.recv().await.expect("a1 waiter should be notified");
        assert_eq!(value["error"], "backend_offline");
        assert_eq!(value["retryable"], true);
        assert!(rx_a2.try_recv().is_err(), "other agents' pending requests must remain");

        let pending = state.inner.read().await.pending_responses.clone();
        let map = pending.read().await;
        assert!(map.contains_key("req-a2"));
        assert!(!map.contains_key("req-a1"));
    }

    #[tokio::test]
    async fn fail_pending_for_connection_skips_newer_reconnect_waiters() {
        let config = crate::config::HubConfig {
            listen_addr: "127.0.0.1:0".parse().unwrap(),
            agent_token_hash: "fake-hash".to_string(),
            users: vec![],
        };
        let state = AppState::new(&config, false);
        let (tx_old, mut rx_old) = mpsc::channel(1);
        let (tx_new, mut rx_new) = mpsc::channel(1);
        {
            let pending = state.inner.read().await.pending_responses.clone();
            let mut map = pending.write().await;
            map.insert(
                "req-old".to_string(),
                PendingResponse {
                    tx: tx_old,
                    agent_id: "a1".to_string(),
                    connection_id: 10,
                    session_id: None,
                    desired_roots: None,
                    desired_collections: None,
                },
            );
            map.insert(
                "req-new".to_string(),
                PendingResponse {
                    tx: tx_new,
                    agent_id: "a1".to_string(),
                    connection_id: 11,
                    session_id: None,
                    desired_roots: None,
                    desired_collections: None,
                },
            );
        }

        assert_eq!(state.fail_pending_for_connection("a1", 10).await, 1);
        assert_eq!(
            rx_old.recv().await.expect("old waiter notified")["error"],
            "backend_offline"
        );
        assert!(rx_new.try_recv().is_err(), "new connection waiters must survive");
    }

    #[tokio::test]
    async fn disconnect_requeues_desired_resource_update_for_reconnect() {
        let config = crate::config::HubConfig {
            listen_addr: "127.0.0.1:0".parse().unwrap(),
            agent_token_hash: "fake-hash".to_string(),
            users: vec![],
        };
        let state = AppState::new(&config, false);
        let (agent_tx, _agent_rx) = mpsc::channel(8);
        {
            let mut inner = state.inner.write().await;
            inner.agents.register(
                "a1".to_string(),
                "agent".to_string(),
                agent_tx,
                std::sync::Arc::new(tokio::sync::Notify::new()),
                0,
                vec![],
                0,
                vec![],
                filebox_protocol::resources::Capabilities::default(),
            );
        }
        let connection_id = {
            let inner = state.inner.read().await;
            inner.agents.get("a1").unwrap().connection_id
        };
        let (tx, mut rx) = mpsc::channel(1);
        let desired = RootConfig {
            name: "workspace".to_string(),
            path: "/workspace".to_string(),
            enabled: true,
            pinned_folders: vec![],
        };
        {
            let pending = state.inner.read().await.pending_responses.clone();
            pending.write().await.insert(
                "resource-request".to_string(),
                PendingResponse {
                    tx,
                    agent_id: "a1".to_string(),
                    connection_id,
                    session_id: None,
                    desired_roots: Some(vec![desired.clone()]),
                    desired_collections: None,
                },
            );
        }

        assert_eq!(
            state
                .fail_pending_for_connection("a1", connection_id)
                .await,
            1
        );
        assert_eq!(rx.recv().await.unwrap()["error"], "backend_offline");
        let inner = state.inner.read().await;
        assert_eq!(
            inner.agents.get("a1").unwrap().pending_update.as_ref().unwrap().roots,
            vec![desired]
        );
    }

    #[tokio::test]
    async fn resource_updates_serialize_per_agent_only() {
        let config = crate::config::HubConfig {
            listen_addr: "127.0.0.1:0".parse().unwrap(),
            agent_token_hash: "fake-hash".to_string(),
            users: vec![],
        };
        let state = AppState::new(&config, false);
        let first = state.lock_resource_update("a1").await;

        assert!(
            tokio::time::timeout(
                std::time::Duration::from_millis(20),
                state.lock_resource_update("a1"),
            )
            .await
            .is_err(),
            "the same Agent must serialize resource rewrites",
        );
        let other = tokio::time::timeout(
            std::time::Duration::from_millis(20),
            state.lock_resource_update("a2"),
        )
        .await
        .expect("unrelated Agents must not block each other");
        drop(other);
        drop(first);

        tokio::time::timeout(
            std::time::Duration::from_millis(20),
            state.lock_resource_update("a1"),
        )
        .await
        .expect("the lock must be released after the prior update");
    }
}
