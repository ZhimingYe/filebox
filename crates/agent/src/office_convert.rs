//! External LibreOffice (`soffice`) Office preview conversion.
//!
//! Enabled only when `FILEBOX_AGENT_SOFFICE` (or `_DIR`) points at a working
//! binary. Each convert runs in an isolated job sandbox with its own
//! UserInstallation profile; cancel/timeout kill the process group.

use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use filebox_protocol::message::OfficePreviewOutput;
use filebox_protocol::resources::RootConfig;
use sha2::{Digest, Sha256};

/// Virtual path prefix for cached derived previews (not listed by fs_list).
pub const OFFICE_CACHE_VPATH_PREFIX: &str = "/.filebox/office-cache/";

const ALLOWED_EXTS: &[&str] = &[
    "doc", "docx", "docm", "ppt", "pptx", "pptm", "xls", "xlsx", "xlsm", "ods",
];
const SPREADSHEET_EXTS: &[&str] = &["xls", "xlsx", "xlsm", "ods"];
const CSV_CONVERT_SPEC: &str =
    "csv:Text - txt - csv (StarCalc):44,34,76,1,,0,false,true,true,false,false,-1";

const DEFAULT_TIMEOUT_SECS: u64 = 120;
const DEFAULT_MAX_SRC_BYTES: u64 = 512 * 1024 * 1024;
const DEFAULT_MAX_PDF_BYTES: u64 = 1024 * 1024 * 1024;
const DEFAULT_CACHE_BYTES: u64 = 1024 * 1024 * 1024;
const DEFAULT_MAX_LOG_BYTES: u64 = 8 * 1024 * 1024;
const DEFAULT_MAX_MEMORY_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_SPREADSHEET_SHEETS: usize = 2048;
const CACHE_FILE_ACCOUNTING_FLOOR_BYTES: u64 = 4096;
const PROBE_TIMEOUT: Duration = Duration::from_secs(5);
const DEGRADED_RETRY_COOLDOWN: Duration = Duration::from_secs(30);
static CACHE_META_WRITE_SEQ: AtomicU64 = AtomicU64::new(0);

#[derive(Clone)]
pub struct OfficeConfig {
    pub soffice: PathBuf,
    pub version_id: String,
    pub timeout: Duration,
    pub max_src_bytes: u64,
    pub max_pdf_bytes: u64,
    pub cache_bytes: u64,
    pub max_log_bytes: u64,
    pub max_memory_bytes: u64,
    pub office_dir: PathBuf,
}

#[derive(Debug, Clone)]
pub struct OfficeConvertResult {
    pub cache_key: String,
    pub size: u64,
    pub outputs: Vec<OfficePreviewOutput>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OfficeCachePath {
    pub cache_key: String,
    pub format: String,
}

/// Shared runtime for convert jobs (single-flight + cancel handles).
pub struct OfficeRuntime {
    pub config: OfficeConfig,
    inflight: AtomicUsize,
    /// req_id → (cancel flag, optional process group id)
    jobs: Mutex<HashMap<String, OfficeJobHandle>>,
    degraded_until: Mutex<Option<Instant>>,
}

struct OfficeJobHandle {
    cancel: Arc<AtomicBool>,
    pgid: Arc<Mutex<Option<i32>>>,
}

impl OfficeRuntime {
    pub fn new(config: OfficeConfig) -> Result<Arc<Self>, String> {
        fs::create_dir_all(config.office_dir.join("cache"))
            .map_err(|e| diagnostic("office_storage_error", format!("create cache dir: {e}")))?;
        fs::create_dir_all(config.office_dir.join("jobs"))
            .map_err(|e| diagnostic("office_storage_error", format!("create jobs dir: {e}")))?;
        // Reap crashed leftovers from a previous process.
        reap_stale_jobs(&config.office_dir.join("jobs"));
        reap_stale_cache_temps(&config.office_dir.join("cache"));
        enforce_cache_budget(&config.office_dir, config.cache_bytes);
        Ok(Arc::new(Self {
            config,
            inflight: AtomicUsize::new(0),
            jobs: Mutex::new(HashMap::new()),
            degraded_until: Mutex::new(None),
        }))
    }

    pub fn is_ready(&self) -> bool {
        self.degraded_until
            .lock()
            .map(|until| until.map(|deadline| deadline <= Instant::now()).unwrap_or(true))
            .unwrap_or(false)
    }

    pub fn reserve_job(self: &Arc<Self>, req_id: &str) -> Result<OfficeJobLease, String> {
        if !self.is_ready() {
            return Err("office_unavailable".to_string());
        }
        if self
            .inflight
            .compare_exchange(0, 1, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return Err("agent_busy".to_string());
        }
        let cancel = Arc::new(AtomicBool::new(false));
        let pgid = Arc::new(Mutex::new(None));
        let inserted = self.jobs.lock().map(|mut jobs| {
            jobs.insert(
                req_id.to_string(),
                OfficeJobHandle {
                    cancel: cancel.clone(),
                    pgid: pgid.clone(),
                },
            );
        });
        if inserted.is_err() {
            self.inflight.store(0, Ordering::Release);
            return Err("office_internal_error".to_string());
        }
        Ok(OfficeJobLease {
            runtime: self.clone(),
            req_id: req_id.to_string(),
            cancel,
            pgid,
        })
    }

    fn note_unavailable(&self) {
        if let Ok(mut until) = self.degraded_until.lock() {
            *until = Some(Instant::now() + DEGRADED_RETRY_COOLDOWN);
        }
    }

    fn note_success(&self) {
        if let Ok(mut until) = self.degraded_until.lock() {
            *until = None;
        }
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

pub struct OfficeJobLease {
    runtime: Arc<OfficeRuntime>,
    req_id: String,
    cancel: Arc<AtomicBool>,
    pgid: Arc<Mutex<Option<i32>>>,
}

impl Drop for OfficeJobLease {
    fn drop(&mut self) {
        if let Ok(mut jobs) = self.runtime.jobs.lock() {
            jobs.remove(&self.req_id);
        }
        self.runtime.inflight.store(0, Ordering::Release);
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
    let timeout = Duration::from_secs(
        env_u64(
            "FILEBOX_AGENT_OFFICE_TIMEOUT_SECS",
            DEFAULT_TIMEOUT_SECS,
        )
        .clamp(10, 60 * 60),
    );
    let max_src_bytes = env_u64(
        "FILEBOX_AGENT_OFFICE_MAX_SRC_BYTES",
        DEFAULT_MAX_SRC_BYTES,
    );
    let max_pdf_bytes = env_u64(
        "FILEBOX_AGENT_OFFICE_MAX_PDF_BYTES",
        DEFAULT_MAX_PDF_BYTES,
    );
    let cache_bytes = env_u64("FILEBOX_AGENT_OFFICE_CACHE_BYTES", DEFAULT_CACHE_BYTES);
    let max_log_bytes = env_u64(
        "FILEBOX_AGENT_OFFICE_MAX_LOG_BYTES",
        DEFAULT_MAX_LOG_BYTES,
    );
    let max_memory_bytes = env_u64(
        "FILEBOX_AGENT_OFFICE_MAX_MEMORY_BYTES",
        DEFAULT_MAX_MEMORY_BYTES,
    );
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
        max_log_bytes,
        max_memory_bytes,
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
    let mut command = Command::new(soffice);
    command
        .args(["--headless", "--version"])
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(unix)]
    unsafe {
        use std::os::unix::process::CommandExt;
        command.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut child = command
        .spawn()
        .map_err(|e| format!("failed to spawn soffice: {e}"))?;
    let probe_pgid = child.id() as i32;
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| "failed to capture soffice version output".to_string())?;
    let reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout.by_ref().take(64 * 1024).read_to_end(&mut buf);
        buf
    });
    let deadline = Instant::now() + PROBE_TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(25));
            }
            Ok(None) => {
                kill_process_group(probe_pgid);
                let _ = child.kill();
                let _ = child.wait();
                return Err("soffice --version timed out".to_string());
            }
            Err(e) => {
                kill_process_group(probe_pgid);
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("failed waiting for soffice --version: {e}"));
            }
        }
    };
    let stdout = reader
        .join()
        .map_err(|_| "soffice version reader panicked".to_string())?;
    if !status.success() {
        return Err(format!("soffice --version exited {status}"));
    }
    let stdout = String::from_utf8_lossy(&stdout);
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

/// Parse `/.filebox/office-cache/<64-hex>.(pdf|csv)`.
pub fn parse_cache_virtual_path(path: &str) -> Option<OfficeCachePath> {
    let rest = path.strip_prefix(OFFICE_CACHE_VPATH_PREFIX)?;
    let (key, format) = rest.rsplit_once('.')?;
    if !matches!(format, "pdf" | "csv") {
        return None;
    }
    if key.len() == 64 && key.chars().all(|c| c.is_ascii_hexdigit()) {
        Some(OfficeCachePath {
            cache_key: key.to_ascii_lowercase(),
            format: format.to_string(),
        })
    } else {
        None
    }
}

#[allow(dead_code)] // Used by callers / tests; keep API next to parse_cache_virtual_path.
pub fn cache_virtual_path(cache_key: &str, format: &str) -> String {
    format!("{OFFICE_CACHE_VPATH_PREFIX}{cache_key}.{format}")
}

