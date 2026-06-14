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
    pub fn load() -> Self {
        let config_path = std::env::var("FILEBOX_CONFIG_PATH")
            .unwrap_or_else(|_| "./hub.json".to_string());

        let path = PathBuf::from(&config_path);
        if !path.exists() {
            tracing::warn!(
                "Config file not found at '{}'. Create a hub.json with:\n\
                 {{\n\
                 \x20 \"agent_token_hash\": \"<bcrypt hash of agent token>\",\n\
                 \x20 \"users\": [{{ \"username\": \"admin\", \"password_hash\": \"<bcrypt hash>\" }}]\n\
                 }}",
                config_path
            );
            tracing::warn!("Using insecure defaults — DO NOT use in production.");

            return Self {
                listen_addr: std::env::var("FILEBOX_LISTEN_ADDR")
                    .unwrap_or_else(|_| "0.0.0.0:3000".to_string())
                    .parse()
                    .expect("invalid FILEBOX_LISTEN_ADDR"),
                agent_token_hash: bcrypt::hash("dev-token", 4).unwrap(),
                users: vec![UserConfig {
                    username: "admin".to_string(),
                    password_hash: bcrypt::hash("dev-password", 4).unwrap(),
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

        if config.users.is_empty() {
            tracing::warn!("No users configured in hub.json — nobody will be able to log in.");
        }

        config
    }
}
