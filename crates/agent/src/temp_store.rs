//! Dedicated temp-upload folder: the ONLY place this agent ever writes.
//!
//! The browser drags small files onto the hub, the hub forwards the bytes over
//! the agent WebSocket, and this module writes them into
//! `<temp base>/<upload folder>` (defaults: `<data_dir>/temp` /
//! `agent-temp-copied-file`, both configurable). Everything else in the
//! codebase stays read-only.
//!
//! Security posture:
//! - Writes happen ONLY inside the upload folder. Names are validated as
//!   single path components (no separators, no `..`, no NUL), so a name can
//!   never escape the folder.
//! - The folder and the private staging dir are created 0700; files are 0600.
//! - Uploads stream into a private staging directory and are hard-linked into
//!   the upload folder only after the byte count checks out. `hard_link` is a
//!   no-clobber atomic publish, and the final path is canonicalized and
//!   re-verified to sit inside the upload folder before it is accepted.
//! - Existing files are never overwritten: name collisions get a numeric
//!   suffix instead.
//! - Per-file and total-folder quotas are enforced with reservations.
//! - Cleanup deletes only entries INSIDE the folder, never follows symlinks,
//!   and refuses to run if the folder itself has been swapped for a symlink.

use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;

use filebox_protocol::resources::TempRootInfo;
use filebox_protocol::temp::validate_upload_folder_name;

/// Defaults (bytes). The hub independently caps request bodies at 64 MiB, so
/// effective per-file uploads are the smaller of the two limits.
pub const DEFAULT_MAX_FILE_BYTES: u64 = 20 * 1024 * 1024;
pub const DEFAULT_MAX_TOTAL_BYTES: u64 = 1024 * 1024 * 1024;
/// Sanity clamps for env-configured limits.
const MIN_MAX_FILE_BYTES: u64 = 1;
const MAX_MAX_FILE_BYTES: u64 = 1024 * 1024 * 1024;
const MIN_MAX_TOTAL_BYTES: u64 = 1024 * 1024;
const MAX_MAX_TOTAL_BYTES: u64 = 128 * 1024 * 1024 * 1024;
/// Never follow a symlink swapped in where the upload folder should be.
const DEFAULT_UPLOAD_FOLDER_NAME: &str = "agent-temp-copied-file";
const STAGING_DIR_NAME: &str = ".staging";
/// Bounded scans: startup accounting / reaping must not walk unbounded trees.
const MAX_SCAN_ENTRIES: usize = 100_000;
/// Collision-suffix attempts before giving up on a name.
const MAX_COLLISION_RETRIES: u32 = 50;

#[derive(Debug, Clone)]
pub struct TempStoreConfig {
    pub base_dir: PathBuf,
    pub upload_folder_name: String,
    pub max_file_bytes: u64,
    pub max_total_bytes: u64,
}

impl TempStoreConfig {
    /// Resolve from the environment and agent.toml, defaulting under the
    /// agent data dir. Precedence: env var > agent.toml > default.
    /// `FILEBOX_AGENT_TEMP_DIR` / `temp_dir` set the base directory;
    /// `FILEBOX_AGENT_TEMP_UPLOAD_NAME` / `temp_upload_name` set the folder
    /// name; `FILEBOX_AGENT_TEMP_MAX_FILE_BYTES` / `_MAX_TOTAL_BYTES` set the
    /// quotas.
    pub fn from_env(data_dir: &Path, toml_temp_dir: Option<&str>, toml_upload_name: Option<&str>) -> Self {
        let base_dir = std::env::var("FILEBOX_AGENT_TEMP_DIR")
            .ok()
            .filter(|v| !v.trim().is_empty())
            .map(expand_home)
            .or_else(|| toml_temp_dir.map(|v| expand_home(v.to_string())))
            .unwrap_or_else(|| data_dir.join("temp"));
        let upload_folder_name = std::env::var("FILEBOX_AGENT_TEMP_UPLOAD_NAME")
            .ok()
            .filter(|v| !v.trim().is_empty())
            .map(|v| v.trim().to_string())
            .or_else(|| toml_upload_name.map(|v| v.trim().to_string()))
            .unwrap_or_else(|| DEFAULT_UPLOAD_FOLDER_NAME.to_string());
        let max_file_bytes = env_u64("FILEBOX_AGENT_TEMP_MAX_FILE_BYTES", DEFAULT_MAX_FILE_BYTES)
            .clamp(MIN_MAX_FILE_BYTES, MAX_MAX_FILE_BYTES);
        let max_total_bytes = env_u64("FILEBOX_AGENT_TEMP_MAX_TOTAL_BYTES", DEFAULT_MAX_TOTAL_BYTES)
            .clamp(MIN_MAX_TOTAL_BYTES, MAX_MAX_TOTAL_BYTES);
        Self {
            base_dir,
            upload_folder_name,
            max_file_bytes,
            max_total_bytes,
        }
    }
}

