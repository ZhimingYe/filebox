//! Login audit log.
//!
//! Records authentication-relevant events (login success / failure / rate
//! limit / logout) with username, client IP, and user agent. Entries are
//! kept in a bounded in-memory ring and persisted as JSONL in a sidecar file
//! next to the hub config (`audit-log.jsonl`), so records survive restarts.
//!
//! Write failures never fail the login flow: the hub keeps recording in
//! memory and warns once, then retries on the next record. The file is
//! rewritten (temp file + rename, mode 0600) once it outgrows ~1.5× the
//! in-memory cap so disk usage stays bounded.

use std::collections::VecDeque;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

pub const AUDIT_FILE_NAME: &str = "audit-log.jsonl";
/// Maximum entries kept in memory (and kept after file compaction).
pub const AUDIT_MAX_ENTRIES: usize = 2000;
/// Rewrite the file once it holds this many lines.
const AUDIT_COMPACT_LINES: u64 = (AUDIT_MAX_ENTRIES as u64) + 1000;
/// Length caps for strings arriving from untrusted network peers. They land
/// on disk, so they must stay bounded regardless of input size.
const EVENT_MAX: usize = 32;
const USERNAME_MAX: usize = 64;
const IP_MAX: usize = 64;
const USER_AGENT_MAX: usize = 256;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct LoginAuditEntry {
    pub id: u64,
    pub at_ms: u64,
    pub event: String,
    pub username: String,
    pub ip: String,
    pub user_agent: String,
}

struct Inner {
    /// Chronological order (oldest first). Bounded to `AUDIT_MAX_ENTRIES`.
    entries: VecDeque<LoginAuditEntry>,
    next_id: u64,
    path: Option<PathBuf>,
    /// Lines believed to be on disk (approximate after failed writes).
    lines_on_disk: u64,
    write_warned: bool,
}

pub struct LoginAuditLog {
    inner: Mutex<Inner>,
}

/// Where to persist the audit log.
///
/// Production: `audit-log.jsonl` next to the resolved hub config, so the
/// audit trail follows the config dir (single-file `./hub.json` setups get a
/// sibling file in cwd). Dev mode (no config file exists): `audit-log.jsonl`
/// in the working directory (gitignored in this repo).
pub fn default_path(secure: bool) -> Option<PathBuf> {
    let config_path = crate::config::resolve_config_path();
    if config_path.is_file() {
        return Some(
            config_path
                .parent()
                .filter(|parent| !parent.as_os_str().is_empty())
                .map(|parent| parent.join(AUDIT_FILE_NAME))
                .unwrap_or_else(|| PathBuf::from(AUDIT_FILE_NAME)),
        );
    }
    // No config file: production would have exited during config load, so
    // this is dev mode. A local file keeps the feature fully functional.
    if !secure {
        return Some(PathBuf::from(AUDIT_FILE_NAME));
    }
    None
}

impl LoginAuditLog {
    pub fn load(path: Option<PathBuf>) -> Self {
        let path = path.filter(|p| !p.as_os_str().is_empty());
        let mut inner = Inner {
            entries: VecDeque::new(),
            next_id: 1,
            path: path.clone(),
            lines_on_disk: 0,
            write_warned: false,
        };
        if let Some(p) = &path {
            match std::fs::File::open(p) {
                Ok(file) => {
                    let reader = std::io::BufReader::new(file);
                    let mut lines = 0u64;
                    let mut malformed_warned = false;
                    for line in std::io::BufRead::lines(reader) {
                        lines += 1;
                        match line {
                            Ok(line) => {
                                let line = line.trim();
                                if line.is_empty() {
                                    continue;
                                }
                                match serde_json::from_str::<LoginAuditEntry>(line) {
                                    Ok(entry) => {
                                        inner.next_id =
                                            inner.next_id.max(entry.id.saturating_add(1));
                                        inner.entries.push_back(entry);
                                    }
                                    Err(_) if !malformed_warned => {
                                        malformed_warned = true;
                                        tracing::warn!(
                                            target: "audit",
                                            path = %p.display(),
                                            "audit log has malformed lines; they will be dropped on compaction",
                                        );
                                    }
                                    Err(_) => {}
                                }
                            }
                            Err(error) => {
                                tracing::warn!(
                                    target: "audit",
                                    path = %p.display(),
                                    %error,
                                    "audit log read error; tail entries may be missing",
                                );
                                break;
                            }
                        }
                    }
                    // Bound memory even if a hand-edited file exceeded the cap.
                    while inner.entries.len() > AUDIT_MAX_ENTRIES {
                        inner.entries.pop_front();
                    }
                    inner.lines_on_disk = lines;
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    // Fresh log — created on first record.
                }
                Err(error) => {
                    tracing::warn!(
                        target: "audit",
                        path = %p.display(),
                        %error,
                        "audit log unreadable; keeping records in memory only",
                    );
                    inner.path = None;
                }
            }
        }
        Self {
            inner: Mutex::new(inner),
        }
    }