pub type ProgressFn = Arc<dyn Fn(&str, u64, Option<String>) + Send + Sync>;

pub fn run_convert(
    runtime: &Arc<OfficeRuntime>,
    roots: &[RootConfig],
    req_id: &str,
    root: &str,
    path: &str,
    on_progress: Option<ProgressFn>,
) -> Result<OfficeConvertResult, String> {
    let lease = runtime.reserve_job(req_id)?;
    run_convert_reserved(runtime, roots, req_id, root, path, lease, on_progress)
}

pub fn run_convert_reserved(
    runtime: &OfficeRuntime,
    roots: &[RootConfig],
    req_id: &str,
    root: &str,
    path: &str,
    lease: OfficeJobLease,
    on_progress: Option<ProgressFn>,
) -> Result<OfficeConvertResult, String> {
    let result = run_convert_inner(
        runtime,
        roots,
        req_id,
        root,
        path,
        lease.cancel.clone(),
        lease.pgid.clone(),
        on_progress,
    );
    if matches!(&result, Err(error) if error == "office_unavailable") {
        runtime.note_unavailable();
    } else if result.is_ok() {
        runtime.note_success();
    }
    drop(lease);
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

    // Resolve once, then apply the denylist to the canonical path relative to
    // the canonical root. This prevents an allowed-looking in-root symlink
    // from redirecting conversion to a denied file.
    let (abs_src, root_canon) = crate::fs::resolve_path(roots, root, path)
        .map_err(|e| diagnostic("office_source_unavailable", e))?;
    let rel_path = abs_src
        .strip_prefix(&root_canon)
        .map_err(|_| "denied".to_string())?;
    if filebox_protocol::denylist::is_denied(&rel_path.to_string_lossy()) {
        return Err("denied".to_string());
    }

    // Open through the shared O_NOFOLLOW/openat path and keep this descriptor
    // for staging, closing the canonicalize→open substitution window.
    let mut source = crate::fs::open_resolved_leaf(&root_canon, rel_path, &abs_src)
        .map_err(|e| diagnostic("office_source_unavailable", e))?;
    let meta = source
        .metadata()
        .map_err(|e| diagnostic("office_source_unavailable", format!("stat source: {e}")))?;
    if !meta.is_file() {
        return Err("office_source_unavailable".to_string());
    }
    let src_size = meta.len();
    if src_size > cfg.max_src_bytes {
        return Err("office_source_too_large".to_string());
    }
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let outcome = (|| {
        if cancel.load(Ordering::Relaxed) {
            return Err("cancelled".to_string());
        }
        emit(
            &on_progress,
            "preparing",
            0,
            Some("Preparing preview…".into()),
        );

        let deadline = Instant::now() + cfg.timeout;
        let job_dir = cfg
            .office_dir
            .join("jobs")
            .join(hex::encode(Sha256::digest(req_id.as_bytes())));
        let _ = fs::remove_dir_all(&job_dir);
        let _job_cleanup = JobDirCleanup(job_dir.clone());
        let profile = job_dir.join("profile");
        let indir = job_dir.join("in");
        let outdir = job_dir.join("out");
        fs::create_dir_all(&profile)
            .map_err(|e| diagnostic("office_storage_error", format!("mkdir profile: {e}")))?;
        fs::create_dir_all(&indir)
            .map_err(|e| diagnostic("office_storage_error", format!("mkdir input: {e}")))?;
        fs::create_dir_all(&outdir)
            .map_err(|e| diagnostic("office_storage_error", format!("mkdir output: {e}")))?;
        let staged = indir.join(format!("source.{ext}"));
        let fingerprint = stage_and_fingerprint_source(
            &mut source,
            &staged,
            &cancel,
            deadline,
            cfg.max_src_bytes,
            src_size,
            on_progress.as_ref(),
        )?;
        let spreadsheet = SPREADSHEET_EXTS.contains(&ext.as_str());
        let conversion_key = make_cache_key(
            root,
            path,
            &fingerprint,
            &cfg.version_id,
            if spreadsheet { "csv-sheets-v1" } else { "pdf-v1" },
        );

        if let Some(outputs) = load_cached_outputs(&cfg.office_dir, &conversion_key) {
            let primary = &outputs[0];
            return Ok(OfficeConvertResult {
                cache_key: primary.cache_key.clone(),
                size: primary.size,
                outputs,
            });
        }

        if cancel.load(Ordering::Relaxed) {
            return Err("cancelled".to_string());
        }

        emit(
            &on_progress,
            "converting",
            1,
            Some(if spreadsheet {
                "Converting worksheets to CSV…".into()
            } else {
                "Converting to PDF…".into()
            }),
        );

        let log_path = job_dir.join("log.txt");
        let started = Instant::now();
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .ok_or_else(|| "office_timeout".to_string())?;
        run_soffice(
            cfg,
            &profile,
            &outdir,
            &staged,
            &log_path,
            remaining,
            &cancel,
            &pgid_slot,
            &job_dir,
            if spreadsheet { CSV_CONVERT_SPEC } else { "pdf" },
        )?;

        if cancel.load(Ordering::Relaxed) {
            return Err("cancelled".to_string());
        }

        emit(
            &on_progress,
            "caching",
            2,
            Some(format!(
                "Finishing preview… ({}s)",
                started.elapsed().as_secs()
            )),
        );

        let derived = find_outputs(&outdir, spreadsheet)?;
        let total_size = derived.iter().try_fold(0u64, |total, output| {
            let size = fs::metadata(&output.path)
                .map_err(|e| diagnostic("office_storage_error", format!("stat output: {e}")))?
                .len();
            if size == 0 && output.format != "csv" {
                return Err("office_convert_failed".to_string());
            }
            total
                .checked_add(size)
                .ok_or_else(|| "office_output_too_large".to_string())
        })?;
        if total_size > cfg.max_pdf_bytes {
            return Err("office_output_too_large".to_string());
        }
        if cfg.cache_bytes == 0 || total_size > cfg.cache_bytes {
            return Err(diagnostic(
                "office_cache_too_small",
                format!(
                    "converted preview ({total_size} bytes) exceeds Office cache budget ({} bytes)",
                    cfg.cache_bytes
                ),
            ));
        }

        let mut outputs = Vec::with_capacity(derived.len());
        for (index, output) in derived.iter().enumerate() {
            let cache_key = if output.format == "pdf" {
                conversion_key.clone()
            } else {
                make_output_cache_key(&conversion_key, index, &output.label, &output.format)
            };
            let size = fs::metadata(&output.path)
                .map_err(|e| diagnostic("office_storage_error", format!("stat output: {e}")))?
                .len();
            if let Err(error) = promote_to_cache(
                &cfg.office_dir,
                &cache_key,
                &output.format,
                &output.path,
                root,
                &root_canon,
                path,
                mtime,
                src_size,
                &fingerprint,
            ) {
                remove_cached_outputs(&cfg.office_dir, &outputs);
                return Err(error);
            }
            outputs.push(OfficePreviewOutput {
                label: output.label.clone(),
                format: output.format.clone(),
                cache_key,
                size,
            });
        }
        if let Err(error) = write_cache_manifest(&cfg.office_dir, &conversion_key, &outputs) {
            remove_cached_outputs(&cfg.office_dir, &outputs);
            return Err(error);
        }
        let preserve_keys: Vec<String> =
            outputs.iter().map(|output| output.cache_key.clone()).collect();
        if !enforce_cache_budget_preserving(&cfg.office_dir, cfg.cache_bytes, &preserve_keys) {
            let _ = fs::remove_file(cache_manifest_path(&cfg.office_dir, &conversion_key));
            remove_cached_outputs(&cfg.office_dir, &outputs);
            return Err(diagnostic(
                "office_cache_too_small",
                format!(
                    "converted preview and cache metadata exceed Office cache budget ({} bytes)",
                    cfg.cache_bytes
                ),
            ));
        }

        let primary = &outputs[0];
        Ok(OfficeConvertResult {
            cache_key: primary.cache_key.clone(),
            size: primary.size,
            outputs,
        })
    })();

    outcome
}

fn emit(on_progress: &Option<ProgressFn>, phase: &str, processed: u64, message: Option<String>) {
    if let Some(cb) = on_progress {
        cb(phase, processed, message);
    }
}

fn make_cache_key(
    root: &str,
    path: &str,
    fingerprint: &str,
    version_id: &str,
    preview_format: &str,
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(root.as_bytes());
    hasher.update([0]);
    hasher.update(path.as_bytes());
    hasher.update([0]);
    hasher.update(fingerprint.as_bytes());
    hasher.update([0]);
    hasher.update(version_id.as_bytes());
    if preview_format != "pdf-v1" {
        hasher.update([0]);
        hasher.update(preview_format.as_bytes());
    }
    hex::encode(hasher.finalize())
}

fn make_output_cache_key(
    conversion_key: &str,
    index: usize,
    label: &str,
    format: &str,
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(conversion_key.as_bytes());
    hasher.update([0]);
    hasher.update(index.to_string().as_bytes());
    hasher.update([0]);
    hasher.update(label.as_bytes());
    hasher.update([0]);
    hasher.update(format.as_bytes());
    hex::encode(hasher.finalize())
}

