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

        // TOML values can be overridden by env vars.
        // FILEBOX_AGENT_HUB is the documented name; FILEBOX_HUB_URL kept as a legacy alias.
        let hub_url = std::env::var("FILEBOX_AGENT_HUB")
            .ok()
            .or_else(|| std::env::var("FILEBOX_HUB_URL").ok())
            .or(toml_config.hub)
            .unwrap_or_else(|| {
                eprintln!("[agent] FATAL: no hub URL configured.");
                eprintln!("[agent] Set 'hub' in agent.toml or FILEBOX_AGENT_HUB env var.");
                std::process::exit(1);
            });

        let token = std::env::var("FILEBOX_AGENT_TOKEN")
            .ok()
            .or(toml_config.token)
            .unwrap_or_else(|| {
                eprintln!("[agent] FATAL: no agent token configured.");
                eprintln!("[agent] Set 'token' in agent.toml or FILEBOX_AGENT_TOKEN env var.");
                std::process::exit(1);
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

        enforce_secure_hub_url(&hub_url);

        Self {
            hub_url,
            token,
            agent_name,
            data_dir,
        }
    }
}

fn enforce_secure_hub_url(hub_url: &str) {
    if is_secure_hub_url(hub_url) {
        return;
    }

    if allow_insecure_hub() {
        eprintln!(
            "[agent] WARNING: connecting to hub over plaintext (FILEBOX_ALLOW_INSECURE_HUB=1)"
        );
        return;
    }

    eprintln!(
        "[agent] FATAL: hub URL must use https:// or wss://. Got: {}",
        hub_url
    );
    eprintln!("[agent] Set FILEBOX_ALLOW_INSECURE_HUB=1 to override for local development only.");
    std::process::exit(1);
}

fn is_secure_hub_url(hub_url: &str) -> bool {
    let url = hub_url.trim_start().to_ascii_lowercase();
    url.starts_with("https://") || url.starts_with("wss://")
}

fn allow_insecure_hub() -> bool {
    std::env::var("FILEBOX_ALLOW_INSECURE_HUB")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::is_secure_hub_url;

    #[test]
    fn secure_hub_url_accepts_https_and_wss() {
        assert!(is_secure_hub_url("https://hub.example.com"));
        assert!(is_secure_hub_url("wss://hub.example.com/ws/agent"));
        assert!(is_secure_hub_url(" HTTPS://hub.example.com"));
    }

    #[test]
    fn secure_hub_url_rejects_plaintext_and_missing_scheme() {
        assert!(!is_secure_hub_url("http://hub.example.com"));
        assert!(!is_secure_hub_url("ws://hub.example.com"));
        assert!(!is_secure_hub_url("hub.example.com:3000"));
    }
}
