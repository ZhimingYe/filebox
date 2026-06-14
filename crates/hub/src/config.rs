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
            eprintln!("[hub] WARNING: config not found: {}", config_path);
            eprintln!("[hub] WARNING: using dev defaults (user: admin, password: dev-password) — NOT for production");
            eprintln!("[hub] WARNING: create config/hub.json or set FILEBOX_CONFIG_PATH for production use");

            return Self {
                listen_addr: std::env::var("FILEBOX_LISTEN_ADDR")
                    .unwrap_or_else(|_| "0.0.0.0:3000".to_string())
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
