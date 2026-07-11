use std::path::PathBuf;

use filebox_updater::{
    ensure_output_available, prompt_line, prompt_nonempty_secret, prompt_yes_no, write_private_file,
};

const DEFAULT_CONFIG_PATH: &str = "agent.toml";

#[derive(Debug, serde::Deserialize, serde::Serialize)]
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
                "Agent config file not found at '{}'. Run `agent --init-config` to create it.",
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

pub fn init_interactive(request: filebox_updater::ConfigInitRequest) -> Result<(), String> {
    let output = request
        .output
        .unwrap_or_else(|| PathBuf::from(DEFAULT_CONFIG_PATH));
    ensure_output_available(&output, request.force)?;

    eprintln!("Filebox Agent configuration");
    eprintln!();

    let (hub_url, insecure) = loop {
        let value = prompt_line("Hub URL", Some("https://hub.example.com"))?;
        if is_secure_hub_url(&value) {
            break (value.trim_end_matches('/').to_string(), false);
        }
        let lower = value.trim_start().to_ascii_lowercase();
        if lower.starts_with("http://") || lower.starts_with("ws://") {
            if prompt_yes_no("Use plaintext for local development", false)? {
                break (value.trim_end_matches('/').to_string(), true);
            }
        } else {
            eprintln!("URL must start with https:// or wss://.");
        }
    };

    let token = prompt_nonempty_secret("Agent token")?;
    let default_name = std::env::var("HOSTNAME")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| std::env::var("COMPUTERNAME").ok())
        .unwrap_or_else(|| "default-agent".to_string());
    let name = prompt_line("Agent name", Some(&default_name))?;
    let default_data_dir = dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("filebox");
    let data_dir_input = prompt_line(
        "Data directory",
        Some(default_data_dir.to_string_lossy().as_ref()),
    )?;
    let data_dir = expand_home(&data_dir_input);

    let config = TomlConfig {
        hub: Some(hub_url),
        token: Some(token),
        name: Some(name),
        data_dir: Some(data_dir.to_string_lossy().into_owned()),
    };
    let mut contents = toml::to_string_pretty(&config)
        .map_err(|error| format!("failed to serialize agent config: {error}"))?;
    if insecure {
        contents = format!(
            "# WARNING: start with FILEBOX_ALLOW_INSECURE_HUB=1 for this plaintext URL.\n{contents}"
        );
    }
    write_private_file(&output, contents.as_bytes(), request.force)?;

    eprintln!();
    eprintln!("Created {}", output.display());
    if insecure {
        eprintln!("Plaintext URL selected; start with FILEBOX_ALLOW_INSECURE_HUB=1.");
    }
    Ok(())
}

fn expand_home(value: &str) -> PathBuf {
    if value == "~" {
        return dirs::home_dir().unwrap_or_else(|| PathBuf::from(value));
    }
    if let Some(rest) = value.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest);
        }
    }
    PathBuf::from(value)
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
    use super::{is_secure_hub_url, TomlConfig};

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

    #[test]
    fn generated_toml_round_trips_all_fields() {
        let config = TomlConfig {
            hub: Some("https://hub.example.com".to_string()),
            token: Some("secret-token".to_string()),
            name: Some("Lab Server".to_string()),
            data_dir: Some("/var/lib/filebox".to_string()),
        };
        let contents = toml::to_string_pretty(&config).unwrap();
        let reparsed: TomlConfig = toml::from_str(&contents).unwrap();
        assert_eq!(reparsed.hub.as_deref(), Some("https://hub.example.com"));
        assert_eq!(reparsed.token.as_deref(), Some("secret-token"));
        assert_eq!(reparsed.name.as_deref(), Some("Lab Server"));
        assert_eq!(reparsed.data_dir.as_deref(), Some("/var/lib/filebox"));
    }
}