fn env_u64(name: &str, default: u64) -> u64 {
    std::env::var(name)
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(default)
}

fn expand_home(value: String) -> PathBuf {
    let value = value.trim();
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

struct UploadSession {
    name: String,
    total_size: u64,
    received: u64,
    /// Open staging file. The handle pins the inode: even if a local attacker
    /// could unlink the staging path mid-upload, our writes go to the original
    /// file, and finalization re-verifies the published path canonically.
    file: File,
    staging_path: PathBuf,
}

pub struct TempStore {
    name: String,
    /// Canonical absolute upload folder (contains no symlink components).
    upload_dir: PathBuf,
    /// Canonical private staging dir (sibling of `upload_dir`, inside base).
    staging_dir: PathBuf,
    max_file_bytes: u64,
    max_total_bytes: u64,
    sessions: Mutex<HashMap<String, UploadSession>>,
    /// Reserved total bytes for in-flight + completed uploads.
    total_bytes: AtomicU64,
}

impl TempStore {
    pub fn new(config: TempStoreConfig) -> Result<Self, String> {
        let folder_name = validate_upload_folder_name(&config.upload_folder_name)
            .map_err(|_| "temp folder name must be a single, non-empty path component".to_string())?;

        let base = &config.base_dir;
        fs::create_dir_all(base)
            .map_err(|e| format!("failed to create temp base dir '{}': {e}", base.display()))?;
        harden_dir_permissions(base);

        let staging_dir = base.join(STAGING_DIR_NAME);
        fs::create_dir_all(&staging_dir).map_err(|e| {
            format!(
                "failed to create temp staging dir '{}': {e}",
                staging_dir.display()
            )
        })?;
        harden_dir_permissions(&staging_dir);

        let upload_dir = base.join(&folder_name);
        fs::create_dir_all(&upload_dir).map_err(|e| {
            format!(
                "failed to create temp upload dir '{}': {e}",
                upload_dir.display()
            )
        })?;
        harden_dir_permissions(&upload_dir);

        let upload_canonical = upload_dir
            .canonicalize()
            .map_err(|e| format!("failed to resolve temp upload dir: {e}"))?;
        verify_real_directory(&upload_canonical)?;
        let staging_canonical = staging_dir
            .canonicalize()
            .map_err(|e| format!("failed to resolve temp staging dir: {e}"))?;

        // Leftovers from a crashed process: staging entries are ours alone.
        reap_directory(&staging_canonical);
        // Account existing content so the total quota survives restarts.
        let total_bytes = account_directory(&upload_canonical);

        Ok(Self {
            name: folder_name,
            upload_dir: upload_canonical,
            staging_dir: staging_canonical,
            max_file_bytes: config.max_file_bytes,
            max_total_bytes: config.max_total_bytes,
            sessions: Mutex::new(HashMap::new()),
            total_bytes: AtomicU64::new(total_bytes),
        })
    }

    /// Synthetic-root metadata advertised at Register time.
    pub fn root_info(&self) -> TempRootInfo {
        TempRootInfo {
            name: self.name.clone(),
            path: self.upload_dir.to_string_lossy().to_string(),
            max_file_bytes: self.max_file_bytes,
            max_total_bytes: self.max_total_bytes,
        }
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    /// Absolute upload folder path (canonical — for display only).
    pub fn upload_dir_str(&self) -> String {
        self.upload_dir.to_string_lossy().to_string()
    }

    /// Open an upload session. Returns a machine-readable error code on
    /// failure; no state is left behind.
    pub fn begin(&self, req_id: &str, name: &str, total_size: u64) -> Result<(), String> {
        let name = filebox_protocol::temp::validate_upload_name(name)?;
        // The req_id becomes the staging file name — it must be a safe single
        // component token, never trusted for path structure.
        if !is_safe_staging_token(req_id) {
            return Err("temp_internal_error".to_string());
        }
        if total_size > self.max_file_bytes {
            return Err("temp_file_too_large".to_string());
        }

        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| "temp_internal_error".to_string())?;
        if sessions.contains_key(req_id) {
            return Err("temp_internal_error".to_string());
        }
        // Reserve quota atomically so concurrent uploads cannot overshoot.
        let reserved = self
            .total_bytes
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |current| {
                (current.saturating_add(total_size) <= self.max_total_bytes)
                    .then_some(current + total_size)
            })
            .is_ok();
        if !reserved {
            return Err("temp_quota_exceeded".to_string());
        }

        let staging_path = self.staging_dir.join(req_id);
        let file = match open_staging_file(&staging_path) {
            Ok(file) => file,
            Err(e) => {
                self.total_bytes.fetch_sub(total_size, Ordering::AcqRel);
                return Err(e);
            }
        };

        sessions.insert(
            req_id.to_string(),
            UploadSession {
                name,
                total_size,
                received: 0,
                file,
                staging_path,
            },
        );
        Ok(())
    }

    /// Append one chunk. Returns `Ok(None)` while the upload is incomplete,
    /// `Ok(Some((final_name, size)))` when the last chunk landed, or an error
    /// code (the session is aborted and cleaned up on error).
    pub fn write_chunk(
        &self,
        req_id: &str,
        offset: u64,
        data: &[u8],
        done: bool,
    ) -> Result<Option<(String, u64)>, String> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| "temp_internal_error".to_string())?;
        let Some(session) = sessions.get_mut(req_id) else {
            return Err("temp_no_session".to_string());
        };
        // Strictly sequential — out-of-order chunks abort the upload.
        if offset != session.received {
            self.abort_locked(&mut sessions, req_id);
            return Err("temp_chunk_out_of_order".to_string());
        }
        let Some(new_len) = session.received.checked_add(data.len() as u64) else {
            self.abort_locked(&mut sessions, req_id);
            return Err("temp_upload_too_large".to_string());
        };
        if new_len > session.total_size {
            self.abort_locked(&mut sessions, req_id);
            return Err("temp_upload_too_large".to_string());
        }
        if let Err(e) = session.file.write_all(data) {
            self.abort_locked(&mut sessions, req_id);
            tracing::warn!("temp upload write failed for {}: {e}", req_id);
            return Err("temp_write_failed".to_string());
        }
        session.received = new_len;

        if !done {
            return Ok(None);
        }
        if session.received != session.total_size {
            self.abort_locked(&mut sessions, req_id);
            return Err("temp_upload_incomplete".to_string());
        }
        if let Err(e) = session.file.flush() {
            self.abort_locked(&mut sessions, req_id);
            tracing::warn!("temp upload flush failed for {}: {e}", req_id);
            return Err("temp_write_failed".to_string());
        }

        let (name, total_size, staging_path) = (
            session.name.clone(),
            session.total_size,
            session.staging_path.clone(),
        );
        // Publish: close the staging fd (session removed below), then
        // hard-link (atomic, no-clobber) into the upload folder under a
        // collision-free name.
        sessions.remove(req_id);
        drop(sessions);

        self.publish(&name, total_size, &staging_path)
    }

    /// Abort an in-flight upload (Cancel or protocol error) and release its
    /// quota reservation.
    pub fn cancel(&self, req_id: &str) {
        let mut sessions = match self.sessions.lock() {
            Ok(s) => s,
            Err(_) => return,
        };
        if let Some(session) = sessions.remove(req_id) {
            drop(session.file);
            let _ = fs::remove_file(&session.staging_path);
            self.total_bytes
                .fetch_sub(session.total_size, Ordering::AcqRel);
        }
    }

    /// Abort every in-flight upload (connection teardown). Staging files are
    /// unlinked; startup reaping also covers crash leftovers.
    pub fn cancel_all(&self) {
        let mut sessions = match self.sessions.lock() {
            Ok(s) => s,
            Err(_) => return,
        };
        let drained: Vec<UploadSession> = sessions.drain().map(|(_, s)| s).collect();
        for session in drained {
            drop(session.file);
            let _ = fs::remove_file(&session.staging_path);
            self.total_bytes
                .fetch_sub(session.total_size, Ordering::AcqRel);
        }
    }

    /// Remove every entry inside the upload folder. The folder itself and the
    /// quota bookkeeping survive. Symlinks are unlinked (never followed) and
    /// directories are removed recursively without following links inside.
    pub fn cleanup(&self, cancelled: Option<&AtomicBool>) -> Result<(u64, u64), String> {
        // Refuse if the folder has been swapped for a symlink since startup.
        verify_real_directory(&self.upload_dir)?;

        let entries = fs::read_dir(&self.upload_dir)
            .map_err(|e| format!("failed to read temp upload dir: {e}"))?;
        let mut removed = 0u64;
        let mut freed = 0u64;
        for (idx, entry) in entries.enumerate() {
            if idx >= MAX_SCAN_ENTRIES {
                return Err("temp_cleanup_too_large".to_string());
            }
            if cancelled.is_some_and(|flag| flag.load(Ordering::Acquire)) {
                return Err("request_cancelled".to_string());
            }
            let entry = entry.map_err(|e| format!("failed to read temp entry: {e}"))?;
            let path = entry.path();
            let md = fs::symlink_metadata(&path).map_err(|e| {
                format!("failed to stat temp entry '{}': {e}", path.display())
            })?;
            if md.file_type().is_symlink() {
                // Unlink the link itself — never touch its target.
                fs::remove_file(&path)
                    .map_err(|e| format!("failed to remove '{}': {e}", path.display()))?;
                removed += 1;
            } else if md.is_dir() {
                fs::remove_dir_all(&path)
                    .map_err(|e| format!("failed to remove '{}': {e}", path.display()))?;
                removed += 1;
            } else {
                freed += md.len();
                fs::remove_file(&path)
                    .map_err(|e| format!("failed to remove '{}': {e}", path.display()))?;
                removed += 1;
            }
        }
        // Everything user-visible is gone; only in-flight staging reservations
        // (kept in `total_bytes`) may remain.
        let in_flight = self
            .sessions
            .lock()
            .map(|s| s.values().map(|v| v.total_size).sum::<u64>())
            .unwrap_or(0);
        self.total_bytes.store(in_flight, Ordering::Release);
        Ok((removed, freed))
    }

    /// Internal: called with the sessions lock HELD. Aborts a session and
    /// releases its reservation. (Borrows `sessions` so the lock can't be
    /// dropped mid-abort.)
    fn abort_locked(
        &self,
        sessions: &mut HashMap<String, UploadSession>,
        req_id: &str,
    ) {
        if let Some(session) = sessions.remove(req_id) {
            drop(session.file);
            let _ = fs::remove_file(&session.staging_path);
            self.total_bytes
                .fetch_sub(session.total_size, Ordering::AcqRel);
        }
    }

    /// Publish a completed staging file into the upload folder and verify the
    /// result stays inside it.
    fn publish(
        &self,
        name: &str,
        size: u64,
        staging_path: &Path,
    ) -> Result<Option<(String, u64)>, String> {
        // The staging fd is closed by the caller (session removed), so the
        // file on disk is complete and flushed.
        for _ in 0..MAX_COLLISION_RETRIES {
            let final_name = pick_free_name(&self.upload_dir, name);
            let final_path = self.upload_dir.join(&final_name);
            match fs::hard_link(staging_path, &final_path) {
                Ok(()) => {
                    let _ = fs::remove_file(staging_path);
                    // Final defense: the published path must canonicalize to a
                    // file inside the (canonical) upload folder.
                    let canonical = match final_path.canonicalize() {
                        Ok(p) => p,
                        Err(e) => {
                            let _ = fs::remove_file(&final_path);
                            return Err(format!("temp publish verify failed: {e}"));
                        }
                    };
                    if !canonical.starts_with(&self.upload_dir) {
                        let _ = fs::remove_file(&final_path);
                        return Err("temp_path_violation".to_string());
                    }
                    return Ok(Some((final_name, size)));
                }
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(e) => {
                    let _ = fs::remove_file(staging_path);
                    return Err(format!("temp publish failed: {e}"));
                }
            }
        }
        let _ = fs::remove_file(staging_path);
        Err("temp_name_conflict".to_string())
    }
}