    /// Record an authentication event. Never panics and never fails the
    /// caller: persistence problems degrade to in-memory-only with a warning.
    pub fn record(&self, event: &str, username: &str, ip: &str, user_agent: &str) {
        let at_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let mut inner = self.inner.lock().unwrap();
        let entry = LoginAuditEntry {
            id: inner.next_id,
            at_ms,
            event: truncate_chars(event, EVENT_MAX),
            username: truncate_chars(username, USERNAME_MAX),
            ip: truncate_chars(ip, IP_MAX),
            user_agent: truncate_chars(user_agent, USER_AGENT_MAX),
        };
        inner.next_id = inner.next_id.saturating_add(1);
        inner.entries.push_back(entry.clone());
        while inner.entries.len() > AUDIT_MAX_ENTRIES {
            inner.entries.pop_front();
        }
        self.append(&mut inner, &entry);
        if inner.lines_on_disk >= AUDIT_COMPACT_LINES {
            self.compact(&mut inner);
        }
    }

    /// Newest-first page of entries. `before` (exclusive entry id) supports
    /// "load older" pagination. `has_more` is true when another page exists.
    pub fn recent(&self, limit: usize, before: Option<u64>) -> (Vec<LoginAuditEntry>, bool) {
        let inner = self.inner.lock().unwrap();
        let mut out = Vec::new();
        let mut has_more = false;
        for entry in inner.entries.iter().rev() {
            if let Some(b) = before {
                if entry.id >= b {
                    continue;
                }
            }
            if out.len() < limit {
                out.push(entry.clone());
            } else {
                has_more = true;
                break;
            }
        }
        (out, has_more)
    }

    fn append(&self, inner: &mut Inner, entry: &LoginAuditEntry) {
        let Some(path) = inner.path.clone() else {
            return;
        };
        let result = (|| -> Result<(), String> {
            create_parent_dir(&path)?;
            let mut file = open_append(&path)?;
            let mut line = serde_json::to_string(entry).map_err(|e| e.to_string())?;
            line.push('\n');
            file.write_all(line.as_bytes()).map_err(|e| e.to_string())?;
            Ok(())
        })();
        self.note_write_result(inner, &path, result, 1);
    }

    /// Rewrite the file with exactly the in-memory tail (bounded), so the
    /// on-disk log never grows unboundedly between restarts.
    fn compact(&self, inner: &mut Inner) {
        let Some(path) = inner.path.clone() else {
            return;
        };
        let mut buf = String::new();
        for entry in &inner.entries {
            if let Ok(json) = serde_json::to_string(entry) {
                buf.push_str(&json);
                buf.push('\n');
            }
        }
        let result = (|| -> Result<(), String> {
            let tmp = path.with_extension("jsonl.tmp");
            filebox_updater::write_private_file(&tmp, buf.as_bytes(), true)?;
            std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
            Ok(())
        })();
        self.note_write_result(inner, &path, result, inner.entries.len() as u64);
    }

    /// Track write health: log the first failure of a streak once, and keep
    /// `lines_on_disk` truthful on success so compaction triggers correctly.
    fn note_write_result(
        &self,
        inner: &mut Inner,
        path: &Path,
        result: Result<(), String>,
        lines_if_ok: u64,
    ) {
        match result {
            Ok(()) => {
                inner.lines_on_disk = lines_if_ok;
                inner.write_warned = false;
            }
            Err(error) => {
                inner.lines_on_disk = inner.lines_on_disk.saturating_add(lines_if_ok);
                if !inner.write_warned {
                    inner.write_warned = true;
                    tracing::warn!(
                        target: "audit",
                        path = %path.display(),
                        %error,
                        "failed to write audit log; keeping records in memory only",
                    );
                }
            }
        }
    }
}

fn create_parent_dir(path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("failed to create '{}': {error}", parent.display()))?;
    }
    Ok(())
}

fn open_append(path: &Path) -> Result<std::fs::File, String> {
    let mut options = std::fs::OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
        .open(path)
        .map_err(|error| format!("failed to open '{}': {error}", path.display()))
}

