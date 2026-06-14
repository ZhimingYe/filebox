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

    pub fn load_or_create(data_dir: &PathBuf, agent_id: String) -> Self {
        let path = data_dir.join("agent_state.json");
        if path.exists() {
            match std::fs::read_to_string(&path) {
                Ok(text) => match serde_json::from_str::<PersistedConfig>(&text) {
                    Ok(config) => {
                        tracing::info!(
                            "Loaded persisted config: rev={}, {} roots",
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
        PersistedConfig::new(agent_id)
    }

    pub fn save(&self, data_dir: &PathBuf) {
        let path = data_dir.join("agent_state.json");
        match serde_json::to_string_pretty(self) {
            Ok(text) => {
                if let Err(e) = std::fs::write(&path, text) {
                    tracing::error!("Failed to persist config: {}", e);
                }
            }
            Err(e) => {
                tracing::error!("Failed to serialize config: {}", e);
            }
        }
    }
}