/// Create the staging file atomically, refusing to follow symlinks on Unix.
fn open_staging_file(path: &Path) -> Result<File, String> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
        options.custom_flags(libc::O_NOFOLLOW);
    }
    options
        .open(path)
        .map_err(|e| format!("failed to open staging file: {e}"))
}

/// Reject symlinks (and non-directories) where a real directory must be.
fn verify_real_directory(path: &Path) -> Result<(), String> {
    let md = fs::symlink_metadata(path)
        .map_err(|e| format!("temp dir vanished or is inaccessible: {e}"))?;
    if !md.is_dir() || md.file_type().is_symlink() {
        return Err("temp_path_violation".to_string());
    }
    Ok(())
}

/// Staging file names are hub-supplied `req_id`s — accept only a bounded
/// `[A-Za-z0-9_-]` token so they can never carry path structure.
fn is_safe_staging_token(token: &str) -> bool {
    !token.is_empty()
        && token.len() <= 128
        && token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Best-effort 0700 on a directory we own (Unix only). Never fatal — the
/// canonical-path + no-follow checks are the actual security boundary.
fn harden_dir_permissions(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(md) = fs::metadata(path) {
            if md.is_dir() {
                let mut perms = md.permissions();
                perms.set_mode(0o700);
                if fs::set_permissions(path, perms).is_err() {
                    tracing::warn!(
                        "could not set 0700 on '{}' — continuing with existing permissions",
                        path.display()
                    );
                }
            }
        }
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
}

/// Does any filesystem entry exist at `path`? (`NotFound` = free; any other
/// outcome counts as occupied, which is the safe answer.)
fn path_occupied(path: &Path) -> bool {
    match fs::symlink_metadata(path) {
        Ok(_) => true,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
        Err(_) => true,
    }
}

/// `name` if free, else `stem (2).ext`, `stem (3).ext`, …
fn pick_free_name(dir: &Path, name: &str) -> String {
    if !path_occupied(&dir.join(name)) {
        return name.to_string();
    }
    let (stem, ext) = split_ext(name);
    for i in 2..=MAX_COLLISION_RETRIES * 4 {
        let candidate = format!("{stem} ({i}){ext}");
        if !path_occupied(&dir.join(&candidate)) {
            return candidate;
        }
    }
    name.to_string()
}

fn split_ext(name: &str) -> (&str, &str) {
    match name.rfind('.') {
        Some(idx) if idx > 0 => (&name[..idx], &name[idx..]),
        _ => (name, ""),
    }
}

/// Remove every direct entry of `dir` (files, dirs, symlinks — never followed).
fn reap_directory(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for (idx, entry) in entries.enumerate() {
        if idx >= MAX_SCAN_ENTRIES {
            break;
        }
        let Ok(entry) = entry else { continue };
        let path = entry.path();
        let Ok(md) = fs::symlink_metadata(&path) else { continue };
        if md.is_dir() && !md.file_type().is_symlink() {
            let _ = fs::remove_dir_all(&path);
        } else {
            let _ = fs::remove_file(&path);
        }
    }
}

/// Sum the sizes of regular files directly inside `dir` (symlinks are not
/// followed — their targets are not part of this folder's quota).
fn account_directory(dir: &Path) -> u64 {
    let Ok(entries) = fs::read_dir(dir) else { return 0 };
    let mut total = 0u64;
    for (idx, entry) in entries.enumerate() {
        if idx >= MAX_SCAN_ENTRIES {
            break;
        }
        let Ok(entry) = entry else { continue };
        let Ok(md) = fs::symlink_metadata(entry.path()) else { continue };
        if md.is_file() {
            total = total.saturating_add(md.len());
        }
    }
    total
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store_in(tmp: &Path, name: &str, max_file: u64, max_total: u64) -> TempStore {
        let cfg = TempStoreConfig {
            base_dir: tmp.to_path_buf(),
            upload_folder_name: name.to_string(),
            max_file_bytes: max_file,
            max_total_bytes: max_total,
        };
        TempStore::new(cfg).unwrap()
    }

    fn begin_upload(store: &TempStore, req: &str, name: &str, data: &[u8]) {
        store.begin(req, name, data.len() as u64).unwrap();
        let result = store
            .write_chunk(req, 0, data, true)
            .unwrap()
            .expect("upload should complete");
        assert_eq!(result.1, data.len() as u64);
    }

    #[test]
    fn upload_lands_inside_folder_with_content() {
        let tmp = tempfile::tempdir().unwrap();
        let store = store_in(tmp.path(), "agent-temp-copied-file", 1024, 4096);
        begin_upload(&store, "r1", "hello.txt", b"hello world");
        let path = tmp.path().join("agent-temp-copied-file").join("hello.txt");
        assert_eq!(fs::read(&path).unwrap(), b"hello world");
    }

    #[test]
    fn upload_in_multiple_chunks() {
        let tmp = tempfile::tempdir().unwrap();
        let store = store_in(tmp.path(), "drop", 1024, 4096);
        store.begin("r1", "data.bin", 6).unwrap();
        assert!(store.write_chunk("r1", 0, b"abc", false).unwrap().is_none());
        let done = store.write_chunk("r1", 3, b"def", true).unwrap();
        assert_eq!(done.as_ref().map(|(n, s)| (n.as_str(), *s)), Some(("data.bin", 6)));
        let path = tmp.path().join("drop").join("data.bin");
        assert_eq!(fs::read(&path).unwrap(), b"abcdef");
    }

    #[test]
    fn rejects_path_escape_names() {
        let tmp = tempfile::tempdir().unwrap();
        let store = store_in(tmp.path(), "drop", 1024, 4096);
        for bad in ["../evil", "a/b", "a\\b", "..", "."] {
            assert_eq!(store.begin("r1", bad, 1), Err("temp_name_invalid".to_string()));
        }
        // Nothing escaped outside the folder.
        assert!(!tmp.path().join("evil").exists());
    }

    #[test]
    fn rejects_hostile_req_ids_that_carry_path_structure() {
        let tmp = tempfile::tempdir().unwrap();
        let store = store_in(tmp.path(), "drop", 1024, 4096);
        for bad in ["../escape", "a/b", "a\\b", "", "..", "."] {
            assert_eq!(store.begin(bad, "x.bin", 1), Err("temp_internal_error".to_string()));
        }
        // No staging file escaped the staging dir.
        assert!(!tmp.path().join("escape").exists());
        assert_eq!(fs::read_dir(tmp.path().join(".staging")).unwrap().count(), 0);
        // Legitimate tokens still work.
        assert!(store.begin("temp_up_1234-ab_cd", "x.bin", 1).is_ok());
        store.cancel("temp_up_1234-ab_cd");
    }

    #[test]
    fn rejects_oversized_and_quota_exceeded() {
        let tmp = tempfile::tempdir().unwrap();
        let store = store_in(tmp.path(), "drop", 10, 10);
        assert_eq!(store.begin("r1", "big.bin", 11), Err("temp_file_too_large".to_string()));
        // Quota: one 6-byte file OK, second 6-byte file would total 12 > 10.
        store.begin("r1", "a.bin", 6).unwrap();
        assert!(store.write_chunk("r1", 0, b"abcdef", true).unwrap().is_some());
        assert_eq!(store.begin("r2", "b.bin", 6), Err("temp_quota_exceeded".to_string()));
        // Failing after a reserved session also releases the reservation.
        store.begin("r2", "b.bin", 4).unwrap();
        assert_eq!(store.begin("r3", "c.bin", 4), Err("temp_quota_exceeded".to_string()));
        store.cancel("r2");
        store.begin("r3", "c.bin", 4).unwrap();
        assert!(store.write_chunk("r3", 0, b"dcba", true).unwrap().is_some());
    }

    #[test]
    fn rejects_out_of_order_chunks_and_cleans_session() {
        let tmp = tempfile::tempdir().unwrap();
        let store = store_in(tmp.path(), "drop", 1024, 4096);
        store.begin("r1", "x.bin", 6).unwrap();
        assert_eq!(
            store.write_chunk("r1", 3, b"abc", false),
            Err("temp_chunk_out_of_order".to_string())
        );
        // Session aborted: further chunks and completion are refused.
        assert_eq!(store.write_chunk("r1", 0, b"abc", true), Err("temp_no_session".to_string()));
        assert!(!tmp.path().join("drop").join("x.bin").exists());
        // Staging is empty again.
        let staging = tmp.path().join(".staging");
        assert_eq!(fs::read_dir(&staging).unwrap().count(), 0);
    }

    #[test]
    fn rejects_incomplete_final_chunk() {
        let tmp = tempfile::tempdir().unwrap();
        let store = store_in(tmp.path(), "drop", 1024, 4096);
        store.begin("r1", "x.bin", 10).unwrap();
        assert_eq!(
            store.write_chunk("r1", 0, b"abc", true),
            Err("temp_upload_incomplete".to_string())
        );
        assert!(!tmp.path().join("drop").join("x.bin").exists());
    }

    #[test]
    fn name_collision_gets_numeric_suffix_never_overwrites() {
        let tmp = tempfile::tempdir().unwrap();
        let store = store_in(tmp.path(), "drop", 1024, 4096);
        begin_upload(&store, "r1", "a.txt", b"first");
        begin_upload(&store, "r2", "a.txt", b"second");
        begin_upload(&store, "r3", "a.txt", b"third");
        let dir = tmp.path().join("drop");
        assert_eq!(fs::read_to_string(dir.join("a.txt")).unwrap(), "first");
        assert_eq!(fs::read_to_string(dir.join("a (2).txt")).unwrap(), "second");
        assert_eq!(fs::read_to_string(dir.join("a (3).txt")).unwrap(), "third");
    }

    #[test]
    fn cleanup_removes_content_but_keeps_folder_and_does_not_follow_symlinks() {
        let tmp = tempfile::tempdir().unwrap();
        let store = store_in(tmp.path(), "drop", 4096, 40960);
        begin_upload(&store, "r1", "a.bin", b"12345");
        let dir = tmp.path().join("drop");
        fs::create_dir_all(dir.join("sub")).unwrap();
        fs::write(dir.join("sub").join("nested.txt"), b"nested").unwrap();

        // A symlink pointing OUTSIDE the folder: cleanup must unlink the link,
        // not the target.
        let outside = tmp.path().join("outside-target.txt");
        fs::write(&outside, b"keep me").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, dir.join("link.txt")).unwrap();
        #[cfg(windows)]
        std::os::windows::fs::symlink_file(&outside, dir.join("link.txt")).unwrap();

        let (removed, freed) = store.cleanup(None).unwrap();
        assert!(removed >= 3);
        // Only directly-listed regular files contribute to `freed`;
        // nested files go away with their directory.
        assert!(freed >= 5);
        assert!(outside.exists(), "symlink target must survive");
        assert!(dir.exists(), "folder itself must survive");
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 0);
    }

    #[test]
    fn cleanup_refuses_symlinked_folder() {
        let tmp = tempfile::tempdir().unwrap();
        let store = store_in(tmp.path(), "drop", 4096, 40960);
        let dir = tmp.path().join("drop");
        fs::remove_dir_all(&dir).unwrap();
        let elsewhere = tmp.path().join("elsewhere");
        fs::create_dir_all(&elsewhere).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&elsewhere, &dir).unwrap();
        #[cfg(windows)]
        std::os::windows::fs::symlink_dir(&elsewhere, &dir).unwrap();
        assert_eq!(store.cleanup(None), Err("temp_path_violation".to_string()));
        assert!(elsewhere.exists());
    }

    #[test]
    fn cancel_removes_staging_and_releases_quota() {
        let tmp = tempfile::tempdir().unwrap();
        let store = store_in(tmp.path(), "drop", 1024, 10);
        store.begin("r1", "x.bin", 6).unwrap();
        store.write_chunk("r1", 0, b"abc", false).unwrap();
        store.cancel("r1");
        assert_eq!(fs::read_dir(tmp.path().join(".staging")).unwrap().count(), 0);
        // Reservation released: a full-size upload fits again.
        store.begin("r2", "y.bin", 10).unwrap();
        assert!(store.write_chunk("r2", 0, b"0123456789", true).unwrap().is_some());
    }

    #[test]
    fn startup_reaps_stale_staging_and_accounts_existing_files() {
        let tmp = tempfile::tempdir().unwrap();
        {
            let store = store_in(tmp.path(), "drop", 4096, 4096);
            begin_upload(&store, "r1", "keep.bin", b"12345678"); // 8 bytes
        }
        // Simulate a crashed upload: stale staging file + fresh accounting.
        let staging = tmp.path().join(".staging");
        fs::write(staging.join("dead-session"), b"junk").unwrap();
        let store = store_in(tmp.path(), "drop", 4096, 4096);
        assert_eq!(fs::read_dir(&staging).unwrap().count(), 0, "stale staging must be reaped");
        // 8 bytes already used: quota is 4096, so a 4088-byte upload fits
        // while 4089 does not.
        assert!(store.begin("r2", "more.bin", 4088).is_ok());
        store.cancel("r2");
        assert_eq!(store.begin("r3", "more.bin", 4089), Err("temp_quota_exceeded".to_string()));
    }

    #[test]
    fn empty_file_upload_works() {
        let tmp = tempfile::tempdir().unwrap();
        let store = store_in(tmp.path(), "drop", 4096, 4096);
        store.begin("r1", "empty.txt", 0).unwrap();
        let done = store.write_chunk("r1", 0, b"", true).unwrap();
        assert_eq!(done.as_ref().map(|(n, s)| (n.as_str(), *s)), Some(("empty.txt", 0)));
        assert!(tmp.path().join("drop").join("empty.txt").exists());
    }

    #[test]
    fn invalid_folder_name_is_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        for bad in ["../escape", "a/b", "", "   "] {
            let cfg = TempStoreConfig {
                base_dir: tmp.path().to_path_buf(),
                upload_folder_name: bad.to_string(),
                max_file_bytes: 1024,
                max_total_bytes: 4096,
            };
            assert!(TempStore::new(cfg).is_err());
        }
    }
}
