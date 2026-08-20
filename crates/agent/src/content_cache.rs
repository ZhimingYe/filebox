//! Whole-file content cache for the agent's read-only file path.
//!
//! **The problem it fixes:** every preview / download re-reads file bytes
//! from storage. On shared HPC filesystems (NFS / Lustre / GPFS) a read can
//! stall for seconds-to-minutes under contention, and re-reading the same
//! small file over and over multiplies that cost. Directory listings were
//! already cached ([`crate::dir_cache::DirCache`]); file **content** was not
//! — so the UI stayed smooth while file previews hit the disk fresh every
//! time.
//!
//! **How reads work (progressive — the first byte never waits for the whole
//! file):**
//! 1. a recent logical alias (`root` + relative path, restat cooldown) hits
//!    a completed entry or in-flight fill → served from memory, **no**
//!    canonicalize / open / stat (the expensive part on NFS);
//! 2. completed entry after a fresh open → served from memory;
//! 3. an in-flight fill that has reached the requested offset → wait for a
//!    full wire chunk (or EOF) from its buffer so one WS round-trip actually
//!    carries ~512 KiB, not whatever a single `read()` returned;
//! 4. otherwise a background fill starts and the requested range is read
//!    directly, looping `read()` on the same fd until the chunk is full.
//!
//! On a stalled shared filesystem a slow whole-file fill must not hold the
//! first byte hostage, but it also must not *compete* with sequential live
//! reads of the same path: once a fill is running and has reached `offset`,
//! later chunks wait on it instead of re-opening the file. Retries and
//! repeat previews converge to memory speed.
//!
//! **Validity / safety:**
//! - size **and** mtime must both match, otherwise the entry is ignored and
//!   the file is read fresh.
//! - mtime is `Option<SystemTime>`: filesystems without mtimes never cache.
//! - keyed by the canonical absolute path **after** root / denylist /
//!   symlink-escape checks, so the cache can never bypass path safety.
//! - root reconfigure clears the cache (a root's path may have changed):
//!   in-flight fills are cancelled and a generation counter makes sure a
//!   fill started before the clear can never insert afterwards.
//! - entries are immutable `Arc<Vec<u8>>` — a reader holding a reference is
//!   unaffected by eviction.
//! - whole-file reads happen only for files `<= max_file_bytes`; bigger
//!   files stream per chunk exactly as before (no unbounded memory).
//! - fills are capped (`MAX_CONCURRENT_FILLS`) so a preview storm cannot
//!   start an unbounded number of whole-file reads.

use std::collections::HashMap;
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant, SystemTime};

/// Default total memory budget for cached file content. HPC nodes have
/// plenty of RAM, so 1 GiB of hot preview bytes is a reasonable trade.
const DEFAULT_MAX_TOTAL_BYTES: usize = 1024 * 1024 * 1024;
/// Default per-file cap: files at or below this size are whole-read + cached
/// (64 MiB ≈ 128 wire chunks, comfortably inside a node's memory).
const DEFAULT_MAX_FILE_BYTES: usize = 64 * 1024 * 1024;
/// Max simultaneous background whole-file fills. Fills compete with live
/// chunk reads for storage bandwidth, so keep them few; each in-flight fill
/// may hold up to `max_file_bytes` of memory.
const MAX_CONCURRENT_FILLS: usize = 4;
/// Fill segment size: progress is published after every *full* segment so
/// live chunk reads wake up with a wire-sized buffer, not a short NFS read.
const FILL_SEGMENT_BYTES: usize = 512 * 1024;
/// Sequential preview/download chunks of the same logical path skip
/// canonicalize/open/stat while this recent. 0 = never skip (always restat).
const LOGICAL_RESTAT_COOLDOWN_MS: u64 = 2000;
/// Bound on (root, rel-path) aliases. Each is a handful of bytes; this is
/// just a leak cap if a client walks a huge tree without evicting content.
const MAX_LOGICAL_ALIASES: usize = 4096;

/// Result of waiting on an in-flight fill. Cancel is distinct from miss so a
/// cancelled request does not fall through to canonicalize/open.
#[derive(Debug)]
pub enum FillWait {
    Ready(Vec<u8>),
    Unavailable,
    Cancelled,
}

pub struct ContentCache {
    inner: Mutex<Inner>,
    max_total_bytes: usize,
    max_file_bytes: usize,
    max_fills: usize,
    fills: Mutex<Fills>,
    /// Bumped by `clear()`. A fill that started before a clear must not
    /// insert afterwards; checked atomically with the entry-map lock.
    generation: AtomicU64,
    /// (root name, relative path) → last successful open's canonical key.
    /// Lets sequential FileReadRequests skip NFS metadata for a few seconds.
    logical: Mutex<HashMap<(String, String), LogicalAlias>>,
    restat_cooldown_ms: AtomicU64,
}

