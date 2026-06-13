pub struct AgentConfig {
    pub hub_url: String,
    pub token: String,
    pub agent_name: String,
}

impl AgentConfig {
    pub fn from_env() -> Self {
        let hub_url = std::env::var("FILEBOX_HUB_URL")
            .unwrap_or_else(|_| "ws://localhost:3000".to_string());

        let token = std::env::var("FILEBOX_AGENT_TOKEN")
            .unwrap_or_else(|_| "dev-token".to_string());

        let agent_name = std::env::var("FILEBOX_AGENT_NAME")
            .unwrap_or_else(|_| "default-agent".to_string());

        Self {
            hub_url,
            token,
            agent_name,
        }
    }
}
