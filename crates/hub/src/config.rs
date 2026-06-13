use std::net::SocketAddr;
use std::path::PathBuf;

pub struct Config {
    pub listen_addr: SocketAddr,
    pub session_key: String,
    pub db_path: PathBuf,
}

impl Config {
    pub fn from_env() -> Self {
        let listen_addr: SocketAddr = std::env::var("FILEBOX_LISTEN_ADDR")
            .unwrap_or_else(|_| "0.0.0.0:3000".to_string())
            .parse()
            .expect("invalid FILEBOX_LISTEN_ADDR");

        let session_key = std::env::var("FILEBOX_SESSION_KEY")
            .unwrap_or_else(|_| "dev-session-key".to_string());

        let db_path = std::env::var("FILEBOX_DB_PATH")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("./data/hub.db"));

        Self {
            listen_addr,
            session_key,
            db_path,
        }
    }
}
