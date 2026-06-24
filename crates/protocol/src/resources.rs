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

/// Snapshot of host + process / per-user stats for the System Monitor view.
///
/// Designed for HPC nodes (terabyte memory, tens of thousands of PIDs). The
/// agent gathers everything in one `/proc` sweep and aggregates per-user on
/// the spot, so the browser never sees raw process counts — only top-N
/// processes and top-N users plus a global totals row.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SysStats {
    // ── Host overview ──
    pub cpu_usage_percent: f32,
    pub mem_used_bytes: u64,
    pub mem_total_bytes: u64,
    pub swap_used_bytes: u64,
    pub swap_total_bytes: u64,
    pub load_avg: [f64; 3],
    pub uptime_secs: u64,
    pub boot_time: i64,
    // ── Processes ──
    /// Top-N processes (default top 50 by memory). The full per-process
    /// detail set is here; the browser never needs a second request.
    pub top_processes: Vec<ProcessInfo>,
    /// Total process count on the node (the sweep saw this many PIDs).
    /// Lets the UI show "showing 50 of 12,847".
    pub total_processes: u32,
    // ── Multi-tenant aggregation ──
    pub top_users: Vec<UserAgg>,
    pub user_totals: UserTotals,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProcessInfo {
    pub pid: u32,
    pub name: String,
    /// Resolved username; falls back to the numeric uid as a string.
    pub user: String,
    pub uid: u32,
    /// One-letter kernel state: R / S / D / Z / I.
    pub state: String,
    pub mem_bytes: u64,
    pub cpu_usage: f32,
    /// Accumulated CPU time (CPU-milliseconds). Lets the UI show how many
    /// core-seconds a long-running job has burned, independent of the
    /// instantaneous `cpu_usage` sample.
    pub accumulated_cpu_ms: u64,
    /// Wall-clock start time, Unix epoch seconds.
    pub start_time: i64,
    /// Seconds the process has been running.
    pub run_time_secs: u64,
    /// Parent PID if known.
    pub parent_pid: Option<u32>,
    /// Full command line (argv joined with spaces). Not redacted — filebox is
    /// read-only and a logged-in user already has filesystem read access; a
    /// process command line is not an additional secret surface. Hard-capped
    /// in length on the agent to prevent a hostile cmdline from ballooning
    /// the payload (purely a size guard, not content filtering).
    pub command: String,
    /// HPC parallelism hint parsed from the command line (e.g. `mpirun -np
    /// 128`, `srun --ntasks=128`, `--nproc_per_node=8`). Lets the UI badge
    /// launcher processes with their fan-out without parsing argv client-side.
    pub nproc: Option<u32>,
}

/// Per-user aggregate, the multi-tenant core of this view.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserAgg {
    pub user: String,
    pub uid: u32,
    /// Sum of all of this user's processes' instantaneous CPU%.
    pub cpu_usage: f32,
    /// Sum of all of this user's processes' RSS.
    pub mem_bytes: u64,
    /// Sum of accumulated CPU time across the user's processes.
    pub accumulated_cpu_ms: u64,
    /// Number of processes owned by this user (as seen in the sweep).
    pub process_count: u32,
}