fn cache_artifact_path(office_dir: &Path, key: &str, format: &str) -> PathBuf {
    office_dir.join("cache").join(format!("{key}.{format}"))
}

fn cache_meta_path(office_dir: &Path, key: &str) -> PathBuf {
    office_dir.join("cache").join(format!("{key}.json"))
}

fn cache_manifest_path(office_dir: &Path, conversion_key: &str) -> PathBuf {
    office_dir
        .join("cache")
        .join(format!("{conversion_key}.manifest.json"))
}

fn cache_artifact_size(office_dir: &Path, key: &str, format: &str) -> Option<u64> {
    let artifact = cache_artifact_path(office_dir, key, format);
    let meta = fs::metadata(artifact).ok()?;
    if meta.is_file() && (format == "csv" || meta.len() > 0) {
        Some(meta.len())
    } else {
        None
    }
}

fn load_cached_outputs(
    office_dir: &Path,
    conversion_key: &str,
) -> Option<Vec<OfficePreviewOutput>> {
    let manifest_path = cache_manifest_path(office_dir, conversion_key);
    if let Ok(raw) = fs::read_to_string(&manifest_path) {
        if let Ok(outputs) = serde_json::from_str::<Vec<OfficePreviewOutput>>(&raw) {
            let valid = !outputs.is_empty()
                && outputs.len() <= MAX_SPREADSHEET_SHEETS
                && outputs.iter().all(|output| {
                    !output.label.is_empty()
                        && output.label.chars().count() <= 256
                        && matches!(output.format.as_str(), "pdf" | "csv")
                        && output.cache_key.len() == 64
                        && output.cache_key.chars().all(|c| c.is_ascii_hexdigit())
                        && cache_metadata_has_format(
                            office_dir,
                            &output.cache_key,
                            &output.format,
                        )
                        && cache_artifact_size(
                            office_dir,
                            &output.cache_key,
                            &output.format,
                        ) == Some(output.size)
                });
            if valid {
                for output in &outputs {
                    touch_cache_meta(office_dir, &output.cache_key);
                }
                return Some(outputs);
            }
        }
        let _ = fs::remove_file(manifest_path);
    }

    // A PDF created by the previous cache schema remains usable.
    if !cache_metadata_has_format(office_dir, conversion_key, "pdf") {
        return None;
    }
    let size = cache_artifact_size(office_dir, conversion_key, "pdf")?;
    touch_cache_meta(office_dir, conversion_key);
    Some(vec![OfficePreviewOutput {
        label: "Document".to_string(),
        format: "pdf".to_string(),
        cache_key: conversion_key.to_string(),
        size,
    }])
}

fn touch_cache_meta(office_dir: &Path, key: &str) {
    let path = cache_meta_path(office_dir, key);
    let Ok(buf) = fs::read_to_string(&path) else {
        return;
    };
    if let Ok(mut v) = serde_json::from_str::<serde_json::Value>(&buf) {
        let hits = v
            .get("hits")
            .and_then(|h| h.as_u64())
            .unwrap_or(0)
            .saturating_add(1);
        v["hits"] = serde_json::json!(hits);
        v["last_access"] = serde_json::json!(now_secs());
        let _ = write_cache_meta_atomic(&path, &v.to_string());
    }
}

fn cache_metadata_has_format(office_dir: &Path, key: &str, format: &str) -> bool {
    fs::read_to_string(cache_meta_path(office_dir, key))
        .ok()
        .and_then(|raw| serde_json::from_str::<OfficeCacheMetadata>(&raw).ok())
        .is_some_and(|metadata| metadata.format == format)
}

fn promote_to_cache(
    office_dir: &Path,
    key: &str,
    format: &str,
    source: &Path,
    root: &str,
    root_canonical: &Path,
    path: &str,
    mtime: u64,
    src_size: u64,
    fingerprint: &str,
) -> Result<(), String> {
    let cache_dir = office_dir.join("cache");
    fs::create_dir_all(&cache_dir)
        .map_err(|e| diagnostic("office_storage_error", format!("mkdir cache: {e}")))?;
    let dest = cache_artifact_path(office_dir, key, format);
    let tmp = cache_dir.join(format!("{key}.{format}.tmp"));
    let mut tmp_cleanup = FileCleanup {
        path: tmp.clone(),
        active: true,
    };
    fs::copy(source, &tmp)
        .map_err(|e| diagnostic("office_storage_error", format!("cache copy: {e}")))?;
    fs::rename(&tmp, &dest)
        .map_err(|e| diagnostic("office_storage_error", format!("cache rename: {e}")))?;
    tmp_cleanup.active = false;
    let meta = serde_json::json!({
        "root": root,
        "root_identity": path_identity(root_canonical),
        "path": path,
        "format": format,
        "mtime": mtime,
        "src_size": src_size,
        "fingerprint": fingerprint,
        "created_at": now_secs(),
        "last_access": now_secs(),
        "hits": 1u64,
    });
    if let Err(e) = write_cache_meta_atomic(&cache_meta_path(office_dir, key), &meta.to_string()) {
        let _ = fs::remove_file(&dest);
        return Err(diagnostic(
            "office_storage_error",
            format!("cache metadata: {e}"),
        ));
    }
    Ok(())
}

fn write_cache_manifest(
    office_dir: &Path,
    conversion_key: &str,
    outputs: &[OfficePreviewOutput],
) -> Result<(), String> {
    let raw = serde_json::to_string(outputs)
        .map_err(|e| diagnostic("office_internal_error", format!("serialize manifest: {e}")))?;
    write_cache_meta_atomic(&cache_manifest_path(office_dir, conversion_key), &raw)
        .map_err(|e| diagnostic("office_storage_error", format!("cache manifest: {e}")))
}

fn remove_cached_outputs(office_dir: &Path, outputs: &[OfficePreviewOutput]) {
    for output in outputs {
        let _ = fs::remove_file(cache_artifact_path(
            office_dir,
            &output.cache_key,
            &output.format,
        ));
        let _ = fs::remove_file(cache_meta_path(office_dir, &output.cache_key));
    }
}

fn write_cache_meta_atomic(path: &Path, contents: &str) -> std::io::Result<()> {
    let seq = CACHE_META_WRITE_SEQ.fetch_add(1, Ordering::Relaxed);
    let tmp = path.with_extension(format!("json.tmp.{}.{}", std::process::id(), seq));
    let mut cleanup = FileCleanup {
        path: tmp.clone(),
        active: true,
    };
    fs::write(&tmp, contents)?;
    fs::rename(&tmp, path)?;
    cleanup.active = false;
    Ok(())
}

fn enforce_cache_budget(office_dir: &Path, budget: u64) {
    let _ = enforce_cache_budget_inner(office_dir, budget, &[]);
}

fn enforce_cache_budget_preserving(
    office_dir: &Path,
    budget: u64,
    preserve_keys: &[String],
) -> bool {
    enforce_cache_budget_inner(office_dir, budget, preserve_keys)
}

struct CacheEvictionEntry {
    files: Vec<(PathBuf, u64)>,
    keys: Vec<String>,
    accounted_size: u64,
    last_access: u64,
}

fn cache_file_accounted_size(path: &Path) -> Option<u64> {
    let metadata = fs::metadata(path).ok()?;
    metadata
        .is_file()
        .then_some(metadata.len().max(CACHE_FILE_ACCOUNTING_FLOOR_BYTES))
}

fn cache_key_is_valid(key: &str) -> bool {
    key.len() == 64 && key.chars().all(|c| c.is_ascii_hexdigit())
}

fn cache_entry(
    files: Vec<PathBuf>,
    keys: Vec<String>,
    last_access: u64,
) -> Option<CacheEvictionEntry> {
    let files: Vec<(PathBuf, u64)> = files
        .into_iter()
        .map(|path| cache_file_accounted_size(&path).map(|size| (path, size)))
        .collect::<Option<_>>()?;
    let accounted_size = files
        .iter()
        .fold(0u64, |total, (_, size)| total.saturating_add(*size));
    Some(CacheEvictionEntry {
        files,
        keys,
        accounted_size,
        last_access,
    })
}

fn remove_cache_entry(entry: &CacheEvictionEntry) -> u64 {
    let mut removed = 0u64;
    for (path, accounted_size) in &entry.files {
        match fs::remove_file(path) {
            Ok(()) => removed = removed.saturating_add(*accounted_size),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                removed = removed.saturating_add(*accounted_size);
            }
            Err(error) => {
                tracing::warn!(
                    "Failed to evict Office cache file {}: {}",
                    path.display(),
                    error
                );
            }
        }
    }
    removed
}