/// Last successful open of a logical (root, rel) path. Validated `size` +
/// `mtime` are the content-cache key; `last_validated` is the restat clock.
struct LogicalAlias {
    path: PathBuf,
    size: u64,
    mtime: SystemTime,
    last_validated: Instant,
}

struct Inner {
    entries: HashMap<PathBuf, Entry>,
    total_bytes: usize,
    /// Monotonic recency clock for LRU eviction.
    clock: u64,
}

struct Entry {
    size: u64,
    mtime: SystemTime,
    data: Arc<Vec<u8>>,
    last_used: u64,
}

struct Fills {
    in_flight: HashMap<PathBuf, Arc<FillState>>,
    /// Count of live fill threads (including ones whose entries were
    /// dropped by `clear()` — they still hold a slot until they finish).
    active: usize,
}

/// In-flight background fill for one file.
struct FillState {
    /// File state the fill is keyed on. Requests only serve from the buffer
    /// when their own stat matches, so every chunk stays consistent with
    /// the request that opened the file.
    size: u64,
    mtime: SystemTime,
    /// Bytes read so far; grows as the fill progresses and is the source of
    /// truth for range coverage.
    data: Mutex<Vec<u8>>,
    cancelled: AtomicBool,
    /// Set just before the fill thread drops its in-flight entry so waiters
    /// can distinguish "still reading" from "gone".
    finished: AtomicBool,
    cond: Condvar,
}

impl ContentCache {
    pub fn new(max_total_bytes: usize, max_file_bytes: usize) -> Self {
        Self::new_with_fills(max_total_bytes, max_file_bytes, MAX_CONCURRENT_FILLS)
    }

    fn new_with_fills(max_total_bytes: usize, max_file_bytes: usize, max_fills: usize) -> Self {
        // Either dimension set to 0 disables caching entirely (preserve the
        // 0 verbatim — `.max(1)` here would silently re-enable it).
        let disabled = max_total_bytes == 0 || max_file_bytes == 0;
        Self {
            inner: Mutex::new(Inner {
                entries: HashMap::new(),
                total_bytes: 0,
                clock: 0,
            }),
            max_total_bytes: if disabled { 0 } else { max_total_bytes },
            max_file_bytes: if disabled { 0 } else { max_file_bytes },
            max_fills: if disabled { 0 } else { max_fills },
            fills: Mutex::new(Fills {
                in_flight: HashMap::new(),
                active: 0,
            }),
            generation: AtomicU64::new(0),
            logical: Mutex::new(HashMap::new()),
            restat_cooldown_ms: AtomicU64::new(LOGICAL_RESTAT_COOLDOWN_MS),
        }
    }

    /// Build from `FILEBOX_AGENT_CONTENT_CACHE_BYTES` (total budget) and
    /// `FILEBOX_AGENT_CONTENT_CACHE_MAX_FILE_BYTES` (per-file cap). Setting
    /// either to 0 disables caching entirely.
    pub fn from_env() -> Self {
        let total = std::env::var("FILEBOX_AGENT_CONTENT_CACHE_BYTES")
            .ok()
            .and_then(|s| s.parse::<usize>().ok())
            .unwrap_or(DEFAULT_MAX_TOTAL_BYTES);
        let per_file = std::env::var("FILEBOX_AGENT_CONTENT_CACHE_MAX_FILE_BYTES")
            .ok()
            .and_then(|s| s.parse::<usize>().ok())
            .unwrap_or(DEFAULT_MAX_FILE_BYTES);
        let cache = Self::new(total, per_file);
        let cooldown_ms = std::env::var("FILEBOX_AGENT_CONTENT_CACHE_RESTAT_COOLDOWN_MS")
            .ok()
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(LOGICAL_RESTAT_COOLDOWN_MS);
        cache
            .restat_cooldown_ms
            .store(cooldown_ms, Ordering::Release);
        cache
    }

    fn restat_cooldown(&self) -> Duration {
        Duration::from_millis(self.restat_cooldown_ms.load(Ordering::Acquire))
    }

    #[cfg(test)]
    pub fn set_restat_cooldown_ms(&self, ms: u64) {
        self.restat_cooldown_ms.store(ms, Ordering::Release);
    }

    pub fn max_file_bytes(&self) -> usize {
        self.max_file_bytes
    }

    /// Whole-file data on a (size, mtime) match; `None` otherwise.
    pub fn get(&self, path: &Path, size: u64, mtime: SystemTime) -> Option<Arc<Vec<u8>>> {
        if self.max_total_bytes == 0 {
            return None;
        }
        let mut inner = self.inner.lock().unwrap();
        // Bump the clock before touching the entry so the two borrows of
        // `inner` never overlap.
        inner.clock += 1;
        let clock = inner.clock;
        let entry = inner.entries.get_mut(path)?;
        if entry.size != size || entry.mtime != mtime {
            return None;
        }
        entry.last_used = clock;
        Some(Arc::clone(&entry.data))
    }

