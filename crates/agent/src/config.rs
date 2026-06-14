use std::path::PathBuf;

#[derive(serde::Deserialize)]
struct TomlConfig {
    hub: Option<String>,
    token: Option<String>,
    name: Option<String>,
    data_dir: Option<String>,
}

pub struct AgentConfig {
    pub hub_url: String,
    pub token: String,
    pub agent_name: String,
    pub data_dir: PathBuf,
}

impl AgentConfig {
    pub fn load() -> Self {
        let config_path = std::env::var("FILEBOX_AGENT_CONFIG")
            .unwrap_or_else(|_| "./agent.toml".to_string());

        let path = PathBuf::from(&config_path);
        let toml_config = if path.exists() {
            let contents = std::fs::read_to_string(&path)
                .unwrap_or_else(|e| panic!("Failed to read agent config '{}': {}", config_path, e));
            toml::from_str::<TomlConfig>(&contents)
                .unwrap_or_else(|e| panic!("Failed to parse agent config '{}': {}", config_path, e))
        } else {
            tracing::warn!(
                "Agent config file not found at '{}'. Create an agent.toml with:\n\
                 hub = \"wss://your-hub.example.com\"\n\
                 token = \"your-agent-token\"",
                config_path
            );
            TomlConfig {
                hub: None,
                token: None,
                name: None,
                data_dir: None,
            }
        };

        // TOML values can be overridden by env vars
        let hub_url = std::env::var("FILEBOX_HUB_URL")
            .ok()
            .or(toml_config.hub)
            .unwrap_or_else(|| {
                tracing::warn!("No hub URL configured, using ws://localhost:3000");
                "ws://localhost:3000".to_string()
            });

        let token = std::env::var("FILEBOX_AGENT_TOKEN")
            .ok()
            .or(toml_config.token)
            .unwrap_or_else(|| {
                tracing::warn!("No agent token configured, using dev-token");
                "dev-token".to_string()
            });

        let agent_name = std::env::var("FILEBOX_AGENT_NAME")
            .ok()
            .or(toml_config.name)
            .unwrap_or_else(|| "default-agent".to_string());

        let data_dir = std::env::var("FILEBOX_AGENT_DATA_DIR")
            .ok()
            .or(toml_config.data_dir)
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                dirs::data_local_dir()
                    .unwrap_or_else(|| PathBuf::from("."))
                    .join("filebox")
            });

        Self {
            hub_url,
            token,
            agent_name,
            data_dir,
        }
    }
}
