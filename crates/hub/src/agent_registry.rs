use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use tokio::sync::{mpsc, Notify};

use filebox_protocol::resources::{
    Capabilities, CollectionConfig, CollectionInfo, DesiredCollections, DesiredResources,
    ResourceRevision, RootConfig, RootInfo,
};
use filebox_protocol::message::HubMessage;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AgentStatus {
    Online,
    Slow,
    Offline,
}

pub struct AgentConnection {
    pub agent_id: String,
    pub name: String,
    pub sender: mpsc::UnboundedSender<HubMessage>,
    /// One-shot signal used to tell this connection's read loop to exit
    /// when a newer connection for the same agent_id replaces it. Without
    /// this, the old read loop would block on `ws_stream.next()` for the
    /// OS's TCP timeout (~hours on default Linux) — leaking fds on flaky
    /// networks with frequent reconnects.
    pub abort_notify: Arc<Notify>,
    pub status: AgentStatus,
    pub last_seen: Instant,
    pub last_pong: Option<Instant>,
    pub ping_sent_at: Option<Instant>,
    pub rtt_ms: Option<u64>,
    pub resource_revision: u64,
    pub roots: Vec<RootConfig>,
    pub collections_revision: u64,
    pub collections: Vec<CollectionConfig>,
    pub capabilities: Capabilities,
    pub pending_update: Option<DesiredResources>,
    pub pending_collections_update: Option<DesiredCollections>,
    pub inflight_requests: u32,
    pub connected_at: u64,
    pub last_config_error: Option<String>,
}

impl AgentConnection {
    pub fn to_info(&self) -> AgentInfoResponse {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();

        AgentInfoResponse {
            id: self.agent_id.clone(),
            name: self.name.clone(),
            status: match self.status {
                AgentStatus::Online => "online".to_string(),
                AgentStatus::Slow => "slow".to_string(),
                AgentStatus::Offline => "offline".to_string(),
            },
            last_seen: now.saturating_sub(self.last_seen.elapsed().as_secs()),
            rtt_ms: self.rtt_ms,
            inflight: self.inflight_requests,
            resource_revision: self.resource_revision,
            pending_resource_update: self.pending_update.is_some(),
            last_config_error: self.last_config_error.clone(),
            roots: self
                .roots
                .iter()
                .map(|r| RootInfo {
                    name: r.name.clone(),
                    path_display: r.path.clone(),
                    enabled: r.enabled,
                    pinned_folders: r.pinned_folders.clone(),
                })
                .collect(),
            collections_revision: self.collections_revision,
            pending_collections_update: self.pending_collections_update.is_some(),
            collections: {
                let source = self
                    .pending_collections_update
                    .as_ref()
                    .map(|p| &p.collections)
                    .unwrap_or(&self.collections);
                source
                    .iter()
                    .map(|c| CollectionInfo {
                        name: c.name.clone(),
                        items: c.items.clone(),
                    })
                    .collect()
            },
        }
    }

