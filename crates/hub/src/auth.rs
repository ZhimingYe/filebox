use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

use rand::Rng;

use crate::config::{HubConfig, UserConfig};

const DUMMY_PASSWORD_HASH: &str =
    "$2b$12$q1INUl06TNwuYvDsl1BFi.FVTvhaNO9PChqUbn6SjdqdMN6V2NiG.";

/// After session-id rotation, keep the previous id valid briefly so in-flight
/// parallel requests and long-lived SSE checks that still carry the old cookie
/// do not get `session_expired`. Long enough to cover the SSE 30s validity
/// poll plus a slow client catching up on `Set-Cookie`.
const SESSION_ROTATION_GRACE_SECS: u64 = 120;

#[derive(Debug, Clone)]
pub struct Session {
    /// Rotating cookie value (`filebox_session` / `__Host-filebox_session`).
    pub session_id: String,
    /// Stable for the life of the login. Used for cancel ownership, preview
    /// ownership, and SSE liveness so cookie-id rotation cannot orphan work.
    pub principal_id: String,
    /// Synchronizer token for CSRF defense. Sent to the browser as a
    /// non-HttpOnly cookie + login JSON; must be echoed on API requests via
    /// the `X-CSRF-Token` header. Headerless GETs use short-lived access tokens
    /// instead — never put this value in a URL query string.
    pub csrf_token: String,
    pub permissions: Vec<String>,
    pub created_at: u64,
    pub expires_at: u64,
    /// Original TTL used for sliding renewal on activity.
    pub ttl_secs: u64,
}

impl Session {
    pub fn is_expired(&self) -> bool {
        now_secs() > self.expires_at
    }
}

/// Browser must update cookies when present.
#[derive(Debug, Clone)]
pub struct SessionCookieRefresh {
    pub session_id: String,
    pub csrf_token: String,
    pub max_age: u64,
}

#[derive(Debug, Clone)]
struct RotationGrace {
    /// Id of the live session this retired id maps to.
    current_id: String,
    /// Unix seconds when this alias stops authenticating.
    expires_at: u64,
}

pub struct SessionStore {
    sessions: HashMap<String, Session>,
    /// Retired session ids → current id, for a short post-rotation window.
    rotation_grace: HashMap<String, RotationGrace>,
    agent_token_hash: String,
    users: Vec<UserConfig>,
    dummy_password_hash: String,
}

