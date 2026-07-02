use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use filebox_protocol::resources::RootConfig;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PersistedConfig {
    pub agent_id: String,
    pub resource_revision: u64,
    pub roots: Vec<RootConfig>,
}

impl PersistedConfig {
    pub fn new(agent_id: String) -> Self {
        Self {
            agent_id,
            resource_revision: 0,
            roots: vec![],
        }
    }

    /// Load persisted state from disk, or generate a fresh agent_id on first run.
    /// The agent_id is a UUID generated once and persisted, NOT the human-readable
    /// agent name — using the name caused collisions when two agents shared a name
    /// and made impersonation easier.
    pub fn load_or_create(data_dir: &PathBuf) -> Self {
        let path = data_dir.join("agent_state.json");
        if path.exists() {
            match std::fs::read_to_string(&path) {
                Ok(text) => match serde_json::from_str::<PersistedConfig>(&text) {
                    Ok(config) => {
                        tracing::info!(
                            "Loaded persisted config: agent_id={}, rev={}, {} roots",
                            config.agent_id,
                            config.resource_revision,
                            config.roots.len(),
                        );
                        return config;
                    }
                    Err(e) => {
                        tracing::warn!("Failed to parse persisted config: {}", e);
                    }
                },
                Err(e) => {
                    tracing::warn!("Failed to read persisted config: {}", e);
                }
            }
        }
        // First run: generate a stable UUID and persist immediately so a crash
        // before the first apply_desired() still preserves the ID.
        let new_config = PersistedConfig::new(uuid::Uuid::new_v4().to_string());
        tracing::info!("Generated new agent_id: {}", new_config.agent_id);
        new_config.save(data_dir);
        new_config
    }

