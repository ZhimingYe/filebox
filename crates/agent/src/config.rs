use std::path::PathBuf;

use filebox_updater::{
    ensure_output_available, prompt_line, prompt_nonempty_secret, prompt_yes_no, write_private_file,
};

const DEFAULT_CONFIG_PATH: &str = "agent.toml";

/// Directory / path-component names skipped by Workspace Search by default.
/// These are dependency / virtualenv trees that drown out project files.
/// Override with `search_ignore` in agent.toml or `FILEBOX_AGENT_SEARCH_IGNORE`.
pub const DEFAULT_SEARCH_IGNORE: &[&str] = &[
    "renv",
    "packrat",
    "venv",
    ".venv",
    "node_modules",
    "__pycache__",
    "site-packages",
    ".tox",
    ".nox",
    "target",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
    ".cache",
    "bower_components",
    ".parcel-cache",
    ".turbo",
    ".bundle",
    ".gradle",
    ".pixi",
];

#[derive(Debug, serde::Deserialize, serde::Serialize)]
struct TomlConfig {
    hub: Option<String>,
    token: Option<String>,
    name: Option<String>,
    data_dir: Option<String>,
    /// Path-component names to skip during Workspace Search.
    /// When omitted, [`DEFAULT_SEARCH_IGNORE`] is used. Set to `[]` to disable
    /// name-based ignores (`.gitignore` may still apply).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    search_ignore: Option<Vec<String>>,
    /// When true (default), Workspace Search honors `.gitignore` / `.ignore`
    /// / `.git/info/exclude` under the search tree.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    search_gitignore: Option<bool>,
}

pub struct AgentConfig {
    pub hub_url: String,
    pub token: String,
    pub agent_name: String,
    pub data_dir: PathBuf,
    /// Effective path-component names skipped by Workspace Search.
    pub search_ignore: Vec<String>,
    /// Whether Workspace Search should honor gitignore-style ignore files.
    pub search_gitignore: bool,
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
                search_ignore: None,
                search_gitignore: None,
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

        let search_ignore = resolve_search_ignore(
            std::env::var("FILEBOX_AGENT_SEARCH_IGNORE").ok(),
            toml_config.search_ignore,
        );
        let search_gitignore = resolve_search_gitignore(
            std::env::var("FILEBOX_AGENT_SEARCH_GITIGNORE").ok(),
            toml_config.search_gitignore,
        );

        enforce_secure_hub_url(&hub_url);

        Self {
            hub_url,
            token,
            agent_name,
            data_dir,
            search_ignore,
            search_gitignore,
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
        // Emit defaults so operators can edit the list without hunting docs.
        search_ignore: Some(
            DEFAULT_SEARCH_IGNORE
                .iter()
                .map(|s| (*s).to_string())
                .collect(),
        ),
        search_gitignore: Some(true),
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

/// Resolve the effective search-ignore name list.
///
/// Env (`FILEBOX_AGENT_SEARCH_IGNORE`, comma-separated) wins over toml.
/// When neither is set, [`DEFAULT_SEARCH_IGNORE`] applies. An explicit empty
/// list (`[]` / `""`) disables name-based ignores.
fn resolve_search_ignore(env: Option<String>, toml: Option<Vec<String>>) -> Vec<String> {
    if let Some(raw) = env {
        return normalize_ignore_names(raw.split(',').map(|s| s.to_string()));
    }
    if let Some(list) = toml {
        return normalize_ignore_names(list);
    }
    DEFAULT_SEARCH_IGNORE
        .iter()
        .map(|s| (*s).to_string())
        .collect()
}

fn normalize_ignore_names<I>(names: I) -> Vec<String>
where
    I: IntoIterator<Item = String>,
{
    let mut out = Vec::new();
    for name in names {
        let trimmed = name.trim();
        if trimmed.is_empty() {
            continue;
        }
        // Operators may write "venv/" or "/venv"; strip path punctuation so
        // matching stays a simple path-component compare.
        let cleaned = trimmed.trim_matches(['/', '\\']);
        if cleaned.is_empty() || cleaned.contains('/') || cleaned.contains('\\') {
            continue;
        }
        if !out.iter().any(|existing: &String| existing.eq_ignore_ascii_case(cleaned)) {
            out.push(cleaned.to_string());
        }
    }
    out
}

fn resolve_search_gitignore(env: Option<String>, toml: Option<bool>) -> bool {
    if let Some(raw) = env {
        let v = raw.trim();
        return !(v == "0" || v.eq_ignore_ascii_case("false") || v.eq_ignore_ascii_case("off"));
    }
    toml.unwrap_or(true)
}

#[cfg(test)]
mod tests {
    use super::{
        is_secure_hub_url, normalize_ignore_names, resolve_search_gitignore, resolve_search_ignore,
        TomlConfig, DEFAULT_SEARCH_IGNORE,
    };

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
            search_ignore: Some(vec!["renv".into(), "venv".into()]),
            search_gitignore: Some(true),
        };
        let contents = toml::to_string_pretty(&config).unwrap();
        let reparsed: TomlConfig = toml::from_str(&contents).unwrap();
        assert_eq!(reparsed.hub.as_deref(), Some("https://hub.example.com"));
        assert_eq!(reparsed.token.as_deref(), Some("secret-token"));
        assert_eq!(reparsed.name.as_deref(), Some("Lab Server"));
        assert_eq!(reparsed.data_dir.as_deref(), Some("/var/lib/filebox"));
        assert_eq!(
            reparsed.search_ignore.as_deref(),
            Some(["renv".to_string(), "venv".to_string()].as_slice())
        );
        assert_eq!(reparsed.search_gitignore, Some(true));
    }

    #[test]
    fn search_ignore_defaults_when_unset() {
        let names = resolve_search_ignore(None, None);
        assert_eq!(names.len(), DEFAULT_SEARCH_IGNORE.len());
        assert!(names.iter().any(|n| n == "renv"));
        assert!(names.iter().any(|n| n == "venv"));
    }

    #[test]
    fn search_ignore_env_overrides_toml_and_empty_disables() {
        let from_toml = resolve_search_ignore(None, Some(vec!["custom".into()]));
        assert_eq!(from_toml, vec!["custom".to_string()]);

        let from_env = resolve_search_ignore(
            Some("renv, venv/".into()),
            Some(vec!["custom".into()]),
        );
        assert_eq!(from_env, vec!["renv".to_string(), "venv".to_string()]);

        let empty = resolve_search_ignore(Some("".into()), Some(vec!["custom".into()]));
        assert!(empty.is_empty());
        assert!(normalize_ignore_names(vec!["  ".into(), "/".into()]).is_empty());
    }

    #[test]
    fn search_gitignore_defaults_true_and_env_can_disable() {
        assert!(resolve_search_gitignore(None, None));
        assert!(!resolve_search_gitignore(None, Some(false)));
        assert!(!resolve_search_gitignore(Some("0".into()), Some(true)));
        assert!(!resolve_search_gitignore(Some("false".into()), None));
        assert!(resolve_search_gitignore(Some("1".into()), Some(false)));
    }
}
