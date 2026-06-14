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

#[derive(Clone)]
pub struct AppState {
    pub inner: Arc<RwLock<AppStateInner>>,
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
        }
    }
}