/// Global totals across all users — the "whole node, who's on it" summary.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserTotals {
    pub user_count: u32,
    pub total_cpu_usage: f32,
    pub total_mem_bytes: u64,
    pub total_processes: u32,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capabilities_default_marks_supported_features() {
        let caps = Capabilities::default();
        assert!(caps.fs_list, "fs_list should default to true");
        assert!(caps.fs_stat);
        assert!(caps.fs_read_range);
        assert!(caps.resource_management);
        assert!(caps.sys_stats);
        // Premium previews are off until the agent opts in
        assert!(!caps.image_preview);
        assert!(!caps.pdf_preview);
        assert!(!caps.serve_dir);
    }

    #[test]
    fn api_error_new_sets_fields() {
        let err = ApiError::new("backend_offline", "agent gone", true);
        assert_eq!(err.error, "backend_offline");
        assert_eq!(err.message, "agent gone");
        assert!(err.retryable);
        assert!(err.suggested_retry_after_ms.is_none());
    }

    #[test]
    fn api_error_with_retry_sets_backoff() {
        let err = ApiError::new("rate_limited", "slow down", true).with_retry(1500);
        assert_eq!(err.suggested_retry_after_ms, Some(1500));
    }

    #[test]
    fn root_config_round_trips_through_json() {
        let root = RootConfig {
            name: "docs".to_string(),
            path: "/var/docs".to_string(),
            enabled: true,
        };
        let json = serde_json::to_string(&root).unwrap();
        let back: RootConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(root, back);
    }

    #[test]
    fn fs_entry_type_serializes_as_snake_case() {
        let file_json = serde_json::to_string(&FsEntryType::File).unwrap();
        let dir_json = serde_json::to_string(&FsEntryType::Directory).unwrap();
        let link_json = serde_json::to_string(&FsEntryType::Symlink).unwrap();
        assert_eq!(file_json, "\"file\"");
        assert_eq!(dir_json, "\"directory\"");
        assert_eq!(link_json, "\"symlink\"");
    }

    #[test]
    fn fs_entry_type_deserializes_from_snake_case() {
        let file: FsEntryType = serde_json::from_str("\"file\"").unwrap();
        let dir: FsEntryType = serde_json::from_str("\"directory\"").unwrap();
        let link: FsEntryType = serde_json::from_str("\"symlink\"").unwrap();
        assert_eq!(file, FsEntryType::File);
        assert_eq!(dir, FsEntryType::Directory);
        assert_eq!(link, FsEntryType::Symlink);
    }

    #[test]
    fn fs_entry_type_rejects_unknown_variant() {
        let result: Result<FsEntryType, _> = serde_json::from_str("\"block_device\"");
        assert!(result.is_err());
    }

    #[test]
    fn fs_entry_handles_optional_fields() {
        // Denied file: no size, no modified
        let entry = FsEntry {
            name: ".env".to_string(),
            entry_type: FsEntryType::File,
            size: None,
            modified: None,
            denied: true,
        };
        let json = serde_json::to_string(&entry).unwrap();
        let back: FsEntry = serde_json::from_str(&json).unwrap();
        assert_eq!(back.name, ".env");
        assert!(back.denied);
        assert!(back.size.is_none());
    }

    #[test]
    fn sys_stats_serializes_with_full_payload() {
        let stats = SysStats {
            cpu_usage_percent: 42.5,
            mem_used_bytes: 8 * 1024 * 1024 * 1024,
            mem_total_bytes: 16 * 1024 * 1024 * 1024,
            swap_used_bytes: 0,
            swap_total_bytes: 4 * 1024 * 1024 * 1024,
            load_avg: [1.0, 0.8, 0.5],
            uptime_secs: 3600,
            boot_time: 1_700_000_000,
            top_processes: vec![ProcessInfo {
                pid: 1234,
                name: "chrome".to_string(),
                user: "alice".to_string(),
                uid: 1000,
                state: "R".to_string(),
                mem_bytes: 500 * 1024 * 1024,
                cpu_usage: 12.0,
                accumulated_cpu_ms: 1_800_000,
                start_time: 1_700_000_000,
                run_time_secs: 120,
                parent_pid: Some(1),
                command: "chrome --foo".to_string(),
                nproc: Some(8),
            }],
            total_processes: 12_847,
            top_users: vec![UserAgg {
                user: "alice".to_string(),
                uid: 1000,
                cpu_usage: 42.0,
                mem_bytes: 8 * 1024 * 1024 * 1024,
                accumulated_cpu_ms: 1_800_000,
                process_count: 1280,
            }],
            user_totals: UserTotals {
                user_count: 12,
                total_cpu_usage: 87.0,
                total_mem_bytes: 612 * 1024 * 1024 * 1024,
                total_processes: 12_847,
            },
        };
        let json = serde_json::to_string(&stats).unwrap();
        let back: SysStats = serde_json::from_str(&json).unwrap();
        assert_eq!(back.cpu_usage_percent, 42.5);
        assert_eq!(back.top_processes.len(), 1);
        assert_eq!(back.top_processes[0].pid, 1234);
        assert_eq!(back.top_processes[0].user, "alice");
        assert_eq!(back.top_processes[0].nproc, Some(8));
        assert_eq!(back.load_avg, [1.0, 0.8, 0.5]);
        assert_eq!(back.total_processes, 12_847);
        assert_eq!(back.top_users.len(), 1);
        assert_eq!(back.top_users[0].user, "alice");
        assert_eq!(back.top_users[0].process_count, 1280);
        assert_eq!(back.user_totals.user_count, 12);
    }

    #[test]
    fn root_info_path_display_round_trips() {
        let info = RootInfo {
            name: "logs".to_string(),
            path_display: "/var/logs".to_string(),
            enabled: false,
        };
        let json = serde_json::to_string(&info).unwrap();
        let back: RootInfo = serde_json::from_str(&json).unwrap();
        assert_eq!(info, back);
    }

    #[test]
    fn resource_revision_carries_agent_id() {
        let rev = ResourceRevision {
            agent_id: "agent-xyz".to_string(),
            resource_revision: 7,
            roots: vec![],
        };
        let json = serde_json::to_string(&rev).unwrap();
        assert!(json.contains("\"agent_id\":\"agent-xyz\""));
        assert!(json.contains("\"resource_revision\":7"));
    }

    #[test]
    fn desired_resources_round_trips() {
        let desired = DesiredResources {
            roots: vec![RootConfig {
                name: "data".to_string(),
                path: "/data".to_string(),
                enabled: true,
            }],
        };
        let json = serde_json::to_string(&desired).unwrap();
        let back: DesiredResources = serde_json::from_str(&json).unwrap();
        assert_eq!(back.roots.len(), 1);
        assert_eq!(back.roots[0].name, "data");
    }
}
