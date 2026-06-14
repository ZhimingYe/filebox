use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::{broadcast, mpsc, RwLock};

use filebox_protocol::resources::RootConfig;

use crate::agent_registry::AgentRegistry;
use crate::auth::SessionStore;
use crate::config::HubConfig;

pub struct PendingResponse {
    pub tx: mpsc::Sender<serde_json::Value>,
    pub desired_roots: Option<Vec<RootConfig>>,
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

    pub fn new(config: &HubConfig) -> Self {
        let (sse_tx, _) = broadcast::channel(256);
        Self {
            inner: Arc::new(RwLock::new(AppStateInner {
                sessions: SessionStore::from_config(config),
                agents: AgentRegistry::new(),
                start_time: Instant::now(),
                pending_responses: Arc::new(RwLock::new(std::collections::HashMap::new())),
                sse_tx,
            })),
            rate_limiter: Arc::new(LoginRateLimiter::new(5, std::time::Duration::from_secs(30))),
        }
    }
}
