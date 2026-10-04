//! Request lifetime shared by file, preview, search, Office and upload relays.
use std::time::Duration;

use filebox_protocol::message::HubMessage;
use crate::state::AppState;

pub(crate) const CANCEL_DELIVERY_LIMIT: usize = 256;

pub(crate) struct PendingResponseCleanup {
    state: AppState,
    req_id: String,
    cancel_agent_id: Option<String>,
    active: bool,
    owner: tokio::sync::mpsc::WeakSender<serde_json::Value>,
}

impl PendingResponseCleanup {
    pub(crate) fn new(state: AppState, req_id: String, cancel_agent_id: Option<String>,
        owner: tokio::sync::mpsc::WeakSender<serde_json::Value>,
    ) -> Self {
        Self { state, req_id, cancel_agent_id, active: true, owner }
    }

    pub(crate) async fn finish(mut self, cancel: bool) {
        cleanup_request(&self.state, &self.req_id,
            if cancel { self.cancel_agent_id.as_deref() } else { None }, Some(&self.owner),
        ).await;
        self.active = false;
    }
}

impl Drop for PendingResponseCleanup {
    fn drop(&mut self) {
        if !self.active { return; }
        let state = self.state.clone();
        let req_id = self.req_id.clone();
        let agent_id = self.cancel_agent_id.clone();
        let owner = self.owner.clone();
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move { cleanup_request(&state, &req_id, agent_id.as_deref(), Some(&owner)).await; });
        }
    }
}

pub(crate) async fn cleanup_pending(state: &AppState, req_id: &str) {
    cleanup_request(state, req_id, None, None).await;
}

async fn cleanup_request(
    state: &AppState, req_id: &str, cancel_agent_id: Option<&str>,
    owner: Option<&tokio::sync::mpsc::WeakSender<serde_json::Value>>,
) {
    let target = {
        let mut inner = state.inner.write().await;
        let pending_arc = inner.pending_responses.clone();
        let mut map = pending_arc.write().await;
        if let Some(owner) = owner {
            let owned = owner.upgrade().is_some_and(|tx| {
                map.get(req_id).is_some_and(|p| p.tx.same_channel(&tx))
            });
            if !owned { return; }
        }
        // Office alone accepts caller-chosen IDs. Mark cancellation before
        // releasing admission locks so a delayed Cancel cannot target a retry
        // with the same ID. Generated file-chunk IDs need no tombstones.
        if req_id.starts_with("office_convert_") && map.get(req_id).is_some_and(|p| {
            cancel_agent_id == Some(p.agent_id.as_str())
        }) {
            AppState::mark_request_cancelled_locked(&inner, req_id);
        }
        let pending = map.remove(req_id);
        drop(map);
        if let Some(pending) = &pending {
            AppState::requeue_pending_response_locked(&mut inner, req_id, pending);
        }
        pending.and_then(|p| {
            let agent = inner.agents.get(&p.agent_id)?;
            (cancel_agent_id == Some(p.agent_id.as_str()) && agent.connection_id == p.connection_id)
                .then(|| (agent.sender.clone(), agent.abort_notify.clone()))
        })
    };
    if let Some((sender, abort)) = target {
        // Capture only this generation, release registry locks before waiting
        // on congestion, and bound cleanup. A lost Cancel must not strand a
        // search/upload worker; transport teardown cancels that generation.
        send_cancel(state, sender, abort, req_id).await;
    }
}

/// Weak channel identity prevents a delayed guard from removing/cancelling a
/// new Office request which reused the same req_id, even on the same socket.
pub(crate) fn response_channel() -> (
    tokio::sync::mpsc::Sender<serde_json::Value>,
    tokio::sync::mpsc::Receiver<serde_json::Value>,
    tokio::sync::mpsc::WeakSender<serde_json::Value>,
) {
    let (sender, receiver) = tokio::sync::mpsc::channel(1);
    let owner = sender.downgrade();
    (sender, receiver, owner)
}