fn collect_cache_entries(office_dir: &Path) -> Vec<CacheEvictionEntry> {
    let cache = office_dir.join("cache");
    let Ok(read_dir) = fs::read_dir(&cache) else {
        return Vec::new();
    };
    let paths: Vec<PathBuf> = read_dir
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.is_file())
        .collect();
    let mut entries = Vec::new();
    let mut referenced_keys = HashSet::new();

    for manifest_path in paths.iter().filter(|path| {
        path.file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.ends_with(".manifest.json"))
    }) {
        let parsed = fs::read_to_string(manifest_path)
            .ok()
            .and_then(|raw| serde_json::from_str::<Vec<OfficePreviewOutput>>(&raw).ok());
        let Some(outputs) = parsed else {
            let _ = fs::remove_file(manifest_path);
            continue;
        };
        let mut group_keys = HashSet::new();
        let descriptors_valid = !outputs.is_empty()
            && outputs.len() <= MAX_SPREADSHEET_SHEETS
            && outputs.iter().all(|output| {
                !output.label.is_empty()
                    && output.label.chars().count() <= 256
                    && matches!(output.format.as_str(), "pdf" | "csv")
                    && cache_key_is_valid(&output.cache_key)
                    && group_keys.insert(output.cache_key.clone())
            });
        if !descriptors_valid {
            let _ = fs::remove_file(manifest_path);
            continue;
        }

        let mut files = vec![manifest_path.clone()];
        let mut last_access = 0u64;
        let complete = outputs.iter().all(|output| {
            let artifact = cache_artifact_path(office_dir, &output.cache_key, &output.format);
            let metadata = cache_meta_path(office_dir, &output.cache_key);
            if cache_file_accounted_size(&artifact).is_none()
                || cache_file_accounted_size(&metadata).is_none()
                || !cache_metadata_has_format(office_dir, &output.cache_key, &output.format)
            {
                return false;
            }
            files.push(artifact);
            files.push(metadata);
            last_access =
                last_access.max(read_last_access(office_dir, &output.cache_key).unwrap_or(0));
            true
        });
        if !complete {
            remove_cached_outputs(office_dir, &outputs);
            let _ = fs::remove_file(manifest_path);
            continue;
        }

        let keys: Vec<String> = outputs
            .iter()
            .map(|output| output.cache_key.clone())
            .collect();
        if keys.iter().any(|key| referenced_keys.contains(key)) {
            let _ = fs::remove_file(manifest_path);
            continue;
        }
        referenced_keys.extend(keys.iter().cloned());
        if let Some(entry) = cache_entry(files, keys, last_access) {
            entries.push(entry);
        }
    }

    let mut standalone_keys = HashSet::new();
    for artifact in paths.iter().filter(|path| {
        matches!(
            path.extension().and_then(|extension| extension.to_str()),
            Some("pdf" | "csv")
        )
    }) {
        let key = artifact
            .file_stem()
            .and_then(|stem| stem.to_str())
            .unwrap_or("");
        if !cache_key_is_valid(key) {
            let _ = fs::remove_file(artifact);
            continue;
        }
        if referenced_keys.contains(key) {
            continue;
        }
        let format = artifact
            .extension()
            .and_then(|extension| extension.to_str())
            .unwrap_or("");
        let metadata = cache_meta_path(office_dir, key);
        if !cache_metadata_has_format(office_dir, key, format) {
            let _ = fs::remove_file(artifact);
            let _ = fs::remove_file(metadata);
            continue;
        }
        let key = key.to_string();
        let last_access = read_last_access(office_dir, &key).unwrap_or(0);
        if let Some(entry) = cache_entry(
            vec![artifact.clone(), metadata],
            vec![key.clone()],
            last_access,
        ) {
            standalone_keys.insert(key);
            entries.push(entry);
        }
    }

    for metadata in paths.iter().filter(|path| {
        path.file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.ends_with(".json") && !name.ends_with(".manifest.json"))
    }) {
        let key = metadata
            .file_stem()
            .and_then(|stem| stem.to_str())
            .unwrap_or("");
        if !referenced_keys.contains(key) && !standalone_keys.contains(key) {
            let _ = fs::remove_file(metadata);
        }
    }

    entries
}

fn enforce_cache_budget_inner(
    office_dir: &Path,
    budget: u64,
    preserve_keys: &[String],
) -> bool {
    if budget == 0 {
        // Delete all cache entries.
        let cache = office_dir.join("cache");
        if let Ok(entries) = fs::read_dir(cache) {
            for e in entries.flatten() {
                let _ = fs::remove_file(e.path());
            }
        }
        return true;
    }

    let mut entries = collect_cache_entries(office_dir);
    let mut total = entries.iter().fold(0u64, |sum, entry| {
        sum.saturating_add(entry.accounted_size)
    });
    if total <= budget {
        return true;
    }
    entries.sort_by_key(|entry| entry.last_access);
    for entry in entries {
        if total <= budget {
            break;
        }
        if entry
            .keys
            .iter()
            .any(|key| preserve_keys.iter().any(|preserve| preserve == key))
        {
            continue;
        }
        total = total.saturating_sub(remove_cache_entry(&entry));
    }
    total <= budget
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

struct JobDirCleanup(PathBuf);

impl Drop for JobDirCleanup {
    fn drop(&mut self) {
        if let Err(e) = fs::remove_dir_all(&self.0) {
            if e.kind() != std::io::ErrorKind::NotFound {
                tracing::warn!("Failed to clean Office job {}: {}", self.0.display(), e);
            }
        }
    }
}

struct FileCleanup {
    path: PathBuf,
    active: bool,
}

impl Drop for FileCleanup {
    fn drop(&mut self) {
        if self.active {
            let _ = fs::remove_file(&self.path);
        }
    }
}

fn stage_and_fingerprint_source(
    src: &mut File,
    dest: &Path,
    cancel: &AtomicBool,
    deadline: Instant,
    max_bytes: u64,
    source_size: u64,
    on_progress: Option<&ProgressFn>,
) -> Result<String, String> {
    src.seek(SeekFrom::Start(0))
        .map_err(|e| diagnostic("office_source_unavailable", format!("seek source: {e}")))?;
    let mut out = File::create(dest)
        .map_err(|e| diagnostic("office_storage_error", format!("create staged input: {e}")))?;
    let mut hasher = Sha256::new();
    let mut copied = 0u64;
    let mut buf = vec![0u8; 1024 * 1024];
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err("cancelled".to_string());
        }
        if Instant::now() >= deadline {
            return Err("office_timeout".to_string());
        }
        let read = src
            .read(&mut buf)
            .map_err(|e| diagnostic("office_source_unavailable", format!("read source: {e}")))?;
        if read == 0 {
            break;
        }
        copied = copied.saturating_add(read as u64);
        if copied > max_bytes {
            return Err("office_source_too_large".to_string());
        }
        hasher.update(&buf[..read]);
        out.write_all(&buf[..read])
            .map_err(|e| diagnostic("office_storage_error", format!("stage input: {e}")))?;
        if copied == read as u64 || copied % (8 * 1024 * 1024) < read as u64 {
            if let Some(callback) = on_progress {
                callback(
                    "preparing",
                    copied,
                    Some(format!(
                        "Reading source… {} / {} MiB",
                        copied / (1024 * 1024),
                        source_size / (1024 * 1024)
                    )),
                );
            }
        }
    }
    out.sync_all()
        .map_err(|e| diagnostic("office_storage_error", format!("sync staged input: {e}")))?;
    Ok(hex::encode(hasher.finalize()))
}

struct DerivedOutput {
    path: PathBuf,
    label: String,
    format: String,
}

fn find_outputs(outdir: &Path, spreadsheet: bool) -> Result<Vec<DerivedOutput>, String> {
    let expected_format = if spreadsheet { "csv" } else { "pdf" };
    let mut found = Vec::new();
    let entries = fs::read_dir(outdir)
        .map_err(|e| diagnostic("office_storage_error", format!("read output dir: {e}")))?;
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if !file_type.is_file() {
            continue;
        }
        let path = entry.path();
        if path
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value.eq_ignore_ascii_case(expected_format))
        {
            found.push(path);
            if found.len() > MAX_SPREADSHEET_SHEETS {
                return Err("office_output_too_large".to_string());
            }
        }
    }
    found.sort_by(|left, right| left.file_name().cmp(&right.file_name()));
    if found.is_empty() || (!spreadsheet && found.len() != 1) {
        return Err("office_convert_failed".to_string());
    }
    Ok(found
        .into_iter()
        .enumerate()
        .map(|(index, path)| {
            let label = if spreadsheet {
                path.file_stem()
                    .and_then(|value| value.to_str())
                    .and_then(|value| value.strip_prefix("source-"))
                    .filter(|value| !value.is_empty())
                    .map(|value| value.chars().take(256).collect())
                    .unwrap_or_else(|| format!("Sheet {}", index + 1))
            } else {
                "Document".to_string()
            };
            DerivedOutput {
                path,
                label,
                format: expected_format.to_string(),
            }
        })
        .collect())
}

fn diagnostic(code: &str, detail: impl std::fmt::Display) -> String {
    tracing::warn!("Office operation failed [{}]: {}", code, detail);
    code.to_string()
}