    #[cfg(test)]
    pub fn insert(&self, path: PathBuf, size: u64, mtime: SystemTime, data: Vec<u8>) {
        self.insert_with_generation(None, path, size, mtime, data);
    }

    fn insert_with_generation(
        &self,
        required_generation: Option<u64>,
        path: PathBuf,
        size: u64,
        mtime: SystemTime,
        data: Vec<u8>,
    ) {
        if self.max_total_bytes == 0 {
            return;
        }
        let bytes = data.len();
        if bytes == 0 || bytes as u64 != size {
            return;
        }
        let mut inner = self.inner.lock().unwrap();
        // Check under the entry-map lock: `clear()` bumps the generation
        // before it locks, so a fill started before a clear can never slip
        // an entry in afterwards (in either interleaving).
        if let Some(required) = required_generation {
            if self.generation.load(Ordering::Acquire) != required {
                return;
            }
        }
        inner.clock += 1;
        let clock = inner.clock;
        // Replace an existing entry first so re-caching a hot file doesn't
        // evict other entries to make room for a duplicate.
        if let Some(previous) = inner.entries.remove(&path) {
            inner.total_bytes = inner.total_bytes.saturating_sub(previous.data.len());
        }
        inner.entries.insert(
            path,
            Entry {
                size,
                mtime,
                data: Arc::new(data),
                last_used: clock,
            },
        );
        inner.total_bytes = inner.total_bytes.saturating_add(bytes);
        Self::evict_lru(&mut inner, self.max_total_bytes);
    }

    pub fn clear(&self) {
        // Bump first: fills that started before the clear must never insert
        // afterwards (checked atomically with the entry-map lock below).
        self.generation.fetch_add(1, Ordering::AcqRel);
        // Cancel in-flight fills and drop their shared state so live chunk
        // reads fall back to direct reads immediately.
        let mut fills = self.fills.lock().unwrap();
        for state in fills.in_flight.values() {
            state.cancelled.store(true, Ordering::Release);
            state.cond.notify_all();
        }
        fills.in_flight.clear();
        drop(fills);
        self.logical.lock().unwrap().clear();
        let mut inner = self.inner.lock().unwrap();
        inner.entries.clear();
        inner.total_bytes = 0;
        inner.clock = 0;
    }

    /// Record that `root`/`rel` resolved to `path` with this stat, so the
    /// next few sequential chunks can skip canonicalize/open/stat.
    pub fn remember_logical(
        &self,
        root: &str,
        rel: &str,
        path: PathBuf,
        size: u64,
        mtime: SystemTime,
    ) {
        if self.max_total_bytes == 0 {
            return;
        }
        let mut map = self.logical.lock().unwrap();
        map.insert(
            (root.to_string(), rel.to_string()),
            LogicalAlias {
                path,
                size,
                mtime,
                last_validated: Instant::now(),
            },
        );
        if map.len() > MAX_LOGICAL_ALIASES {
            let stale = map
                .iter()
                .min_by_key(|(_, alias)| alias.last_validated)
                .map(|(key, _)| key.clone());
            if let Some(key) = stale {
                map.remove(&key);
            }
        }
    }

    /// Canonical key + stat from a recent open of this logical path, if the
    /// restat cooldown has not expired. `None` means "open and stat again".
    pub fn logical_lookup(&self, root: &str, rel: &str) -> Option<(PathBuf, u64, SystemTime)> {
        let cooldown = self.restat_cooldown();
        if self.max_total_bytes == 0 || cooldown.is_zero() {
            return None;
        }
        let map = self.logical.lock().unwrap();
        let alias = map.get(&(root.to_string(), rel.to_string()))?;
        if alias.last_validated.elapsed() > cooldown {
            return None;
        }
        Some((alias.path.clone(), alias.size, alias.mtime))
    }

    /// Slide the restat window after a hot-path serve so a slow sequential
    /// stream does not fall back to canonicalize/open mid-download.
    pub fn touch_logical(&self, root: &str, rel: &str) {
        if self.max_total_bytes == 0 {
            return;
        }
        if let Some(alias) = self
            .logical
            .lock()
            .unwrap()
            .get_mut(&(root.to_string(), rel.to_string()))
        {
            alias.last_validated = Instant::now();
        }
    }

