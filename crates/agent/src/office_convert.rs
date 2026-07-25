//! External LibreOffice (`soffice`) Office → PDF conversion.
//!
//! Enabled only when `FILEBOX_AGENT_SOFFICE` (or `_DIR`) points at a working
//! binary. Each convert runs in an isolated job sandbox with its own
//! UserInstallation profile; cancel/timeout kill the process group.

use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use filebox_protocol::resources::RootConfig;
use sha2::{Digest, Sha256};

/// Virtual path prefix for cached PDFs (not listed by fs_list).
pub const OFFICE_CACHE_VPATH_PREFIX: &str = "/.filebox/office-cache/";

const ALLOWED_EXTS: &[&str] = &[
    "doc", "docx", "docm", "ppt", "pptx", "pptm", "xls", "xlsx", "xlsm",
];

const DEFAULT_TIMEOUT_SECS: u64 = 120;
const DEFAULT_MAX_SRC_BYTES: u64 = 50 * 1024 * 1024;
const DEFAULT_MAX_PDF_BYTES: u64 = 200 * 1024 * 1024;
const DEFAULT_CACHE_BYTES: u64 = 1024 * 1024 * 1024;
const MAX_OFFICE_INFLIGHT: usize = 1;

#[derive(Clone)]
pub struct OfficeConfig {
    pub soffice: PathBuf,
    pub version_id: String,
    pub timeout: Duration,
    pub max_src_bytes: u64,
    pub max_pdf_bytes: u64,
    pub cache_bytes: u64,
    pub office_dir: PathBuf,
}

#[derive(Debug, Clone)]
pub struct OfficeConvertResult {
    pub cache_key: String,
    pub size: u64,
}

/// Shared runtime for convert jobs (single-flight + cancel handles).
pub struct OfficeRuntime {
    pub config: OfficeConfig,
    inflight: AtomicUsize,
    /// req_id → (cancel flag, optional process group id)
    jobs: Mutex<HashMap<String, OfficeJobHandle>>,
}

struct OfficeJobHandle {
    cancel: Arc<AtomicBool>,
    pgid: Arc<Mutex<Option<i32>>>,
}

impl OfficeRuntime {
    pub fn new(config: OfficeConfig) -> Arc<Self> {
        let _ = fs::create_dir_all(config.office_dir.join("cache"));
        let _ = fs::create_dir_all(config.office_dir.join("jobs"));
        // Reap crashed leftovers from a previous process.
        reap_stale_jobs(&config.office_dir.join("jobs"));
        Arc::new(Self {
            config,
            inflight: AtomicUsize::new(0),
            jobs: Mutex::new(HashMap::new()),
        })
    }

    pub fn request_cancel(&self, req_id: &str) {
        if let Ok(map) = self.jobs.lock() {
            if let Some(job) = map.get(req_id) {
                job.cancel.store(true, Ordering::Relaxed);
                if let Ok(guard) = job.pgid.lock() {
                    if let Some(pgid) = *guard {
                        kill_process_group(pgid);
                    }
                }
            }
        }
    }

    pub fn cancel_all(&self) {
        if let Ok(map) = self.jobs.lock() {
            for job in map.values() {
                job.cancel.store(true, Ordering::Relaxed);
                if let Ok(guard) = job.pgid.lock() {
                    if let Some(pgid) = *guard {
                        kill_process_group(pgid);
                    }
                }
            }
        }
    }
}

