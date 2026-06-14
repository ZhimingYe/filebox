use std::collections::HashMap;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use tokio::sync::mpsc;

use filebox_protocol::resources::{
    Capabilities, DesiredResources, ResourceRevision, RootConfig, RootInfo,
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
    pub status: AgentStatus,
    pub last_seen: Instant,
    pub last_pong: Option<Instant>,
    pub ping_sent_at: Option<Instant>,
    pub rtt_ms: Option<u64>,
    pub resource_revision: u64,
    pub roots: Vec<RootConfig>,
    pub capabilities: Capabilities,
    pub pending_update: Option<DesiredResources>,
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
                })
                .collect(),
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
        resource_revision: u64,
        roots: Vec<RootConfig>,
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
            status: AgentStatus::Online,
            last_seen: now,
            last_pong: None,
            ping_sent_at: None,
            rtt_ms: None,
            resource_revision,
            roots,
            capabilities,
            pending_update: None,
            inflight_requests: 0,
            connected_at: epoch,
            last_config_error: None,
        };

        self.agents.insert(agent_id, agent);
    }

    pub fn unregister(&mut self, agent_id: &str) {
        if let Some(agent) = self.agents.get_mut(agent_id) {
            agent.status = AgentStatus::Offline;
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

    pub fn set_config_error(&mut self, agent_id: &str, error: String) {
        if let Some(agent) = self.agents.get_mut(agent_id) {
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
