use std::net::SocketAddr;
use std::path::PathBuf;
use std::collections::BTreeMap;

use base64::Engine;
use filebox_llm::ProviderConfig;
use filebox_updater::{
    ensure_output_available, prompt_confirmed_secret, prompt_line, prompt_nonempty_secret,
    prompt_yes_no, write_private_file,
};
use rand::RngCore;

const DEFAULT_CONFIG_PATH: &str = "config/hub.json";
const BCRYPT_COST: u32 = 12;

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize)]
pub struct UserConfig {
    pub username: String,
    pub password_hash: String,
}

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize)]
pub struct HubConfig {
    #[serde(skip)]
    pub prompt_review_mode: crate::prompt_review::ReviewMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt_review: Option<PromptReviewConfig>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub llm_providers: BTreeMap<String, ProviderConfig>,
    #[serde(default = "default_listen_addr")]
    pub listen_addr: SocketAddr,
    pub agent_token_hash: String,
    pub users: Vec<UserConfig>,
}

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize)]
#[serde(untagged)]
pub enum PromptReviewConfig {
    Provider(ProviderRef),
    Inline(ProviderConfig),
}

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
pub struct ProviderRef {
    pub provider: String,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub timeout_secs: Option<u64>,
}

fn default_listen_addr() -> SocketAddr {
    "0.0.0.0:3000".parse().unwrap()
}

/// Resolve the hub config path with the same precedence `load` uses. Exposed
/// so other hub subsystems (e.g. the login audit log) can anchor sidecar
/// files next to the config without reimplementing the lookup chain.
pub fn resolve_config_path() -> PathBuf {
    std::env::var("FILEBOX_CONFIG_PATH")
        .ok()
        .filter(|p| !p.is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            PathBuf::from(DEFAULT_CONFIG_PATH)
                .is_file()
                .then(|| PathBuf::from(DEFAULT_CONFIG_PATH))
        })
        .or_else(|| HubConfig::find_default_config().map(PathBuf::from))
        .or_else(|| {
            PathBuf::from("./hub.json")
                .is_file()
                .then(|| PathBuf::from("./hub.json"))
        })
        .unwrap_or_else(|| PathBuf::from(DEFAULT_CONFIG_PATH))
}

impl HubConfig {
    /// Try to find config/hub.json relative to the binary location.
    /// Walks up from the binary directory, looking for config/hub.json.
    fn find_default_config() -> Option<String> {
        let mut dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
        for _ in 0..5 {
            let candidate = dir.join("config/hub.json");
            if candidate.exists() {
                return Some(candidate.to_string_lossy().into_owned());
            }
            if !dir.pop() {
                break;
            }
        }
        None
    }

    pub fn load() -> Self {
        let (prompt_review_mode, invalid_mode) = crate::prompt_review::review_mode(
            std::env::var("FILEBOX_HUB_PROMPT_REVIEW_ENABLED").ok().as_deref());
        if invalid_mode {
            tracing::warn!("Invalid FILEBOX_HUB_PROMPT_REVIEW_ENABLED; prompt review remains mandatory");
        }
        if prompt_review_mode == crate::prompt_review::ReviewMode::Disabled {
            tracing::warn!("prompt review: disabled at startup by FILEBOX_HUB_PROMPT_REVIEW_ENABLED; AI agent prompts will relay without review");
        }
        let path = resolve_config_path();
        if !path.exists() {
            let dev_mode = std::env::var("FILEBOX_DEV_MODE")
                .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
                .unwrap_or(false);

            if !dev_mode {
                eprintln!("[hub] FATAL: config not found: {}", path.display());
                eprintln!("[hub] Run `hub --init-config` or set FILEBOX_CONFIG_PATH.");
                eprintln!("[hub] For local development only, set FILEBOX_DEV_MODE=1 to use insecure defaults bound to 127.0.0.1.");
                std::process::exit(1);
            }

            eprintln!("[hub] WARNING: FILEBOX_DEV_MODE=1 — using insecure dev defaults");
            eprintln!("[hub] WARNING: binding to 127.0.0.1 only — NOT for production");
            eprintln!("[hub] WARNING: dev credentials: admin / dev-password, agent token: dev-token");
            if prompt_review_mode == crate::prompt_review::ReviewMode::Mandatory {
                tracing::info!("prompt review: not configured; AI agent prompts are disabled");
            }

            return Self {
                prompt_review_mode,
                prompt_review: None,
                llm_providers: BTreeMap::new(),
                listen_addr: std::env::var("FILEBOX_LISTEN_ADDR")
                    .unwrap_or_else(|_| "127.0.0.1:3000".to_string())
                    .parse()
                    .expect("invalid FILEBOX_LISTEN_ADDR"),
                agent_token_hash: bcrypt::hash("dev-token", 10).unwrap(),
                users: vec![UserConfig {
                    username: "admin".to_string(),
                    password_hash: bcrypt::hash("dev-password", 10).unwrap(),
                }],
            };
        }

        let contents = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("Failed to read config file '{}': {}", path.display(), e));

