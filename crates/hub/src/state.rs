use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{broadcast, mpsc, RwLock};

use filebox_protocol::resources::{CollectionConfig, RootConfig};

use crate::agent_registry::AgentRegistry;
use crate::auth::SessionStore;
use crate::config::HubConfig;

pub struct PendingResponse {
    pub tx: mpsc::Sender<serde_json::Value>,
    pub agent_id: String,
    pub session_id: Option<String>,
    pub desired_roots: Option<Vec<RootConfig>>,
    pub desired_collections: Option<Vec<CollectionConfig>>,
}

#[derive(Clone, Debug)]
pub struct PreviewSession {
    pub session_id: String,
    pub agent_id: String,
    pub root: String,
    pub base_path: String,
    pub created_at: Instant,
    pub expires_at: Instant,
    pub requests_served: u32,
    pub bytes_served: u64,
}

pub const PREVIEW_SESSION_TTL: Duration = Duration::from_secs(60 * 60);
pub const PREVIEW_SESSION_MAX_REQUESTS: u32 = 500;
pub const PREVIEW_SESSION_MAX_BYTES: u64 = 512 * 1024 * 1024;
pub const PREVIEW_SESSION_MAX_TOTAL: usize = 1024;
pub const PREVIEW_SESSION_MAX_PER_SESSION: usize = 32;

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

pub const GET_ACCESS_TOKEN_TTL_FILE: Duration = Duration::from_secs(15 * 60);
/// EventSource reconnects remint before expiry; keep this long enough that a
/// healthy tab is not forced through mint storms, but short enough that a
/// leaked URL dies reasonably fast.
pub const GET_ACCESS_TOKEN_TTL_EVENTS: Duration = Duration::from_secs(30 * 60);
/// PDF.js issues many Range requests against the same URL.
pub const GET_ACCESS_TOKEN_MAX_FILE_REQUESTS: u32 = 2_000;
pub const GET_ACCESS_TOKEN_MAX_TOTAL: usize = 4_096;
pub const GET_ACCESS_TOKEN_MAX_PER_SESSION: usize = 64;

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
    pub secure_cookies: bool,
}

#[derive(Clone, Debug, serde::Serialize)]
pub struct SseEvent {
    pub event: String,
    pub data: serde_json::Value,
}

pub struct AppStateInner {
    pub sessions: SessionStore,
    pub agents: AgentRegistry,
    pub start_time: Instant,
    /// Pending responses from agents keyed by req_id
    pub pending_responses: Arc<RwLock<std::collections::HashMap<String, PendingResponse>>>,
    /// Short-lived, directory-scoped bearer tokens for sandboxed HTML previews.
    pub preview_sessions: Arc<RwLock<std::collections::HashMap<String, PreviewSession>>>,
    /// Short-lived GET bearers for `/api/file/raw` and `/api/events` (no CSRF in URLs).
    pub get_access_tokens: Arc<RwLock<std::collections::HashMap<String, GetAccessToken>>>,
    /// Broadcast channel for SSE events
    pub sse_tx: broadcast::Sender<SseEvent>,
}

impl AppState {
    pub async fn emit_sse(&self, event: &str, data: serde_json::Value) {
        let inner = self.inner.read().await;
        let _ = inner.sse_tx.send(SseEvent {
            event: event.to_string(),
            data,
        });
    }

    pub fn new(config: &HubConfig, secure_cookies: bool) -> Self {
        let (sse_tx, _) = broadcast::channel(256);
        Self {
            inner: Arc::new(RwLock::new(AppStateInner {
                sessions: SessionStore::from_config(config),
                agents: AgentRegistry::new(),
                start_time: Instant::now(),
                pending_responses: Arc::new(RwLock::new(std::collections::HashMap::new())),
                preview_sessions: Arc::new(RwLock::new(std::collections::HashMap::new())),
                get_access_tokens: Arc::new(RwLock::new(std::collections::HashMap::new())),
                sse_tx,
            })),
            rate_limiter: Arc::new(LoginRateLimiter::new(5, std::time::Duration::from_secs(30))),
            // Agent fleets commonly reconnect in cohorts after a hub restart
            // or network partition. Keep this high enough for same-IP NATed
            // agents while still bounding unauthenticated WS auth attempts.
            ws_rate_limiter: Arc::new(LoginRateLimiter::new(300, std::time::Duration::from_secs(30))),
            secure_cookies,
        }
    }
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
}