/// Resolve soffice from env and probe `--headless --version`.
pub fn probe_from_env(data_dir: &Path) -> Option<OfficeConfig> {
    let soffice = resolve_soffice_path()?;
    let version_id = match probe_soffice_version(&soffice) {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!(
                "LibreOffice probe failed for {}: {} — office_pdf_preview disabled",
                soffice.display(),
                e
            );
            return None;
        }
    };
    let timeout = Duration::from_secs(env_u64(
        "FILEBOX_AGENT_OFFICE_TIMEOUT_SECS",
        DEFAULT_TIMEOUT_SECS,
    ));
    let max_src_bytes = env_u64(
        "FILEBOX_AGENT_OFFICE_MAX_SRC_BYTES",
        DEFAULT_MAX_SRC_BYTES,
    );
    let max_pdf_bytes = env_u64(
        "FILEBOX_AGENT_OFFICE_MAX_PDF_BYTES",
        DEFAULT_MAX_PDF_BYTES,
    );
    let cache_bytes = env_u64("FILEBOX_AGENT_OFFICE_CACHE_BYTES", DEFAULT_CACHE_BYTES);
    let office_dir = data_dir.join("office");
    tracing::info!(
        "office_pdf_preview enabled (soffice={}, version={})",
        soffice.display(),
        version_id
    );
    Some(OfficeConfig {
        soffice,
        version_id,
        timeout,
        max_src_bytes,
        max_pdf_bytes,
        cache_bytes,
        office_dir,
    })
}

fn resolve_soffice_path() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("FILEBOX_AGENT_SOFFICE") {
        let path = PathBuf::from(p.trim());
        if path.is_file() {
            return Some(path);
        }
        tracing::warn!(
            "FILEBOX_AGENT_SOFFICE is set but not a file: {}",
            path.display()
        );
        return None;
    }
    if let Ok(dir) = std::env::var("FILEBOX_AGENT_SOFFICE_DIR") {
        let dir = PathBuf::from(dir.trim());
        for candidate in [dir.join("soffice"), dir.join("program").join("soffice")] {
            if candidate.is_file() {
                return Some(candidate);
            }
        }
        tracing::warn!(
            "FILEBOX_AGENT_SOFFICE_DIR set but soffice not found under {}",
            dir.display()
        );
    }
    None
}