    pub fn save(&self, data_dir: &PathBuf) {
        let path = data_dir.join("agent_state.json");
        match serde_json::to_string_pretty(self) {
            Ok(text) => {
                if let Err(e) = std::fs::write(&path, text) {
                    tracing::error!("Failed to persist config: {}", e);
                } else {
                    // Restrict to owner read/write. No secrets today, but cheap defense.
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::PermissionsExt;
                        let _ = std::fs::set_permissions(
                            &path,
                            std::fs::Permissions::from_mode(0o600),
                        );
                    }
                }
            }
            Err(e) => {
                tracing::error!("Failed to serialize config: {}", e);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn new_initializes_with_zero_revision_and_empty_roots() {
        let cfg = PersistedConfig::new("agent-abc".to_string());
        assert_eq!(cfg.agent_id, "agent-abc");
        assert_eq!(cfg.resource_revision, 0);
        assert!(cfg.roots.is_empty());
    }

    #[test]
    fn load_or_create_generates_fresh_id_on_first_run() {
        let dir = tempdir().unwrap();
        let cfg = PersistedConfig::load_or_create(&dir.path().to_path_buf());
        assert!(!cfg.agent_id.is_empty());
        assert_eq!(cfg.resource_revision, 0);
        assert!(cfg.roots.is_empty());
        // File must exist immediately after first run
        assert!(dir.path().join("agent_state.json").exists());
    }

    #[test]
    fn load_or_create_round_trips_state_across_calls() {
        let dir = tempdir().unwrap();
        let path = dir.path().to_path_buf();

        // First call: create and mutate
        let mut cfg = PersistedConfig::load_or_create(&path);
        let original_id = cfg.agent_id.clone();
        cfg.resource_revision = 42;
        cfg.roots.push(RootConfig {
            name: "logs".to_string(),
            path: "/var/logs".to_string(),
            enabled: true,
            pinned_folders: vec![],
        });
        cfg.save(&path);

        // Second call: should reload persisted state, NOT generate a new ID
        let reloaded = PersistedConfig::load_or_create(&path);
        assert_eq!(reloaded.agent_id, original_id, "agent_id must be stable across runs");
        assert_eq!(reloaded.resource_revision, 42);
        assert_eq!(reloaded.roots.len(), 1);
        assert_eq!(reloaded.roots[0].name, "logs");
    }

    #[test]
    fn load_or_create_recovers_from_corrupt_file() {
        let dir = tempdir().unwrap();
        let path = dir.path().to_path_buf();

        // Write garbage
        std::fs::write(
            path.join("agent_state.json"),
            "{ this is not valid json",
        )
        .unwrap();

        // Should not panic — should fall through to fresh creation
        let cfg = PersistedConfig::load_or_create(&path);
        assert!(!cfg.agent_id.is_empty());
        assert_eq!(cfg.resource_revision, 0);
    }

    #[test]
    fn load_or_create_with_partial_json_still_recovers() {
        let dir = tempdir().unwrap();
        let path = dir.path().to_path_buf();

        // Valid JSON but missing fields — should be rejected by deserialization
        std::fs::write(
            path.join("agent_state.json"),
            "{\"agent_id\": \"x\"}",
        )
        .unwrap();

        let cfg = PersistedConfig::load_or_create(&path);
        // Falls through to fresh creation
        assert_eq!(cfg.resource_revision, 0);
        assert!(cfg.roots.is_empty());
    }

    #[test]
    fn save_persists_multiple_roots() {
        let dir = tempdir().unwrap();
        let path = dir.path().to_path_buf();

        let cfg = PersistedConfig {
            agent_id: "multi".to_string(),
            resource_revision: 7,
            roots: vec![
                RootConfig {
                    name: "a".to_string(),
                    path: "/a".to_string(),
                    enabled: true,
                    pinned_folders: vec![],
                },
                RootConfig {
                    name: "b".to_string(),
                    path: "/b".to_string(),
                    enabled: false,
                    pinned_folders: vec![],
                },
            ],
        };
        cfg.save(&path);

        let reloaded = PersistedConfig::load_or_create(&path);
        assert_eq!(reloaded.agent_id, "multi");
        assert_eq!(reloaded.resource_revision, 7);
        assert_eq!(reloaded.roots.len(), 2);
        assert!(reloaded.roots[0].enabled);
        assert!(!reloaded.roots[1].enabled);
    }

    #[test]
    fn load_preserves_agent_id_when_old_json_has_no_pinned_folders() {
        // An agent_state.json written by a pre-pinned-folders agent. MUST load
        // without losing the agent_id or roots — `#[serde(default)]` on the new
        // field is what makes this work. This is the single most important
        // backward-compat guard for this feature.
        let dir = tempdir().unwrap();
        let path = dir.path().to_path_buf();
        std::fs::write(
            path.join("agent_state.json"),
            r#"{
  "agent_id": "stable-id-from-old-agent",
  "resource_revision": 3,
  "roots": [
    { "name": "data", "path": "/data", "enabled": true }
  ]
}"#,
        )
        .unwrap();

        let cfg = PersistedConfig::load_or_create(&path);
        assert_eq!(cfg.agent_id, "stable-id-from-old-agent");
        assert_eq!(cfg.resource_revision, 3);
        assert_eq!(cfg.roots.len(), 1);
        assert_eq!(cfg.roots[0].name, "data");
        assert!(
            cfg.roots[0].pinned_folders.is_empty(),
            "old roots must load with empty pins, not fail"
        );
    }

    #[cfg(unix)]
    #[test]
    fn save_sets_owner_only_permissions_on_unix() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempdir().unwrap();
        let path = dir.path().to_path_buf();

        let cfg = PersistedConfig::new("perm-test".to_string());
        cfg.save(&path);

        let metadata = std::fs::metadata(path.join("agent_state.json")).unwrap();
        let mode = metadata.permissions().mode();
        // Owner read/write (0o600), no group/other bits
        assert_eq!(
            mode & 0o777,
            0o600,
            "expected 0o600, got {:o}",
            mode
        );
    }
}
