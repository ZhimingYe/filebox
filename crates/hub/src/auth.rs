use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

use rand::Rng;

use crate::config::{HubConfig, UserConfig};

#[derive(Debug, Clone)]
pub struct Session {
    pub session_id: String,
    pub permissions: Vec<String>,
    pub created_at: u64,
    pub expires_at: u64,
}

impl Session {
    pub fn is_expired(&self) -> bool {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();
        now > self.expires_at
    }
}

pub struct SessionStore {
    sessions: HashMap<String, Session>,
    agent_token_hash: String,
    users: Vec<UserConfig>,
}

impl SessionStore {
    pub fn from_config(config: &HubConfig) -> Self {
        Self {
            sessions: HashMap::new(),
            agent_token_hash: config.agent_token_hash.clone(),
            users: config.users.clone(),
        }
    }

    pub fn validate_login(&self, username: &str, password: &str) -> bool {
        if username.is_empty() || password.is_empty() {
            return false;
        }
        let user = match self.users.iter().find(|u| u.username == username) {
            Some(u) => u,
            None => return false,
        };
        bcrypt::verify(password, &user.password_hash).unwrap_or(false)
    }

    pub fn validate_agent_token(&self, token: &str) -> bool {
        if token.is_empty() {
            return false;
        }
        bcrypt::verify(token, &self.agent_token_hash).unwrap_or(false)
    }

    pub fn create_session(&mut self, _username: &str) -> Session {
        let session_id = generate_session_id();
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();

        let session = Session {
            session_id: session_id.clone(),
            permissions: vec![
                "view_files".to_string(),
                "preview_files".to_string(),
                "manage_roots".to_string(),
                "manage_agent_resources".to_string(),
                "view_health".to_string(),
            ],
            created_at: now,
            expires_at: now + 86400, // 24 hours
        };

        self.sessions.insert(session_id.clone(), session.clone());
        session
    }

    pub fn get_session(&self, session_id: &str) -> Option<&Session> {
        self.sessions.get(session_id).filter(|s| !s.is_expired())
    }

    pub fn remove_expired(&mut self) {
        self.sessions.retain(|_, s| !s.is_expired());
    }
}

fn generate_session_id() -> String {
    let mut rng = rand::rng();
    let mut bytes = [0u8; 32];
    rng.fill(&mut bytes);
    hex::encode(bytes)
}