fn probe_soffice_version(soffice: &Path) -> Result<String, String> {
    let output = Command::new(soffice)
        .args(["--headless", "--version"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| format!("failed to spawn soffice: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "soffice --version exited {}: {}",
            output.status, stderr
        ));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let line = stdout
        .lines()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("LibreOffice")
        .trim();
    // Accept LibreOffice or our fake test binary that prints LibreOffice.
    if !line.to_ascii_lowercase().contains("libreoffice") {
        return Err(format!("unexpected version output: {line}"));
    }
    Ok(line.to_string())
}

fn env_u64(name: &str, default: u64) -> u64 {
    std::env::var(name)
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(default)
}

pub fn is_office_ext(ext: &str) -> bool {
    ALLOWED_EXTS.iter().any(|e| e.eq_ignore_ascii_case(ext))
}

pub fn extension_of(path: &str) -> Option<String> {
    Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
}

/// Parse `/.filebox/office-cache/<64-hex>.pdf` → cache key.
pub fn parse_cache_virtual_path(path: &str) -> Option<String> {
    let rest = path.strip_prefix(OFFICE_CACHE_VPATH_PREFIX)?;
    let key = rest.strip_suffix(".pdf")?;
    if key.len() == 64 && key.chars().all(|c| c.is_ascii_hexdigit()) {
        Some(key.to_ascii_lowercase())
    } else {
        None
    }
}

#[allow(dead_code)] // Used by callers / tests; keep API next to parse_cache_virtual_path.
pub fn cache_virtual_path(cache_key: &str) -> String {
    format!("{OFFICE_CACHE_VPATH_PREFIX}{cache_key}.pdf")
}

pub type ProgressFn = Arc<dyn Fn(&str, u64, Option<String>) + Send + Sync>;

pub fn run_convert(
    runtime: &OfficeRuntime,
    roots: &[RootConfig],
    req_id: &str,
    root: &str,
    path: &str,
    on_progress: Option<ProgressFn>,
) -> Result<OfficeConvertResult, String> {
    let cancel = Arc::new(AtomicBool::new(false));
    let pgid_slot = Arc::new(Mutex::new(None));
    {
        let mut map = runtime
            .jobs
            .lock()
            .map_err(|_| "office job map poisoned".to_string())?;
        map.insert(
            req_id.to_string(),
            OfficeJobHandle {
                cancel: cancel.clone(),
                pgid: pgid_slot.clone(),
            },
        );
    }

    let result = run_convert_inner(
        runtime,
        roots,
        req_id,
        root,
        path,
        cancel,
        pgid_slot,
        on_progress,
    );

    if let Ok(mut map) = runtime.jobs.lock() {
        map.remove(req_id);
    }
    result
}

fn run_convert_inner(
    runtime: &OfficeRuntime,
    roots: &[RootConfig],
    req_id: &str,
    root: &str,
    path: &str,
    cancel: Arc<AtomicBool>,
    pgid_slot: Arc<Mutex<Option<i32>>>,
    on_progress: Option<ProgressFn>,
) -> Result<OfficeConvertResult, String> {
    let cfg = &runtime.config;

    let ext = extension_of(path).ok_or_else(|| "unsupported_format".to_string())?;
    if !is_office_ext(&ext) {
        return Err("unsupported_format".to_string());
    }

    // Path safety + denylist via shared resolver.
    let (abs_src, _root_canon) = crate::fs::resolve_path(roots, root, path)?;
    let rel = path.strip_prefix('/').unwrap_or(path);
    if filebox_protocol::denylist::is_denied(rel) {
        return Err("denied".to_string());
    }

    let meta = fs::metadata(&abs_src).map_err(|e| format!("stat failed: {e}"))?;
    if !meta.is_file() {
        return Err("not_a_file".to_string());
    }
    let src_size = meta.len();
    if src_size > cfg.max_src_bytes {
        return Err("too_large".to_string());
    }
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let cache_key = make_cache_key(root, path, mtime, src_size, &cfg.version_id);

    if let Some(size) = cache_pdf_size(&cfg.office_dir, &cache_key) {
        touch_cache_meta(&cfg.office_dir, &cache_key);
        return Ok(OfficeConvertResult { cache_key, size });
    }

    let prev = runtime.inflight.fetch_add(1, Ordering::AcqRel);
    if prev >= MAX_OFFICE_INFLIGHT {
        runtime.inflight.fetch_sub(1, Ordering::AcqRel);
        return Err("agent_busy: another office conversion is already running".to_string());
    }

    let outcome = (|| {
        if cancel.load(Ordering::Relaxed) {
            return Err("cancelled".to_string());
        }
        emit(
            &on_progress,
            "preparing",
            0,
            Some("Preparing conversion…".into()),
        );

        let job_dir = cfg.office_dir.join("jobs").join(req_id);
        let _ = fs::remove_dir_all(&job_dir);
        let profile = job_dir.join("profile");
        let indir = job_dir.join("in");
        let outdir = job_dir.join("out");
        fs::create_dir_all(&profile).map_err(|e| format!("mkdir profile: {e}"))?;
        fs::create_dir_all(&indir).map_err(|e| format!("mkdir in: {e}"))?;
        fs::create_dir_all(&outdir).map_err(|e| format!("mkdir out: {e}"))?;

        let staged = indir.join(format!("source.{ext}"));
        stage_input(&abs_src, &staged)?;

        if cancel.load(Ordering::Relaxed) {
            let _ = fs::remove_dir_all(&job_dir);
            return Err("cancelled".to_string());
        }

        emit(
            &on_progress,
            "converting",
            1,
            Some("Converting with LibreOffice…".into()),
        );

        let log_path = job_dir.join("log.txt");
        let started = Instant::now();
        run_soffice(
            &cfg.soffice,
            &profile,
            &outdir,
            &staged,
            &log_path,
            cfg.timeout,
            &cancel,
            &pgid_slot,
        )?;

        if cancel.load(Ordering::Relaxed) {
            let _ = fs::remove_dir_all(&job_dir);
            return Err("cancelled".to_string());
        }

        emit(
            &on_progress,
            "caching",
            2,
            Some(format!(
                "Caching PDF… ({}s)",
                started.elapsed().as_secs()
            )),
        );

        let pdf_src = find_output_pdf(&outdir)?;
        let pdf_meta = fs::metadata(&pdf_src).map_err(|e| format!("pdf stat: {e}"))?;
        let pdf_size = pdf_meta.len();
        if pdf_size == 0 {
            let _ = fs::remove_dir_all(&job_dir);
            return Err("convert_failed".to_string());
        }
        if pdf_size > cfg.max_pdf_bytes {
            let _ = fs::remove_dir_all(&job_dir);
            return Err("too_large".to_string());
        }

        promote_to_cache(&cfg.office_dir, &cache_key, &pdf_src, root, path, mtime, src_size)?;
        enforce_cache_budget(&cfg.office_dir, cfg.cache_bytes);
        let _ = fs::remove_dir_all(&job_dir);

        Ok(OfficeConvertResult {
            cache_key,
            size: pdf_size,
        })
    })();

    runtime.inflight.fetch_sub(1, Ordering::AcqRel);
    outcome
}

fn emit(on_progress: &Option<ProgressFn>, phase: &str, processed: u64, message: Option<String>) {
    if let Some(cb) = on_progress {
        cb(phase, processed, message);
    }
}

fn make_cache_key(root: &str, path: &str, mtime: u64, size: u64, version_id: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(root.as_bytes());
    hasher.update([0]);
    hasher.update(path.as_bytes());
    hasher.update([0]);
    hasher.update(mtime.to_le_bytes());
    hasher.update(size.to_le_bytes());
    hasher.update([0]);
    hasher.update(version_id.as_bytes());
    hex::encode(hasher.finalize())
}

fn cache_pdf_path(office_dir: &Path, key: &str) -> PathBuf {
    office_dir.join("cache").join(format!("{key}.pdf"))
}

fn cache_meta_path(office_dir: &Path, key: &str) -> PathBuf {
    office_dir.join("cache").join(format!("{key}.json"))
}

fn cache_pdf_size(office_dir: &Path, key: &str) -> Option<u64> {
    let pdf = cache_pdf_path(office_dir, key);
    let meta = fs::metadata(pdf).ok()?;
    if meta.is_file() && meta.len() > 0 {
        Some(meta.len())
    } else {
        None
    }
}

fn touch_cache_meta(office_dir: &Path, key: &str) {
    let path = cache_meta_path(office_dir, key);
    if let Ok(mut f) = fs::OpenOptions::new().write(true).read(true).open(&path) {
        let mut buf = String::new();
        let _ = f.read_to_string(&mut buf);
        if let Ok(mut v) = serde_json::from_str::<serde_json::Value>(&buf) {
            let hits = v.get("hits").and_then(|h| h.as_u64()).unwrap_or(0) + 1;
            v["hits"] = serde_json::json!(hits);
            v["last_access"] = serde_json::json!(now_secs());
            let _ = fs::write(path, v.to_string());
        }
    }
}

fn promote_to_cache(
    office_dir: &Path,
    key: &str,
    pdf_src: &Path,
    root: &str,
    path: &str,
    mtime: u64,
    src_size: u64,
) -> Result<(), String> {
    let cache_dir = office_dir.join("cache");
    fs::create_dir_all(&cache_dir).map_err(|e| format!("mkdir cache: {e}"))?;
    let dest = cache_pdf_path(office_dir, key);
    let tmp = cache_dir.join(format!("{key}.pdf.tmp"));
    fs::copy(pdf_src, &tmp).map_err(|e| format!("cache copy: {e}"))?;
    fs::rename(&tmp, &dest).map_err(|e| format!("cache rename: {e}"))?;
    let meta = serde_json::json!({
        "root": root,
        "path": path,
        "mtime": mtime,
        "src_size": src_size,
        "created_at": now_secs(),
        "last_access": now_secs(),
        "hits": 1u64,
    });
    let _ = fs::write(cache_meta_path(office_dir, key), meta.to_string());
    Ok(())
}

fn enforce_cache_budget(office_dir: &Path, budget: u64) {
    if budget == 0 {
        // Delete all cache entries.
        let cache = office_dir.join("cache");
        if let Ok(entries) = fs::read_dir(cache) {
            for e in entries.flatten() {
                let _ = fs::remove_file(e.path());
            }
        }
        return;
    }
    let cache = office_dir.join("cache");
    let Ok(entries) = fs::read_dir(&cache) else {
        return;
    };
    let mut pdfs: Vec<(PathBuf, u64, u64)> = Vec::new(); // path, size, last_access
    let mut total = 0u64;
    for e in entries.flatten() {
        let path = e.path();
        if path.extension().and_then(|x| x.to_str()) != Some("pdf") {
            continue;
        }
        let Ok(meta) = e.metadata() else { continue };
        let size = meta.len();
        total = total.saturating_add(size);
        let key = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        let last_access = read_last_access(office_dir, &key).unwrap_or(0);
        pdfs.push((path, size, last_access));
    }
    if total <= budget {
        return;
    }
    pdfs.sort_by_key(|(_, _, a)| *a);
    for (path, size, _) in pdfs {
        if total <= budget {
            break;
        }
        let key = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        let _ = fs::remove_file(&path);
        let _ = fs::remove_file(cache_meta_path(office_dir, &key));
        total = total.saturating_sub(size);
    }
}

fn read_last_access(office_dir: &Path, key: &str) -> Option<u64> {
    let buf = fs::read_to_string(cache_meta_path(office_dir, key)).ok()?;
    let v: serde_json::Value = serde_json::from_str(&buf).ok()?;
    v.get("last_access").and_then(|x| x.as_u64())
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn stage_input(src: &Path, dest: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        if fs::hard_link(src, dest).is_ok() {
            return Ok(());
        }
    }
    fs::copy(src, dest)
        .map(|_| ())
        .map_err(|e| format!("stage input: {e}"))
}

fn find_output_pdf(outdir: &Path) -> Result<PathBuf, String> {
    let mut found = None;
    let entries = fs::read_dir(outdir).map_err(|e| format!("read outdir: {e}"))?;
    for e in entries.flatten() {
        let p = e.path();
        if p.extension().and_then(|x| x.to_str()).map(|e| e.eq_ignore_ascii_case("pdf")) == Some(true)
        {
            found = Some(p);
            break;
        }
    }
    found.ok_or_else(|| "convert_failed".to_string())
}

fn run_soffice(
    soffice: &Path,
    profile: &Path,
    outdir: &Path,
    input: &Path,
    log_path: &Path,
    timeout: Duration,
    cancel: &AtomicBool,
    pgid_slot: &Mutex<Option<i32>>,
) -> Result<(), String> {
    let profile_uri = path_to_file_uri(profile);
    let log = File::create(log_path).map_err(|e| format!("open log: {e}"))?;
    let log_err = log
        .try_clone()
        .map_err(|e| format!("clone log: {e}"))?;

    let mut cmd = Command::new(soffice);
    cmd.args([
        "--headless",
        "--norestore",
        "--nolockcheck",
        "--nodefault",
        "--nofirststartwizard",
        &format!("-env:UserInstallation={profile_uri}"),
        "--convert-to",
        "pdf",
        "--outdir",
    ])
    .arg(outdir)
    .arg(input)
    .stdout(Stdio::from(log))
    .stderr(Stdio::from(log_err))
    .env_remove("DISPLAY");

    #[cfg(unix)]
    unsafe {
        use std::os::unix::process::CommandExt;
        cmd.pre_exec(|| {
            // New session ⇒ process group id == pid; kill(-pid) reaps children.
            if libc::setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }

    let mut child = cmd.spawn().map_err(|e| format!("spawn soffice: {e}"))?;
    #[cfg(unix)]
    {
        let pid = child.id() as i32;
        if let Ok(mut g) = pgid_slot.lock() {
            *g = Some(pid);
        }
    }

    let deadline = Instant::now() + timeout;
    loop {
        if cancel.load(Ordering::Relaxed) {
            let _ = child.kill();
            #[cfg(unix)]
            if let Ok(g) = pgid_slot.lock() {
                if let Some(pgid) = *g {
                    kill_process_group(pgid);
                }
            }
            let _ = child.wait();
            return Err("cancelled".to_string());
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                if let Ok(mut g) = pgid_slot.lock() {
                    *g = None;
                }
                if status.success() {
                    return Ok(());
                }
                // Truncate log note for operators; error code stays stable.
                let _ = append_log_note(log_path, &format!("soffice exited {status}"));
                return Err("convert_failed".to_string());
            }
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    #[cfg(unix)]
                    if let Ok(g) = pgid_slot.lock() {
                        if let Some(pgid) = *g {
                            kill_process_group(pgid);
                        }
                    }
                    let _ = child.wait();
                    if let Ok(mut g) = pgid_slot.lock() {
                        *g = None;
                    }
                    return Err("timeout".to_string());
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(e) => {
                if let Ok(mut g) = pgid_slot.lock() {
                    *g = None;
                }
                return Err(format!("wait soffice: {e}"));
            }
        }
    }
}

fn append_log_note(log_path: &Path, note: &str) {
    if let Ok(mut f) = fs::OpenOptions::new().append(true).open(log_path) {
        let _ = writeln!(f, "{note}");
    }
}

fn path_to_file_uri(path: &Path) -> String {
    let abs = path
        .canonicalize()
        .unwrap_or_else(|_| path.to_path_buf());
    let s = abs.to_string_lossy();
    // LibreOffice expects file:///absolute/path
    if s.starts_with('/') {
        format!("file://{s}")
    } else {
        format!("file:///{s}")
    }
}

#[cfg(unix)]
fn kill_process_group(pgid: i32) {
    if pgid > 0 {
        unsafe {
            let _ = libc::kill(-pgid, libc::SIGKILL);
        }
    }
}

#[cfg(not(unix))]
fn kill_process_group(_pgid: i32) {}

fn reap_stale_jobs(jobs_dir: &Path) {
    let Ok(entries) = fs::read_dir(jobs_dir) else {
        return;
    };
    for e in entries.flatten() {
        let p = e.path();
        if p.is_dir() {
            let _ = fs::remove_dir_all(p);
        }
    }
}

/// Read a cached PDF by virtual-path cache key.
pub fn read_cache_range(
    office_dir: &Path,
    cache_key: &str,
    offset: u64,
    length: Option<u64>,
) -> Result<(Vec<u8>, bool), String> {
    if cache_key.len() != 64 || !cache_key.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("invalid cache key".to_string());
    }
    let path = cache_pdf_path(office_dir, cache_key);
    let mut file = File::open(&path).map_err(|_| "Office preview cache miss".to_string())?;
    let file_len = file
        .metadata()
        .map_err(|e| format!("stat cache: {e}"))?
        .len();
    if offset >= file_len {
        return Ok((vec![], true));
    }
    file.seek(SeekFrom::Start(offset))
        .map_err(|e| format!("seek cache: {e}"))?;
    let remaining = file_len - offset;
    let to_read = length.unwrap_or(remaining).min(remaining).min(4 * 1024 * 1024);
    let mut buf = vec![0u8; to_read as usize];
    file.read_exact(&mut buf)
        .map_err(|e| format!("read cache: {e}"))?;
    let done = offset + to_read >= file_len;
    touch_cache_meta(office_dir, cache_key);
    Ok((buf, done))
}

pub fn stat_cache(office_dir: &Path, cache_key: &str) -> Result<u64, String> {
    cache_pdf_size(office_dir, cache_key).ok_or_else(|| "Office preview cache miss".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use filebox_protocol::resources::RootConfig;
    use std::os::unix::fs::PermissionsExt;
    use tempfile::TempDir;

    fn write_fake_soffice(dir: &Path, delay_ms: u64, fail: bool) -> PathBuf {
        let path = dir.join("soffice");
        let script = format!(
            r#"#!/bin/sh
set -e
if [ "$1" = "--headless" ] && [ "$2" = "--version" ]; then
  echo "LibreOffice 26.2.5.2 fake"
  exit 0
fi
outdir=""
input=""
prev=""
for a in "$@"; do
  if [ "$prev" = "--outdir" ]; then outdir="$a"; fi
  prev="$a"
  input="$a"
done
if [ -z "$outdir" ] || [ -z "$input" ]; then
  echo "bad args" >&2
  exit 2
fi
{sleep}
{fail_block}
base=$(basename "$input")
name=${{base%.*}}
printf '%%PDF-1.4 fake\n' > "$outdir/$name.pdf"
exit 0
"#,
            sleep = if delay_ms > 0 {
                format!("sleep {}", delay_ms as f64 / 1000.0)
            } else {
                String::new()
            },
            fail_block = if fail {
                "echo fail >&2; exit 1"
            } else {
                "true"
            }
        );
        fs::write(&path, script).unwrap();
        let mut perms = fs::metadata(&path).unwrap().permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&path, perms).unwrap();
        path
    }

    fn cfg_with_soffice(tmp: &TempDir, soffice: PathBuf) -> OfficeConfig {
        OfficeConfig {
            soffice,
            version_id: "LibreOffice 26.2.5.2 fake".into(),
            timeout: Duration::from_secs(5),
            max_src_bytes: 10 * 1024 * 1024,
            max_pdf_bytes: 10 * 1024 * 1024,
            cache_bytes: 10 * 1024 * 1024,
            office_dir: tmp.path().join("office"),
        }
    }

    #[test]
    fn parse_virtual_path_accepts_hex_key() {
        let key = "a".repeat(64);
        let path = format!("/.filebox/office-cache/{key}.pdf");
        assert_eq!(parse_cache_virtual_path(&path).as_deref(), Some(key.as_str()));
        assert!(parse_cache_virtual_path("/.filebox/office-cache/nope.pdf").is_none());
        assert!(parse_cache_virtual_path("/docs/a.docx").is_none());
    }

    #[test]
    fn probe_and_convert_with_fake_soffice() {
        let tmp = TempDir::new().unwrap();
        let soffice = write_fake_soffice(tmp.path(), 0, false);
        std::env::set_var("FILEBOX_AGENT_SOFFICE", &soffice);
        let probed = probe_from_env(tmp.path()).expect("probe");
        std::env::remove_var("FILEBOX_AGENT_SOFFICE");
        assert!(probed.version_id.to_lowercase().contains("libreoffice"));

        let root_dir = tmp.path().join("root");
        fs::create_dir_all(&root_dir).unwrap();
        let doc = root_dir.join("report.docx");
        fs::write(&doc, b"fake-docx-bytes").unwrap();
        let roots = vec![RootConfig {
            name: "docs".into(),
            path: root_dir.to_string_lossy().into(),
            enabled: true,
            pinned_folders: vec![],
        }];

        let runtime = OfficeRuntime::new(cfg_with_soffice(&tmp, soffice));
        let result = run_convert(&runtime, &roots, "req1", "docs", "/report.docx", None)
            .expect("convert");
        assert_eq!(result.cache_key.len(), 64);
        assert!(result.size > 0);

        // Cache hit — no second convert needed (still single-flight ok).
        let result2 = run_convert(&runtime, &roots, "req2", "docs", "/report.docx", None)
            .expect("cache hit");
        assert_eq!(result2.cache_key, result.cache_key);

        let (data, done) =
            read_cache_range(&runtime.config.office_dir, &result.cache_key, 0, None).unwrap();
        assert!(done);
        assert!(data.starts_with(b"%PDF"));
    }

    #[test]
    fn convert_respects_cancel() {
        let tmp = TempDir::new().unwrap();
        let soffice = write_fake_soffice(tmp.path(), 2000, false);
        let root_dir = tmp.path().join("root");
        fs::create_dir_all(&root_dir).unwrap();
        fs::write(root_dir.join("a.pptx"), b"x").unwrap();
        let roots = vec![RootConfig {
            name: "docs".into(),
            path: root_dir.to_string_lossy().into(),
            enabled: true,
            pinned_folders: vec![],
        }];
        let runtime = OfficeRuntime::new(cfg_with_soffice(&tmp, soffice));
        let rt = runtime.clone();
        let handle = std::thread::spawn(move || {
            run_convert(&rt, &roots, "cancel-me", "docs", "/a.pptx", None)
        });
        std::thread::sleep(Duration::from_millis(100));
        runtime.request_cancel("cancel-me");
        let err = handle.join().unwrap().unwrap_err();
        assert_eq!(err, "cancelled");
    }

    #[test]
    fn convert_times_out() {
        let tmp = TempDir::new().unwrap();
        let soffice = write_fake_soffice(tmp.path(), 3000, false);
        let root_dir = tmp.path().join("root");
        fs::create_dir_all(&root_dir).unwrap();
        fs::write(root_dir.join("a.xls"), b"x").unwrap();
        let roots = vec![RootConfig {
            name: "docs".into(),
            path: root_dir.to_string_lossy().into(),
            enabled: true,
            pinned_folders: vec![],
        }];
        let mut cfg = cfg_with_soffice(&tmp, soffice);
        cfg.timeout = Duration::from_millis(200);
        let runtime = OfficeRuntime::new(cfg);
        let err = run_convert(&runtime, &roots, "to", "docs", "/a.xls", None).unwrap_err();
        assert_eq!(err, "timeout");
    }

    #[test]
    fn rejects_unsupported_and_too_large() {
        let tmp = TempDir::new().unwrap();
        let soffice = write_fake_soffice(tmp.path(), 0, false);
        let root_dir = tmp.path().join("root");
        fs::create_dir_all(&root_dir).unwrap();
        fs::write(root_dir.join("a.txt"), b"x").unwrap();
        fs::write(root_dir.join("big.docx"), vec![0u8; 100]).unwrap();
        let roots = vec![RootConfig {
            name: "docs".into(),
            path: root_dir.to_string_lossy().into(),
            enabled: true,
            pinned_folders: vec![],
        }];
        let mut cfg = cfg_with_soffice(&tmp, soffice);
        cfg.max_src_bytes = 10;
        let runtime = OfficeRuntime::new(cfg);
        assert_eq!(
            run_convert(&runtime, &roots, "r1", "docs", "/a.txt", None).unwrap_err(),
            "unsupported_format"
        );
        assert_eq!(
            run_convert(&runtime, &roots, "r2", "docs", "/big.docx", None).unwrap_err(),
            "too_large"
        );
    }

    #[test]
    fn single_flight_busy() {
        let tmp = TempDir::new().unwrap();
        let soffice = write_fake_soffice(tmp.path(), 500, false);
        let root_dir = tmp.path().join("root");
        fs::create_dir_all(&root_dir).unwrap();
        fs::write(root_dir.join("a.docx"), b"1").unwrap();
        fs::write(root_dir.join("b.docx"), b"2").unwrap();
        let roots = vec![RootConfig {
            name: "docs".into(),
            path: root_dir.to_string_lossy().into(),
            enabled: true,
            pinned_folders: vec![],
        }];
        let runtime = OfficeRuntime::new(cfg_with_soffice(&tmp, soffice));
        let rt1 = runtime.clone();
        let roots1 = roots.clone();
        let t1 = std::thread::spawn(move || {
            run_convert(&rt1, &roots1, "a", "docs", "/a.docx", None)
        });
        std::thread::sleep(Duration::from_millis(50));
        let err = run_convert(&runtime, &roots, "b", "docs", "/b.docx", None).unwrap_err();
        assert!(err.starts_with("agent_busy"));
        t1.join().unwrap().unwrap();
    }
}
