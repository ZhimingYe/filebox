use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RootConfig {
    pub name: String,
    pub path: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RootInfo {
    pub name: String,
    pub path_display: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Capabilities {
    pub fs_list: bool,
    pub fs_stat: bool,
    pub fs_read_range: bool,
    pub image_preview: bool,
    pub pdf_preview: bool,
    pub serve_dir: bool,
    pub resource_management: bool,
    pub sys_stats: bool,
}

impl Default for Capabilities {
    fn default() -> Self {
        Self {
            fs_list: true,
            fs_stat: true,
            fs_read_range: true,
            image_preview: false,
            pdf_preview: false,
            serve_dir: false,
            resource_management: true,
            sys_stats: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResourceRevision {
    pub agent_id: String,
    pub resource_revision: u64,
    pub roots: Vec<RootInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DesiredResources {
    pub roots: Vec<RootConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FsEntry {
    pub name: String,
    pub entry_type: FsEntryType,
    pub size: Option<u64>,
    pub modified: Option<String>,
    pub denied: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum FsEntryType {
    File,
    Directory,
    Symlink,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileStat {
    pub path: String,
    pub entry_type: FsEntryType,
    pub size: u64,
    pub modified: Option<String>,
    pub permissions: Option<String>,
    pub denied: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SysStats {
    pub cpu_usage_percent: f32,
    pub mem_used_bytes: u64,
    pub mem_total_bytes: u64,
    pub swap_used_bytes: u64,
    pub swap_total_bytes: u64,
    pub top_processes: Vec<ProcessInfo>,
    pub load_avg: [f64; 3],
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProcessInfo {
    pub pid: u32,
    pub name: String,
    pub mem_bytes: u64,
    pub cpu_usage: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiError {
    pub error: String,
    pub message: String,
    pub retryable: bool,
    pub suggested_retry_after_ms: Option<u64>,
}

impl ApiError {
    pub fn new(error: impl Into<String>, message: impl Into<String>, retryable: bool) -> Self {
        Self {
            error: error.into(),
            message: message.into(),
            retryable,
            suggested_retry_after_ms: None,
        }
    }

    pub fn with_retry(mut self, ms: u64) -> Self {
        self.suggested_retry_after_ms = Some(ms);
        self
    }
}