fn run_soffice(
    cfg: &OfficeConfig,
    profile: &Path,
    outdir: &Path,
    input: &Path,
    log_path: &Path,
    timeout: Duration,
    cancel: &AtomicBool,
    pgid_slot: &Mutex<Option<i32>>,
    job_dir: &Path,
    convert_spec: &str,
) -> Result<(), String> {
    let profile_uri = path_to_file_uri(profile);
    let tmp_dir = job_dir.join("tmp");
    fs::create_dir_all(&tmp_dir)
        .map_err(|e| diagnostic("office_storage_error", format!("create temp dir: {e}")))?;
    let log = Arc::new(Mutex::new(
        File::create(log_path)
            .map_err(|e| diagnostic("office_storage_error", format!("open log: {e}")))?,
    ));
    let log_remaining = Arc::new(AtomicU64::new(cfg.max_log_bytes));

    let mut cmd = Command::new(&cfg.soffice);
    cmd.args([
        "--headless",
        "--norestore",
        "--nolockcheck",
        "--nodefault",
        "--nofirststartwizard",
        &format!("-env:UserInstallation={profile_uri}"),
        "--convert-to",
        convert_spec,
        "--outdir",
    ])
    .arg(outdir)
    .arg(input)
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .env_remove("DISPLAY")
    .env("TMPDIR", &tmp_dir)
    .env("TMP", &tmp_dir)
    .env("TEMP", &tmp_dir);

    #[cfg(unix)]
    unsafe {
        use std::os::unix::process::CommandExt;
        let max_memory = cfg.max_memory_bytes;
        let max_file = cfg.max_pdf_bytes.max(1024 * 1024);
        let cpu_secs = timeout.as_secs().saturating_add(10).max(1);
        cmd.pre_exec(move || {
            // New session ⇒ process group id == pid; kill(-pid) reaps children.
            if libc::setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }
            // macOS rejects RLIMIT_AS with EINVAL. Keep the address-space cap
            // on Linux/Android and retain portable limits on other Unix hosts.
            #[cfg(any(target_os = "linux", target_os = "android"))]
            set_process_limit(libc::RLIMIT_AS, max_memory)?;
            #[cfg(not(any(target_os = "linux", target_os = "android")))]
            let _ = max_memory;
            set_process_limit(libc::RLIMIT_FSIZE, max_file)?;
            set_process_limit(libc::RLIMIT_NOFILE, 256)?;
            set_process_limit(libc::RLIMIT_CPU, cpu_secs)?;
            Ok(())
        });
    }

    let mut child = cmd.spawn().map_err(|e| {
        if matches!(
            e.kind(),
            std::io::ErrorKind::NotFound | std::io::ErrorKind::PermissionDenied
        ) {
            diagnostic(
                "office_unavailable",
                "configured soffice disappeared or is not executable",
            )
        } else {
            diagnostic("office_convert_failed", format!("spawn soffice: {e}"))
        }
    })?;
    let mut stdout_log = child.stdout.take().map(|reader| {
        spawn_log_drain(reader, log.clone(), log_remaining.clone())
    });
    let mut stderr_log = child.stderr.take().map(|reader| {
        spawn_log_drain(reader, log.clone(), log_remaining.clone())
    });
    #[cfg(unix)]
    {
        let pid = child.id() as i32;
        if let Ok(mut g) = pgid_slot.lock() {
            *g = Some(pid);
        }
    }

    let deadline = Instant::now() + timeout;
    let max_job_bytes = cfg
        .max_src_bytes
        .saturating_add(cfg.max_pdf_bytes)
        .saturating_add(cfg.max_log_bytes)
        .saturating_add(256 * 1024 * 1024);
    let mut next_disk_check = Instant::now() + Duration::from_secs(1);
    loop {
        if cancel.load(Ordering::Relaxed) {
            terminate_child(&mut child, pgid_slot);
            finish_log_drain(stdout_log.take(), stderr_log.take());
            return Err("cancelled".to_string());
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                #[cfg(unix)]
                if let Ok(g) = pgid_slot.lock() {
                    if let Some(pgid) = *g {
                        kill_process_group(pgid);
                    }
                }
                if let Ok(mut g) = pgid_slot.lock() {
                    *g = None;
                }
                finish_log_drain(stdout_log.take(), stderr_log.take());
                if status.success() {
                    return Ok(());
                }
                let _ = append_log_note(log_path, &format!("soffice exited {status}"));
                if matches!(status.code(), Some(126) | Some(127)) {
                    return Err("office_unavailable".to_string());
                }
                return Err("office_convert_failed".to_string());
            }
            Ok(None) => {
                if Instant::now() >= next_disk_check {
                    if directory_size_exceeds(job_dir, max_job_bytes) {
                        terminate_child(&mut child, pgid_slot);
                        finish_log_drain(stdout_log.take(), stderr_log.take());
                        return Err("office_output_too_large".to_string());
                    }
                    next_disk_check = Instant::now() + Duration::from_secs(1);
                }
                if Instant::now() >= deadline {
                    terminate_child(&mut child, pgid_slot);
                    finish_log_drain(stdout_log.take(), stderr_log.take());
                    return Err("office_timeout".to_string());
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(e) => {
                terminate_child(&mut child, pgid_slot);
                finish_log_drain(stdout_log.take(), stderr_log.take());
                return Err(diagnostic(
                    "office_convert_failed",
                    format!("wait soffice: {e}"),
                ));
            }
        }
    }
}

fn directory_size_exceeds(root: &Path, limit: u64) -> bool {
    let mut total = 0u64;
    let mut pending = vec![root.to_path_buf()];
    while let Some(dir) = pending.pop() {
        let Ok(entries) = fs::read_dir(dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_dir() {
                pending.push(entry.path());
            } else if file_type.is_file() {
                let Ok(metadata) = entry.metadata() else {
                    continue;
                };
                total = total.saturating_add(metadata.len());
                if total > limit {
                    return true;
                }
            }
        }
    }
    false
}

#[cfg(any(target_os = "linux", target_os = "android"))]
type RlimitResource = libc::__rlimit_resource_t;
#[cfg(all(unix, not(any(target_os = "linux", target_os = "android"))))]
type RlimitResource = libc::c_int;

#[cfg(unix)]
fn set_process_limit(resource: RlimitResource, value: u64) -> std::io::Result<()> {
    let limit = libc::rlimit {
        rlim_cur: value as libc::rlim_t,
        rlim_max: value as libc::rlim_t,
    };
    if unsafe { libc::setrlimit(resource, &limit) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

fn spawn_log_drain<R>(
    mut reader: R,
    log: Arc<Mutex<File>>,
    remaining: Arc<AtomicU64>,
) -> std::thread::JoinHandle<()>
where
    R: Read + Send + 'static,
{
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            let Ok(read) = reader.read(&mut buf) else {
                break;
            };
            if read == 0 {
                break;
            }
            let allowed = loop {
                let current = remaining.load(Ordering::Relaxed);
                if current == 0 {
                    break 0;
                }
                let take = current.min(read as u64);
                if remaining
                    .compare_exchange(
                        current,
                        current - take,
                        Ordering::AcqRel,
                        Ordering::Relaxed,
                    )
                    .is_ok()
                {
                    break take as usize;
                }
            };
            if allowed > 0 {
                if let Ok(mut file) = log.lock() {
                    let _ = file.write_all(&buf[..allowed]);
                }
            }
        }
    })
}

fn finish_log_drain(
    stdout: Option<std::thread::JoinHandle<()>>,
    stderr: Option<std::thread::JoinHandle<()>>,
) {
    if let Some(handle) = stdout {
        let _ = handle.join();
    }
    if let Some(handle) = stderr {
        let _ = handle.join();
    }
}