    /// Start a background whole-file fill for `path` (stat key
    /// `size`/`mtime`) if one isn't already running and a slot is free.
    /// The fill re-opens the file itself, aborts if the stat no longer
    /// matches, reads the whole file in segments, and inserts the finished
    /// entry. Returns `true` when a fill is running or was started.
    pub fn begin_fill(self: &Arc<Self>, path: PathBuf, size: u64, mtime: SystemTime) -> bool {
        if self.max_total_bytes == 0 || size == 0 || size > self.max_file_bytes as u64 {
            return false;
        }
        // Read the generation BEFORE registering the fill state. A fill
        // registered under a pre-clear generation can never pass
        // `insert_with_generation`'s check after `clear()` bumps the
        // generation, and one that registers after a clear has finished is
        // a fresh post-clear fill (legitimate). Reading it after
        // registration would let a fill registered pre-clear capture the
        // post-clear generation when `clear()` is preempted between its
        // `fetch_add` and its cancel loop, and slip stale bytes in after
        // the entries were wiped.
        let generation = self.generation.load(Ordering::Acquire);
        let state = {
            let mut fills = self.fills.lock().unwrap();
            if fills.in_flight.contains_key(&path) {
                return true;
            }
            if fills.active >= self.max_fills {
                return false;
            }
            let state = Arc::new(FillState {
                size,
                mtime,
                data: Mutex::new(Vec::new()),
                cancelled: AtomicBool::new(false),
                finished: AtomicBool::new(false),
                cond: Condvar::new(),
            });
            fills.in_flight.insert(path.clone(), Arc::clone(&state));
            fills.active += 1;
            state
        };
        let cache = Arc::clone(self);
        let thread_path = path.clone();
        let thread_state = Arc::clone(&state);
        if std::thread::Builder::new()
            .name("content-cache-fill".to_string())
            .spawn(move || fill_thread(cache, thread_path, generation, thread_state))
            .is_err()
        {
            // Thread spawn failed (resource exhaustion): free the slot and
            // let requests fall back to direct reads.
            self.finish_fill(&path, &state);
            return false;
        }
        true
    }

    /// Serve the requested range from an in-flight fill if it already read
    /// past it. `None` means "not covered (yet) — read directly". Serving
    /// is gated on the request's own (size, mtime) matching the fill's key
    /// so every chunk stays consistent with the request's open.
    pub fn fill_slice(
        &self,
        path: &Path,
        size: u64,
        mtime: SystemTime,
        offset: u64,
        length: Option<u64>,
        max_chunk: usize,
    ) -> Option<Vec<u8>> {
        if self.max_total_bytes == 0 {
            return None;
        }
        let Some(state) = self
            .fills
            .lock()
            .unwrap()
            .in_flight
            .get(path)
            .cloned()
        else {
            return None;
        };
        if state.size != size || state.mtime != mtime {
            return None;
        }
        let data = state.data.lock().unwrap();
        let data_len = data.len() as u64;
        if data_len < offset {
            return None;
        }
        let available = data_len - offset;
        if available == 0 {
            return None;
        }
        let to_read = length.unwrap_or(available).min(available).min(max_chunk as u64) as usize;
        if to_read == 0 {
            return None;
        }
        let start = offset as usize;
        Some(data[start..start + to_read].to_vec())
    }

    /// Wait until the in-flight fill covers a full wire chunk at `offset`
    /// (or EOF / cancellation / the fill finishing). Unlike [`fill_slice`],
    /// this does not return a short prefix; cancel is distinct from miss so
    /// callers do not fall through to a fresh open.
    pub fn wait_fill_slice(
        &self,
        path: &Path,
        size: u64,
        mtime: SystemTime,
        offset: u64,
        length: Option<u64>,
        max_chunk: usize,
        cancelled: Option<&AtomicBool>,
    ) -> FillWait {
        if cancelled.is_some_and(|c| c.load(Ordering::Acquire)) {
            return FillWait::Cancelled;
        }
        if self.max_total_bytes == 0 {
            return FillWait::Unavailable;
        }
        let Some(state) = self.fills.lock().unwrap().in_flight.get(path).cloned() else {
            return FillWait::Unavailable;
        };
        if state.size != size || state.mtime != mtime {
            return FillWait::Unavailable;
        }
        let want = {
            if offset >= size {
                return FillWait::Ready(Vec::new());
            }
            let remaining = size - offset;
            length
                .unwrap_or(remaining)
                .min(remaining)
                .min(max_chunk as u64) as usize
        };
        if want == 0 {
            return FillWait::Ready(Vec::new());
        }
        let slack = max_chunk as u64;
        loop {
            if cancelled.is_some_and(|c| c.load(Ordering::Acquire)) {
                return FillWait::Cancelled;
            }
            if state.cancelled.load(Ordering::Acquire) {
                return FillWait::Unavailable;
            }
            let guard = state.data.lock().unwrap();
            let len = guard.len() as u64;
            if len + slack < offset && !state.finished.load(Ordering::Acquire) {
                // Fill is still reading from the start; this request jumped
                // far ahead. Don't wait.
                return FillWait::Unavailable;
            }
            if len >= offset {
                let available = (len - offset) as usize;
                let finished = state.finished.load(Ordering::Acquire);
                if available >= want {
                    let start = offset as usize;
                    return FillWait::Ready(guard[start..start + want].to_vec());
                }
                if finished {
                    if available == 0 {
                        return FillWait::Unavailable;
                    }
                    if len >= size {
                        let start = offset as usize;
                        return FillWait::Ready(guard[start..start + available].to_vec());
                    }
                    return FillWait::Unavailable;
                }
            } else if state.finished.load(Ordering::Acquire) {
                return FillWait::Unavailable;
            }
            drop(
                state
                    .cond
                    .wait_timeout(guard, Duration::from_millis(50))
                    .unwrap()
                    .0,
            );
        }
    }

