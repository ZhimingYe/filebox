//! TOTP (RFC 6238) two-factor secrets for remote terminal access.
//!
//! Secrets are 160-bit random values, base32-encoded (RFC 4648, no padding)
//! for display/storage, and persisted in a `totp-secrets.json` sidecar next to
//! the hub config (mode 0600, temp file + rename) so bindings survive
//! restarts. Pending binds live only in memory with a 10-minute TTL.
//!
//! The pure algorithm lives in `filebox_protocol::totp` (shared with the
//! agent so both sides compute codes identically); this module is storage
//! and bind policy only.
//!
//! Persistence failures never fail a request: the store degrades to
//! in-memory-only with one warning per failure streak (same discipline as the
//! login audit log).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use filebox_protocol::totp::{base32_encode, generate_secret, verify};
pub use filebox_protocol::totp::otpauth_uri;

pub const TOTP_FILE_NAME: &str = "totp-secrets.json";
/// A pending bind that is never confirmed dies after this long.
const PENDING_BIND_TTL: Duration = Duration::from_secs(10 * 60);

/// Where to persist TOTP secrets. Mirrors `audit::default_path`: next to the
/// resolved hub config, or the working directory in dev mode (no config file).
pub fn default_path(secure: bool) -> Option<PathBuf> {
    let config_path = crate::config::resolve_config_path();
    if config_path.is_file() {
        return Some(
            config_path
                .parent()
                .filter(|parent| !parent.as_os_str().is_empty())
                .map(|parent| parent.join(TOTP_FILE_NAME))
                .unwrap_or_else(|| PathBuf::from(TOTP_FILE_NAME)),
        );
    }
    if !secure {
        return Some(PathBuf::from(TOTP_FILE_NAME));
    }
    None
}

pub enum BindConfirm {
    Confirmed,
    NoPendingBind,
    InvalidCode,
}

struct TotpInner {
    /// username → base32 secret for accounts with a bound authenticator.
    secrets: HashMap<String, String>,
    /// username → (base32 secret, started at) for unconfirmed binds.
    pending_binds: HashMap<String, (String, Instant)>,
    path: Option<PathBuf>,
    write_warned: bool,
}

pub struct TotpStore {
    inner: Mutex<TotpInner>,
}

impl TotpStore {
    pub fn load(path: Option<PathBuf>) -> Self {
        let path = path.filter(|p| !p.as_os_str().is_empty());
        let mut secrets = HashMap::new();
        if let Some(p) = &path {
            match std::fs::read_to_string(p) {
                Ok(contents) => match serde_json::from_str::<HashMap<String, String>>(&contents) {
                    Ok(loaded) => secrets = loaded,
                    Err(error) => {
                        tracing::warn!(
                            target: "audit",
                            path = %p.display(),
                            %error,
                            "totp secrets file is unparseable; starting with an empty store",
                        );
                    }
                },
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    // Fresh store — created on first confirmed bind.
                }
                Err(error) => {
                    tracing::warn!(
                        target: "audit",
                        path = %p.display(),
                        %error,
                        "totp secrets file unreadable; keeping secrets in memory only",
                    );
                }
            }
        }
        Self {
            inner: Mutex::new(TotpInner {
                secrets,
                pending_binds: HashMap::new(),
                path,
                write_warned: false,
            }),
        }
    }

    pub fn is_bound(&self, username: &str) -> bool {
        self.inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .secrets
            .contains_key(username)
    }

    /// Begin (or restart) a bind: generates a fresh pending secret, replacing
    /// any prior pending bind for this username. Returns the base32 secret.
    pub fn start_bind(&self, username: &str) -> Result<String, ()> {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if inner.secrets.contains_key(username) {
            return Err(());
        }
        let now = Instant::now();
        inner
            .pending_binds
            .retain(|_, (_, started)| now.duration_since(*started) < PENDING_BIND_TTL);
        let secret = generate_secret();
        let b32 = base32_encode(&secret);
        inner
            .pending_binds
            .insert(username.to_string(), (b32.clone(), now));
        Ok(b32)
    }

    /// Confirm a pending bind with a first code from the authenticator. On
    /// success the secret becomes bound and is persisted.
    pub fn confirm_bind(&self, username: &str, code: &str) -> BindConfirm {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let now = Instant::now();
        inner
            .pending_binds
            .retain(|_, (_, started)| now.duration_since(*started) < PENDING_BIND_TTL);
        let Some((b32, _)) = inner.pending_binds.get(username) else {
            return BindConfirm::NoPendingBind;
        };
        if !verify(b32, code) {
            return BindConfirm::InvalidCode;
        }
        let b32 = b32.clone();
        inner.secrets.insert(username.to_string(), b32);
        inner.pending_binds.remove(username);
        self.persist(&mut inner);
        BindConfirm::Confirmed
    }

    /// Verify a code against the bound secret for `username`.
    pub fn verify_code(&self, username: &str, code: &str) -> bool {
        let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner
            .secrets
            .get(username)
            .is_some_and(|secret| verify(secret, code))
    }

    /// Rewrite the sidecar atomically (temp file + rename, mode 0600).
    /// Failures degrade to in-memory-only with one warning per streak.
    fn persist(&self, inner: &mut TotpInner) {
        let Some(path) = inner.path.clone() else {
            return;
        };
        let result = (|| -> Result<(), String> {
            let buf = serde_json::to_vec(&inner.secrets).map_err(|e| e.to_string())?;
            let tmp = path.with_extension("json.tmp");
            filebox_updater::write_private_file(&tmp, &buf, true)?;
            std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
            Ok(())
        })();
        match result {
            Ok(()) => inner.write_warned = false,
            Err(error) => {
                if !inner.write_warned {
                    inner.write_warned = true;
                    tracing::warn!(
                        target: "audit",
                        path = %path.display(),
                        %error,
                        "failed to persist totp secrets; keeping them in memory only",
                    );
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    use filebox_protocol::totp::{base32_decode, totp_at, TOTP_STEP_SECS};

    #[test]
    fn bind_confirm_persists_and_reloads() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(TOTP_FILE_NAME);
        let store = TotpStore::load(Some(path.clone()));
        assert!(!store.is_bound("alice"));
        let b32 = store.start_bind("alice").unwrap();
        let secret = base32_decode(&b32).unwrap();
        // Confirm with the current-step code (±1 step tolerance keeps this
        // stable even if the wall clock crosses a step boundary mid-test).
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs()
            / TOTP_STEP_SECS;
        let code = format!("{:06}", totp_at(&secret, now));
        assert!(matches!(
            store.confirm_bind("alice", &code),
            BindConfirm::Confirmed
        ));
        assert!(store.is_bound("alice"));
        // Starting a bind once bound is refused.
        assert!(store.start_bind("alice").is_err());
        // The binding survives a reload.
        let reloaded = TotpStore::load(Some(path));
        assert!(reloaded.is_bound("alice"));
        assert!(reloaded.verify_code("alice", &code));
    }

    #[test]
    fn confirm_without_pending_bind_is_rejected() {
        let store = TotpStore::load(None);
        assert!(matches!(
            store.confirm_bind("nobody", "123456"),
            BindConfirm::NoPendingBind
        ));
    }
}