        let mut value: serde_json::Value = serde_json::from_str(&contents)
            .unwrap_or_else(|e| panic!("Failed to parse config file '{}': invalid JSON at line {}, column {}", path.display(), e.line(), e.column()));
        if prompt_review_mode == crate::prompt_review::ReviewMode::Disabled {
            if let Some(object) = value.as_object_mut() { object.remove("prompt_review"); }
        }
        let mut config: HubConfig = serde_json::from_value(value)
            .unwrap_or_else(|_| panic!("Failed to parse config file '{}': invalid Hub configuration fields", path.display()));
        for name in config.llm_providers.keys() {
            validate_provider_name(name).unwrap_or_else(|error| panic!("prompt review: {error}"));
        }
        config.prompt_review_mode = prompt_review_mode;
        if prompt_review_mode == crate::prompt_review::ReviewMode::Disabled {
            config.prompt_review = None;
        } else if let Some(provider_name) = config
            .resolve_prompt_review()
            .unwrap_or_else(|error| panic!("prompt review: {error}"))
        {
            if let Some(PromptReviewConfig::Inline(review)) = config.prompt_review.as_ref() {
                tracing::info!(
                    "prompt review: enabled, provider {}, protocol {}, model {}",
                    provider_name,
                    review.protocol.as_str(),
                    review.model
                );
            }
        } else {
            tracing::info!("prompt review: not configured; AI agent prompts are disabled");
        }

        // Allow env override for listen address
        if let Ok(addr) = std::env::var("FILEBOX_LISTEN_ADDR") {
            config.listen_addr = addr.parse().expect("invalid FILEBOX_LISTEN_ADDR");
        }

        eprintln!("[hub] config: {}", path.display());
        eprintln!("[hub] users: {}", config.users.iter().map(|u| u.username.as_str()).collect::<Vec<_>>().join(", "));

        if config.users.is_empty() {
            eprintln!("[hub] WARNING: no users configured — nobody will be able to log in.");
        }

        config
    }

    pub fn resolve_prompt_review(&mut self) -> Result<Option<String>, String> {
        for name in self.llm_providers.keys() {
            validate_provider_name(name)?;
        }
        let Some(prompt_review) = self.prompt_review.take() else {
            return Ok(None);
        };
        match prompt_review {
            PromptReviewConfig::Inline(mut provider) => {
                provider.validate().map_err(str::to_owned)?;
                provider.timeout_secs = provider.timeout_secs.clamp(1, 60);
                self.prompt_review = Some(PromptReviewConfig::Inline(provider));
                Ok(Some("inline".into()))
            }
            PromptReviewConfig::Provider(reference) => {
                validate_provider_name(&reference.provider)?;
                let mut provider = self
                    .llm_providers
                    .get(&reference.provider)
                    .cloned()
                    .ok_or_else(|| format!("unknown llm provider '{}'", reference.provider))?;
                if let Some(model) = reference.model {
                    provider.model = model;
                }
                if let Some(timeout_secs) = reference.timeout_secs {
                    provider.timeout_secs = timeout_secs;
                }
                provider.validate().map_err(str::to_owned)?;
                provider.timeout_secs = provider.timeout_secs.clamp(1, 60);
                self.prompt_review = Some(PromptReviewConfig::Inline(provider));
                Ok(Some(reference.provider))
            }
        }
    }
}

fn validate_provider_name(name: &str) -> Result<(), String> {
    let mut chars = name.chars();
    let valid_first = chars
        .next()
        .is_some_and(|character| character.is_ascii_alphanumeric());
    let valid_rest = chars.all(|character| {
        character.is_ascii_alphanumeric() || character == '_' || character == '-'
    });
    if valid_first && valid_rest && name.len() <= 64 {
        Ok(())
    } else {
        Err(format!("invalid llm provider name '{name}'"))
    }
}

