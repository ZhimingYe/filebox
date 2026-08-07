use std::cmp::Ordering as CmpOrdering;
use std::collections::{BinaryHeap, HashMap};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

use filebox_protocol::resources::{FsEntry, FsEntryType, RootConfig};

use crate::fs::{resolve_dir_mtime, scan_dir_entries};

/// Per-directory listing cache for the agent.
///
/// **The problem it fixes:** `read_dir_sorted` reads the ENTIRE directory,
/// canonicalizes every entry, and stats every file — O(N) syscalls. The cursor
/// pagination in the protocol is purely a slice of that in-memory vec, so
/// without a cache, fetching page 2 of a 100k-entry directory re-reads all
/// 100k entries and re-canonicalizes them. That is O(N) PER PAGE.
///
/// **The fix:** retain only the smallest bounded prefix needed for ordinary
/// pagination, memoize it per (root, path, dirs_only), and invalidate via the
/// directory's mtime. Oversized directories are rescanned with bounded heaps
/// once a cursor moves past the cached prefix, so memory stays bounded.
///
/// **Validity / safety:**
/// - mtime change → natural invalidation (entry is recomputed on next access).
/// - in-place file content edits do NOT bump the parent directory's mtime
///   (ext4 & friends), so hit metadata would go stale. `try_cached` re-stats
///   the requested page (O(limit), shared `refresh_entry_metadata` rule)
///   before serving, throttled per entry by `RESTAT_COOLDOWN_MS` (default
///   2000ms; `FILEBOX_AGENT_DIR_CACHE_RESTAT_COOLDOWN_MS`, 0 = exact): rapid
///   paging pays ~1 stat per entry per window, in-place edits surface within
///   one window of the last refresh, and scans mark items fresh at insert so
///   first hits after a scan cost nothing.
/// - root reconfigure (path/name/enabled change) → the connection loop calls
///   `clear()` after a successful `apply_desired`, since a root's path may have
///   changed and cached entries would describe the wrong tree. Denied flags are
///   computed at read time and frozen into the cache; clear-on-reconfigure
///   keeps them consistent with any denylist/root changes.
/// - mtime is `Option<SystemTime>`; `None` (filesystem doesn't support mtime)
///   is treated as "never cache" — every access recomputes. Correctness over
///   speed.
///
/// **Bound:** hard caps apply to per-directory entries, total cached entries,
/// and cached directory count. LRU-ish eviction removes the oldest listing.
pub struct DirCache {
    inner: Mutex<Inner>,
    /// Per-entry re-stat throttle on cache hits (see module docs); zero
    /// disables it.
    restat_cooldown: Duration,
}

struct Inner {
    entries: HashMap<CacheKey, CacheEntry>,
    total_entries: usize,
    /// Bumped on every insert; write-backs from page re-stats check it so a
    /// concurrent rescan can't be overwritten with stale page data.
    next_generation: u64,
}

#[derive(Hash, PartialEq, Eq, Clone)]
struct CacheKey {
    root: String,
    path: String,
    dirs_only: bool,
}

/// One cached listing row: the `FsEntry` plus the moment its metadata was
/// last refreshed (scan insert or page re-stat). Hits serve rows inside the
/// cooldown window without re-statting (see module docs).
#[derive(Clone)]
struct CachedItem {
    entry: FsEntry,
    last_restat: Instant,
}

struct CacheEntry {
    items: Vec<CachedItem>,
    truncated: bool,
    dir_mtime: Option<SystemTime>,
    /// Insert generation (see `Inner::next_generation`) guarding page
    /// re-stat write-backs against concurrent rescans.
    generation: u64,
    last_used: Instant,
}

const MAX_CACHED_DIRS: usize = 256;
const MAX_CACHEABLE_ENTRIES_PER_DIR: usize = 20_000;
const MAX_CACHED_ENTRIES: usize = 200_000;

/// Default re-stat cooldown in milliseconds: metadata is considered fresh
/// for this long after the scan that produced it or the re-stat that
/// refreshed it. Overridable at agent startup via
/// `FILEBOX_AGENT_DIR_CACHE_RESTAT_COOLDOWN_MS` (0 = exact, stat every hit).
const RESTAT_COOLDOWN_MS: u64 = 2000;