    pub fn to_resource_revision(&self) -> ResourceRevision {
        ResourceRevision {
            agent_id: self.agent_id.clone(),
            resource_revision: self.resource_revision,
            roots: self
                .roots
                .iter()
                .map(|r| RootInfo {
                    name: r.name.clone(),
                    path_display: r.path.clone(),
                    enabled: r.enabled,
                    pinned_folders: r.pinned_folders.clone(),
                })
                .collect(),
        }
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct AgentInfoResponse {
    pub id: String,
    pub name: String,
    pub status: String,
    pub last_seen: u64,
    pub rtt_ms: Option<u64>,
    pub inflight: u32,
    pub resource_revision: u64,
    pub pending_resource_update: bool,
    pub last_config_error: Option<String>,
    pub roots: Vec<RootInfo>,
    pub collections_revision: u64,
    pub pending_collections_update: bool,
    pub collections: Vec<CollectionInfo>,
}

pub struct AgentRegistry {
    agents: HashMap<String, AgentConnection>,
}

impl AgentRegistry {
    pub fn new() -> Self {
        Self {
            agents: HashMap::new(),
        }
    }

    pub fn register(
        &mut self,
        agent_id: String,
        name: String,
        sender: mpsc::UnboundedSender<HubMessage>,
        abort_notify: Arc<Notify>,
        resource_revision: u64,
        roots: Vec<RootConfig>,
        collections_revision: u64,
        collections: Vec<CollectionConfig>,
        capabilities: Capabilities,
    ) {
        let now = Instant::now();
        let epoch = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();

        let agent = AgentConnection {
            agent_id: agent_id.clone(),
            name,
            sender,
            abort_notify,
            status: AgentStatus::Online,
            last_seen: now,
            last_pong: None,
            ping_sent_at: None,
            rtt_ms: None,
            resource_revision,
            roots,
            collections_revision,
            collections,
            capabilities,
            pending_update: None,
            pending_collections_update: None,
            inflight_requests: 0,
            connected_at: epoch,
            last_config_error: None,
        };

        self.agents.insert(agent_id, agent);
    }

    /// If there's a live entry for `agent_id`, signal its read loop to exit.
    /// Used by the new connection's setup to abort a stuck old read loop
    /// that's blocked on `ws_stream.next()` waiting for a TCP timeout.
    pub fn notify_old_connection_abort(&self, agent_id: &str) -> bool {
        if let Some(agent) = self.agents.get(agent_id) {
            agent.abort_notify.notify_one();
            true
        } else {
            false
        }
    }

    /// Mark an agent offline, but only if the registry entry still belongs
    /// to the connection that's calling this. Reconnects race with the old
    /// connection's TCP-timeout cleanup: if a new connection has already
    /// replaced this entry (different sender channel), we must NOT mark it
    /// offline — that would silently break the live connection.
    pub fn unregister(
        &mut self,
        agent_id: &str,
        caller_sender: &mpsc::UnboundedSender<HubMessage>,
    ) {
        if let Some(agent) = self.agents.get(agent_id) {
            if agent.sender.same_channel(caller_sender) {
                if let Some(agent) = self.agents.get_mut(agent_id) {
                    agent.status = AgentStatus::Offline;
                }
            }
        }
    }

    pub fn get(&self, agent_id: &str) -> Option<&AgentConnection> {
        self.agents.get(agent_id)
    }

    pub fn get_mut(&mut self, agent_id: &str) -> Option<&mut AgentConnection> {
        self.agents.get_mut(agent_id)
    }

    pub fn list_all(&self) -> Vec<AgentInfoResponse> {
        self.agents.values().map(|a| a.to_info()).collect()
    }

    pub fn update_heartbeats(&mut self) {
        let now = Instant::now();
        for agent in self.agents.values_mut() {
            if agent.status == AgentStatus::Offline {
                continue;
            }

            let elapsed = now.duration_since(agent.last_seen);

            if elapsed > Duration::from_secs(90) {
                agent.status = AgentStatus::Offline;
            } else if elapsed > Duration::from_secs(45) {
                agent.status = AgentStatus::Slow;
            }

            // Check if pong came back for RTT
            if let (Some(ping_at), Some(pong_at)) = (agent.ping_sent_at, agent.last_pong) {
                if pong_at > ping_at {
                    agent.rtt_ms = Some(pong_at.duration_since(ping_at).as_millis() as u64);
                    agent.ping_sent_at = None;
                }
            }
        }
    }

    pub fn send_ping(&mut self, agent_id: &str) -> bool {
        if let Some(agent) = self.agents.get_mut(agent_id) {
            if agent.status != AgentStatus::Offline {
                agent.ping_sent_at = Some(Instant::now());
                let _ = agent.sender.send(HubMessage::Ping);
                return true;
            }
        }
        false
    }

    pub fn record_pong(&mut self, agent_id: &str) {
        if let Some(agent) = self.agents.get_mut(agent_id) {
            agent.last_pong = Some(Instant::now());
            agent.last_seen = Instant::now();
            if agent.status == AgentStatus::Slow {
                agent.status = AgentStatus::Online;
            }
        }
    }

    pub fn update_resources(
        &mut self,
        agent_id: &str,
        revision: u64,
        roots: Vec<RootConfig>,
    ) {
        if let Some(agent) = self.agents.get_mut(agent_id) {
            agent.resource_revision = revision;
            agent.roots = roots;
            agent.pending_update = None;
            agent.last_config_error = None;
        }
    }

    pub fn set_pending_update(&mut self, agent_id: &str, desired: DesiredResources) {
        if let Some(agent) = self.agents.get_mut(agent_id) {
            // Coalesce: replace with latest desired state
            agent.pending_update = Some(desired);
        }
    }

    pub fn update_collections(
        &mut self,
        agent_id: &str,
        revision: u64,
        collections: Vec<CollectionConfig>,
    ) {
        if let Some(agent) = self.agents.get_mut(agent_id) {
            agent.collections_revision = revision;
            agent.collections = collections;
            agent.pending_collections_update = None;
            agent.last_config_error = None;
        }
    }

    pub fn set_pending_collections_update(
        &mut self,
        agent_id: &str,
        desired: DesiredCollections,
    ) {
        if let Some(agent) = self.agents.get_mut(agent_id) {
            agent.pending_collections_update = Some(desired);
        }
    }

    pub fn set_config_error(&mut self, agent_id: &str, error: String) {
        if let Some(agent) = self.agents.get_mut(agent_id) {
            agent.last_config_error = Some(error);
        }
    }

    /// Agent rejected a pending collections update — drop the queued desired state
    /// but keep the last applied collections mirror intact.
    pub fn reject_pending_collections_update(&mut self, agent_id: &str, error: String) {
        if let Some(agent) = self.agents.get_mut(agent_id) {
            agent.pending_collections_update = None;
            agent.last_config_error = Some(error);
        }
    }

    pub fn send_to_agent(&self, agent_id: &str, msg: HubMessage) -> bool {
        if let Some(agent) = self.agents.get(agent_id) {
            agent.sender.send(msg).is_ok()
        } else {
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use filebox_protocol::resources::Capabilities;
    use tokio::sync::mpsc;

    // Keep the receiver alive for the lifetime of the test by leaking it.
    // The sender returned here always has a live consumer, so send_to_agent
    // reports success until the receiver is explicitly dropped.
    fn make_sender() -> mpsc::UnboundedSender<HubMessage> {
        let (tx, rx) = mpsc::unbounded_channel();
        std::mem::forget(rx);
        tx
    }

    fn register_simple(reg: &mut AgentRegistry, id: &str) -> mpsc::UnboundedSender<HubMessage> {
        let tx = make_sender();
        let notify = Arc::new(Notify::new());
        reg.register(
            id.to_string(),
            format!("agent-{}", id),
            tx.clone(),
            notify,
            0,
            vec![],
            0,
            vec![],
            Capabilities::default(),
        );
        tx
    }

    #[test]
    fn new_registry_starts_empty() {
        let reg = AgentRegistry::new();
        assert!(reg.list_all().is_empty());
    }

    #[test]
    fn register_creates_online_agent() {
        let mut reg = AgentRegistry::new();
        register_simple(&mut reg, "a1");

        let agents = reg.list_all();
        assert_eq!(agents.len(), 1);
        assert_eq!(agents[0].id, "a1");
        assert_eq!(agents[0].status, "online");
        assert_eq!(agents[0].resource_revision, 0);
        assert!(!agents[0].pending_resource_update);
    }

    #[test]
    fn register_replaces_existing_agent_with_same_id() {
        // Reconnection: same agent_id, new sender
        let mut reg = AgentRegistry::new();
        register_simple(&mut reg, "a1");
        let first_connected_at = reg.get("a1").unwrap().connected_at;

        // Re-register with a different name (simulating reconnect)
        std::thread::sleep(std::time::Duration::from_millis(1100));
        reg.register(
            "a1".to_string(),
            "new-name".to_string(),
            make_sender(),
            Arc::new(Notify::new()),
            5,
            vec![],
            0,
            vec![],
            Capabilities::default(),
        );

        let agent = reg.get("a1").unwrap();
        assert_eq!(agent.name, "new-name");
        assert_eq!(agent.resource_revision, 5);
        // Should NOT create duplicate
        assert_eq!(reg.list_all().len(), 1);
        let _ = first_connected_at;
    }

    #[test]
    fn unregister_marks_agent_offline_but_keeps_record() {
        let mut reg = AgentRegistry::new();
        let tx = register_simple(&mut reg, "a1");

        reg.unregister("a1", &tx);

        let agent = reg.get("a1").expect("agent record must persist after unregister");
        assert_eq!(agent.status, AgentStatus::Offline);
    }

    #[test]
    fn unregister_unknown_agent_is_noop() {
        let mut reg = AgentRegistry::new();
        let tx = make_sender();
        reg.unregister("nonexistent", &tx);
        // Should not panic
    }

    #[test]
    fn unregister_does_not_offline_reconnected_agent() {
        // Regression: reconnect race. The OLD connection's cleanup calls
        // unregister AFTER the new connection has already replaced the
        // registry entry. The new entry has a different sender channel, so
        // unregister must NOT mark it offline — otherwise the live new
        // connection silently appears offline to the hub.
        let mut reg = AgentRegistry::new();
        let old_tx = register_simple(&mut reg, "a1");

        // Simulate reconnect: same agent_id, fresh sender
        let new_tx = make_sender();
        let new_notify = Arc::new(Notify::new());
        reg.register(
            "a1".to_string(),
            "reconnected".to_string(),
            new_tx,
            new_notify,
            5,
            vec![],
            0,
            vec![],
            Capabilities::default(),
        );

        // Old connection's cleanup runs NOW (after the new register)
        reg.unregister("a1", &old_tx);

        let agent = reg.get("a1").expect("agent record must persist");
        assert_eq!(
            agent.status,
            AgentStatus::Online,
            "new connection must remain Online after old connection cleanup"
        );
        assert_eq!(agent.name, "reconnected");
        assert_eq!(agent.resource_revision, 5);
    }

    #[tokio::test]
    async fn notify_old_connection_abort_wakes_waiters_before_replacement() {
        // When a new connection registers for an agent_id that already has a
        // live entry, the hub calls notify_old_connection_abort() to make
        // the old read loop exit. Verify the notify actually fires.
        let mut reg = AgentRegistry::new();
        let old_notify = Arc::new(Notify::new());
        reg.register(
            "a1".to_string(),
            "first".to_string(),
            make_sender(),
            old_notify.clone(),
            0,
            vec![],
            0,
            vec![],
            Capabilities::default(),
        );

        // Spawn a task that waits on the old notify (simulating the old
        // handle_socket's read-loop select! arm).
        let waiter = old_notify.clone();
        let task = tokio::spawn(async move {
            waiter.notified().await;
        });

        // Yield once to let the task reach notified().
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;

        assert!(
            reg.notify_old_connection_abort("a1"),
            "must report true when an entry exists"
        );

        // The waiting task should complete shortly.
        tokio::time::timeout(std::time::Duration::from_secs(1), task)
            .await
            .expect("notified() must resolve after notify_old_connection_abort")
            .expect("task must not panic");

        // Unknown agent returns false (no-op).
        assert!(!reg.notify_old_connection_abort("ghost"));
    }

    #[test]
    fn get_returns_none_for_unknown_id() {
        let reg = AgentRegistry::new();
        assert!(reg.get("ghost").is_none());
    }

    #[test]
    fn list_all_reflects_current_state() {
        let mut reg = AgentRegistry::new();
        register_simple(&mut reg, "a1");
        register_simple(&mut reg, "a2");

        let agents = reg.list_all();
        assert_eq!(agents.len(), 2);
        let ids: Vec<_> = agents.iter().map(|a| a.id.as_str()).collect();
        assert!(ids.contains(&"a1"));
        assert!(ids.contains(&"a2"));
    }

    #[test]
    fn send_ping_returns_true_for_online_agent() {
        let mut reg = AgentRegistry::new();
        register_simple(&mut reg, "a1");

        assert!(reg.send_ping("a1"));
        assert!(reg.get("a1").unwrap().ping_sent_at.is_some());
    }

    #[test]
    fn send_ping_returns_false_for_offline_agent() {
        let mut reg = AgentRegistry::new();
        let tx = register_simple(&mut reg, "a1");
        reg.unregister("a1", &tx);

        assert!(!reg.send_ping("a1"));
    }

    #[test]
    fn send_ping_returns_false_for_unknown_agent() {
        let mut reg = AgentRegistry::new();
        assert!(!reg.send_ping("ghost"));
    }

    #[test]
    fn record_pong_sets_rtt_when_ping_was_sent() {
        let mut reg = AgentRegistry::new();
        register_simple(&mut reg, "a1");
        reg.send_ping("a1");
        std::thread::sleep(std::time::Duration::from_millis(10));
        reg.record_pong("a1");

        reg.update_heartbeats();
        let agent = reg.get("a1").unwrap();
        assert!(agent.rtt_ms.is_some(), "RTT must be set after pong");
        assert!(agent.ping_sent_at.is_none(), "ping_sent_at cleared after pong");
    }

    #[test]
    fn record_pong_promotes_slow_agent_to_online() {
        let mut reg = AgentRegistry::new();
        register_simple(&mut reg, "a1");

        // Force slow status
        {
            let agent = reg.get_mut("a1").unwrap();
            agent.status = AgentStatus::Slow;
            // Make last_seen old enough to still be in slow window
            agent.last_seen = Instant::now() - Duration::from_secs(50);
        }
        reg.record_pong("a1");

        let agent = reg.get("a1").unwrap();
        assert_eq!(agent.status, AgentStatus::Online);
    }

    #[test]
    fn update_heartbeats_offlines_agent_missing_90s() {
        let mut reg = AgentRegistry::new();
        register_simple(&mut reg, "a1");

        // Simulate last_seen 95 seconds ago
        let agent = reg.get_mut("a1").unwrap();
        agent.last_seen = Instant::now() - Duration::from_secs(95);

        reg.update_heartbeats();
        assert_eq!(reg.get("a1").unwrap().status, AgentStatus::Offline);
    }

    #[test]
    fn update_heartbeats_marks_slow_after_45s() {
        let mut reg = AgentRegistry::new();
        register_simple(&mut reg, "a1");

        let agent = reg.get_mut("a1").unwrap();
        agent.last_seen = Instant::now() - Duration::from_secs(50);

        reg.update_heartbeats();
        assert_eq!(reg.get("a1").unwrap().status, AgentStatus::Slow);
    }

    #[test]
    fn update_heartbeats_keeps_online_when_recent() {
        let mut reg = AgentRegistry::new();
        register_simple(&mut reg, "a1");

        reg.update_heartbeats();
        assert_eq!(reg.get("a1").unwrap().status, AgentStatus::Online);
    }

    #[test]
    fn update_heartbeats_does_not_revive_offline_agents() {
        let mut reg = AgentRegistry::new();
        let tx = register_simple(&mut reg, "a1");
        reg.unregister("a1", &tx);

        // Even with a fresh pong, offline agents must stay offline via update_heartbeats
        let agent = reg.get_mut("a1").unwrap();
        agent.last_seen = Instant::now();

        reg.update_heartbeats();
        assert_eq!(reg.get("a1").unwrap().status, AgentStatus::Offline);
    }

    #[test]
    fn update_resources_clears_pending_and_error() {
        let mut reg = AgentRegistry::new();
        register_simple(&mut reg, "a1");

        reg.set_pending_update(
            "a1",
            DesiredResources { roots: vec![] },
        );
        reg.set_config_error("a1", "previous error".to_string());

        reg.update_resources(
            "a1",
            3,
            vec![RootConfig {
                name: "r".to_string(),
                path: "/r".to_string(),
                enabled: true,
                pinned_folders: vec![],
            }],
        );

        let agent = reg.get("a1").unwrap();
        assert_eq!(agent.resource_revision, 3);
        assert_eq!(agent.roots.len(), 1);
        assert!(agent.pending_update.is_none());
        assert!(agent.last_config_error.is_none());
    }

    #[test]
    fn reject_pending_collections_update_clears_pending_keeps_mirror() {
        let mut reg = AgentRegistry::new();
        register_simple(&mut reg, "a1");

        reg.set_pending_collections_update(
            "a1",
            DesiredCollections {
                collections: vec![CollectionConfig {
                    name: "bad".to_string(),
                    items: vec![],
                }],
            },
        );

        reg.reject_pending_collections_update("a1", "duplicate name".to_string());

        let agent = reg.get("a1").unwrap();
        assert!(agent.pending_collections_update.is_none());
        assert_eq!(
            agent.last_config_error.as_deref(),
            Some("duplicate name")
        );
        assert!(agent.collections.is_empty());
    }

    #[test]
    fn set_pending_update_coalesces_to_latest() {
        let mut reg = AgentRegistry::new();
        register_simple(&mut reg, "a1");

        let r1 = DesiredResources {
            roots: vec![RootConfig {
                name: "old".to_string(),
                path: "/old".to_string(),
                enabled: true,
                pinned_folders: vec![],
            }],
        };
        let r2 = DesiredResources {
            roots: vec![RootConfig {
                name: "new".to_string(),
                path: "/new".to_string(),
                enabled: true,
                pinned_folders: vec![],
            }],
        };

        reg.set_pending_update("a1", r1);
        reg.set_pending_update("a1", r2); // should replace, not append

        let agent = reg.get("a1").unwrap();
        let pending = agent.pending_update.as_ref().unwrap();
        assert_eq!(pending.roots.len(), 1);
        assert_eq!(pending.roots[0].name, "new");
    }

    #[test]
    fn set_config_error_stores_message() {
        let mut reg = AgentRegistry::new();
        register_simple(&mut reg, "a1");

        reg.set_config_error("a1", "bad path".to_string());
        assert_eq!(
            reg.get("a1").unwrap().last_config_error.as_deref(),
            Some("bad path")
        );
    }

    #[test]
    fn offline_pin_deltas_chain_onto_pending() {
        // Regression for P2: when the agent is offline, consecutive pin
        // deltas must accumulate in pending_update, not overwrite each other.
        // routes.rs::patch_root_handler bases its clone on the existing
        // pending_update (when present) rather than agent.roots, so a second
        // offline pin sees the first one already in the base and adds to it.
        // This test fixes the registry-level contract that the routes logic
        // depends on: set_pending_update with a chained desired state, then a
        // second set_pending_update built from that same pending base, produces
        // a pending containing BOTH pins.
        let mut reg = AgentRegistry::new();
        register_simple(&mut reg, "a1");

        // Seed the agent with a root that has no pins yet (the "last applied"
        // state, reflected in agent.roots).
        {
            let agent = reg.get_mut("a1").unwrap();
            agent.roots = vec![RootConfig {
                name: "demo".to_string(),
                path: "/demo".to_string(),
                enabled: true,
                pinned_folders: vec![],
            }];
        }

        // Simulate the routes.rs offline flow: patch_root_handler reads
        // pending_update as the base (None first → agent.roots), applies the
        // pin_add delta, and set_pending_update stores it.
        let base1 = reg
            .get("a1")
            .and_then(|a| a.pending_update.as_ref().map(|p| p.roots.clone()))
            .unwrap_or_else(|| reg.get("a1").unwrap().roots.clone());
        let mut chained1 = base1;
        for r in chained1.iter_mut() {
            if r.name == "demo" && !r.pinned_folders.iter().any(|p| p == "/a") {
                r.pinned_folders.push("/a".to_string());
            }
        }
        reg.set_pending_update("a1", DesiredResources { roots: chained1 });

        // Second offline pin: patch_root_handler now reads the PENDING as the
        // base (which already has /a), adds /b, and set_pending_update stores.
        let base2 = reg
            .get("a1")
            .and_then(|a| a.pending_update.as_ref().map(|p| p.roots.clone()))
            .expect("pending must be present after first pin");
        let mut chained2 = base2;
        for r in chained2.iter_mut() {
            if r.name == "demo" && !r.pinned_folders.iter().any(|p| p == "/b") {
                r.pinned_folders.push("/b".to_string());
            }
        }
        reg.set_pending_update("a1", DesiredResources { roots: chained2 });

        // The pending state must now contain BOTH pins. The old whole-state-
        // replace bug would have left only /b (the second delta overwrote the
        // first because it was computed from agent.roots, which had no pins).
        let pending = reg
            .get("a1")
            .unwrap()
            .pending_update
            .as_ref()
            .expect("pending must be present");
        let demo = pending
            .roots
            .iter()
            .find(|r| r.name == "demo")
            .expect("demo root must be in pending");
        assert!(
            demo.pinned_folders.iter().any(|p| p == "/a"),
            "first offline pin /a must survive the second pin (chained, not overwritten)"
        );
        assert!(
            demo.pinned_folders.iter().any(|p| p == "/b"),
            "second offline pin /b must be present"
        );
    }

    #[test]
    fn pending_update_survives_re_register() {
        // Regression for P0: an offline-queued resource change (e.g. a pin edit
        // made while the agent was down) MUST survive re-registration. The hub's
        // ws.rs handle_socket captures the old pending_update before register()
        // and re-applies it after; this test pins the registry-level contract
        // that the ws.rs path depends on: set_pending_update on a live entry,
        // then register() a fresh entry (simulating reconnect) — the caller is
        // responsible for re-applying, so register() itself must NOT be what
        // preserves it (it resets to None). We assert the capture+re-apply
        // sequence works, mirroring the ws.rs flow exactly.
        let mut reg = AgentRegistry::new();
        register_simple(&mut reg, "a1");

        let desired = DesiredResources {
            roots: vec![RootConfig {
                name: "pinned".to_string(),
                path: "/p".to_string(),
                enabled: true,
                pinned_folders: vec!["/sub".to_string()],
            }],
        };
        reg.set_pending_update("a1", desired.clone());

        // Reconnect flow (as ws.rs does it): capture, register, re-apply.
        let captured = reg.get("a1").and_then(|a| a.pending_update.clone());
        reg.register(
            "a1".to_string(),
            "reconnected".to_string(),
            make_sender(),
            Arc::new(Notify::new()),
            0,
            vec![],
            0,
            vec![],
            Capabilities::default(),
        );
        // After register() the fresh entry has NO pending — this is the bug
        // surface, and exactly why ws.rs must re-apply rather than rely on
        // register().
        assert!(
            reg.get("a1").unwrap().pending_update.is_none(),
            "register() resets pending_update to None; ws.rs must re-apply"
        );
        if let Some(pending) = captured {
            reg.set_pending_update("a1", pending);
        }

        // Now the pending update must be present and intact, including pins.
        let agent = reg.get("a1").unwrap();
        let pending = agent
            .pending_update
            .as_ref()
            .expect("re-applied pending must be present");
        assert_eq!(pending.roots.len(), 1);
        assert_eq!(pending.roots[0].pinned_folders, vec!["/sub".to_string()]);
    }

    #[test]
    fn send_to_agent_delivers_message_to_online_agent() {
        let mut reg = AgentRegistry::new();
        register_simple(&mut reg, "a1");

        let sent = reg.send_to_agent(
            "a1",
            HubMessage::Error {
                message: "hi".to_string(),
            },
        );
        assert!(sent);
    }

    #[test]
    fn send_to_agent_returns_false_for_unknown_agent() {
        let reg = AgentRegistry::new();
        let sent = reg.send_to_agent(
            "ghost",
            HubMessage::Error {
                message: "x".to_string(),
            },
        );
        assert!(!sent);
    }

    #[test]
    fn to_info_includes_root_path_display() {
        let mut reg = AgentRegistry::new();
        reg.register(
            "a1".to_string(),
            "test".to_string(),
            make_sender(),
            Arc::new(Notify::new()),
            2,
            vec![
                RootConfig {
                    name: "r1".to_string(),
                    path: "/path/one".to_string(),
                    enabled: true,
                    pinned_folders: vec![],
                },
                RootConfig {
                    name: "r2".to_string(),
                    path: "/path/two".to_string(),
                    enabled: false,
                    pinned_folders: vec![],
                },
            ],
            0,
            vec![],
            Capabilities::default(),
        );

        let info = reg.get("a1").unwrap().to_info();
        assert_eq!(info.id, "a1");
        assert_eq!(info.roots.len(), 2);
        assert_eq!(info.roots[0].path_display, "/path/one");
        assert!(info.roots[0].enabled);
        assert!(!info.roots[1].enabled);
    }

    #[test]
    fn to_resource_revision_carries_revision_and_roots() {
        let mut reg = AgentRegistry::new();
        reg.register(
            "a1".to_string(),
            "test".to_string(),
            make_sender(),
            Arc::new(Notify::new()),
            7,
            vec![RootConfig {
                name: "x".to_string(),
                path: "/x".to_string(),
                enabled: true,
                pinned_folders: vec![],
            }],
            0,
            vec![],
            Capabilities::default(),
        );

        let rev = reg.get("a1").unwrap().to_resource_revision();
        assert_eq!(rev.agent_id, "a1");
        assert_eq!(rev.resource_revision, 7);
        assert_eq!(rev.roots.len(), 1);
    }

    #[test]
    fn to_info_status_string_serializes() {
        let mut reg = AgentRegistry::new();
        let tx = register_simple(&mut reg, "a1");
        assert_eq!(reg.get("a1").unwrap().to_info().status, "online");

        reg.unregister("a1", &tx);
        assert_eq!(reg.get("a1").unwrap().to_info().status, "offline");
    }

    #[test]
    fn to_info_reflects_pending_flag() {
        let mut reg = AgentRegistry::new();
        register_simple(&mut reg, "a1");
        assert!(!reg.get("a1").unwrap().to_info().pending_resource_update);

        reg.set_pending_update("a1", DesiredResources { roots: vec![] });
        assert!(reg.get("a1").unwrap().to_info().pending_resource_update);
    }

    #[test]
    fn send_to_agent_detects_dropped_receiver() {
        let mut reg = AgentRegistry::new();
        let (tx, rx) = mpsc::unbounded_channel::<HubMessage>();
        reg.register(
            "a1".to_string(),
            "test".to_string(),
            tx,
            Arc::new(Notify::new()),
            0,
            vec![],
            0,
            vec![],
            Capabilities::default(),
        );
        drop(rx); // simulate dead consumer

        let sent = reg.send_to_agent(
            "a1",
            HubMessage::Error {
                message: "x".to_string(),
            },
        );
        assert!(!sent, "must report false when receiver is gone");
    }
}
