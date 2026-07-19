use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

use rand::Rng;

use crate::config::{HubConfig, UserConfig};

const DUMMY_PASSWORD_HASH: &str =
    "$2b$12$q1INUl06TNwuYvDsl1BFi.FVTvhaNO9PChqUbn6SjdqdMN6V2NiG.";

#[derive(Debug, Clone)]
pub struct Session {
    pub session_id: String,
    /// Synchronizer token for CSRF defense. Sent to the browser as a
    /// non-HttpOnly cookie + login JSON; must be echoed on API requests via
    /// the `X-CSRF-Token` header. Headerless GETs use short-lived access tokens
    /// instead — never put this value in a URL query string.
    pub csrf_token: String,
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
    dummy_password_hash: String,
}

impl SessionStore {
    pub fn from_config(config: &HubConfig) -> Self {
        Self {
            sessions: HashMap::new(),
            agent_token_hash: config.agent_token_hash.clone(),
            users: config.users.clone(),
            dummy_password_hash: DUMMY_PASSWORD_HASH.to_string(),
        }
    }

    pub fn validate_login(&self, username: &str, password: &str) -> bool {
        let (hash, real_user) = match self.users.iter().find(|u| u.username == username) {
            Some(u) => (u.password_hash.as_str(), true),
            None => (self.dummy_password_hash.as_str(), false),
        };
        bcrypt::verify(password, hash).unwrap_or(false) && real_user
    }

    pub fn validate_agent_token(&self, token: &str) -> bool {
        if token.is_empty() {
            return false;
        }
        bcrypt::verify(token, &self.agent_token_hash).unwrap_or(false)
    }

    pub fn create_session(&mut self, _username: &str, remember: bool) -> (Session, u64) {
        let session_id = generate_session_id();
        let csrf_token = generate_session_id();
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();

        let ttl: u64 = if remember { 30 * 86400 } else { 86400 };

        let session = Session {
            session_id: session_id.clone(),
            csrf_token,
            permissions: vec![
                "view_files".to_string(),
                "preview_files".to_string(),
                "manage_roots".to_string(),
                "manage_agent_resources".to_string(),
                "view_health".to_string(),
            ],
            created_at: now,
            expires_at: now + ttl,
        };

        self.sessions.insert(session_id.clone(), session.clone());
        (session, ttl)
    }

    pub fn get_session(&self, session_id: &str) -> Option<&Session> {
        self.sessions.get(session_id).filter(|s| !s.is_expired())
    }

    pub fn get_session_rotating(&mut self, session_id: &str) -> Option<(Session, Option<(String, u64)>)> {
        let current = self.sessions.get(session_id).filter(|s| !s.is_expired())?.clone();
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let total = current.expires_at.saturating_sub(current.created_at);
        let remaining = current.expires_at.saturating_sub(now);

        if total > 0 && remaining > 0 && remaining.saturating_mul(2) < total {
            let new_id = generate_session_id();
            // Keep the CSRF token across session-id rotation so open tabs that
            // already hold the synchronizer (header / readable cookie) keep
            // working. GET access tokens are rebound separately in middleware.
            let new_session = Session {
                session_id: new_id.clone(),
                csrf_token: current.csrf_token.clone(),
                permissions: current.permissions.clone(),
                created_at: now,
                expires_at: current.expires_at,
            };
            self.sessions.remove(session_id);
            self.sessions.insert(new_id.clone(), new_session.clone());
            return Some((new_session, Some((new_id, remaining))));
        }

        Some((current, None))
    }

