use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Instant, SystemTime};

use filebox_protocol::resources::{FsEntry, RootConfig};

use crate::fs::{dir_mtime, paginate, read_dir_sorted};

/// Per-directory listing cache for the agent.
///
/// **The problem it fixes:** `read_dir_sorted` reads the ENTIRE directory,
/// canonicalizes every entry, and stats every file — O(N) syscalls. The cursor
/// pagination in the protocol is purely a slice of that in-memory vec, so
/// without a cache, fetching page 2 of a 100k-entry directory re-reads all
/// 100k entries and re-canonicalizes them. That is O(N) PER PAGE.
///
/// **The fix:** memoize the sorted entry vec per (root, path, dirs_only) and
/// invalidate via the directory's mtime. A content add/remove/rename bumps the
/// directory mtime on virtually every real filesystem, so a single O(1) stat
/// per request replaces the O(N) re-read. Cache hits then paginate a cached
/// vec — true O(limit) pagination.
///
/// **Validity / safety:**
/// - mtime change → natural invalidation (entry is recomputed on next access).
/// - root reconfigure (path/name/enabled change) → the connection loop calls
///   `clear()` after a successful `apply_desired`, since a root's path may have
///   changed and cached entries would describe the wrong tree. Denied flags are
///   computed at read time and frozen into the cache; clear-on-reconfigure
///   keeps them consistent with any denylist/root changes.
/// - mtime is `Option<SystemTime>`; `None` (filesystem doesn't support mtime)
///   is treated as "never cache" — every access recomputes. Correctness over
///   speed.
///
/// **Bound:** a hard cap on cached directories (LRU-ish: evict the entry with
/// the oldest `last_used` when over cap). Tree navigation is lazy so a few
/// hundred cached dirs is plenty; the cap prevents unbounded growth if a user
/// scrolls through thousands of directories.
pub struct DirCache {
    inner: Mutex<Inner>,
}

struct Inner {
    entries: HashMap<CacheKey, CacheEntry>,
}

#[derive(Hash, PartialEq, Eq, Clone)]
struct CacheKey {
    root: String,
    path: String,
    dirs_only: bool,
}

struct CacheEntry {
    items: Vec<FsEntry>,
    dir_mtime: Option<SystemTime>,
    last_used: Instant,
}

/// Maximum number of directories whose listing we keep cached. Each entry holds
/// a sorted Vec<FsEntry>; for typical directories this is small. The cap is on
/// DIRECTORY count, not total items, so a few huge directories could in theory
/// use more memory — but the agent already materializes those transiently per
/// request without a cache, so caching them is strictly better than before.
const MAX_CACHED_DIRS: usize = 256;

impl DirCache {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            inner: Mutex::new(Inner {
                entries: HashMap::new(),
            }),
        })
    }

    /// Drop every cached listing. Called by the connection loop after a
    /// successful resource apply (roots may have changed).
    pub fn clear(&self) {
        let mut inner = self.inner.lock().expect("DirCache mutex poisoned");
        inner.entries.clear();
    }

    /// List a directory with cache-backed pagination. On a cache hit (same
    /// mtime), paginates the cached vec in O(limit). On a miss, recomputes via
    /// `read_dir_sorted`, stores, then paginates.
    ///
    /// `dirs_only` is part of the key: a dirs-only listing is a different vec
    /// from a full listing, so they are cached independently.
    pub fn list(
        &self,
        roots: &[RootConfig],
        root_name: &str,
        path: &str,
        limit: usize,
        cursor: Option<&str>,
        dirs_only: bool,
    ) -> Result<(Vec<FsEntry>, Option<String>), String> {
        // Cheap validity probe — O(1) stat. Also enforces path security even
        // on a cache hit (resolve + sensitive-fs check live in dir_mtime), so
        // serving from cache never bypasses the safety checks.
        let current_mtime = dir_mtime(roots, root_name, path)?;

        let key = CacheKey {
            root: root_name.to_string(),
            path: path.to_string(),
            dirs_only,
        };

        // Fast path: cache hit with unchanged mtime.
        if let Some(page) = self.try_cached(&key, current_mtime, limit, cursor) {
            return Ok(page);
        }

        // Miss: recompute and store. read_dir_sorted re-resolves the path
        // (dir_mtime already resolved it, but resolve is cheap relative to the
        // read and only happens on miss).
        let (items, mtime) = read_dir_sorted(roots, root_name, path, dirs_only)?;
        // Paginate by reference (no full-vec clone), then store the owned vec.
        let page = paginate(&items, limit, cursor);

        // Don't cache when mtime is unavailable: we couldn't validate it later,
        // so a cached entry could go stale silently. Recompute-every-time is
        // the safe fallback.
        if let Some(mtime) = mtime {
            let mut inner = self.inner.lock().expect("DirCache mutex poisoned");
            inner.entries.insert(
                key,
                CacheEntry {
                    items,
                    dir_mtime: Some(mtime),
                    last_used: Instant::now(),
                },
            );
            Self::evict_if_needed(&mut inner);
        }

        Ok(page)
    }

    /// Attempt to serve from cache. Returns the paginated page on a validated
    /// hit, None on miss / stale / unsupported-mtime.
    fn try_cached(
        &self,
        key: &CacheKey,
        current_mtime: Option<SystemTime>,
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
        // Borrow the cached vec (no clone of the full list); paginate clones
        // only the ≤ limit items it returns.
        Some(paginate(&entry.items, limit, cursor))
    }

    /// Evict the least-recently-used entry when over the cap. Called under the
    /// lock on insert. O(n) scan, but n ≤ MAX_CACHED_DIRS + 1 so it's cheap.
    fn evict_if_needed(inner: &mut Inner) {
        while inner.entries.len() > MAX_CACHED_DIRS {
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
                inner.entries.remove(&evict_key);
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
}