    fn finish_fill(&self, path: &Path, state: &Arc<FillState>) {
        if let Ok(mut fills) = self.fills.lock() {
            if fills
                .in_flight
                .get(path)
                .is_some_and(|current| Arc::ptr_eq(current, state))
            {
                fills.in_flight.remove(path);
            }
            fills.active = fills.active.saturating_sub(1);
        }
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.inner.lock().unwrap().entries.len()
    }

    #[cfg(test)]
    pub fn total_bytes(&self) -> usize {
        self.inner.lock().unwrap().total_bytes
    }

    /// Evict least-recently-used entries until the total budget fits. Never
    /// evicts the last entry when the budget is simply smaller than one
    /// file — dropping everything would defeat caching a single large file.
    fn evict_lru(inner: &mut Inner, max_total_bytes: usize) {
        while inner.total_bytes > max_total_bytes && inner.entries.len() > 1 {
            let oldest = inner
                .entries
                .iter()
                .min_by_key(|(_, entry)| entry.last_used)
                .map(|(path, _)| path.clone());
            let Some(oldest) = oldest else { break };
            if let Some(evicted) = inner.entries.remove(&oldest) {
                inner.total_bytes = inner.total_bytes.saturating_sub(evicted.data.len());
            }
        }
    }
}

/// Background whole-file read. Runs on its own OS thread (not through the
/// FS job pool) so a long fill can never occupy one of the request workers.
/// Reads in segments, publishing each segment into the shared buffer so
/// live chunk reads can start serving from it as soon as it passes them.
fn fill_thread(cache: Arc<ContentCache>, path: PathBuf, generation: u64, state: Arc<FillState>) {
    let size = state.size;
    let mtime = state.mtime;
    let display_path = path.display().to_string();
    // catch_unwind: a panic (e.g. a poisoned Mutex) must still release the
    // fill slot and drop the in-flight entry, or the slot leaks forever and
    // the path can never be cached again until a root reconfigure.
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        (|| -> std::io::Result<()> {
            let mut file = File::open(&path)?;
            let meta = file.metadata()?;
            // The file changed since the request that started this fill: abort.
            // A fresh request will start a new fill with the current stat.
            if !meta.is_file() || meta.len() != size || meta.modified().ok() != Some(mtime) {
                return Ok(());
            }
            let segment = FILL_SEGMENT_BYTES.min(size as usize).max(1);
            let mut buf = vec![0u8; segment];
            loop {
                if state.cancelled.load(Ordering::Acquire) {
                    return Ok(());
                }
                // Fill the whole segment (or EOF) before publishing. A single
                // `read()` on NFS often returns one rsize (~32–64 KiB); waking
                // waiters on every short read made live chunks siphon 50 KiB
                // at a time over the WS.
                let mut filled = 0usize;
                while filled < buf.len() {
                    match file.read(&mut buf[filled..]) {
                        Ok(0) => break,
                        Ok(n) => filled += n,
                        Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                        Err(e) => return Err(e),
                    }
                }
                if filled == 0 {
                    break;
                }
                {
                    let mut shared = state.data.lock().unwrap();
                    shared.extend_from_slice(&buf[..filled]);
                    state.cond.notify_all();
                }
            }
            // Short/oversized reads (file shrank or grew mid-fill) are rejected
            // by the insert guard; the entry is keyed by the stat captured here.
            // Take the bytes from the shared buffer — the same bytes live chunk
            // reads have been served from all along.
            let final_data = state.data.lock().unwrap().clone();
            cache.insert_with_generation(Some(generation), path.clone(), size, mtime, final_data);
            Ok(())
        })()
    }));
    state.finished.store(true, Ordering::Release);
    state.cond.notify_all();
    match result {
        Ok(Ok(())) => {}
        Ok(Err(error)) => {
            tracing::warn!("content cache fill failed for {}: {}", display_path, error);
        }
        Err(panic) => {
            let message = panic
                .downcast_ref::<String>()
                .map(|s| s.as_str())
                .or_else(|| panic.downcast_ref::<&str>().copied())
                .unwrap_or("unknown panic payload");
            tracing::warn!("content cache fill panicked for {}: {}", display_path, message);
        }
    }
    cache.finish_fill(&path, &state);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn mtime(secs: u64) -> SystemTime {
        std::time::UNIX_EPOCH + Duration::from_secs(secs)
    }

    fn wait_until(mut condition: impl FnMut() -> bool, timeout: Duration) -> bool {
        let deadline = std::time::Instant::now() + timeout;
        while std::time::Instant::now() < deadline {
            if condition() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        condition()
    }

    #[test]
    fn hit_requires_size_and_mtime_match() {
        let cache = ContentCache::new(1024, 1024);
        let path = PathBuf::from("/data/a.bin");
        cache.insert(path.clone(), 100, mtime(1), vec![7u8; 100]);

        assert!(cache.get(&path, 100, mtime(1)).is_some());
        assert!(cache.get(&path, 101, mtime(1)).is_none(), "size mismatch");
        assert!(cache.get(&path, 100, mtime(2)).is_none(), "mtime mismatch");
        assert!(cache.get(PathBuf::from("/data/other").as_path(), 100, mtime(1)).is_none());
    }

    #[test]
    fn eviction_drops_oldest_first() {
        let cache = ContentCache::new(100, 1024);
        cache.insert(PathBuf::from("/a"), 60, mtime(1), vec![1u8; 60]);
        cache.insert(PathBuf::from("/b"), 60, mtime(2), vec![2u8; 60]);
        // /a is now older; a new insert over budget evicts oldest first.
        cache.insert(PathBuf::from("/c"), 60, mtime(3), vec![3u8; 60]);
        assert!(cache.get(PathBuf::from("/a").as_path(), 60, mtime(1)).is_none());
        assert!(cache.get(PathBuf::from("/b").as_path(), 60, mtime(2)).is_none());
        assert!(cache.get(PathBuf::from("/c").as_path(), 60, mtime(3)).is_some());
        assert!(cache.total_bytes() <= 100);
    }

    #[test]
    fn replacing_same_path_does_not_double_count() {
        let cache = ContentCache::new(1000, 1024);
        let path = PathBuf::from("/a");
        cache.insert(path.clone(), 50, mtime(1), vec![1u8; 50]);
        cache.insert(path.clone(), 80, mtime(2), vec![2u8; 80]);
        assert_eq!(cache.len(), 1);
        assert_eq!(cache.total_bytes(), 80);
        assert!(cache.get(&path, 80, mtime(2)).is_some());
    }

    #[test]
    fn clear_drops_everything() {
        let cache = ContentCache::new(1024, 1024);
        cache.insert(PathBuf::from("/a"), 10, mtime(1), vec![1u8; 10]);
        cache.clear();
        assert_eq!(cache.len(), 0);
        assert_eq!(cache.total_bytes(), 0);
    }

    #[test]
    fn disabled_cache_never_stores() {
        let cache = ContentCache::new(0, 1024);
        cache.insert(PathBuf::from("/a"), 10, mtime(1), vec![1u8; 10]);
        assert_eq!(cache.len(), 0);
        assert!(cache.get(PathBuf::from("/a").as_path(), 10, mtime(1)).is_none());
        assert!(
            !Arc::new(ContentCache::new(0, 1024)).begin_fill(PathBuf::from("/a"), 10, mtime(1)),
            "disabled cache must not start fills"
        );
    }

    // ── background fill behavior ──

    fn temp_file(bytes: usize) -> (tempfile::TempDir, PathBuf, SystemTime, u64) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("data.bin");
        let payload: Vec<u8> = (0..bytes).map(|i| (i % 251) as u8).collect();
        std::fs::write(&path, &payload).unwrap();
        let meta = std::fs::metadata(&path).unwrap();
        (dir, path, meta.modified().unwrap(), meta.len())
    }

    #[test]
    fn fill_reads_whole_file_and_inserts_entry() {
        let (_dir, path, mtime, size) = temp_file(3 * FILL_SEGMENT_BYTES + 17);
        let cache = Arc::new(ContentCache::new(16 * 1024 * 1024, 4 * 1024 * 1024));

        assert!(cache.begin_fill(path.clone(), size, mtime));
        assert!(
            wait_until(|| cache.len() == 1, Duration::from_secs(5)),
            "fill should complete and insert the entry"
        );
        let whole = cache.get(&path, size, mtime).expect("entry must be servable");
        assert_eq!(whole.len() as u64, size);
        assert_eq!(whole[0], 0);
        assert_eq!(whole[whole.len() - 1], ((size - 1) % 251) as u8);
        assert!(cache.total_bytes() == size as usize);
    }

    #[test]
    fn fill_slice_serves_covered_ranges_with_correct_bytes() {
        let (_dir, path, mtime, size) = temp_file(4 * FILL_SEGMENT_BYTES);
        let cache = Arc::new(ContentCache::new(16 * 1024 * 1024, 4 * 1024 * 1024));

        assert!(cache.begin_fill(path.clone(), size, mtime));
        // The range becomes servable as soon as the fill reads past it; if
        // the fill already finished, the completed entry serves instead.
        assert!(
            wait_until(
                || {
                    cache.fill_slice(&path, size, mtime, 0, Some(512 * 1024), 512 * 1024).is_some()
                        || cache.len() == 1
                },
                Duration::from_secs(5)
            ),
            "covered range must become servable"
        );
        let data = cache
            .fill_slice(&path, size, mtime, 512 * 1024, Some(1024), 1024)
            .unwrap_or_else(|| {
                let whole = cache.get(&path, size, mtime).expect("completed entry must serve");
                whole[512 * 1024..512 * 1024 + 1024].to_vec()
            });
        assert_eq!(data.len(), 1024);
        assert_eq!(data[0], (512 * 1024 % 251) as u8);
    }

    #[test]
    fn fill_slice_respects_key_and_coverage() {
        let (_dir, path, file_mtime, size) = temp_file(FILL_SEGMENT_BYTES * 2);
        let cache = Arc::new(ContentCache::new(16 * 1024 * 1024, 4 * 1024 * 1024));

        assert!(cache.begin_fill(path.clone(), size, file_mtime));
        // Wrong key (file changed since the request's stat) → never serve.
        assert!(cache.fill_slice(&path, size + 1, file_mtime, 0, Some(1024), 1024).is_none());
        assert!(cache.fill_slice(&path, size, mtime(999), 0, Some(1024), 1024).is_none());
        // Range beyond what the fill read → not covered.
        assert!(cache.fill_slice(&path, size, file_mtime, size, Some(1024), 1024).is_none());
        // Covered range with the right key → served (or the fill already
        // finished and the completed entry serves).
        assert!(
            wait_until(
                || {
                    cache.fill_slice(&path, size, file_mtime, 0, Some(1024), 1024).is_some()
                        || cache.len() == 1
                },
                Duration::from_secs(5)
            )
        );
    }

    #[test]
    fn fill_aborts_when_file_does_not_match_key() {
        let (_dir, path, mtime, size) = temp_file(4096);
        let cache = Arc::new(ContentCache::new(16 * 1024 * 1024, 4 * 1024 * 1024));

        // Stat key that cannot match the file on disk (size shifted): the
        // fill must abort without inserting or serving anything.
        assert!(cache.begin_fill(path.clone(), size + 1, mtime));
        std::thread::sleep(Duration::from_millis(100));
        assert_eq!(cache.len(), 0, "key-mismatched fill must not insert");
        assert!(
            cache.fill_slice(&path, size + 1, mtime, 0, Some(1024), 1024).is_none(),
            "aborted fill must not serve"
        );
        // A fresh fill with the correct key still works.
        assert!(cache.begin_fill(path.clone(), size, mtime));
        assert!(wait_until(|| cache.len() == 1, Duration::from_secs(5)));
    }

    #[test]
    fn fill_slots_are_limited() {
        let cache = Arc::new(ContentCache::new(16 * 1024 * 1024, 4 * 1024 * 1024));
        let cache_fill_limited = ContentCache::new_with_fills(16 * 1024 * 1024, 4 * 1024 * 1024, 1);
        let cache_fill_limited = Arc::new(cache_fill_limited);

        // Deterministic cap check: a 1-slot cache refuses the second fill.
        // (Bind the temp dirs by name — `_` would drop them immediately and
        // delete the files the fill threads are about to open.)
        let (_dir_a, path_a, mtime_a, size_a) = temp_file(FILL_SEGMENT_BYTES * 3);
        let (_dir_b, path_b, mtime_b, size_b) = temp_file(FILL_SEGMENT_BYTES * 3);
        assert!(cache_fill_limited.begin_fill(path_a.clone(), size_a, mtime_a));
        assert!(
            !cache_fill_limited.begin_fill(path_b.clone(), size_b, mtime_b),
            "second fill must be refused while the slot is busy"
        );
        // Once the first completes, the slot frees up.
        assert!(wait_until(|| cache_fill_limited.len() == 1, Duration::from_secs(5)));
        assert!(cache_fill_limited.begin_fill(path_b.clone(), size_b, mtime_b));
        assert!(wait_until(|| cache_fill_limited.len() == 2, Duration::from_secs(5)));

        // The default cache tracks active fills across distinct paths.
        let (_dir, path_c, mtime_c, size_c) = temp_file(FILL_SEGMENT_BYTES * 2);
        assert!(cache.begin_fill(path_c.clone(), size_c, mtime_c));
        assert!(wait_until(|| cache.len() == 1, Duration::from_secs(5)));
    }

    #[test]
    fn clear_cancels_fill_and_blocks_late_insert() {
        // 8 MiB so the fill cannot finish before clear() runs.
        let (_dir, path, mtime, size) = temp_file(8 * 1024 * 1024);
        let cache = Arc::new(ContentCache::new(16 * 1024 * 1024, 16 * 1024 * 1024));

        assert!(cache.begin_fill(path.clone(), size, mtime));
        cache.clear();
        std::thread::sleep(Duration::from_millis(100));
        // Whatever the interleaving (fill finished before clear → wiped;
        // after → cancelled + generation guard), nothing may reappear.
        assert_eq!(cache.len(), 0, "no entry may survive or reappear after clear");
        assert!(cache.total_bytes() == 0);
        assert!(
            cache.fill_slice(&path, size, mtime, 0, Some(1024), 1024).is_none(),
            "cancelled fill must not serve"
        );
    }

    #[test]
    fn wait_fill_slice_returns_a_full_chunk_not_a_short_prefix() {
        let (_dir, path, mtime, size) = temp_file(FILL_SEGMENT_BYTES * 2);
        let cache = Arc::new(ContentCache::new(16 * 1024 * 1024, 4 * 1024 * 1024));
        assert!(cache.begin_fill(path.clone(), size, mtime));

        let data = match cache.wait_fill_slice(
            &path,
            size,
            mtime,
            0,
            Some(FILL_SEGMENT_BYTES as u64),
            FILL_SEGMENT_BYTES,
            None,
        ) {
            FillWait::Ready(data) => data,
            FillWait::Unavailable | FillWait::Cancelled => cache
                .get(&path, size, mtime)
                .map(|whole| whole[..FILL_SEGMENT_BYTES].to_vec())
                .expect("full first chunk must be servable"),
        };
        assert_eq!(data.len(), FILL_SEGMENT_BYTES);
        assert_eq!(data[0], 0);
        assert_eq!(
            data[FILL_SEGMENT_BYTES - 1],
            ((FILL_SEGMENT_BYTES - 1) % 251) as u8
        );
    }

    #[test]
    fn wait_fill_slice_does_not_block_on_a_far_ahead_range() {
        let (_dir, path, mtime, size) = temp_file(FILL_SEGMENT_BYTES * 4);
        let cache = Arc::new(ContentCache::new(16 * 1024 * 1024, 4 * 1024 * 1024));
        assert!(cache.begin_fill(path.clone(), size, mtime));
        // A PDF-style range far ahead of a sequential fill must not wait.
        let far = (FILL_SEGMENT_BYTES * 3) as u64;
        let start = std::time::Instant::now();
        let hit = cache.wait_fill_slice(&path, size, mtime, far, Some(1024), 1024, None);
        assert!(
            start.elapsed() < Duration::from_millis(500),
            "far-ahead wait must return immediately"
        );
        match hit {
            FillWait::Ready(data) => assert_eq!(data.len(), 1024),
            FillWait::Unavailable => {}
            FillWait::Cancelled => panic!("far-ahead wait must not report cancel"),
        }
    }

    #[test]
    fn logical_lookup_skips_restat_within_cooldown() {
        let cache = ContentCache::new(1024, 1024);
        let path = PathBuf::from("/data/a.bin");
        cache.remember_logical("root", "a.bin", path.clone(), 100, mtime(1));
        let hit = cache.logical_lookup("root", "a.bin").expect("alias");
        assert_eq!(hit.0, path);
        assert_eq!(hit.1, 100);

        cache.set_restat_cooldown_ms(0);
        assert!(
            cache.logical_lookup("root", "a.bin").is_none(),
            "zero cooldown must force a restat"
        );
    }

    #[test]
    fn logical_touch_slides_the_restat_window() {
        let cache = ContentCache::new(1024, 1024);
        cache.set_restat_cooldown_ms(50);
        let path = PathBuf::from("/data/a.bin");
        cache.remember_logical("root", "a.bin", path.clone(), 100, mtime(1));
        std::thread::sleep(Duration::from_millis(30));
        assert!(cache.logical_lookup("root", "a.bin").is_some());
        cache.touch_logical("root", "a.bin");
        std::thread::sleep(Duration::from_millis(30));
        assert!(
            cache.logical_lookup("root", "a.bin").is_some(),
            "touch must slide the cooldown so a slow stream keeps skipping restat"
        );
    }

    #[test]
    fn wait_fill_slice_cancel_is_distinct_from_miss() {
        let flag = std::sync::atomic::AtomicBool::new(true);
        let cache = ContentCache::new(1024, 1024);
        assert!(matches!(
            cache.wait_fill_slice(
                PathBuf::from("/nope").as_path(),
                1,
                mtime(1),
                0,
                Some(1),
                1,
                Some(&flag),
            ),
            FillWait::Cancelled
        ));
    }

    #[test]
    fn wait_fill_slice_treats_fill_clear_as_miss_not_request_cancel() {
        let (_dir, path, mtime, size) = temp_file(FILL_SEGMENT_BYTES * 2);
        let cache = Arc::new(ContentCache::new(16 * 1024 * 1024, 4 * 1024 * 1024));
        assert!(cache.begin_fill(path.clone(), size, mtime));
        cache.clear();
        let flag = std::sync::atomic::AtomicBool::new(false);
        assert!(matches!(
            cache.wait_fill_slice(&path, size, mtime, 0, Some(1024), 1024, Some(&flag)),
            FillWait::Unavailable
        ));
    }
}
