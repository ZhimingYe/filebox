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