pub fn init_interactive(request: filebox_updater::ConfigInitRequest) -> Result<(), String> {
    let output = request
        .output
        .unwrap_or_else(|| PathBuf::from(DEFAULT_CONFIG_PATH));
    ensure_output_available(&output, request.force)?;

    eprintln!("Filebox Hub configuration");
    eprintln!();

    let listen_addr = loop {
        let value = prompt_line("Listen address", Some("0.0.0.0:3000"))?;
        match value.parse::<SocketAddr>() {
            Ok(addr) => break addr,
            Err(_) => eprintln!("Enter an address such as 0.0.0.0:3000."),
        }
    };

    let username = loop {
        let value = prompt_line("Admin username", Some("admin"))?;
        if value.trim().is_empty() {
            eprintln!("Username cannot be empty.");
        } else {
            break value;
        }
    };

    let password = prompt_confirmed_secret("Admin password", "Confirm admin password")?;
    let auto_token = prompt_yes_no("Generate a random agent token", true)?;
    let agent_token = if auto_token {
        random_agent_token()
    } else {
        prompt_nonempty_secret("Agent token")?
    };

    eprintln!("Generating bcrypt hashes...");
    let config = build_generated_config(
        listen_addr,
        username.clone(),
        &password,
        &agent_token,
        BCRYPT_COST,
    )?;
    let mut json = serde_json::to_string_pretty(&config)
        .map_err(|error| format!("failed to serialize hub config: {error}"))?;
    json.push('\n');
    write_private_file(&output, json.as_bytes(), request.force)?;

    eprintln!();
    eprintln!("Created {}", output.display());
    eprintln!("Admin username: {username}");
    eprintln!("Agent token (save this; it is shown only now): {agent_token}");
    eprintln!("Use the same token when running `agent --init-config`.");
    eprintln!("Run `hub --init-llm` to configure an LLM provider (AI Agents prompts require one).");
    Ok(())
}

fn build_generated_config(
    listen_addr: SocketAddr,
    username: String,
    password: &str,
    agent_token: &str,
    bcrypt_cost: u32,
) -> Result<HubConfig, String> {
    let password_hash = bcrypt::hash(password, bcrypt_cost)
        .map_err(|error| format!("failed to hash admin password: {error}"))?;
    let agent_token_hash = bcrypt::hash(agent_token, bcrypt_cost)
        .map_err(|error| format!("failed to hash agent token: {error}"))?;
    Ok(HubConfig {
        prompt_review_mode: crate::prompt_review::ReviewMode::Mandatory,
        prompt_review: None,
        llm_providers: BTreeMap::new(),
        listen_addr,
        agent_token_hash,
        users: vec![UserConfig {
            username,
            password_hash,
        }],
    })
}

