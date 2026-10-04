use super::*;
use filebox_protocol::resources::{CollectionConfig, RootConfig, TempRootInfo};

pub(super) struct Registration {
    pub(super) agent_id: String,
    pub(super) name: String,
    resource_revision: u64,
    roots: Vec<RootConfig>,
    collections_revision: u64,
    collections: Vec<CollectionConfig>,
    capabilities: Capabilities,
    temp_root: Option<TempRootInfo>,
}

impl Registration {
    pub(super) fn from_message(message: AgentMessage, temporary_id: String) -> Option<Self> {
        let AgentMessage::Register {
            agent_id, name, resource_revision, roots, collections_revision,
            collections, capabilities, temp_root,
        } = message else { return None; };
        Some(Self {
            agent_id: agent_id.filter(|id| !id.is_empty()).unwrap_or(temporary_id),
            name, resource_revision, roots, collections_revision,
            collections, capabilities, temp_root,
        })
    }

    pub(super) async fn install(
        self, state: AppState, sender: mpsc::Sender<HubMessage>, abort: Arc<Notify>,
    ) -> AgentContext {
        let mut inner = state.inner.write().await;
        // Drain the old generation's waiters BEFORE publishing its replacement.
        // Otherwise delayed cleanup can restore old desired state over a newer
        // successful edit, or leave a queued update unsent until another reconnect.
        if let Some(old) = inner.agents.get(&self.agent_id) {
            let old_id = old.connection_id;
            tracing::warn!(agent_id = %self.agent_id, old_connection = old_id,
                connected_at = old.connected_at, "Replacing Agent connection");
            inner.agents.notify_old_connection_abort(&self.agent_id);
            let pending_arc = inner.pending_responses.clone();
            let mut pending = pending_arc.write().await;
            let keys: Vec<_> = pending.iter()
                .filter(|(_, p)| p.agent_id == self.agent_id && p.connection_id == old_id)
                .map(|(key, _)| key.clone()).collect();
            let victims: Vec<_> = keys.into_iter().filter_map(|key| pending.remove(&key).map(|response| (key, response))).collect();
            drop(pending);
            for (req_id, victim) in victims {
                AppState::requeue_pending_response_locked(&mut inner, &req_id, &victim);
                victim.deliver(crate::state::agent_disconnect_pending_error());
            }
        }
        let pending_roots = inner.agents.get(&self.agent_id).and_then(|a| a.pending_update.clone());
        let pending_collections = inner.agents.get(&self.agent_id).and_then(|a| a.pending_collections_update.clone());
        inner.agents.register(
            self.agent_id.clone(), self.name.clone(), sender.clone(), abort,
            self.resource_revision, self.roots, self.collections_revision,
            self.collections, self.capabilities, self.temp_root,
        );
        if let Some(pending) = pending_roots {
            inner.agents.set_pending_update(&self.agent_id, pending);
        }
        if let Some(pending) = pending_collections {
            inner.agents.set_pending_collections_update(&self.agent_id, pending);
        }
        let agent = inner.agents.get_mut(&self.agent_id).expect("registration just installed");
        let connection_id = agent.connection_id;
        // This fresh queue has capacity for both coalesced control updates.
        if let Some(pending) = &agent.pending_update {
            if let Some(revision) = agent.resource_revision.checked_add(1) {
                let roots = if agent.capabilities.pinned_folders {
                    pending.roots.clone()
                } else {
                    updates::strip_pinned_folders(&pending.roots)
                };
                let req_id = format!("pending_{}", Uuid::new_v4());
                if sender.try_send(HubMessage::ResourcesSetDesired {
                    req_id: req_id.clone(), desired_revision: revision, roots,
                }).is_ok() {
                    agent.pending_resource_request = Some(req_id);
                }
            } else {
                tracing::error!(agent_id = %self.agent_id, "Resource revision overflow on reconnect");
            }
        }
        if let Some(pending) = &agent.pending_collections_update {
            if agent.capabilities.collections {
                if let Some(revision) = agent.collections_revision.checked_add(1) {
                    let req_id = format!("pending_col_{}", Uuid::new_v4());
                    if sender.try_send(HubMessage::CollectionsSetDesired {
                        req_id: req_id.clone(), desired_revision: revision,
                        collections: pending.collections.clone(),
                    }).is_ok() {
                        agent.pending_collection_request = Some(req_id);
                    }
                } else {
                    tracing::error!(agent_id = %self.agent_id, "Collections revision overflow on reconnect");
                }
            }
        }
        // Registration and event publication are one ordered operation: a
        // browser responding to the event must already see the new generation.
        AppState::emit_sse_locked(&inner, "agent_connected", serde_json::json!({
            "agent_id": self.agent_id, "name": self.name,
        })).await;
        drop(inner);
        AgentContext { state, agent_id: self.agent_id, connection_id }
    }
}