fn restat_cooldown_from_env() -> Duration {
    let ms = std::env::var("FILEBOX_AGENT_DIR_CACHE_RESTAT_COOLDOWN_MS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(RESTAT_COOLDOWN_MS);
    Duration::from_millis(ms)
}

#[derive(Clone)]
struct RankedEntry {
    folded_name: String,
    entry: FsEntry,
}

impl RankedEntry {
    fn new(entry: FsEntry) -> Self {
        Self {
            folded_name: entry.name.to_lowercase(),
            entry,
        }
    }
}

impl PartialEq for RankedEntry {
    fn eq(&self, other: &Self) -> bool {
        self.cmp(other) == CmpOrdering::Equal
    }
}

impl Eq for RankedEntry {}

impl PartialOrd for RankedEntry {
    fn partial_cmp(&self, other: &Self) -> Option<CmpOrdering> {
        Some(self.cmp(other))
    }
}

impl Ord for RankedEntry {
    fn cmp(&self, other: &Self) -> CmpOrdering {
        let self_is_dir = self.entry.entry_type == FsEntryType::Directory;
        let other_is_dir = other.entry.entry_type == FsEntryType::Directory;
        other_is_dir
            .cmp(&self_is_dir)
            .then_with(|| self.folded_name.cmp(&other.folded_name))
            .then_with(|| self.entry.name.cmp(&other.entry.name))
    }
}

struct ScannedPage {
    cache_items: Vec<FsEntry>,
    truncated: bool,
    page: Vec<FsEntry>,
    next_cursor: Option<String>,
    dir_mtime: Option<SystemTime>,
}

fn push_smallest(heap: &mut BinaryHeap<RankedEntry>, entry: RankedEntry, capacity: usize) {
    if capacity == 0 {
        return;
    }
    if heap.len() < capacity {
        heap.push(entry);
        return;
    }
    if heap.peek().is_some_and(|largest| entry < *largest) {
        heap.pop();
        heap.push(entry);
    }
}

fn push_smallest_ref(
    heap: &mut BinaryHeap<RankedEntry>,
    entry: &RankedEntry,
    capacity: usize,
) {
    if capacity == 0 {
        return;
    }
    if heap.len() < capacity || heap.peek().is_some_and(|largest| entry < largest) {
        push_smallest(heap, entry.clone(), capacity);
    }
}

fn sorted_entries(heap: BinaryHeap<RankedEntry>) -> Vec<FsEntry> {
    heap.into_sorted_vec()
        .into_iter()
        .map(|ranked| ranked.entry)
        .collect()
}

fn scan_bounded(
    roots: &[RootConfig],
    root_name: &str,
    path: &str,
    limit: usize,
    cursor: Option<&str>,
    dirs_only: bool,
    cancelled: &AtomicBool,
) -> Result<ScannedPage, String> {
    let page_capacity = limit.saturating_add(1);
    let cache_capacity = MAX_CACHEABLE_ENTRIES_PER_DIR.saturating_add(1);
    let mut cache_heap = BinaryHeap::with_capacity(cache_capacity);
    let mut after_directory_cursor = BinaryHeap::with_capacity(page_capacity);
    let mut after_file_cursor = BinaryHeap::with_capacity(page_capacity);
    let mut cursor_is_directory = None;
    let mut total_entries = 0usize;
    let folded_cursor = cursor.map(str::to_lowercase);

    let dir_mtime = scan_dir_entries(
        roots,
        root_name,
        path,
        dirs_only,
        Some(cancelled),
        |entry| {
            total_entries = total_entries.saturating_add(1);
            let ranked = RankedEntry::new(entry);
            if let Some(cursor) = cursor {
                if ranked.entry.name == cursor {
                    cursor_is_directory =
                        Some(ranked.entry.entry_type == FsEntryType::Directory);
                }
                let is_directory = ranked.entry.entry_type == FsEntryType::Directory;
                let name_after_cursor = ranked
                    .folded_name
                    .as_str()
                    .cmp(folded_cursor.as_deref().unwrap_or_default())
                    .then_with(|| ranked.entry.name.as_str().cmp(cursor))
                    == CmpOrdering::Greater;
                if !is_directory || name_after_cursor {
                    push_smallest_ref(
                        &mut after_directory_cursor,
                        &ranked,
                        page_capacity,
                    );
                }
                if !is_directory && name_after_cursor {
                    push_smallest_ref(&mut after_file_cursor, &ranked, page_capacity);
                }
            }
            push_smallest(&mut cache_heap, ranked, cache_capacity);
            Ok(())
        },
    )?;

    let mut leading = sorted_entries(cache_heap);
    let truncated = total_entries > MAX_CACHEABLE_ENTRIES_PER_DIR;
    let page_candidates = match (cursor, cursor_is_directory) {
        (Some(_), Some(true)) => sorted_entries(after_directory_cursor),
        (Some(_), Some(false)) => sorted_entries(after_file_cursor),
        _ => leading.iter().take(page_capacity).cloned().collect(),
    };
    let has_more = page_candidates.len() > limit;
    let page: Vec<FsEntry> = page_candidates.into_iter().take(limit).collect();
    let next_cursor = has_more
        .then(|| page.last().map(|entry| entry.name.clone()))
        .flatten();
    if leading.len() > MAX_CACHEABLE_ENTRIES_PER_DIR {
        leading.truncate(MAX_CACHEABLE_ENTRIES_PER_DIR);
    }

    Ok(ScannedPage {
        cache_items: leading,
        truncated,
        page,
        next_cursor,
        dir_mtime,
    })
}

impl DirCache {
    pub fn new() -> Arc<Self> {
        Self::with_cooldown(restat_cooldown_from_env())
    }

    /// Constructor with an explicit cooldown. Tests use small/zero cooldowns
    /// to exercise the re-stat path deterministically.
    fn with_cooldown(cooldown: Duration) -> Arc<Self> {
        Arc::new(Self {
            inner: Mutex::new(Inner {
                entries: HashMap::new(),
                total_entries: 0,
                next_generation: 0,
            }),
            restat_cooldown: cooldown,
        })
    }

    /// Drop every cached listing. Called by the connection loop after a
    /// successful resource apply (roots may have changed).
    pub fn clear(&self) {
        let mut inner = self.inner.lock().expect("DirCache mutex poisoned");
        inner.entries.clear();
        inner.total_entries = 0;
    }

    /// List a directory with cache-backed pagination. Cache hits paginate in
    /// O(limit); misses scan with bounded memory and support cooperative cancel.
    ///
    /// `dirs_only` is part of the key: a dirs-only listing is a different vec
    /// from a full listing, so they are cached independently.
    #[allow(dead_code)]
    pub fn list(
        &self,
        roots: &[RootConfig],
        root_name: &str,
        path: &str,
        limit: usize,
        cursor: Option<&str>,
        dirs_only: bool,
    ) -> Result<(Vec<FsEntry>, Option<String>), String> {
        let cancelled = AtomicBool::new(false);
        self.list_with_cancel(
            roots,
            root_name,
            path,
            limit,
            cursor,
            dirs_only,
            &cancelled,
        )
    }

    pub fn list_with_cancel(
        &self,
        roots: &[RootConfig],
        root_name: &str,
        path: &str,
        limit: usize,
        cursor: Option<&str>,
        dirs_only: bool,
        cancelled: &AtomicBool,
    ) -> Result<(Vec<FsEntry>, Option<String>), String> {
        if cancelled.load(Ordering::Acquire) {
            return Err("request_cancelled".to_string());
        }
        // Cheap validity probe — O(1) stat. Also enforces path security even
        // on a cache hit (resolve + sensitive-fs check live in
        // resolve_dir_mtime), so serving from cache never bypasses the safety
        // checks.
        let (abs_path, current_mtime) = resolve_dir_mtime(roots, root_name, path)?;

        let key = CacheKey {
            root: root_name.to_string(),
            path: path.to_string(),
            dirs_only,
        };

        // Fast path: cache hit with unchanged mtime.
        if let Some(page) = self.try_cached(&key, current_mtime, &abs_path, limit, cursor) {
            return Ok(page);
        }

        let scanned = scan_bounded(
            roots,
            root_name,
            path,
            limit,
            cursor,
            dirs_only,
            cancelled,
        )?;

        // Don't cache when mtime is unavailable: we couldn't validate it later,
        // so a cached entry could go stale silently. Recompute-every-time is
        // the safe fallback.
        if let Some(mtime) = scanned.dir_mtime {
            let cached_len = scanned.cache_items.len();
            let mut inner = self.inner.lock().expect("DirCache mutex poisoned");
            let generation = inner.next_generation;
            inner.next_generation = inner.next_generation.wrapping_add(1);
            // The scan just read every entry's metadata from disk, so all
            // items start inside the cooldown window — the first hits after a
            // scan cost no re-stats at all.
            let scanned_at = Instant::now();
            let items = scanned
                .cache_items
                .into_iter()
                .map(|entry| CachedItem {
                    entry,
                    last_restat: scanned_at,
                })
                .collect();
            let previous = inner.entries.insert(
                key,
                CacheEntry {
                    items,
                    truncated: scanned.truncated,
                    dir_mtime: Some(mtime),
                    generation,
                    last_used: Instant::now(),
                },
            );
            if let Some(previous) = previous {
                inner.total_entries = inner.total_entries.saturating_sub(previous.items.len());
            }
            inner.total_entries = inner.total_entries.saturating_add(cached_len);
            Self::evict_if_needed(&mut inner);
        }

        Ok((scanned.page, scanned.next_cursor))
    }

    /// Attempt to serve from cache. Returns the paginated page on a validated
    /// hit, None on miss / stale / unsupported-mtime.
    fn try_cached(
        &self,
        key: &CacheKey,
        current_mtime: Option<SystemTime>,
        abs_path: &Path,
        limit: usize,
        cursor: Option<&str>,
    ) -> Option<(Vec<FsEntry>, Option<String>)> {
        let current = current_mtime?;
        let mut inner = self.inner.lock().expect("DirCache mutex poisoned");
        let entry = inner.entries.get_mut(key)?;
        if entry.dir_mtime != Some(current) {
            // Stale — let the caller recompute.
            return None;
        }
        entry.last_used = Instant::now();
        let start = match cursor {
            Some(cursor) => entry.items.iter().position(|item| item.entry.name == cursor)? + 1,
            None => 0,
        };
        let available = entry.items.len().saturating_sub(start);
        if entry.truncated && available < limit {
            return None;
        }
        let mut page: Vec<CachedItem> = entry
            .items
            .iter()
            .skip(start)
            .take(limit)
            .cloned()
            .collect();
        let has_more = start.saturating_add(page.len()) < entry.items.len()
            || (entry.truncated && page.len() == limit);
        let next_cursor = (has_more && page.len() == limit)
            .then(|| page.last().map(|item| item.entry.name.clone()))
            .flatten();
        let generation = entry.generation;
        drop(inner);

        // Refresh the page's metadata with fresh stats, WITHOUT holding the
        // lock (a slow networked FS must not stall other listings): in-place
        // edits don't bump the parent dir mtime, so cached size/modified
        // would otherwise go stale. The stat rule is shared with
        // scan_dir_entries (denied frozen, size for files, modified follows
        // symlinks); entries inside the cooldown window are served as-is
        // (see module docs).
        let refreshed: Vec<(usize, FsEntry)> = page
            .iter()
            .enumerate()
            .filter_map(|(i, item)| {
                if item.entry.denied {
                    return None;
                }
                if item.last_restat.elapsed() < self.restat_cooldown {
                    return None;
                }
                let mut fresh = item.entry.clone();
                if !crate::fs::refresh_entry_metadata(&abs_path.join(&item.entry.name), &mut fresh)
                {
                    return None;
                }
                Some((i, fresh))
            })
            .collect();
        // The caller sees the refreshed page; the cache is updated below.
        // One timestamp for all write-backs: the moment the stats actually
        // completed (stats take real time on slow mounts).
        let restat_done_at = Instant::now();
        for (i, fresh) in &refreshed {
            page[*i].entry = fresh.clone();
        }

        // Write back under the lock, guarded by the generation: if a rescan
        // replaced the entry while we were statting, its values are newer.
        let mut inner = self.inner.lock().expect("DirCache mutex poisoned");
        if let Some(entry) = inner.entries.get_mut(key) {
            if entry.generation == generation {
                for (i, fresh) in refreshed {
                    if let Some(slot) = entry.items.get_mut(start + i) {
                        slot.entry = fresh;
                        slot.last_restat = restat_done_at;
                    }
                }
            }
        }
        Some((
            page.into_iter().map(|item| item.entry).collect(),
            next_cursor,
        ))
    }

    /// Evict the least-recently-used entry when over the cap. Called under the
    /// lock on insert. O(n) scan, but n ≤ MAX_CACHED_DIRS + 1 so it's cheap.
    fn evict_if_needed(inner: &mut Inner) {
        Self::evict_to_limits(inner, MAX_CACHED_DIRS, MAX_CACHED_ENTRIES);
    }

    fn evict_to_limits(inner: &mut Inner, max_dirs: usize, max_entries: usize) {
        while inner.entries.len() > max_dirs || inner.total_entries > max_entries {
            // Find the entry with the oldest last_used. Scope the immutable
            // borrow so it ends before the mutable remove.
            let evict_key: Option<CacheKey> = {
                inner
                    .entries
                    .iter()
                    .min_by_key(|(_, e)| e.last_used)
                    .map(|(k, _)| k.clone())
            };
            if let Some(evict_key) = evict_key {
                if let Some(evicted) = inner.entries.remove(&evict_key) {
                    inner.total_entries =
                        inner.total_entries.saturating_sub(evicted.items.len());
                }
            } else {
                break;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use filebox_protocol::resources::RootConfig;
    use std::fs;
    use std::path::PathBuf;
    use tempfile::tempdir;

    struct Sandbox {
        _root_dir: tempfile::TempDir,
        root_path: PathBuf,
    }

    impl Sandbox {
        fn new() -> Self {
            // tempdir() yields a process-unique, auto-deleted directory — no
            // collision between parallel test threads (a hand-rolled name based
            // on Instant::now().elapsed() is always ~0 and collides).
            let dir = tempdir().unwrap();
            let root_path = dir.path().canonicalize().unwrap();
            Self {
                _root_dir: dir,
                root_path,
            }
        }

        fn root(&self) -> RootConfig {
            RootConfig {
                name: "test".to_string(),
                path: self.root_path.to_string_lossy().to_string(),
                enabled: true,
                pinned_folders: vec![],
            }
        }

        fn write_file(&self, rel: &str, contents: &[u8]) {
            let path = self.root_path.join(rel);
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).unwrap();
            }
            fs::write(&path, contents).unwrap();
        }

        fn mkdir(&self, rel: &str) {
            fs::create_dir_all(self.root_path.join(rel)).unwrap();
        }
    }

    #[test]
    fn cache_hit_avoids_reread_after_content_unchanged() {
        // Two calls with nothing changed in between must return identical
        // results; the second is served from cache.
        let sb = Sandbox::new();
        sb.write_file("a.txt", b"x");
        sb.mkdir("sub");
        let roots = vec![sb.root()];
        let cache = DirCache::new();

        let (p1, n1) = cache.list(&roots, "test", "", 100, None, false).unwrap();
        let (p2, n2) = cache.list(&roots, "test", "", 100, None, false).unwrap();

        let names1: Vec<_> = p1.iter().map(|e| e.name.as_str()).collect();
        let names2: Vec<_> = p2.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names1, names2);
        assert!(n1.is_none());
        assert!(n2.is_none());
    }

    #[test]
    fn cache_invalidates_when_directory_mtime_changes() {
        // Add a file between calls → mtime bumps → cache must recompute and
        // surface the new entry.
        let sb = Sandbox::new();
        sb.write_file("a.txt", b"x");
        let roots = vec![sb.root()];
        let cache = DirCache::new();

        let (p1, _) = cache.list(&roots, "test", "", 100, None, false).unwrap();
        assert_eq!(p1.len(), 1);

        // mtime resolution varies by FS (often 1s on some, ns on others).
        // Sleep long enough to guarantee an mtime change on any FS.
        std::thread::sleep(std::time::Duration::from_millis(1100));
        sb.write_file("b.txt", b"y");

        let (p2, _) = cache.list(&roots, "test", "", 100, None, false).unwrap();
        let names: Vec<_> = p2.iter().map(|e| e.name.as_str()).collect();
        assert!(names.contains(&"a.txt"));
        assert!(names.contains(&"b.txt"), "new file must appear after mtime change");
    }

    #[test]
    fn inplace_content_edit_surfaces_on_next_list() {
        // Regression for issue #39: editing a file's CONTENT in place changes
        // the file's mtime but NOT the parent directory's mtime, so a
        // mtime-only cache keeps serving the old `modified` value. The page
        // re-stat on cache hit must surface the new value immediately.
        let sb = Sandbox::new();
        sb.write_file("a.txt", b"first");
        let roots = vec![sb.root()];
        // Tiny cooldown so the post-edit hit really re-stats (this test
        // asserts the re-stat, not the cooldown skip path).
        let cache = DirCache::with_cooldown(Duration::from_millis(50));

        let (p1, _) = cache.list(&roots, "test", "", 100, None, false).unwrap();
        let modified_before = p1
            .iter()
            .find(|e| e.name == "a.txt")
            .and_then(|e| e.modified.clone());
        assert!(modified_before.is_some(), "scan must report a modified time");

        // Ensure the in-place write lands >1s after the scan so coarse mtime
        // resolution (1s on some filesystems) can't collapse the two values.
        std::thread::sleep(std::time::Duration::from_millis(1100));
        sb.write_file("a.txt", b"second");

        // Dir mtime is unchanged (in-place edit), yet the next list must show
        // the current file mtime thanks to the per-page re-stat.
        let (p2, _) = cache.list(&roots, "test", "", 100, None, false).unwrap();
        let modified_after = p2
            .iter()
            .find(|e| e.name == "a.txt")
            .and_then(|e| e.modified.clone());
        assert_ne!(
            modified_after, modified_before,
            "cache hit must re-stat the page and surface the in-place edit"
        );
    }

    #[test]
    fn restat_cooldown_defers_refresh_within_window() {
        // The deliberate tradeoff: hits inside the window serve cached
        // values; hits after it re-stat and surface the in-place edit.
        let sb = Sandbox::new();
        sb.write_file("a.txt", b"first");
        let roots = vec![sb.root()];
        let cache = DirCache::with_cooldown(Duration::from_secs(2));

        let (p1, _) = cache.list(&roots, "test", "", 100, None, false).unwrap();
        let e1 = p1.iter().find(|e| e.name == "a.txt").unwrap();
        let modified_before = e1.modified.clone().expect("scan must report a modified time");
        let size_before = e1.size.expect("scan must report a size");

        // In-place edit >1s later so coarse mtime resolution (1s on some
        // filesystems) can't collapse the values; dir mtime is unchanged.
        std::thread::sleep(Duration::from_millis(1100));
        sb.write_file("a.txt", b"second!");

        // Visit INSIDE the window: still inside the 2s cooldown from the
        // scan, so the hit serves the cached values without re-statting.
        let (p2, _) = cache.list(&roots, "test", "", 100, None, false).unwrap();
        let e2 = p2.iter().find(|e| e.name == "a.txt").unwrap();
        assert_eq!(
            e2.modified.as_deref(),
            Some(modified_before.as_str()),
            "a hit inside the cooldown window must serve the cached value"
        );
        assert_eq!(e2.size, Some(size_before));

        // Visit AFTER the window: the re-stat surfaces the edit.
        std::thread::sleep(Duration::from_millis(1500));
        let (p3, _) = cache.list(&roots, "test", "", 100, None, false).unwrap();
        let e3 = p3.iter().find(|e| e.name == "a.txt").unwrap();
        assert_ne!(
            e3.modified.as_deref(),
            Some(modified_before.as_str()),
            "a hit after the cooldown window must re-stat and surface the edit"
        );
        assert_ne!(e3.size, Some(size_before));
    }

    #[test]
    fn denied_entries_stay_frozen_on_cache_hit() {
        // The page re-stat must skip denied entries: they keep
        // size=None/modified=None even after an in-place edit that would
        // otherwise change their metadata. Leaking size/mtime of a denied
        // file on a cache hit would defeat the denylist.
        let sb = Sandbox::new();
        sb.write_file(".env", b"SECRET=one");
        let roots = vec![sb.root()];
        // Small cooldown so the post-edit hit really re-stats and exercises
        // the denied-skip branch.
        let cache = DirCache::with_cooldown(Duration::from_millis(50));

        let (p1, _) = cache.list(&roots, "test", "", 100, None, false).unwrap();
        let denied = p1
            .iter()
            .find(|e| e.name == ".env")
            .expect("denied entry is still listed");
        assert!(denied.denied, ".env must be flagged denied");
        assert!(denied.size.is_none(), "denied entries must not expose size");
        assert!(denied.modified.is_none(), "denied entries must not expose mtime");

        // In-place edit (parent dir mtime unchanged), then a cache-hit re-list.
        std::thread::sleep(std::time::Duration::from_millis(1100));
        sb.write_file(".env", b"SECRET=two");

        let (p2, _) = cache.list(&roots, "test", "", 100, None, false).unwrap();
        let denied_after = p2
            .iter()
            .find(|e| e.name == ".env")
            .expect("denied entry is still listed");
        assert!(denied_after.denied);
        assert!(
            denied_after.size.is_none(),
            "cache-hit re-stat must not leak size for denied entries"
        );
        assert!(
            denied_after.modified.is_none(),
            "cache-hit re-stat must not leak mtime for denied entries"
        );
    }

    #[cfg(unix)]
    #[test]
    fn symlink_target_edit_refreshes_modified_on_hit() {
        use std::os::unix::fs::symlink;

        // A symlink entry is classified by file_type (no follow), but its
        // size/modified come from fs::metadata (follows). The page re-stat
        // must mirror scan_dir_entries exactly: editing the TARGET in place
        // refreshes the link's `modified` on a cache hit (in-place edits
        // don't bump the parent dir mtime), while `size` stays None because
        // the entry is a Symlink, not a File.
        let sb = Sandbox::new();
        sb.write_file("target.txt", b"first");
        symlink(
            sb.root_path.join("target.txt"),
            sb.root_path.join("link.txt"),
        )
        .unwrap();
        let roots = vec![sb.root()];
        // Small cooldown so the post-edit hit really re-stats (the 1.1s
        // granularity sleep lands outside the window).
        let cache = DirCache::with_cooldown(Duration::from_millis(50));

        let (p1, _) = cache.list(&roots, "test", "", 100, None, false).unwrap();
        let link = p1
            .iter()
            .find(|e| e.name == "link.txt")
            .expect("symlink is listed");
        assert_eq!(link.entry_type, FsEntryType::Symlink);
        assert!(link.size.is_none(), "symlink entries never report size");
        let modified_before = link
            .modified
            .clone()
            .expect("symlink reports target mtime via follow");

        // Edit the target in place; the parent dir mtime is unchanged.
        std::thread::sleep(std::time::Duration::from_millis(1100));
        sb.write_file("target.txt", b"second");

        let (p2, _) = cache.list(&roots, "test", "", 100, None, false).unwrap();
        let link_after = p2
            .iter()
            .find(|e| e.name == "link.txt")
            .expect("symlink is still listed");
        assert_ne!(
            link_after.modified.as_deref(),
            Some(modified_before.as_str()),
            "cache hit must re-stat through the symlink"
        );
        assert_eq!(link_after.entry_type, FsEntryType::Symlink);
        assert!(link_after.size.is_none());
    }

    #[test]
    fn concurrent_hits_are_stable() {
        use std::sync::Barrier;

        // Hammer one cached directory from 8 threads. Every call is a cache
        // hit (10 files, limit 4, never truncated), so the two-phase re-stat
        // — stats outside the lock, generation-guarded write-back — runs
        // concurrently. Whatever the interleaving, each thread's pagination
        // must still cover all 10 files exactly once, with no duplicates,
        // no lost pages, and no panics.
        let sb = Sandbox::new();
        for ch in b'a'..=b'j' {
            sb.write_file(&format!("{}.txt", ch as char), b"x");
        }
        let expected: Vec<String> = (b'a'..=b'j')
            .map(|ch| format!("{}.txt", ch as char))
            .collect();

        let roots = vec![sb.root()];
        // Zero cooldown: every hit re-stats, so the generation-guarded
        // write-back stays hot under concurrency (a real cooldown would
        // collapse 49 of 50 iterations into cache-only hits).
        let cache = DirCache::with_cooldown(Duration::ZERO);
        let barrier = Arc::new(Barrier::new(8));
        let mut handles = Vec::new();
        for _ in 0..8 {
            let cache = cache.clone();
            let roots = roots.clone();
            let expected = expected.clone();
            let barrier = barrier.clone();
            handles.push(std::thread::spawn(move || {
                barrier.wait();
                for _ in 0..50 {
                    let (p1, c1) = cache.list(&roots, "test", "", 4, None, false).unwrap();
                    let (p2, c2) = cache.list(&roots, "test", "", 4, c1.as_deref(), false).unwrap();
                    let (p3, c3) = cache.list(&roots, "test", "", 4, c2.as_deref(), false).unwrap();
                    assert_eq!(p1.len(), 4);
                    assert_eq!(p2.len(), 4);
                    assert_eq!(p3.len(), 2);
                    assert!(c3.is_none());
                    let mut names: Vec<String> = p1
                        .iter()
                        .chain(p2.iter())
                        .chain(p3.iter())
                        .map(|e| e.name.clone())
                        .collect();
                    assert_eq!(names.len(), 10);
                    names.sort();
                    assert_eq!(
                        names, expected,
                        "concurrent pagination must cover every file exactly once"
                    );
                }
            }));
        }
        for handle in handles {
            handle.join().expect("concurrent hit thread must not panic");
        }
    }

    #[test]
    fn cache_pagination_uses_cached_vec() {
        // Create 5 files; page through with the cache. Page 2 must NOT require
        // a re-read that loses data — the cached vec is sliced consistently.
        let sb = Sandbox::new();
        for ch in ['a', 'b', 'c', 'd', 'e'] {
            sb.write_file(&format!("{}.txt", ch), b"x");
        }
        let roots = vec![sb.root()];
        let cache = DirCache::new();

        let (p1, n1) = cache.list(&roots, "test", "", 2, None, false).unwrap();
        let (p2, n2) = cache.list(&roots, "test", "", 2, n1.as_deref(), false).unwrap();
        let (p3, n3) = cache.list(&roots, "test", "", 2, n2.as_deref(), false).unwrap();

        assert_eq!(p1.len(), 2);
        assert_eq!(p2.len(), 2);
        assert_eq!(p3.len(), 1);
        assert!(n3.is_none());
    }

    #[test]
    fn dirs_only_caches_separately_from_full_listing() {
        // A dirs_only request and a full request for the same dir must not
        // collide: each produces a different vec.
        let sb = Sandbox::new();
        sb.write_file("a.txt", b"x");
        sb.mkdir("sub");
        let roots = vec![sb.root()];
        let cache = DirCache::new();

        let (dirs, _) = cache.list(&roots, "test", "", 100, None, true).unwrap();
        let (full, _) = cache.list(&roots, "test", "", 100, None, false).unwrap();

        // dirs_only returned only the directory; full returned dir + file.
        assert_eq!(dirs.len(), 1);
        assert_eq!(dirs[0].name, "sub");
        assert_eq!(full.len(), 2);
    }

    #[test]
    fn clear_drops_all_entries() {
        let sb = Sandbox::new();
        sb.write_file("a.txt", b"x");
        let roots = vec![sb.root()];
        let cache = DirCache::new();

        let _ = cache.list(&roots, "test", "", 100, None, false).unwrap();
        cache.clear();
        {
            let inner = cache.inner.lock().unwrap();
            assert!(inner.entries.is_empty(), "clear() must empty the cache");
        }
    }

    #[test]
    fn cache_hits_still_enforce_path_security() {
        // A cached entry must not bypass the resolve/sensitive checks: a path
        // outside the root must still error even after warming the cache for a
        // valid path.
        let sb = Sandbox::new();
        sb.write_file("a.txt", b"x");
        let roots = vec![sb.root()];
        let cache = DirCache::new();

        let _ = cache.list(&roots, "test", "", 100, None, false).unwrap();
        let escape = cache.list(&roots, "test", "../../..", 100, None, false);
        assert!(escape.is_err(), "path-escape must still be rejected on cache hit path");
    }

    #[test]
    fn cancelled_list_stops_before_touching_the_filesystem() {
        let cache = DirCache::new();
        let cancelled = AtomicBool::new(true);
        let result = cache.list_with_cancel(
            &[],
            "missing",
            "/",
            200,
            None,
            false,
            &cancelled,
        );
        assert_eq!(result.unwrap_err(), "request_cancelled");
    }

    #[test]
    fn bounded_heap_keeps_only_the_smallest_entries() {
        let mut heap = BinaryHeap::new();
        for name in ["z.txt", "b.txt", "a.txt", "m.txt"] {
            push_smallest(
                &mut heap,
                RankedEntry::new(FsEntry {
                    name: name.to_string(),
                    entry_type: FsEntryType::File,
                    size: None,
                    modified: None,
                    denied: false,
                }),
                2,
            );
        }
        let names: Vec<String> = sorted_entries(heap)
            .into_iter()
            .map(|entry| entry.name)
            .collect();
        assert_eq!(names, vec!["a.txt", "b.txt"]);
    }

    #[test]
    fn cache_eviction_honors_total_entry_budget() {
        let make_entry = |name: &str| FsEntry {
            name: name.to_string(),
            entry_type: FsEntryType::File,
            size: None,
            modified: None,
            denied: false,
        };
        let make_item = |name: &str| CachedItem {
            entry: make_entry(name),
            last_restat: Instant::now(),
        };
        let old_key = CacheKey {
            root: "root".to_string(),
            path: "/old".to_string(),
            dirs_only: false,
        };
        let new_key = CacheKey {
            root: "root".to_string(),
            path: "/new".to_string(),
            dirs_only: false,
        };
        let mut inner = Inner {
            entries: HashMap::new(),
            total_entries: 6,
            next_generation: 0,
        };
        inner.entries.insert(
            old_key.clone(),
            CacheEntry {
                items: vec![make_item("a"), make_item("b"), make_item("c")],
                truncated: false,
                dir_mtime: Some(SystemTime::UNIX_EPOCH),
                generation: 0,
                last_used: Instant::now() - std::time::Duration::from_secs(1),
            },
        );
        inner.entries.insert(
            new_key.clone(),
            CacheEntry {
                items: vec![make_item("d"), make_item("e"), make_item("f")],
                truncated: false,
                dir_mtime: Some(SystemTime::UNIX_EPOCH),
                generation: 0,
                last_used: Instant::now(),
            },
        );

        DirCache::evict_to_limits(&mut inner, 10, 4);

        assert!(!inner.entries.contains_key(&old_key));
        assert!(inner.entries.contains_key(&new_key));
        assert_eq!(inner.total_entries, 3);
    }
}