fn truncate_chars(input: &str, max: usize) -> String {
    if input.chars().count() <= max {
        return input.to_string();
    }
    let truncated: String = input.chars().take(max).collect();
    format!("{}…", truncated)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn memory_log() -> LoginAuditLog {
        LoginAuditLog::load(None)
    }

    fn entry(event: &str, username: &str) -> LoginAuditEntry {
        LoginAuditEntry {
            id: 0,
            at_ms: 0,
            event: event.to_string(),
            username: username.to_string(),
            ip: "10.0.0.1".to_string(),
            user_agent: "test-agent".to_string(),
        }
    }

    #[test]
    fn recent_returns_newest_first() {
        let log = memory_log();
        log.record("login_failed", "alice", "10.0.0.1", "ua-1");
        log.record("login_success", "alice", "10.0.0.1", "ua-2");
        let (entries, has_more) = log.recent(10, None);
        assert_eq!(entries.len(), 2);
        assert!(!has_more);
        assert_eq!(entries[0].event, "login_success");
        assert_eq!(entries[1].event, "login_failed");
        // ids increase monotonically
        assert!(entries[0].id > entries[1].id);
    }

    #[test]
    fn recent_respects_before_for_pagination() {
        let log = memory_log();
        for _ in 0..5 {
            log.record("login_success", "alice", "10.0.0.1", "ua");
        }
        let (page1, has_more) = log.recent(2, None);
        assert_eq!(page1.len(), 2);
        assert!(has_more);
        let (page2, has_more) = log.recent(2, Some(page1[1].id));
        assert_eq!(page2.len(), 2);
        assert!(has_more);
        assert!(page2[0].id < page1[1].id);
        let (page3, has_more) = log.recent(2, Some(page2[1].id));
        assert_eq!(page3.len(), 1);
        assert!(!has_more);
    }

    #[test]
    fn memory_is_bounded_to_max_entries() {
        let log = memory_log();
        for _ in 0..(AUDIT_MAX_ENTRIES + 50) {
            log.record("login_success", "alice", "10.0.0.1", "ua");
        }
        let (entries, has_more) = log.recent(AUDIT_MAX_ENTRIES, None);
        assert_eq!(entries.len(), AUDIT_MAX_ENTRIES);
        // Evicted entries are gone for good — a bounded log can't page past them.
        assert!(!has_more);
        // The oldest surviving entry's id must be 51.
        assert_eq!(entries.last().unwrap().id, 51);
    }

    #[test]
    fn strings_from_the_network_are_truncated() {
        let log = memory_log();
        let long_ua = "Mozilla/5.0 ".repeat(100);
        let long_user = "u".repeat(500);
        log.record("login_failed", &long_user, "10.0.0.1", &long_ua);
        let (entries, _) = log.recent(1, None);
        assert_eq!(entries[0].user_agent.chars().count(), USER_AGENT_MAX + 1);
        assert_eq!(entries[0].username.chars().count(), USERNAME_MAX + 1);
        assert!(entries[0].user_agent.ends_with('…'));
    }

    #[test]
    fn persistence_survives_reload() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(AUDIT_FILE_NAME);

        let log = LoginAuditLog::load(Some(path.clone()));
        log.record("login_success", "bob", "192.0.2.7", "curl/8.0");
        log.record("logout", "bob", "192.0.2.7", "curl/8.0");

        let reloaded = LoginAuditLog::load(Some(path.clone()));
        let (entries, has_more) = reloaded.recent(10, None);
        assert_eq!(entries.len(), 2);
        assert!(!has_more);
        assert_eq!(entries[0].event, "logout");
        assert_eq!(entries[0].username, "bob");
        assert_eq!(entries[0].ip, "192.0.2.7");
        assert_eq!(entries[0].user_agent, "curl/8.0");
        assert_eq!(entries[0].id, 2);

        // Ids keep increasing across reloads (stable pagination cursors).
        reloaded.record("login_failed", "bob", "192.0.2.7", "curl/8.0");
        let (entries, _) = LoginAuditLog::load(Some(path.clone())).recent(1, None);
        assert_eq!(entries[0].id, 3);
        assert_eq!(entries[0].event, "login_failed");
    }

    #[test]
    fn malformed_lines_are_skipped_on_load() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(AUDIT_FILE_NAME);
        let good = LoginAuditEntry {
            id: 7,
            at_ms: 123,
            event: "login_success".to_string(),
            username: "bob".to_string(),
            ip: "10.0.0.1".to_string(),
            user_agent: "ua".to_string(),
        };
        std::fs::write(
            &path,
            format!("not-json\n{}\n", serde_json::to_string(&good).unwrap()),
        )
        .unwrap();

        let log = LoginAuditLog::load(Some(path));
        let (entries, _) = log.recent(10, None);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].id, 7);
        // next id continues after the highest loaded id
        log.record("logout", "bob", "10.0.0.1", "ua");
        let (entries, _) = log.recent(10, None);
        assert_eq!(entries[0].id, 8);
    }

    #[test]
    fn entry_round_trips_through_jsonl() {
        let original = entry("login_success", "admin");
        let json = serde_json::to_string(&original).unwrap();
        let parsed: LoginAuditEntry = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, original);
    }
}