    pub fn remove(&mut self, session_id: &str) {
        self.sessions.remove(session_id);
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{HubConfig, UserConfig};

    fn make_store(users: Vec<(&str, &str)>, agent_hash: &str) -> SessionStore {
        let config = HubConfig {
            listen_addr: "0.0.0.0:3000".parse().unwrap(),
            agent_token_hash: agent_hash.to_string(),
            users: users
                .into_iter()
                .map(|(u, p)| UserConfig {
                    username: u.to_string(),
                    password_hash: p.to_string(),
                })
                .collect(),
        };
        SessionStore::from_config(&config)
    }

    fn make_store_with_real_password(
        username: &str,
        password: &str,
        agent_token: &str,
    ) -> SessionStore {
        let hash = bcrypt::hash(password, 4).unwrap();
        let agent_hash = bcrypt::hash(agent_token, 4).unwrap();
        make_store(vec![(username, &hash)], &agent_hash)
    }

    #[test]
    fn validate_login_accepts_correct_password() {
        let store = make_store_with_real_password("admin", "hunter2", "agenttok");
        assert!(store.validate_login("admin", "hunter2"));
    }

    #[test]
    fn validate_login_rejects_wrong_password() {
        let store = make_store_with_real_password("admin", "hunter2", "agenttok");
        assert!(!store.validate_login("admin", "wrong"));
    }

    #[test]
    fn validate_login_rejects_unknown_user() {
        let store = make_store_with_real_password("admin", "hunter2", "agenttok");
        assert!(!store.validate_login("nobody", "hunter2"));
    }

    #[test]
    fn validate_login_rejects_empty_inputs() {
        let store = make_store_with_real_password("admin", "hunter2", "agenttok");
        assert!(!store.validate_login("", "hunter2"));
        assert!(!store.validate_login("admin", ""));
        assert!(!store.validate_login("", ""));
    }

    #[test]
    fn validate_agent_token_accepts_correct_token() {
        let store = make_store_with_real_password("admin", "pw", "my-agent-tok");
        assert!(store.validate_agent_token("my-agent-tok"));
    }

    #[test]
    fn validate_agent_token_rejects_wrong_token() {
        let store = make_store_with_real_password("admin", "pw", "real-tok");
        assert!(!store.validate_agent_token("wrong-tok"));
    }

    #[test]
    fn validate_agent_token_rejects_empty_token() {
        let store = make_store_with_real_password("admin", "pw", "real-tok");
        assert!(!store.validate_agent_token(""));
    }

    #[test]
    fn validate_login_returns_false_on_malformed_hash() {
        // Should never panic — must return false on garbage input
        let store = make_store(vec![("admin", "not-a-real-hash")], "agent-hash");
        assert!(!store.validate_login("admin", "anything"));
    }

    #[test]
    fn create_session_without_remember_has_24h_ttl() {
        let mut store = make_store_with_real_password("admin", "pw", "tok");
        let (session, ttl) = store.create_session("admin", false);
        assert_eq!(ttl, 86400);
        assert!(session.expires_at > session.created_at);
        assert!(!session.is_expired());
    }

    #[test]
    fn create_session_with_remember_has_30d_ttl() {
        let mut store = make_store_with_real_password("admin", "pw", "tok");
        let (_session, ttl) = store.create_session("admin", true);
        assert_eq!(ttl, 30 * 86400);
    }

    #[test]
    fn create_session_returns_unique_session_ids() {
        let mut store = make_store_with_real_password("admin", "pw", "tok");
        let (s1, _) = store.create_session("admin", false);
        let (s2, _) = store.create_session("admin", false);
        assert_ne!(s1.session_id, s2.session_id);
        // 32 bytes hex-encoded = 64 chars
        assert_eq!(s1.session_id.len(), 64);
    }

    #[test]
    fn get_session_returns_some_for_active_session() {
        let mut store = make_store_with_real_password("admin", "pw", "tok");
        let (session, _) = store.create_session("admin", false);
        let sid = session.session_id.clone();
        assert!(store.get_session(&sid).is_some());
    }

    #[test]
    fn get_session_returns_none_for_unknown_id() {
        let store = make_store_with_real_password("admin", "pw", "tok");
        assert!(store.get_session("nonexistent").is_none());
    }

    #[test]
    fn get_session_rotating_preserves_active_session_before_half_life() {
        let mut store = make_store_with_real_password("admin", "pw", "tok");
        let (session, _) = store.create_session("admin", false);
        let sid = session.session_id.clone();

        let (rotated, new_cookie) = store.get_session_rotating(&sid).unwrap();

        assert_eq!(rotated.session_id, sid);
        assert!(new_cookie.is_none());
    }

    #[test]
    fn get_session_rotating_reissues_id_after_half_life() {
        let mut store = make_store_with_real_password("admin", "pw", "tok");
        let session_id = "old-session-id".to_string();
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();
        store.sessions.insert(
            session_id.clone(),
            Session {
                session_id: session_id.clone(),
                csrf_token: "csrf-old".to_string(),
                permissions: vec!["view_files".to_string()],
                created_at: now.saturating_sub(80),
                expires_at: now + 20,
            },
        );

        let (rotated, new_cookie) = store.get_session_rotating(&session_id).unwrap();

        assert_ne!(rotated.session_id, session_id);
        assert!(store.get_session(&session_id).is_none());
        assert!(store.get_session(&rotated.session_id).is_some());
        assert_eq!(new_cookie.unwrap().0, rotated.session_id);
        assert_eq!(rotated.csrf_token, "csrf-old");
    }

    #[test]
    fn create_session_issues_csrf_token_distinct_from_session_id() {
        let mut store = make_store_with_real_password("admin", "pw", "tok");
        let (session, _) = store.create_session("admin", false);
        assert_eq!(session.csrf_token.len(), 64);
        assert_ne!(session.csrf_token, session.session_id);
    }

    #[test]
    fn get_session_returns_none_for_expired_session() {
        let mut store = make_store_with_real_password("admin", "pw", "tok");
        // Manually insert an expired session
        let session_id = "expired-test-id".to_string();
        let past = 1u64; // unix epoch + 1s = always expired
        store.sessions.insert(
            session_id.clone(),
            Session {
                session_id: session_id.clone(),
                csrf_token: "csrf-test".to_string(),
                permissions: vec![],
                created_at: 0,
                expires_at: past,
            },
        );
        assert!(store.get_session(&session_id).is_none());
    }

    #[test]
    fn session_is_expired_when_expires_at_in_past() {
        let s = Session {
            session_id: "x".to_string(),
            csrf_token: "csrf-test".to_string(),
            permissions: vec![],
            created_at: 0,
            expires_at: 1, // epoch + 1s = past
        };
        assert!(s.is_expired());
    }

    #[test]
    fn session_is_not_expired_when_expires_at_in_future() {
        let future = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs()
            + 3600;
        let s = Session {
            session_id: "x".to_string(),
            csrf_token: "csrf-test".to_string(),
            permissions: vec![],
            created_at: 0,
            expires_at: future,
        };
        assert!(!s.is_expired());
    }

    #[test]
    fn session_permissions_includes_required_scopes() {
        let mut store = make_store_with_real_password("admin", "pw", "tok");
        let (session, _) = store.create_session("admin", false);
        assert!(session.permissions.contains(&"view_files".to_string()));
        assert!(session.permissions.contains(&"preview_files".to_string()));
        assert!(session.permissions.contains(&"manage_roots".to_string()));
        assert!(
            session
                .permissions
                .contains(&"manage_agent_resources".to_string())
        );
        assert!(session.permissions.contains(&"view_health".to_string()));
    }

    #[test]
    fn remove_expired_clears_only_expired_sessions() {
        let mut store = make_store_with_real_password("admin", "pw", "tok");

        // Insert an active session
        let (active, _) = store.create_session("admin", false);
        let active_id = active.session_id.clone();

        // Insert an expired session directly
        let expired_id = "expired-id".to_string();
        store.sessions.insert(
            expired_id.clone(),
            Session {
                session_id: expired_id.clone(),
                csrf_token: "csrf-test".to_string(),
                permissions: vec![],
                created_at: 0,
                expires_at: 1,
            },
        );

        store.remove_expired();

        assert!(store.get_session(&active_id).is_some());
        assert!(store.get_session(&expired_id).is_none());
    }

    #[test]
    fn remove_deletes_active_session() {
        let mut store = make_store_with_real_password("admin", "pw", "tok");
        let (session, _) = store.create_session("admin", false);
        let sid = session.session_id.clone();

        store.remove(&sid);

        assert!(store.get_session(&sid).is_none());
    }

    #[test]
    fn from_config_preserves_all_users() {
        let h1 = bcrypt::hash("p1", 4).unwrap();
        let h2 = bcrypt::hash("p2", 4).unwrap();
        let store = make_store(
            vec![("u1", h1.as_str()), ("u2", h2.as_str())],
            "agent-hash",
        );
        assert!(store.validate_login("u1", "p1"));
        assert!(store.validate_login("u2", "p2"));
        assert!(!store.validate_login("u1", "p2"));
    }
}
