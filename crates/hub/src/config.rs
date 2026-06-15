use std::net::SocketAddr;
use std::path::PathBuf;

#[derive(Clone, Debug, serde::Deserialize)]
pub struct UserConfig {
    pub username: String,
    pub password_hash: String,
}

#[derive(Clone, Debug, serde::Deserialize)]
pub struct HubConfig {
    #[serde(default = "default_listen_addr")]
    pub listen_addr: SocketAddr,
    pub agent_token_hash: String,
    pub users: Vec<UserConfig>,
}

fn default_listen_addr() -> SocketAddr {
    "0.0.0.0:3000".parse().unwrap()
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
        let config_path = std::env::var("FILEBOX_CONFIG_PATH")
            .ok()
            .filter(|p| !p.is_empty())
            .or_else(Self::find_default_config)
            .unwrap_or_else(|| "./hub.json".to_string());

        let path = PathBuf::from(&config_path);
        if !path.exists() {
            let dev_mode = std::env::var("FILEBOX_DEV_MODE")
                .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
                .unwrap_or(false);

            if !dev_mode {
                eprintln!("[hub] FATAL: config not found: {}", config_path);
                eprintln!("[hub] Create config/hub.json (use scripts/serve_at_server.sh) or set FILEBOX_CONFIG_PATH.");
                eprintln!("[hub] For local development only, set FILEBOX_DEV_MODE=1 to use insecure defaults bound to 127.0.0.1.");
                std::process::exit(1);
            }

            eprintln!("[hub] WARNING: FILEBOX_DEV_MODE=1 — using insecure dev defaults");
            eprintln!("[hub] WARNING: binding to 127.0.0.1 only — NOT for production");
            eprintln!("[hub] WARNING: dev credentials: admin / dev-password, agent token: dev-token");

            return Self {
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
            .unwrap_or_else(|e| panic!("Failed to read config file '{}': {}", config_path, e));

        let mut config: HubConfig = serde_json::from_str(&contents)
            .unwrap_or_else(|e| panic!("Failed to parse config file '{}': {}", config_path, e));

        // Allow env override for listen address
        if let Ok(addr) = std::env::var("FILEBOX_LISTEN_ADDR") {
            config.listen_addr = addr.parse().expect("invalid FILEBOX_LISTEN_ADDR");
        }

        eprintln!("[hub] config: {}", config_path);
        eprintln!("[hub] users: {}", config.users.iter().map(|u| u.username.as_str()).collect::<Vec<_>>().join(", "));

        if config.users.is_empty() {
            eprintln!("[hub] WARNING: no users configured — nobody will be able to log in.");
        }

        config
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