impl SessionStore {
    pub fn from_config(config: &HubConfig) -> Self {
        Self {
            sessions: HashMap::new(),
            rotation_grace: HashMap::new(),
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
        let principal_id = generate_session_id();
        let csrf_token = generate_session_id();
        let now = now_secs();

        let ttl: u64 = if remember { 30 * 86400 } else { 86400 };

        let session = Session {
            session_id: session_id.clone(),
            principal_id,
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
            ttl_secs: ttl,
        };

        self.sessions.insert(session_id.clone(), session.clone());
        (session, ttl)
    }

    /// Read-only lookup (resolves rotation grace aliases). Never mutates
    /// session ids — safe to call before CSRF validation.
    pub fn get_session(&self, session_id: &str) -> Option<&Session> {
        let now = now_secs();
        let live_id = self.resolve_live_id(session_id, now)?;
        self.sessions.get(live_id).filter(|s| !s.is_expired())
    }

    pub fn get_session_by_principal(&self, principal_id: &str) -> Option<&Session> {
        self.sessions
            .values()
            .find(|s| s.principal_id == principal_id && !s.is_expired())
    }

    /// Call **only after** CSRF has been validated. Past half-life this:
    /// 1. slides `expires_at` forward by a full `ttl_secs` (active users stay signed in),
    /// 2. rotates the cookie session id (with grace for in-flight stale cookies),
    /// 3. returns `Set-Cookie` material for both session + CSRF Max-Age.
    ///
    /// Presenting a grace alias always re-issues the live cookie without a
    /// second rotation.
    pub fn refresh_session_after_auth(
        &mut self,
        session_id: &str,
    ) -> Option<(Session, Option<SessionCookieRefresh>)> {
        let now = now_secs();
        self.purge_expired_grace(now);

        let live_id = self.resolve_live_id(session_id, now)?.to_string();
        let presented_retired = live_id != session_id;

        let current = self.sessions.get(&live_id).filter(|s| !s.is_expired())?.clone();
        let total = current.expires_at.saturating_sub(current.created_at);
        let remaining = current.expires_at.saturating_sub(now);

        if total > 0 && remaining > 0 && remaining.saturating_mul(2) < total {
            let new_id = generate_session_id();
            let new_expires = now.saturating_add(current.ttl_secs.max(1));
            let new_session = Session {
                session_id: new_id.clone(),
                principal_id: current.principal_id.clone(),
                // Keep CSRF across cookie-id rotation so open tabs that already hold
                // the synchronizer (header / readable cookie) keep working.
                // GET access tokens are bound to principal_id, not cookie id.
                csrf_token: current.csrf_token.clone(),
                permissions: current.permissions.clone(),
                created_at: now,
                expires_at: new_expires,
                ttl_secs: current.ttl_secs,
            };
            self.sessions.remove(&live_id);
            self.sessions.insert(new_id.clone(), new_session.clone());
            self.record_rotation_grace(&live_id, &new_id, now);
            let refresh = SessionCookieRefresh {
                session_id: new_id,
                csrf_token: new_session.csrf_token.clone(),
                max_age: current.ttl_secs,
            };
            return Some((new_session, Some(refresh)));
        }

        if presented_retired {
            let refresh = SessionCookieRefresh {
                session_id: live_id,
                csrf_token: current.csrf_token.clone(),
                max_age: remaining.max(1),
            };
            return Some((current, Some(refresh)));
        }

        Some((current, None))
    }

    pub fn remove(&mut self, session_id: &str) {
        // Logout may present either the live id or a still-valid grace alias.
        let now = now_secs();
        let live_id = self
            .resolve_live_id(session_id, now)
            .unwrap_or(session_id)
            .to_string();
        let principal = self
            .sessions
            .get(&live_id)
            .map(|s| s.principal_id.clone());
        self.sessions.remove(&live_id);
        self.sessions.remove(session_id);
        if let Some(principal_id) = principal {
            self.sessions
                .retain(|_, s| s.principal_id != principal_id);
        }
        self.rotation_grace
            .retain(|old, g| old.as_str() != session_id && old.as_str() != live_id && g.current_id != live_id);
    }

    pub fn remove_expired(&mut self) {
        let now = now_secs();
        self.sessions.retain(|_, s| !s.is_expired());
        self.purge_expired_grace(now);
        self.rotation_grace
            .retain(|_, g| self.sessions.contains_key(&g.current_id));
    }

    fn resolve_live_id<'a>(&'a self, session_id: &'a str, now: u64) -> Option<&'a str> {
        if self.sessions.contains_key(session_id) {
            return Some(session_id);
        }
        let mut current = session_id;
        for _ in 0..4 {
            let grace = self.rotation_grace.get(current)?;
            if grace.expires_at <= now {
                return None;
            }
            if self.sessions.contains_key(&grace.current_id) {
                return Some(grace.current_id.as_str());
            }
            current = grace.current_id.as_str();
        }
        None
    }

    fn record_rotation_grace(&mut self, old_id: &str, new_id: &str, now: u64) {
        let grace_expires = now.saturating_add(SESSION_ROTATION_GRACE_SECS);
        for entry in self.rotation_grace.values_mut() {
            if entry.current_id == old_id {
                entry.current_id = new_id.to_string();
                entry.expires_at = grace_expires;
            }
        }
        self.rotation_grace.insert(
            old_id.to_string(),
            RotationGrace {
                current_id: new_id.to_string(),
                expires_at: grace_expires,
            },
        );
    }

    fn purge_expired_grace(&mut self, now: u64) {
        self.rotation_grace.retain(|_, g| g.expires_at > now);
    }
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
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

    fn past_half_life_session(session_id: &str, now: u64) -> Session {
        Session {
            session_id: session_id.to_string(),
            principal_id: "principal-1".to_string(),
            csrf_token: "csrf-old".to_string(),
            permissions: vec!["view_files".to_string()],
            created_at: now.saturating_sub(80),
            expires_at: now + 20,
            ttl_secs: 100,
        }
    }

    #[test]
    fn refresh_preserves_active_session_before_half_life() {
        let mut store = make_store_with_real_password("admin", "pw", "tok");
        let (session, _) = store.create_session("admin", false);
        let sid = session.session_id.clone();
        let principal = session.principal_id.clone();

        let (refreshed, new_cookie) = store.refresh_session_after_auth(&sid).unwrap();

        assert_eq!(refreshed.session_id, sid);
        assert_eq!(refreshed.principal_id, principal);
        assert!(new_cookie.is_none());
    }

    #[test]
    fn refresh_rotates_id_and_slides_expiry_after_half_life() {
        let mut store = make_store_with_real_password("admin", "pw", "tok");
        let session_id = "old-session-id".to_string();
        let now = now_secs();
        store
            .sessions
            .insert(session_id.clone(), past_half_life_session(&session_id, now));

        let (rotated, new_cookie) = store.refresh_session_after_auth(&session_id).unwrap();

        assert_ne!(rotated.session_id, session_id);
        assert_eq!(rotated.principal_id, "principal-1");
        // Old id stays resolvable during the grace window (parallel requests / SSE).
        assert!(store.get_session(&session_id).is_some());
        assert_eq!(
            store.get_session(&session_id).unwrap().session_id,
            rotated.session_id
        );
        assert!(store.get_session(&rotated.session_id).is_some());
        let refresh = new_cookie.unwrap();
        assert_eq!(refresh.session_id, rotated.session_id);
        assert_eq!(refresh.csrf_token, "csrf-old");
        assert_eq!(refresh.max_age, 100);
        // Sliding renewal: active use gets a full TTL from now.
        assert!(rotated.expires_at >= now + 100);
        assert!(store.get_session_by_principal("principal-1").is_some());
    }

    #[test]
    fn refresh_reissues_cookie_for_grace_alias_without_re_rotating() {
        let mut store = make_store_with_real_password("admin", "pw", "tok");
        let session_id = "old-session-id".to_string();
        let now = now_secs();
        store
            .sessions
            .insert(session_id.clone(), past_half_life_session(&session_id, now));

        let (rotated, first_cookie) = store.refresh_session_after_auth(&session_id).unwrap();
        assert!(first_cookie.is_some());

        // A concurrent request still presenting the old cookie must succeed and
        // receive Set-Cookie for the live id — not session_expired.
        let (again, upgrade_cookie) = store.refresh_session_after_auth(&session_id).unwrap();
        assert_eq!(again.session_id, rotated.session_id);
        let refresh = upgrade_cookie.expect("grace alias should re-issue live cookie");
        assert_eq!(refresh.session_id, rotated.session_id);
        // Must not mint yet another id on the grace hit.
        assert_eq!(store.sessions.len(), 1);
    }

    #[test]
    fn lookup_before_csrf_does_not_rotate() {
        let mut store = make_store_with_real_password("admin", "pw", "tok");
        let session_id = "old-session-id".to_string();
        let now = now_secs();
        store
            .sessions
            .insert(session_id.clone(), past_half_life_session(&session_id, now));

        // Simulates require_session: look up for CSRF check first. Must not retire
        // the cookie id before CSRF succeeds (otherwise a csrf_denied response
        // would leave the browser on a dead id after grace).
        let looked_up = store.get_session(&session_id).unwrap().clone();
        assert_eq!(looked_up.session_id, session_id);
        assert!(store.sessions.contains_key(&session_id));
        assert!(store.rotation_grace.is_empty());
    }

    #[test]
    fn remove_invalidates_grace_aliases() {
        let mut store = make_store_with_real_password("admin", "pw", "tok");
        let session_id = "old-session-id".to_string();
        let now = now_secs();
        store
            .sessions
            .insert(session_id.clone(), past_half_life_session(&session_id, now));

        let (rotated, _) = store.refresh_session_after_auth(&session_id).unwrap();
        store.remove(&rotated.session_id);

        assert!(store.get_session(&session_id).is_none());
        assert!(store.get_session(&rotated.session_id).is_none());
        assert!(store.refresh_session_after_auth(&session_id).is_none());
        assert!(store.get_session_by_principal("principal-1").is_none());
    }

    #[test]
    fn create_session_issues_csrf_token_distinct_from_session_id() {
        let mut store = make_store_with_real_password("admin", "pw", "tok");
        let (session, _) = store.create_session("admin", false);
        assert_eq!(session.csrf_token.len(), 64);
        assert_ne!(session.csrf_token, session.session_id);
        assert_ne!(session.principal_id, session.session_id);
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
                principal_id: "p".to_string(),
                csrf_token: "csrf-test".to_string(),
                permissions: vec![],
                created_at: 0,
                expires_at: past,
                ttl_secs: 60,
            },
        );
        assert!(store.get_session(&session_id).is_none());
    }

    #[test]
    fn session_is_expired_when_expires_at_in_past() {
        let s = Session {
            session_id: "x".to_string(),
            principal_id: "p".to_string(),
            csrf_token: "csrf-test".to_string(),
            permissions: vec![],
            created_at: 0,
            expires_at: 1, // epoch + 1s = past
            ttl_secs: 60,
        };
        assert!(s.is_expired());
    }

    #[test]
    fn session_is_not_expired_when_expires_at_in_future() {
        let future = now_secs() + 3600;
        let s = Session {
            session_id: "x".to_string(),
            principal_id: "p".to_string(),
            csrf_token: "csrf-test".to_string(),
            permissions: vec![],
            created_at: 0,
            expires_at: future,
            ttl_secs: 3600,
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
                principal_id: "expired-principal".to_string(),
                csrf_token: "csrf-test".to_string(),
                permissions: vec![],
                created_at: 0,
                expires_at: 1,
                ttl_secs: 60,
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