fn terminate_child(child: &mut std::process::Child, pgid_slot: &Mutex<Option<i32>>) {
    #[cfg(unix)]
    if let Ok(g) = pgid_slot.lock() {
        if let Some(pgid) = *g {
            kill_process_group(pgid);
        }
    }
    let _ = child.kill();
    let _ = child.wait();
    if let Ok(mut g) = pgid_slot.lock() {
        *g = None;
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

fn reap_stale_cache_temps(cache_dir: &Path) {
    let Ok(entries) = fs::read_dir(cache_dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.ends_with(".tmp") || name.contains(".json.tmp.") {
            let _ = fs::remove_file(entry.path());
        }
    }
}

/// Read a cached derived preview by virtual path.
pub fn read_cache_range(
    office_dir: &Path,
    roots: &[RootConfig],
    requested_root: &str,
    cache: &OfficeCachePath,
    offset: u64,
    length: Option<u64>,
) -> Result<(Vec<u8>, bool), String> {
    if cache.cache_key.len() != 64
        || !cache.cache_key.chars().all(|c| c.is_ascii_hexdigit())
        || !matches!(cache.format.as_str(), "pdf" | "csv")
    {
        return Err("invalid cache key".to_string());
    }
    authorize_cache_source(
        office_dir,
        roots,
        requested_root,
        &cache.cache_key,
        &cache.format,
    )?;
    let path = cache_artifact_path(office_dir, &cache.cache_key, &cache.format);
    let mut file = File::open(&path).map_err(|_| "Office preview cache miss".to_string())?;
    let file_len = file
        .metadata()
        .map_err(|e| diagnostic("office_storage_error", format!("stat cache: {e}")))?
        .len();
    if offset >= file_len {
        touch_cache_meta(office_dir, &cache.cache_key);
        return Ok((vec![], true));
    }
    file.seek(SeekFrom::Start(offset))
        .map_err(|e| diagnostic("office_storage_error", format!("seek cache: {e}")))?;
    let remaining = file_len - offset;
    let to_read = length.unwrap_or(remaining).min(remaining).min(4 * 1024 * 1024);
    let mut buf = vec![0u8; to_read as usize];
    file.read_exact(&mut buf)
        .map_err(|e| diagnostic("office_storage_error", format!("read cache: {e}")))?;
    let done = offset + to_read >= file_len;
    touch_cache_meta(office_dir, &cache.cache_key);
    Ok((buf, done))
}

pub fn stat_cache(
    office_dir: &Path,
    roots: &[RootConfig],
    requested_root: &str,
    cache: &OfficeCachePath,
) -> Result<u64, String> {
    authorize_cache_source(
        office_dir,
        roots,
        requested_root,
        &cache.cache_key,
        &cache.format,
    )?;
    let size = cache_artifact_size(office_dir, &cache.cache_key, &cache.format)
        .ok_or_else(|| "Office preview cache miss".to_string())?;
    touch_cache_meta(office_dir, &cache.cache_key);
    Ok(size)
}

#[derive(serde::Deserialize)]
struct OfficeCacheMetadata {
    root: String,
    root_identity: String,
    path: String,
    #[serde(default = "default_pdf_format")]
    format: String,
}

fn default_pdf_format() -> String {
    "pdf".to_string()
}

fn authorize_cache_source(
    office_dir: &Path,
    roots: &[RootConfig],
    requested_root: &str,
    cache_key: &str,
    format: &str,
) -> Result<(), String> {
    let raw = fs::read_to_string(cache_meta_path(office_dir, cache_key))
        .map_err(|_| "Office preview cache miss".to_string())?;
    let meta: OfficeCacheMetadata = serde_json::from_str(&raw)
        .map_err(|_| "Office preview cache metadata is invalid".to_string())?;
    if meta.root != requested_root {
        return Err("denied".to_string());
    }
    if meta.format != format {
        return Err("denied".to_string());
    }
    // Revalidate the current root identity for every cache access, but do not
    // reopen/re-hash the Office source on every Range request. The cached
    // preview is already immutable and was created only after canonical denylist
    // checks; repeated source I/O would make large remote documents stall.
    let (_, root_canon) = crate::fs::resolve_path(roots, &meta.root, "/")
        .map_err(|_| "root_unavailable".to_string())?;
    if meta.root_identity != path_identity(&root_canon) {
        return Err("root_unavailable".to_string());
    }
    let relative = meta.path.strip_prefix('/').unwrap_or(&meta.path);
    if filebox_protocol::denylist::is_denied(relative) {
        return Err("denied".to_string());
    }
    Ok(())
}

fn path_identity(path: &Path) -> String {
    hex::encode(Sha256::digest(path.as_os_str().as_encoded_bytes()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use filebox_protocol::resources::RootConfig;
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::fs::symlink;
    use tempfile::TempDir;

    fn write_fake_soffice(dir: &Path, delay_ms: u64, fail: bool) -> PathBuf {
        write_fake_soffice_named(dir, "soffice", delay_ms, fail, true)
    }

    fn write_fake_soffice_named(
        dir: &Path,
        name: &str,
        delay_ms: u64,
        fail: bool,
        libreoffice_version: bool,
    ) -> PathBuf {
        let path = dir.join(name);
        let version_line = if libreoffice_version {
            "LibreOffice 26.2.5.2 fake"
        } else {
            "SomeOtherOffice 1.0"
        };
        let script = format!(
            r#"#!/bin/sh
set -e
if [ "$1" = "--headless" ] && [ "$2" = "--version" ]; then
  echo "{version_line}"
  exit 0
fi
outdir=""
input=""
convert=""
prev=""
for a in "$@"; do
  if [ "$prev" = "--outdir" ]; then outdir="$a"; fi
  if [ "$prev" = "--convert-to" ]; then convert="$a"; fi
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
case "$convert" in
  csv:*)
    printf 'name,value\nalpha,1\n' > "$outdir/$name-Sheet1.csv"
    : > "$outdir/$name-Sheet2.csv"
    exit 0
    ;;
esac
# Minimal pdf.js-compatible PDF (same bytes as scripts/e2e_office_preview.sh).
echo 'JVBERi0xLjQKMSAwIG9iajw8IC9UeXBlIC9DYXRhbG9nIC9QYWdlcyAyIDAgUiA+PmVuZG9iagoyIDAgb2JqPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj5lbmRvYmoKMyAwIG9iajw8IC9UeXBlIC9QYWdlIC9QYXJlbnQgMiAwIFIgL01lZGlhQm94IFswIDAgNjEyIDc5Ml0gL0NvbnRlbnRzIDQgMCBSIC9SZXNvdXJjZXM8PCAvRm9udDw8IC9GMSA1IDAgUiA+PiA+PiA+PmVuZG9iago0IDAgb2JqPDwgL0xlbmd0aCAzNiA+PnN0cmVhbQpCVCAvRjEgMjQgVGYgNzIgNzIwIFRkIChIZWxsbykgVGogRVQKZW5kc3RyZWFtCmVuZG9iago1IDAgb2JqPDwgL1R5cGUgL0ZvbnQgL1N1YnR5cGUgL1R5cGUxIC9CYXNlRm9udCAvSGVsdmV0aWNhID4+ZW5kb2JqCnhyZWYKMCA2CjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDAwOSAwMDAwMCBuIAowMDAwMDAwMDU2IDAwMDAwIG4gCjAwMDAwMDAxMTEgMDAwMDAgbiAKMDAwMDAwMDIzMyAwMDAwMCBuIAowMDAwMDAwMzE3IDAwMDAwIG4gCnRyYWlsZXI8PCAvU2l6ZSA2IC9Sb290IDEgMCBSID4+CnN0YXJ0eHJlZgozODUKJSVFT0YK' | base64 -d > "$outdir/$name.pdf"
exit 0
"#,
            version_line = version_line,
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

    fn make_roots(root_dir: &Path) -> Vec<RootConfig> {
        vec![RootConfig {
            name: "docs".into(),
            path: root_dir.to_string_lossy().into(),
            enabled: true,
            pinned_folders: vec![],
        }]
    }

    fn cache_total_pdf_bytes(office_dir: &Path) -> u64 {
        let cache = office_dir.join("cache");
        let Ok(entries) = fs::read_dir(cache) else {
            return 0;
        };
        entries
            .flatten()
            .filter(|e| e.path().extension().and_then(|x| x.to_str()) == Some("pdf"))
            .filter_map(|e| e.metadata().ok().map(|m| m.len()))
            .sum()
    }

    fn cache_accounted_bytes(office_dir: &Path) -> u64 {
        let cache = office_dir.join("cache");
        let Ok(entries) = fs::read_dir(cache) else {
            return 0;
        };
        entries
            .flatten()
            .filter_map(|entry| {
                entry
                    .metadata()
                    .ok()
                    .filter(|metadata| metadata.is_file())
                    .map(|metadata| metadata.len().max(CACHE_FILE_ACCOUNTING_FLOOR_BYTES))
            })
            .sum()
    }

    fn cfg_with_soffice(tmp: &TempDir, soffice: PathBuf) -> OfficeConfig {
        OfficeConfig {
            soffice,
            version_id: "LibreOffice 26.2.5.2 fake".into(),
            timeout: Duration::from_secs(5),
            max_src_bytes: 10 * 1024 * 1024,
            max_pdf_bytes: 10 * 1024 * 1024,
            cache_bytes: 10 * 1024 * 1024,
            max_log_bytes: 1024 * 1024,
            max_memory_bytes: 512 * 1024 * 1024,
            office_dir: tmp.path().join("office"),
        }
    }

    fn cache_ref(key: &str, format: &str) -> OfficeCachePath {
        OfficeCachePath {
            cache_key: key.to_string(),
            format: format.to_string(),
        }
    }

    #[test]
    fn parse_virtual_path_accepts_hex_key() {
        let key = "a".repeat(64);
        let path = format!("/.filebox/office-cache/{key}.pdf");
        assert_eq!(
            parse_cache_virtual_path(&path),
            Some(cache_ref(&key, "pdf"))
        );
        assert_eq!(
            parse_cache_virtual_path(&format!(
                "/.filebox/office-cache/{key}.csv"
            )),
            Some(cache_ref(&key, "csv"))
        );
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

        let runtime = OfficeRuntime::new(cfg_with_soffice(&tmp, soffice.clone())).unwrap();
        let result = run_convert(&runtime, &roots, "req1", "docs", "/report.docx", None)
            .expect("convert");
        assert_eq!(result.cache_key.len(), 64);
        assert!(result.size > 0);

        // Cache hit — no second convert needed (still single-flight ok).
        let result2 = run_convert(&runtime, &roots, "req2", "docs", "/report.docx", None)
            .expect("cache hit");
        assert_eq!(result2.cache_key, result.cache_key);

        let (data, done) =
            read_cache_range(
                &runtime.config.office_dir,
                &roots,
                "docs",
                &cache_ref(&result.cache_key, "pdf"),
                0,
                None,
            )
            .unwrap();
        assert!(done);
        assert!(data.starts_with(b"%PDF"));
    }

    #[test]
    fn spreadsheet_converts_every_sheet_to_cached_csv() {
        let tmp = TempDir::new().unwrap();
        let soffice = write_fake_soffice(tmp.path(), 0, false);
        let root_dir = tmp.path().join("root");
        fs::create_dir_all(&root_dir).unwrap();
        fs::write(root_dir.join("report.xlsx"), b"fake-xlsx-bytes").unwrap();
        let roots = make_roots(&root_dir);
        let runtime = OfficeRuntime::new(cfg_with_soffice(&tmp, soffice.clone())).unwrap();

        let result =
            run_convert(&runtime, &roots, "sheet-1", "docs", "/report.xlsx", None).unwrap();
        assert_eq!(result.outputs.len(), 2);
        assert_eq!(result.outputs[0].label, "Sheet1");
        assert_eq!(result.outputs[1].label, "Sheet2");
        assert_eq!(result.outputs[1].size, 0);
        assert!(result.outputs.iter().all(|output| output.format == "csv"));

        let first = &result.outputs[0];
        assert_eq!(
            stat_cache(
                &runtime.config.office_dir,
                &roots,
                "docs",
                &cache_ref(&first.cache_key, "csv"),
            )
            .unwrap(),
            first.size
        );
        assert_eq!(
            stat_cache(
                &runtime.config.office_dir,
                &roots,
                "docs",
                &cache_ref(&first.cache_key, "pdf"),
            )
            .unwrap_err(),
            "denied"
        );
        let (data, done) = read_cache_range(
            &runtime.config.office_dir,
            &roots,
            "docs",
            &cache_ref(&first.cache_key, "csv"),
            0,
            None,
        )
        .unwrap();
        assert!(done);
        assert_eq!(data, b"name,value\nalpha,1\n");
        let (empty, done) = read_cache_range(
            &runtime.config.office_dir,
            &roots,
            "docs",
            &cache_ref(&result.outputs[1].cache_key, "csv"),
            0,
            None,
        )
        .unwrap();
        assert!(done);
        assert!(empty.is_empty());

        fs::remove_file(soffice).unwrap();
        let cached =
            run_convert(&runtime, &roots, "sheet-2", "docs", "/report.xlsx", None).unwrap();
        assert_eq!(cached.outputs, result.outputs);
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
        let runtime = OfficeRuntime::new(cfg_with_soffice(&tmp, soffice)).unwrap();
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
        let runtime = OfficeRuntime::new(cfg).unwrap();
        let err = run_convert(&runtime, &roots, "to", "docs", "/a.xls", None).unwrap_err();
        assert_eq!(err, "office_timeout");
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
        let runtime = OfficeRuntime::new(cfg).unwrap();
        assert_eq!(
            run_convert(&runtime, &roots, "r1", "docs", "/a.txt", None).unwrap_err(),
            "unsupported_format"
        );
        assert_eq!(
            run_convert(&runtime, &roots, "r2", "docs", "/big.docx", None).unwrap_err(),
            "office_source_too_large"
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
        let roots = make_roots(&root_dir);
        let runtime = OfficeRuntime::new(cfg_with_soffice(&tmp, soffice)).unwrap();
        let rt1 = runtime.clone();
        let roots1 = roots.clone();
        let t1 = std::thread::spawn(move || {
            run_convert(&rt1, &roots1, "a", "docs", "/a.docx", None)
        });
        std::thread::sleep(Duration::from_millis(50));
        let err = run_convert(&runtime, &roots, "b", "docs", "/b.docx", None).unwrap_err();
        assert_eq!(err, "agent_busy");
        t1.join().unwrap().unwrap();
    }

    #[test]
    fn rejects_denylisted_office_path() {
        let tmp = TempDir::new().unwrap();
        let soffice = write_fake_soffice(tmp.path(), 0, false);
        let root_dir = tmp.path().join("root");
        let ssh = root_dir.join(".ssh");
        fs::create_dir_all(&ssh).unwrap();
        fs::write(ssh.join("notes.docx"), b"secret-docx").unwrap();
        let roots = make_roots(&root_dir);
        let runtime = OfficeRuntime::new(cfg_with_soffice(&tmp, soffice)).unwrap();
        let err = run_convert(&runtime, &roots, "den", "docs", "/.ssh/notes.docx", None)
            .unwrap_err();
        assert_eq!(err, "denied");
        assert_eq!(cache_total_pdf_bytes(&runtime.config.office_dir), 0);
    }

    #[test]
    fn rejects_symlink_alias_to_denylisted_office_path() {
        let tmp = TempDir::new().unwrap();
        let soffice = write_fake_soffice(tmp.path(), 0, false);
        let root_dir = tmp.path().join("root");
        let ssh = root_dir.join(".ssh");
        fs::create_dir_all(&ssh).unwrap();
        fs::write(ssh.join("secret.docx"), b"secret-docx").unwrap();
        symlink(".ssh/secret.docx", root_dir.join("report.docx")).unwrap();
        let roots = make_roots(&root_dir);
        let runtime = OfficeRuntime::new(cfg_with_soffice(&tmp, soffice)).unwrap();

        let err = run_convert(
            &runtime,
            &roots,
            "symlink-denied",
            "docs",
            "/report.docx",
            None,
        )
        .unwrap_err();
        assert_eq!(err, "denied");
        assert_eq!(cache_total_pdf_bytes(&runtime.config.office_dir), 0);
    }

    #[test]
    fn cache_read_rechecks_current_root_authorization() {
        let tmp = TempDir::new().unwrap();
        let soffice = write_fake_soffice(tmp.path(), 0, false);
        let root_dir = tmp.path().join("root");
        fs::create_dir_all(&root_dir).unwrap();
        fs::write(root_dir.join("report.docx"), b"one").unwrap();
        let roots = make_roots(&root_dir);
        let runtime = OfficeRuntime::new(cfg_with_soffice(&tmp, soffice)).unwrap();
        let result =
            run_convert(&runtime, &roots, "cache-auth", "docs", "/report.docx", None).unwrap();

        let mut disabled = roots.clone();
        disabled[0].enabled = false;
        assert!(
            stat_cache(
                &runtime.config.office_dir,
                &disabled,
                "docs",
                &cache_ref(&result.cache_key, "pdf"),
            )
            .is_err()
        );
        assert!(
            read_cache_range(
                &runtime.config.office_dir,
                &disabled,
                "docs",
                &cache_ref(&result.cache_key, "pdf"),
                0,
                None,
            )
            .is_err()
        );
    }

    #[test]
    fn cache_read_rejects_same_named_root_repointed_elsewhere() {
        let tmp = TempDir::new().unwrap();
        let soffice = write_fake_soffice(tmp.path(), 0, false);
        let original_root = tmp.path().join("original-root");
        let replacement_root = tmp.path().join("replacement-root");
        fs::create_dir_all(&original_root).unwrap();
        fs::create_dir_all(&replacement_root).unwrap();
        fs::write(original_root.join("report.docx"), b"original").unwrap();
        fs::write(replacement_root.join("report.docx"), b"replacement").unwrap();
        let original_roots = make_roots(&original_root);
        let runtime = OfficeRuntime::new(cfg_with_soffice(&tmp, soffice)).unwrap();
        let result = run_convert(
            &runtime,
            &original_roots,
            "cache-root-identity",
            "docs",
            "/report.docx",
            None,
        )
        .unwrap();

        let replacement_roots = make_roots(&replacement_root);
        assert!(
            stat_cache(
                &runtime.config.office_dir,
                &replacement_roots,
                "docs",
                &cache_ref(&result.cache_key, "pdf"),
            )
            .is_err()
        );
    }

    #[test]
    fn same_size_same_second_source_rewrite_changes_cache_key() {
        let tmp = TempDir::new().unwrap();
        let soffice = write_fake_soffice(tmp.path(), 0, false);
        let root_dir = tmp.path().join("root");
        fs::create_dir_all(&root_dir).unwrap();
        let source = root_dir.join("report.docx");
        fs::write(&source, b"one").unwrap();
        let roots = make_roots(&root_dir);
        let runtime = OfficeRuntime::new(cfg_with_soffice(&tmp, soffice)).unwrap();
        let first =
            run_convert(&runtime, &roots, "fingerprint-1", "docs", "/report.docx", None).unwrap();
        fs::write(&source, b"two").unwrap();
        let second =
            run_convert(&runtime, &roots, "fingerprint-2", "docs", "/report.docx", None).unwrap();
        assert_ne!(first.cache_key, second.cache_key);
    }

    #[test]
    fn virtual_path_and_cache_miss_errors() {
        assert!(parse_cache_virtual_path("/.filebox/office-cache/abcd.pdf").is_none());
        assert!(parse_cache_virtual_path("/.filebox/other/aaaa.pdf").is_none());
        let key = "b".repeat(64);
        assert!(parse_cache_virtual_path(&format!("/.filebox/office-cache/{key}.PDF")).is_none());

        let tmp = TempDir::new().unwrap();
        let office_dir = tmp.path().join("office");
        fs::create_dir_all(office_dir.join("cache")).unwrap();
        let miss_key = "c".repeat(64);
        let roots = make_roots(tmp.path());
        assert!(
            stat_cache(&office_dir, &roots, "docs", &cache_ref(&miss_key, "pdf")).is_err()
        );
        assert!(
            read_cache_range(
                &office_dir,
                &roots,
                "docs",
                &cache_ref(&miss_key, "pdf"),
                0,
                None,
            )
            .is_err()
        );
        assert!(
            read_cache_range(
                &office_dir,
                &roots,
                "docs",
                &cache_ref("short", "pdf"),
                0,
                None,
            )
            .is_err()
        );
    }

    #[test]
    fn cache_lru_respects_budget() {
        let tmp = TempDir::new().unwrap();
        let soffice = write_fake_soffice(tmp.path(), 0, false);
        let root_dir = tmp.path().join("root");
        fs::create_dir_all(&root_dir).unwrap();
        for name in ["a.docx", "b.docx", "c.docx"] {
            fs::write(root_dir.join(name), name.as_bytes()).unwrap();
        }
        let roots = make_roots(&root_dir);
        let mut cfg = cfg_with_soffice(&tmp, soffice);
        // Artifact + metadata + manifest each consume at least one accounting block.
        cfg.cache_bytes = 13 * 1024;
        let runtime = OfficeRuntime::new(cfg).unwrap();
        run_convert(&runtime, &roots, "1", "docs", "/a.docx", None).unwrap();
        run_convert(&runtime, &roots, "2", "docs", "/b.docx", None).unwrap();
        let latest = run_convert(&runtime, &roots, "3", "docs", "/c.docx", None).unwrap();
        let total = cache_total_pdf_bytes(&runtime.config.office_dir);
        assert!(total > 0);
        assert!(
            cache_accounted_bytes(&runtime.config.office_dir) <= runtime.config.cache_bytes,
            "accounted cache exceeds budget {}",
            runtime.config.cache_bytes
        );
        assert!(
            stat_cache(
                &runtime.config.office_dir,
                &roots,
                "docs",
                &cache_ref(&latest.cache_key, "pdf"),
            )
            .is_ok(),
            "budget enforcement must not evict the PDF just returned as successful"
        );
    }

    #[test]
    fn spreadsheet_cache_budget_counts_empty_sheets_and_metadata() {
        let tmp = TempDir::new().unwrap();
        let soffice = write_fake_soffice(tmp.path(), 0, false);
        let root_dir = tmp.path().join("root");
        fs::create_dir_all(&root_dir).unwrap();
        fs::write(root_dir.join("report.xlsx"), b"fake-xlsx-bytes").unwrap();
        let roots = make_roots(&root_dir);
        let mut cfg = cfg_with_soffice(&tmp, soffice);
        // Two CSVs (including one empty), two metadata files, and one manifest.
        cfg.cache_bytes = 4 * CACHE_FILE_ACCOUNTING_FLOOR_BYTES;
        let runtime = OfficeRuntime::new(cfg).unwrap();

        let error =
            run_convert(&runtime, &roots, "sheet-budget", "docs", "/report.xlsx", None)
                .unwrap_err();
        assert_eq!(error, "office_cache_too_small");
        assert_eq!(cache_accounted_bytes(&runtime.config.office_dir), 0);
    }

    #[test]
    fn incomplete_manifest_removes_the_whole_cached_conversion() {
        let tmp = TempDir::new().unwrap();
        let soffice = write_fake_soffice(tmp.path(), 0, false);
        let root_dir = tmp.path().join("root");
        fs::create_dir_all(&root_dir).unwrap();
        fs::write(root_dir.join("report.xlsx"), b"fake-xlsx-bytes").unwrap();
        let roots = make_roots(&root_dir);
        let runtime = OfficeRuntime::new(cfg_with_soffice(&tmp, soffice)).unwrap();
        let result =
            run_convert(&runtime, &roots, "sheet-orphan", "docs", "/report.xlsx", None).unwrap();

        fs::remove_file(cache_artifact_path(
            &runtime.config.office_dir,
            &result.outputs[0].cache_key,
            "csv",
        ))
        .unwrap();
        enforce_cache_budget(
            &runtime.config.office_dir,
            runtime.config.cache_bytes,
        );

        assert_eq!(cache_accounted_bytes(&runtime.config.office_dir), 0);
    }

    #[test]
    fn cache_budget_smaller_than_output_fails_without_false_success() {
        let tmp = TempDir::new().unwrap();
        let soffice = write_fake_soffice(tmp.path(), 0, false);
        let root_dir = tmp.path().join("root");
        fs::create_dir_all(&root_dir).unwrap();
        fs::write(root_dir.join("a.docx"), b"x").unwrap();
        let roots = make_roots(&root_dir);
        let mut cfg = cfg_with_soffice(&tmp, soffice);
        cfg.cache_bytes = 1;
        let runtime = OfficeRuntime::new(cfg).unwrap();

        let error =
            run_convert(&runtime, &roots, "small-cache", "docs", "/a.docx", None).unwrap_err();
        assert_eq!(error, "office_cache_too_small");
        assert_eq!(cache_total_pdf_bytes(&runtime.config.office_dir), 0);
    }

    #[test]
    fn probe_rejects_non_libreoffice_version() {
        let tmp = TempDir::new().unwrap();
        let soffice = write_fake_soffice_named(tmp.path(), "soffice", 0, false, false);
        std::env::set_var("FILEBOX_AGENT_SOFFICE", &soffice);
        assert!(probe_from_env(tmp.path()).is_none());
        std::env::remove_var("FILEBOX_AGENT_SOFFICE");
    }

    #[test]
    fn probe_rejects_missing_binary() {
        std::env::set_var("FILEBOX_AGENT_SOFFICE", "/nonexistent/soffice-xyz");
        assert!(probe_from_env(Path::new("/tmp")).is_none());
        std::env::remove_var("FILEBOX_AGENT_SOFFICE");
    }

    #[test]
    fn convert_failed_on_soffice_error() {
        let tmp = TempDir::new().unwrap();
        let soffice = write_fake_soffice(tmp.path(), 0, true);
        let root_dir = tmp.path().join("root");
        fs::create_dir_all(&root_dir).unwrap();
        fs::write(root_dir.join("a.docx"), b"x").unwrap();
        let roots = make_roots(&root_dir);
        let runtime = OfficeRuntime::new(cfg_with_soffice(&tmp, soffice)).unwrap();
        let err = run_convert(&runtime, &roots, "fail", "docs", "/a.docx", None).unwrap_err();
        assert_eq!(err, "office_convert_failed");
        assert!(
            fs::read_dir(runtime.config.office_dir.join("jobs"))
                .unwrap()
                .next()
                .is_none()
        );
    }

    #[test]
    fn disappearing_soffice_enters_passive_degraded_state() {
        let tmp = TempDir::new().unwrap();
        let soffice = write_fake_soffice(tmp.path(), 0, false);
        let root_dir = tmp.path().join("root");
        fs::create_dir_all(&root_dir).unwrap();
        fs::write(root_dir.join("a.docx"), b"x").unwrap();
        let roots = make_roots(&root_dir);
        let runtime =
            OfficeRuntime::new(cfg_with_soffice(&tmp, soffice.clone())).unwrap();
        fs::remove_file(soffice).unwrap();

        assert_eq!(
            run_convert(&runtime, &roots, "gone-1", "docs", "/a.docx", None).unwrap_err(),
            "office_unavailable"
        );
        assert_eq!(
            run_convert(&runtime, &roots, "gone-2", "docs", "/a.docx", None).unwrap_err(),
            "office_unavailable"
        );
    }

    #[test]
    fn non_executable_soffice_reports_unavailable_and_degrades_passively() {
        let tmp = TempDir::new().unwrap();
        let soffice = write_fake_soffice(tmp.path(), 0, false);
        let root_dir = tmp.path().join("root");
        fs::create_dir_all(&root_dir).unwrap();
        fs::write(root_dir.join("a.docx"), b"x").unwrap();
        let roots = make_roots(&root_dir);
        let runtime =
            OfficeRuntime::new(cfg_with_soffice(&tmp, soffice.clone())).unwrap();
        let mut permissions = fs::metadata(&soffice).unwrap().permissions();
        permissions.set_mode(0o644);
        fs::set_permissions(&soffice, permissions).unwrap();

        assert_eq!(
            run_convert(&runtime, &roots, "no-exec", "docs", "/a.docx", None).unwrap_err(),
            "office_unavailable"
        );
        assert!(!runtime.is_ready());
    }

    #[test]
    fn runtime_init_failure_disables_office() {
        let tmp = TempDir::new().unwrap();
        let soffice = write_fake_soffice(tmp.path(), 0, false);
        let blocked = tmp.path().join("not-a-directory");
        fs::write(&blocked, b"x").unwrap();
        let mut cfg = cfg_with_soffice(&tmp, soffice);
        cfg.office_dir = blocked.join("office");
        assert!(OfficeRuntime::new(cfg).is_err());
    }

    #[test]
    fn runtime_reaps_stale_jobs_on_start() {
        let tmp = TempDir::new().unwrap();
        let soffice = write_fake_soffice(tmp.path(), 0, false);
        let office_dir = tmp.path().join("office");
        let stale = office_dir.join("jobs").join("leftover-req");
        fs::create_dir_all(&stale).unwrap();
        fs::write(stale.join("log.txt"), b"old").unwrap();
        assert!(stale.exists());
        let _runtime = OfficeRuntime::new(cfg_with_soffice(&tmp, soffice)).unwrap();
        assert!(
            !stale.exists(),
            "stale job directory should be removed on runtime init"
        );
    }
}
