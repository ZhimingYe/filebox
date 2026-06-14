use serde::{Deserialize, Serialize};
use crate::resources::{Capabilities, FileStat, FsEntry, RootConfig, SysStats};

// ── Agent → Hub ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AgentMessage {
    Auth {
        token: String,
    },
    Register {
        agent_id: Option<String>,
        name: String,
        resource_revision: u64,
        roots: Vec<RootConfig>,
        capabilities: Capabilities,
    },
    Pong,
    Heartbeat,
    ResourcesApplied {
        req_id: String,
        agent_id: String,
        resource_revision: u64,
    },
    ResourcesRejected {
        req_id: String,
        agent_id: String,
        current_resource_revision: u64,
        error: String,
        message: String,
    },
    ResourcesUpdated {
        agent_id: String,
        resource_revision: u64,
        roots: Vec<RootConfig>,
    },
    FsListResponse {
        req_id: String,
        items: Vec<FsEntry>,
        next_cursor: Option<String>,
        error: Option<String>,
    },
    FsStatResponse {
        req_id: String,
        stat: Option<FileStat>,
        error: Option<String>,
    },
    FileChunk {
        req_id: String,
        offset: u64,
        data: Vec<u8>,
        done: bool,
        error: Option<String>,
    },
    Progress {
        req_id: String,
        phase: String,
        processed: u64,
        total: Option<u64>,
        message: Option<String>,
    },
    SysStatsResponse {
        req_id: String,
        stats: Option<SysStats>,
        error: Option<String>,
    },
}

// ── Hub → Agent ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum HubMessage {
    AuthResult {
        success: bool,
        agent_id: Option<String>,
    },
    Ping,
    ResourcesSetDesired {
        req_id: String,
        desired_revision: u64,
        roots: Vec<RootConfig>,
    },
    FsListRequest {
        req_id: String,
        root: String,
        path: String,
        limit: u32,
        cursor: Option<String>,
    },
    FsStatRequest {
        req_id: String,
        root: String,
        path: String,
    },
    FileReadRequest {
        req_id: String,
        root: String,
        path: String,
        offset: u64,
        length: Option<u64>,
    },
    Cancel {
        req_id: String,
    },
    Error {
        message: String,
    },
    SysStatsRequest {
        req_id: String,
    },
}