pub(crate) async fn send_cancel(
    state: &AppState,
    sender: tokio::sync::mpsc::Sender<HubMessage>, abort: std::sync::Arc<tokio::sync::Notify>, req_id: &str,
) -> bool {
    let message = match sender.try_send(HubMessage::Cancel { req_id: req_id.to_string() }) {
        Ok(()) => return true,
        Err(tokio::sync::mpsc::error::TrySendError::Full(message)) => message,
        Err(tokio::sync::mpsc::error::TrySendError::Closed(_)) => {
            abort.notify_one();
            return false;
        }
    };
    let Ok(permit) = state.cancel_delivery_semaphore.clone().try_acquire_owned() else {
        abort.notify_one();
        return false;
    };
    let abort_on_failure = abort.clone();
    // No suspension between removing the waiter and spawning this delivery.
    // Dropping its JoinHandle detaches it: HTTP/prefetch cancellation cannot
    // lose either the Cancel or the bounded transport-teardown fallback.
    tokio::spawn(async move {
        let _permit = permit;
        if matches!(tokio::time::timeout(Duration::from_secs(5), sender.send(message)).await, Ok(Ok(()))) {
            true
        } else {
            abort.notify_one();
            false
        }
    }).await.unwrap_or_else(|_| {
        abort_on_failure.notify_one();
        false
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::PendingResponse;
    use std::sync::Arc;
    use tokio::sync::{mpsc, Notify};

    fn state() -> AppState {
        AppState::new(&crate::config::HubConfig {
            listen_addr: "127.0.0.1:0".parse().unwrap(), agent_token_hash: "fake".into(), users: vec![],
        }, false)
    }

    async fn register(state: &AppState, capacity: usize) -> (u64, mpsc::Receiver<HubMessage>, Arc<Notify>) {
        let (sender, receiver) = mpsc::channel(capacity);
        let abort = Arc::new(Notify::new());
        let mut inner = state.inner.write().await;
        inner.agents.register("agent".into(), "test".into(), sender, abort.clone(), 0, vec![],
            0, vec![], filebox_protocol::resources::Capabilities::default(), None);
        (inner.agents.get("agent").unwrap().connection_id, receiver, abort)
    }

    async fn guard(state: &AppState, connection_id: u64) -> (PendingResponseCleanup, mpsc::Receiver<serde_json::Value>) {
        guard_with_id(state, connection_id, "reused").await
    }

    async fn guard_with_id(state: &AppState, connection_id: u64, req_id: &str) -> (PendingResponseCleanup, mpsc::Receiver<serde_json::Value>) {
        let (sender, receiver, owner) = response_channel();
        state.inner.read().await.pending_responses.write().await.insert(req_id.into(), PendingResponse {
            tx: sender, agent_id: "agent".into(), connection_id,
            session_id: None, desired_roots: None, desired_collections: None,
        });
        (PendingResponseCleanup::new(state.clone(), req_id.into(), Some("agent".into()), owner), receiver)
    }

    #[tokio::test]
    async fn delayed_cleanup_cannot_remove_a_reused_id_on_the_same_generation() {
        let state = state();
        let (id, mut outbound, _) = register(&state, 8).await;
        let (old, _old_reply) = guard(&state, id).await;
        let old_entry = state.inner.read().await.pending_responses.write().await.remove("reused").unwrap();
        let (new, _new_reply) = guard(&state, id).await;
        old.finish(true).await;
        assert!(state.inner.read().await.pending_responses.read().await.contains_key("reused"));
        assert!(outbound.try_recv().is_err());
        drop(old_entry);
        new.finish(false).await;
    }

    #[tokio::test]
    async fn stale_cleanup_never_cancels_a_replacement_generation() {
        let state = state();
        let (old_id, _old_outbound, _) = register(&state, 8).await;
        let (old, _reply) = guard(&state, old_id).await;
        let (_new_id, mut new_outbound, new_abort) = register(&state, 8).await;
        old.finish(true).await;
        assert!(new_outbound.try_recv().is_err());
        assert!(tokio::time::timeout(Duration::from_millis(20), new_abort.notified()).await.is_err());
        assert!(state.inner.read().await.pending_responses.read().await.is_empty());
    }

    #[tokio::test]
    async fn cancel_waits_for_capacity_without_holding_registry_lock() {
        let state = state();
        let (id, mut outbound, _) = register(&state, 1).await;
        state.inner.read().await.agents.send_to_agent("agent", HubMessage::Ping);
        let (guard, _reply) = guard(&state, id).await;
        let cleanup = guard.finish(true);
        tokio::pin!(cleanup);
        assert!(tokio::time::timeout(Duration::from_millis(20), cleanup.as_mut()).await.is_err());
        assert!(state.inner.try_write().is_ok());
        assert!(matches!(outbound.recv().await, Some(HubMessage::Ping)));
        cleanup.await;
        assert!(matches!(outbound.recv().await, Some(HubMessage::Cancel { req_id }) if req_id == "reused"));
    }

    #[tokio::test]
    async fn stalled_cancel_aborts_only_the_captured_connection() {
        let state = state();
        let (old_id, _old_outbound, old_abort) = register(&state, 1).await;
        state.inner.read().await.agents.send_to_agent("agent", HubMessage::Ping);
        let (guard, _reply) = guard(&state, old_id).await;
        let cleanup = tokio::spawn(guard.finish(true));
        tokio::time::timeout(Duration::from_secs(1), async {
            while state.inner.read().await.pending_responses.read().await.contains_key("reused") {
                tokio::task::yield_now().await;
            }
        }).await.unwrap();
        let (_, _new_outbound, new_abort) = register(&state, 8).await;
        tokio::time::timeout(Duration::from_secs(6), cleanup).await.unwrap().unwrap();
        assert!(tokio::time::timeout(Duration::from_millis(20), old_abort.notified()).await.is_ok());
        assert!(tokio::time::timeout(Duration::from_millis(20), new_abort.notified()).await.is_err());
    }

    async fn wait_removed(state: &AppState, req_id: &str) {
        tokio::time::timeout(Duration::from_secs(1), async {
            while state.inner.read().await.pending_responses.read().await.contains_key(req_id) {
                tokio::task::yield_now().await;
            }
        }).await.unwrap();
    }

    #[tokio::test]
    async fn interrupted_finish_still_delivers_cancel_without_disconnect() {
        let state = state();
        let (id, mut outbound, abort) = register(&state, 1).await;
        state.inner.read().await.agents.send_to_agent("agent", HubMessage::Ping);
        let (guard, _reply) = guard(&state, id).await;
        let cleanup = tokio::spawn(guard.finish(true));
        wait_removed(&state, "reused").await;
        cleanup.abort();
        assert!(cleanup.await.unwrap_err().is_cancelled());
        assert!(matches!(outbound.recv().await, Some(HubMessage::Ping)));
        let frame = tokio::time::timeout(Duration::from_secs(1), outbound.recv()).await.unwrap();
        assert!(matches!(frame, Some(HubMessage::Cancel { req_id }) if req_id == "reused"));
        assert!(tokio::time::timeout(Duration::from_millis(20), abort.notified()).await.is_err());
    }

    #[tokio::test]
    async fn interrupted_finish_keeps_stalled_cancel_fallback_bound_to_old_socket() {
        let state = state();
        let (id, _outbound, old_abort) = register(&state, 1).await;
        state.inner.read().await.agents.send_to_agent("agent", HubMessage::Ping);
        let (guard, _reply) = guard(&state, id).await;
        let cleanup = tokio::spawn(guard.finish(true));
        wait_removed(&state, "reused").await;
        cleanup.abort();
        assert!(cleanup.await.unwrap_err().is_cancelled());
        let (_, mut new_outbound, new_abort) = register(&state, 8).await;
        tokio::time::timeout(Duration::from_secs(6), old_abort.notified()).await.unwrap();
        assert!(new_outbound.try_recv().is_err());
        assert!(tokio::time::timeout(Duration::from_millis(20), new_abort.notified()).await.is_err());
    }

    #[tokio::test]
    async fn office_reuse_is_rejected_while_old_cancel_waits_for_capacity() {
        let state = state();
        let (id, mut outbound, _) = register(&state, 2).await;
        {
            let mut inner = state.inner.write().await;
            let agent = inner.agents.get_mut("agent").unwrap();
            agent.capabilities.office_pdf_preview = true;
            agent.roots = vec![filebox_protocol::resources::RootConfig {
                name: "docs".into(), path: "/tmp".into(), enabled: true, pinned_folders: vec![],
            }];
            inner.agents.send_to_agent("agent", HubMessage::Ping);
            inner.agents.send_to_agent("agent", HubMessage::Ping);
        }
        let req_id = format!("office_convert_{}", uuid::Uuid::new_v4());
        let (old, _reply) = guard_with_id(&state, id, &req_id).await;
        let cleanup = tokio::spawn(old.finish(true));
        wait_removed(&state, &req_id).await;
        // Even after several queue slots open, admission rejects the reused ID.
        assert!(matches!(outbound.try_recv(), Ok(HubMessage::Ping)));
        assert!(matches!(outbound.try_recv(), Ok(HubMessage::Ping)));
        let response = tokio::time::timeout(Duration::from_secs(1), crate::office_proxy::office_convert_handler(
            axum::extract::State(state.clone()),
            axum::extract::Extension(crate::state::AuthenticatedSession { id: "session".into(), principal_id: "principal".into() }),
            axum::extract::Path("agent".into()),
            axum::Json(crate::office_proxy::OfficeConvertBody {
                root: "docs".into(), path: "/report.docx".into(), force: false,
                req_id: Some(req_id.clone()), client_nonce: None,
            }),
        )).await.unwrap();
        assert_eq!(response.status(), axum::http::StatusCode::CONFLICT);
        cleanup.await.unwrap();
        assert!(matches!(outbound.recv().await, Some(HubMessage::Cancel { req_id: cancelled }) if cancelled == req_id));
        assert!(outbound.try_recv().is_err());
    }

    #[tokio::test]
    async fn interrupted_explicit_cancel_still_completes_delivery() {
        let state = state();
        let (id, mut outbound, abort) = register(&state, 1).await;
        state.inner.read().await.agents.send_to_agent("agent", HubMessage::Ping);
        let (guard, mut reply) = guard(&state, id).await;
        state.inner.read().await.pending_responses.write().await.get_mut("reused").unwrap().session_id = Some("principal".into());
        let cancelled_state = state.clone();
        let cancel = tokio::spawn(async move {
            crate::routes::cancel_handler(
                axum::extract::State(cancelled_state),
                axum::extract::Extension(crate::state::AuthenticatedSession { id: "session".into(), principal_id: "principal".into() }),
                axum::Json(crate::routes::CancelRequest { agent_id: "agent".into(), req_id: "reused".into() }),
            ).await
        });
        wait_removed(&state, "reused").await;
        cancel.abort();
        assert!(cancel.await.unwrap_err().is_cancelled());
        assert_eq!(reply.recv().await.unwrap()["error"], "cancelled");
        guard.finish(false).await;
        assert!(matches!(outbound.recv().await, Some(HubMessage::Ping)));
        let frame = tokio::time::timeout(Duration::from_secs(1), outbound.recv()).await.unwrap();
        assert!(matches!(frame, Some(HubMessage::Cancel { req_id }) if req_id == "reused"));
        assert!(tokio::time::timeout(Duration::from_millis(20), abort.notified()).await.is_err());
    }

    #[tokio::test]
    async fn cancel_delivery_limit_fails_closed_without_spawning_more_waiters() {
        let mut state = state();
        state.cancel_delivery_semaphore = Arc::new(tokio::sync::Semaphore::new(1));
        let permit = state.cancel_delivery_semaphore.clone().acquire_owned().await.unwrap();
        let (id, _outbound, abort) = register(&state, 1).await;
        state.inner.read().await.agents.send_to_agent("agent", HubMessage::Ping);
        let (guard, _reply) = guard(&state, id).await;
        tokio::time::timeout(Duration::from_secs(1), guard.finish(true)).await.unwrap();
        tokio::time::timeout(Duration::from_secs(1), abort.notified()).await.unwrap();
        assert!(state.inner.read().await.pending_responses.read().await.is_empty());
        drop(permit);
        assert_eq!(state.cancel_delivery_semaphore.available_permits(), 1);
    }
}