fn random_agent_token() -> String {
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_provider() -> ProviderConfig {
        ProviderConfig {
            protocol: filebox_llm::Protocol::ChatCompletions,
            base_url: "https://api.deepseek.com".into(),
            model: "deepseek-flash".into(),
            api_key: Some("test-key".into()),
            api_key_env: None,
            timeout_secs: 20,
            path: None,
        }
    }

    #[test]
    fn default_listen_addr_binds_to_all_interfaces_port_3000() {
        let addr = default_listen_addr();
        assert_eq!(addr.ip().to_string(), "0.0.0.0");
        assert_eq!(addr.port(), 3000);
    }

    #[test]
    fn hub_config_parses_full_json() {
        let json = r#"{
            "listen_addr": "127.0.0.1:8080",
            "agent_token_hash": "$2b$12$abc",
            "users": [
                {"username": "admin", "password_hash": "$2b$12$xyz"},
                {"username": "alice", "password_hash": "$2b$12$qqq"}
            ]
        }"#;
        let config: HubConfig = serde_json::from_str(json).unwrap();
        assert_eq!(config.listen_addr.port(), 8080);
        assert_eq!(config.agent_token_hash, "$2b$12$abc");
        assert_eq!(config.users.len(), 2);
        assert_eq!(config.users[0].username, "admin");
        assert_eq!(config.users[1].username, "alice");
    }

    #[test]
    fn hub_config_uses_default_listen_addr_when_missing() {
        let json = r#"{
            "agent_token_hash": "$2b$12$abc",
            "users": []
        }"#;
        let config: HubConfig = serde_json::from_str(json).unwrap();
        assert_eq!(config.listen_addr.port(), 3000);
    }

    #[test]
    fn hub_config_accepts_empty_users_list() {
        let json = r#"{
            "agent_token_hash": "$2b$12$abc",
            "users": []
        }"#;
        let config: HubConfig = serde_json::from_str(json).unwrap();
        assert!(config.users.is_empty());
    }

    #[test]
    fn hub_config_rejects_missing_agent_token_hash() {
        let json = r#"{
            "users": []
        }"#;
        let result: Result<HubConfig, _> = serde_json::from_str(json);
        assert!(result.is_err());
    }

    #[test]
    fn hub_config_rejects_missing_users_field() {
        let json = r#"{
            "agent_token_hash": "$2b$12$abc"
        }"#;
        let result: Result<HubConfig, _> = serde_json::from_str(json);
        assert!(result.is_err());
    }

    #[test]
    fn hub_config_supports_ipv6_listen_addr() {
        let json = r#"{
            "listen_addr": "[::1]:3000",
            "agent_token_hash": "x",
            "users": []
        }"#;
        let config: HubConfig = serde_json::from_str(json).unwrap();
        assert!(config.listen_addr.is_ipv6());
    }

    #[test]
    fn user_config_parses_from_json() {
        let json = r#"{"username": "admin", "password_hash": "$2b$12$abc"}"#;
        let user: UserConfig = serde_json::from_str(json).unwrap();
        assert_eq!(user.username, "admin");
        assert_eq!(user.password_hash, "$2b$12$abc");
    }

    #[test]
    fn generated_config_hashes_password_and_agent_token() {
        let config = build_generated_config(
            "127.0.0.1:3000".parse().unwrap(),
            "admin".to_string(),
            "secret-password",
            "secret-token",
            4,
        )
        .unwrap();
        assert!(bcrypt::verify("secret-password", &config.users[0].password_hash).unwrap());
        assert!(bcrypt::verify("secret-token", &config.agent_token_hash).unwrap());
        assert!(!config.users[0].password_hash.contains("secret-password"));

        let json = serde_json::to_string(&config).unwrap();
        let reparsed: HubConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(reparsed.users[0].username, "admin");
    }

    #[test]
    fn generated_agent_tokens_are_random_and_url_safe() {
        let first = random_agent_token();
        let second = random_agent_token();
        assert_ne!(first, second);
        assert!(first.len() >= 40);
        assert!(first
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_'));
    }

    #[test]
    fn provider_reference_resolves_overrides_and_clamps_review_timeout() {
        let mut config: HubConfig = serde_json::from_value(serde_json::json!({
            "prompt_review": {
                "provider": "deepseek",
                "model": "review-model",
                "timeout_secs": 120
            },
            "llm_providers": {
                "deepseek": {
                    "protocol": "chat_completions",
                    "base_url": "https://api.deepseek.com",
                    "model": "deepseek-flash",
                    "api_key": "test-key"
                }
            },
            "agent_token_hash": "hash",
            "users": []
        }))
        .unwrap();

        assert_eq!(
            config.resolve_prompt_review().unwrap().as_deref(),
            Some("deepseek")
        );
        let Some(PromptReviewConfig::Inline(provider)) = config.prompt_review else {
            panic!("provider reference must resolve to inline config");
        };
        assert_eq!(provider.model, "review-model");
        assert_eq!(provider.timeout_secs, 60);
    }

    #[test]
    fn provider_reference_rejects_unknown_name() {
        let mut config = HubConfig {
            prompt_review_mode: crate::prompt_review::ReviewMode::Mandatory,
            prompt_review: Some(PromptReviewConfig::Provider(ProviderRef {
                provider: "missing".into(),
                model: None,
                timeout_secs: None,
            })),
            llm_providers: BTreeMap::new(),
            listen_addr: default_listen_addr(),
            agent_token_hash: "hash".into(),
            users: vec![],
        };
        assert_eq!(
            config.resolve_prompt_review().unwrap_err(),
            "unknown llm provider 'missing'"
        );
    }

    #[test]
    fn invalid_provider_name_is_rejected_at_resolution() {
        let mut config = HubConfig {
            prompt_review_mode: crate::prompt_review::ReviewMode::Mandatory,
            prompt_review: None,
            llm_providers: BTreeMap::from([("bad.name".into(), test_provider())]),
            listen_addr: default_listen_addr(),
            agent_token_hash: "hash".into(),
            users: vec![],
        };
        assert_eq!(
            config.resolve_prompt_review().unwrap_err(),
            "invalid llm provider name 'bad.name'"
        );
    }

    #[test]
    fn legacy_inline_prompt_review_remains_valid_and_is_clamped() {
        let mut provider = test_provider();
        provider.timeout_secs = 90;
        let mut config = HubConfig {
            prompt_review_mode: crate::prompt_review::ReviewMode::Mandatory,
            prompt_review: Some(PromptReviewConfig::Inline(provider)),
            llm_providers: BTreeMap::new(),
            listen_addr: default_listen_addr(),
            agent_token_hash: "hash".into(),
            users: vec![],
        };
        assert_eq!(
            config.resolve_prompt_review().unwrap().as_deref(),
            Some("inline")
        );
        assert!(matches!(
            config.prompt_review,
            Some(PromptReviewConfig::Inline(provider)) if provider.timeout_secs == 60
        ));
    }
}
