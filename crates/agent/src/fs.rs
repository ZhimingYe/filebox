use std::fs;
use std::io::{ErrorKind, Read, Seek, SeekFrom};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use filebox_protocol::denylist;
use filebox_protocol::message::FILE_CHUNK_MAX_BYTES;
use filebox_protocol::resources::{FileStat, FsEntry, FsEntryType, RootConfig};

use crate::content_cache::{ContentCache, FillWait};

/// Resolve a root name + relative path to an absolute, canonical path.
///
/// Returns `(canonical_target, canonical_root)` on success. The canonical_root
/// is returned so callers don't need to re-lookup and re-canonicalize the root
/// (which would be dead code — resolve_path already verified both).
///
/// Returns Err with a specific message if the root is not found, the root
/// path is missing (deleted/unmounted), the target path doesn't exist, or the
/// path escapes the root. The specific message lets the frontend distinguish
/// "your root directory is gone" from "this file doesn't exist" from "path
/// escape attempt" — all of which used to return the same opaque None.
pub(crate) fn resolve_path(
    roots: &[RootConfig],
    root_name: &str,
    relative_path: &str,
) -> Result<(PathBuf, PathBuf), String> {
    let root = roots.iter().find(|r| r.name == root_name && r.enabled)
        .ok_or_else(|| format!("Root '{}' not found or disabled", root_name))?;
    let root_path = Path::new(&root.path);

    // Canonicalize the root FIRST so we can give a root-specific error when
    // the root directory itself is missing (deleted, unmounted, typo). Without
    // this ordering, a missing root path would be indistinguishable from a
    // missing target path.
    let root_canonical = root_path.canonicalize().map_err(|_| {
        format!(
            "Root '{}' path '{}' is not accessible — the directory may be missing or unmounted",
            root_name, root.path
        )
    })?;

    // Strip leading "/" so join doesn't replace the root
    let rel = relative_path.strip_prefix('/').unwrap_or(relative_path);

    // Join and normalize
    let joined = root_path.join(rel);

    // Canonicalize to resolve symlinks and `..`
    let canonical = match joined.canonicalize() {
        Ok(p) => p,
        Err(_) => {
            // If canonicalize fails (file doesn't exist yet), try parent
            if let Some(parent) = joined.parent() {
                if let Ok(parent_canon) = parent.canonicalize() {
                    let file_name = joined.file_name()
                        .ok_or_else(|| format!("Path not found: {}/{}", root_name, relative_path))?;
                    parent_canon.join(file_name)
                } else {
                    return Err(format!("Path not found: {}/{}", root_name, relative_path));
                }
            } else {
                return Err(format!("Path not found: {}/{}", root_name, relative_path));
            }
        }
    };

    // Verify the canonical path is inside the root
    if !canonical.starts_with(&root_canonical) {
        return Err(format!("Path is outside root: {}/{}", root_name, relative_path));
    }

    Ok((canonical, root_canonical))
}

/// Check if a relative path is denied by the sensitive denylist.
fn is_path_denied(relative_path: &str) -> bool {
    denylist::is_denied(relative_path)
}

#[cfg(unix)]
fn is_sensitive_virtual_path(path: &Path) -> bool {
    ["/proc", "/sys", "/dev/fd", "/dev/mapper"]
        .iter()
        .map(Path::new)
        .any(|blocked| path == blocked || path.starts_with(blocked))
}

#[cfg(not(unix))]
fn is_sensitive_virtual_path(_path: &Path) -> bool {
    false
}

/// Compute the relative path from root to the given absolute path.
fn relative_path(root_path: &Path, abs_path: &Path) -> String {
    abs_path
        .strip_prefix(root_path)
        .unwrap_or(abs_path)
        .to_string_lossy()
        .to_string()
}

/// Open a leaf file under `root_canonical` without following any symlink
/// component (openat + O_NOFOLLOW on Unix). Shared by fs reads and workspace
/// content search so TOCTOU races cannot redirect an intermediate directory
/// outside the root after canonicalize.
#[cfg(unix)]
pub(crate) fn open_resolved_leaf(
    root_canonical: &Path,
    rel_path: &Path,
    _abs_path: &Path,
) -> Result<fs::File, String> {
    use std::ffi::CString;
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    use std::os::unix::ffi::OsStrExt;

    fn cstring_path(path: &Path) -> Result<CString, String> {
        CString::new(path.as_os_str().as_bytes())
            .map_err(|_| "Invalid path: NUL byte".to_string())
    }

    fn cstring_component(component: &std::ffi::OsStr) -> Result<CString, String> {
        CString::new(component.as_bytes())
            .map_err(|_| "Invalid path component: NUL byte".to_string())
    }

    let mut components = Vec::new();
    for component in rel_path.components() {
        match component {
            Component::Normal(name) => components.push(name),
            Component::CurDir => {}
            _ => return Err("Invalid path component".to_string()),
        }
    }

    let root_c = cstring_path(root_canonical)?;
    let root_fd = unsafe {
        libc::open(
            root_c.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
        )
    };
    if root_fd < 0 {
        return Err(format!(
            "Failed to open root directory: {}",
            std::io::Error::last_os_error()
        ));
    }

    let mut dir = unsafe { OwnedFd::from_raw_fd(root_fd) };
    if components.is_empty() {
        return Ok(fs::File::from(dir));
    }

    for (idx, component) in components.iter().enumerate() {
        let name = cstring_component(component)?;
        let is_last = idx + 1 == components.len();
        let mut flags = libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW;
        if is_last {
            // Avoid hanging open() on a FIFO; cleared for regular files below.
            flags |= libc::O_NONBLOCK;
        } else {
            flags |= libc::O_DIRECTORY;
        }

        let fd = unsafe { libc::openat(dir.as_raw_fd(), name.as_ptr(), flags) };
        if fd < 0 {
            return Err(format!(
                "Failed to open path safely: {}",
                std::io::Error::last_os_error()
            ));
        }

        let child = unsafe { OwnedFd::from_raw_fd(fd) };
        if is_last {
            return Ok(fs::File::from(child));
        }
        dir = child;
    }

    Err("Invalid path".to_string())
}

#[cfg(not(unix))]
pub(crate) fn open_resolved_leaf(
    _root_canonical: &Path,
    _rel_path: &Path,
    abs_path: &Path,
) -> Result<fs::File, String> {
    fs::File::open(abs_path).map_err(|e| format!("Failed to open file: {}", e))
}

/// Read a directory and return ALL of its entries, sorted (directories first,
/// then alphabetically), plus the directory's own mtime (used by the cache to
/// invalidate when contents change). This is the uncached primitive;
/// `list_directory` paginates its output, and `DirCache` memoizes it.
///
/// When `dirs_only` is true, files are skipped ENTIRELY — we never canonicalize
/// them or stat their size/mtime. That is the whole point: a directory with
/// tens of thousands of files and a handful of subdirs is read in O(dirs)
/// syscalls instead of O(files). Skipping is safe because we return nothing
/// for files (no path-surface exposure); directories still go through the full
/// canonicalize + deny check.
/// Resolve a directory path through the security checks (root enabled, inside
/// root, not a sensitive virtual fs) and return its canonical path plus mtime
/// in one call. DirCache uses this as its validity probe on cache hits — a
/// single stat instead of re-reading the whole directory — and also needs the
/// canonical path to re-stat individual entries on those hits (in-place file
/// edits don't bump the parent dir's mtime), so resolving twice would be
/// wasteful.
pub(crate) fn resolve_dir_mtime(
    roots: &[RootConfig],
    root_name: &str,
    path: &str,
) -> Result<(std::path::PathBuf, Option<std::time::SystemTime>), String> {
    let (abs_path, _root_canonical) = resolve_path(roots, root_name, path)?;
    if !abs_path.is_dir() {
        return Err(format!("Not a directory: {}", path));
    }
    if is_sensitive_virtual_path(&abs_path) {
        return Err("Access denied: sensitive virtual filesystem".to_string());
    }
    let mtime = fs::metadata(&abs_path).ok().and_then(|m| m.modified().ok());
    Ok((abs_path, mtime))
}

/// Format a SystemTime the same way listings do (local time, RFC3339).
pub(crate) fn mtime_to_rfc3339(t: std::time::SystemTime) -> String {
    let dt: chrono::DateTime<chrono::Local> = t.into();
    dt.to_rfc3339()
}

/// Refresh an entry's `size`/`modified` from one fresh stat, following the
/// single canonical metadata rule for listings: size only for regular files,
/// modified always (via `fs::metadata`, which follows symlinks). Both
/// `scan_dir_entries` (on a full scan) and `DirCache::try_cached` (page
/// re-stats on cache hits) must agree, so the rule lives here instead of
/// being duplicated and kept in sync by tests.
///
/// Denied entries must not be passed here — they stay frozen (no size,
/// no mtime). Returns `false` when the stat fails; the entry is left
/// untouched (callers keep prior values and may retry later).
pub(crate) fn refresh_entry_metadata(path: &Path, entry: &mut FsEntry) -> bool {
    let md = match fs::metadata(path) {
        Ok(md) => md,
        Err(_) => return false,
    };
    if entry.entry_type == FsEntryType::File {
        entry.size = Some(md.len());
    }
    entry.modified = md.modified().ok().map(mtime_to_rfc3339);
    true
}

pub(crate) fn read_dir_sorted(
    roots: &[RootConfig],
    root_name: &str,
    path: &str,
    dirs_only: bool,
) -> Result<(Vec<FsEntry>, Option<std::time::SystemTime>), String> {
    let mut items = Vec::new();
    let dir_mtime = scan_dir_entries(
        roots,
        root_name,
        path,
        dirs_only,
        None,
        |entry| {
            items.push(entry);
            Ok(())
        },
    )?;
    items.sort_by(compare_fs_entries);
    Ok((items, dir_mtime))
}

pub(crate) fn compare_fs_entries(a: &FsEntry, b: &FsEntry) -> std::cmp::Ordering {
    let a_is_dir = a.entry_type == FsEntryType::Directory;
    let b_is_dir = b.entry_type == FsEntryType::Directory;
    b_is_dir
        .cmp(&a_is_dir)
        .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        .then_with(|| a.name.cmp(&b.name))
}

pub(crate) fn scan_dir_entries<F>(
    roots: &[RootConfig],
    root_name: &str,
    path: &str,
    dirs_only: bool,
    cancelled: Option<&AtomicBool>,
    mut visit: F,
) -> Result<Option<std::time::SystemTime>, String>
where
    F: FnMut(FsEntry) -> Result<(), String>,
{
    let (abs_path, root_canonical) = resolve_path(roots, root_name, path)?;

    if !abs_path.is_dir() {
        return Err(format!("Not a directory: {}", path));
    }
    if is_sensitive_virtual_path(&abs_path) {
        return Err("Access denied: sensitive virtual filesystem".to_string());
    }

    // Directory mtime — the cache's invalidation signal. A content
    // add/remove/rename bumps the directory's mtime on virtually every real
    // filesystem, so this single O(1) stat replaces the O(N) re-read on cache
    // hits. None if unavailable (cache treats None as "always revalidate").
    let dir_mtime = fs::metadata(&abs_path).ok().and_then(|m| m.modified().ok());

    let entries = fs::read_dir(&abs_path)
        .map_err(|e| format!("Failed to read directory: {}", e))?;

    for entry in entries {
        if cancelled.is_some_and(|flag| flag.load(Ordering::Acquire)) {
            return Err("request_cancelled".to_string());
        }
        let entry = entry.map_err(|e| format!("Failed to read entry: {}", e))?;
        let file_name = entry.file_name().to_string_lossy().to_string();
        let entry_path = entry.path();

        let metadata = entry
            .file_type()
            .map_err(|e| format!("Failed to read file type: {}", e))?;

        // dirs_only fast path: skip non-directories before any syscall-heavy
        // work (canonicalize / metadata). Symlink-to-dir is classified as
        // Symlink here (file_type does not follow), matching the legacy
        // behavior, so it is skipped too — which is what the tree wants.
        if dirs_only && !metadata.is_dir() {
            continue;
        }

        // Skip hidden files starting with . (but not the directory itself)
        // Actually, we show them but mark as denied if sensitive
        let rel = relative_path(&root_canonical, &entry_path);
        let entry_canonical = entry_path
            .canonicalize()
            .unwrap_or_else(|_| entry_path.clone());
        let denied = is_path_denied(&rel) || is_sensitive_virtual_path(&entry_canonical);

        let entry_type = if metadata.is_dir() {
            FsEntryType::Directory
        } else if metadata.is_symlink() {
            FsEntryType::Symlink
        } else {
            FsEntryType::File
        };

        // Size/modified follow the shared refresh_entry_metadata rule (size
        // only for files, modified follows symlinks); denied entries stay
        // frozen with no metadata.
        let mut fs_entry = FsEntry {
            name: file_name,
            entry_type,
            size: None,
            modified: None,
            denied,
        };
        if !denied {
            refresh_entry_metadata(&entry_path, &mut fs_entry);
        }

        visit(fs_entry)?;
    }

    if cancelled.is_some_and(|flag| flag.load(Ordering::Acquire)) {
        return Err("request_cancelled".to_string());
    }
    Ok(dir_mtime)
}

/// Apply cursor pagination to a pre-sorted entry list. The cursor is the name
/// of the last entry on the previous page; we resume right after it. Borrows
/// the slice so callers (notably the cache, on a hit) don't have to clone the
/// whole vec just to slice it — only the returned page (≤ limit items) is
/// cloned. This is what makes cache-hit pagination genuinely O(limit).
pub(crate) fn paginate(
    items: &[FsEntry],
    limit: usize,
    cursor: Option<&str>,
) -> (Vec<FsEntry>, Option<String>) {
    let start = if let Some(cursor) = cursor {
        items
            .iter()
            .position(|i| i.name == cursor)
            .map(|p| p + 1)
            .unwrap_or(0)
    } else {
        0
    };

    let page: Vec<FsEntry> = items.iter().skip(start).take(limit).cloned().collect();
    let next_cursor = if page.len() == limit {
        page.last().map(|e| e.name.clone())
    } else {
        None
    };
    (page, next_cursor)
}

/// Uncached, paginated directory listing. Production requests go through
/// `DirCache::list` (which memoizes `read_dir_sorted`), so this wrapper is no
/// longer on the hot path — but it remains the test surface that validates
/// `read_dir_sorted` + `paginate`, which is exactly what the cache builds on.
#[allow(dead_code)]
pub fn list_directory(
    roots: &[RootConfig],
    root_name: &str,
    path: &str,
    limit: usize,
    cursor: Option<&str>,
    dirs_only: bool,
) -> Result<(Vec<FsEntry>, Option<String>), String> {
    let (items, _mtime) = read_dir_sorted(roots, root_name, path, dirs_only)?;
    Ok(paginate(&items, limit, cursor))
}

pub fn stat_file(
    roots: &[RootConfig],
    root_name: &str,
    path: &str,
) -> Result<FileStat, String> {
    let (abs_path, root_canonical) = resolve_path(roots, root_name, path)?;

    let rel_path = abs_path
        .strip_prefix(&root_canonical)
        .map_err(|_| "Path not found or outside root".to_string())?;
    let rel = rel_path.to_string_lossy().to_string();
    let denied = is_path_denied(&rel);
    if denied || is_sensitive_virtual_path(&abs_path) {
        return Err("Access denied: sensitive file".to_string());
    }

    let metadata = fs::metadata(&abs_path)
        .map_err(|e| format!("Failed to stat file: {}", e))?;

    let entry_type = if metadata.is_dir() {
        FsEntryType::Directory
    } else if metadata.file_type().is_symlink() {
        FsEntryType::Symlink
    } else {
        FsEntryType::File
    };

    let modified = metadata
        .modified()
        .ok()
        .and_then(|t| {
            let dt: chrono::DateTime<chrono::Local> = t.into();
            Some(dt.to_rfc3339())
        });

    let permissions = {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            Some(format!("{:o}", metadata.permissions().mode()))
        }
        #[cfg(not(unix))]
        {
            None
        }
    };

    Ok(FileStat {
        path: path.to_string(),
        entry_type,
        size: metadata.len(),
        modified,
        permissions,
        denied,
    })
}

pub struct FileReadRange {
    pub data: Vec<u8>,
    pub done: bool,
    pub file_size: Option<u64>,
    pub modified: Option<String>,
}

/// Read until `buf` is full or EOF. A single `read()` is allowed to return
/// far fewer bytes than requested (NFS rsize, FUSE, leftover O_NONBLOCK);
/// treating that as the whole chunk turns one 512 KiB WS round-trip into a
/// storm of ~50 KiB ones, each re-opening the file.
pub(crate) fn read_at_least<R: Read>(reader: &mut R, buf: &mut [u8]) -> std::io::Result<usize> {
    let mut filled = 0;
    let mut would_block = 0u32;
    while filled < buf.len() {
        match reader.read(&mut buf[filled..]) {
            Ok(0) => break,
            Ok(n) => filled += n,
            Err(e) if e.kind() == ErrorKind::Interrupted => continue,
            Err(e) if e.kind() == ErrorKind::WouldBlock => {
                would_block = would_block.saturating_add(1);
                if would_block > 1_000 {
                    return Err(e);
                }
                std::thread::sleep(Duration::from_millis(1));
                continue;
            }
            Err(e) => return Err(e),
        }
    }
    Ok(filled)
}

/// `open_resolved_leaf` uses O_NONBLOCK so a FIFO in a root cannot hang the
/// worker at open. Once `metadata()` has confirmed a regular file, blocking
/// reads are required or NFS/macOS will short-read ~one page cache slice.
#[cfg(unix)]
fn set_file_blocking(file: &fs::File) -> Result<(), String> {
    use std::os::fd::AsRawFd;
    let fd = file.as_raw_fd();
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL, 0) };
    if flags < 0 {
        return Err(format!(
            "Failed to get file flags: {}",
            std::io::Error::last_os_error()
        ));
    }
    if (flags & libc::O_NONBLOCK) != 0 {
        let rc = unsafe { libc::fcntl(fd, libc::F_SETFL, flags & !libc::O_NONBLOCK) };
        if rc < 0 {
            return Err(format!(
                "Failed to set blocking mode: {}",
                std::io::Error::last_os_error()
            ));
        }
    }
    Ok(())
}

#[cfg(not(unix))]
fn set_file_blocking(_file: &fs::File) -> Result<(), String> {
    Ok(())
}

fn serve_from_cache(
    cache: &Arc<ContentCache>,
    abs_path: &Path,
    file_len: u64,
    mtime: SystemTime,
    offset: u64,
    length: Option<u64>,
    cancelled: Option<&AtomicBool>,
) -> Result<Option<FileReadRange>, String> {
    if cancelled.is_some_and(|c| c.load(Ordering::Acquire)) {
        return Err("request_cancelled".to_string());
    }
    let modified = Some(mtime_to_rfc3339(mtime));
    if let Some(whole) = cache.get(abs_path, file_len, mtime) {
        return Ok(Some(slice_cached(whole, file_len, modified, offset, length)));
    }
    match cache.wait_fill_slice(
        abs_path,
        file_len,
        mtime,
        offset,
        length,
        FILE_CHUNK_MAX_BYTES as usize,
        cancelled,
    ) {
        FillWait::Cancelled => Err("request_cancelled".to_string()),
        FillWait::Unavailable => Ok(None),
        FillWait::Ready(data) => {
            let done = offset + data.len() as u64 >= file_len;
            Ok(Some(FileReadRange {
                data,
                done,
                file_size: Some(file_len),
                modified,
            }))
        }
    }
}

/// Serve a slice of a whole-file cache entry with the same offset / length /
/// done semantics as the streaming read path.
fn slice_cached(
    whole: Arc<Vec<u8>>,
    file_len: u64,
    modified: Option<String>,
    offset: u64,
    length: Option<u64>,
) -> FileReadRange {
    let data_len = whole.len() as u64;
    if offset >= data_len {
        return FileReadRange {
            data: vec![],
            done: true,
            file_size: Some(file_len),
            modified,
        };
    }
    let remaining = data_len - offset;
    let to_read = length
        .unwrap_or(remaining)
        .min(remaining)
        .min(FILE_CHUNK_MAX_BYTES) as usize;
    let start = offset as usize;
    let end = start + to_read;
    let done = offset + to_read as u64 >= file_len;
    FileReadRange {
        data: whole[start..end].to_vec(),
        done,
        file_size: Some(file_len),
        modified,
    }
}

pub fn read_file_range_with_metadata(
    roots: &[RootConfig],
    root_name: &str,
    path: &str,
    offset: u64,
    length: Option<u64>,
    content_cache: Option<&Arc<ContentCache>>,
    cancelled: Option<&AtomicBool>,
) -> Result<FileReadRange, String> {
    if cancelled.is_some_and(|c| c.load(Ordering::Acquire)) {
        return Err("request_cancelled".to_string());
    }

    let rel_key = path.strip_prefix('/').unwrap_or(path);
    if is_path_denied(rel_key) {
        return Err("Access denied: sensitive file".to_string());
    }

    // Skip canonicalize/open/stat while a recent alias is still fresh.
    if let Some(cache) = content_cache {
        if let Some((abs_path, file_len, mtime)) = cache.logical_lookup(root_name, rel_key) {
            if let Some(range) = serve_from_cache(
                cache,
                &abs_path,
                file_len,
                mtime,
                offset,
                length,
                cancelled,
            )? {
                cache.touch_logical(root_name, rel_key);
                return Ok(range);
            }
            if cancelled.is_some_and(|c| c.load(Ordering::Acquire)) {
                return Err("request_cancelled".to_string());
            }
        }
    }

    let (abs_path, root_canonical) = resolve_path(roots, root_name, path)?;

    let rel_path = abs_path
        .strip_prefix(&root_canonical)
        .map_err(|_| "Path not found or outside root".to_string())?;
    let rel = rel_path.to_string_lossy().to_string();
    if is_path_denied(&rel) || is_sensitive_virtual_path(&abs_path) {
        return Err("Access denied: sensitive file".to_string());
    }

    let mut file = open_resolved_leaf(&root_canonical, rel_path, &abs_path)?;
    let file_metadata = file
        .metadata()
        .map_err(|e| format!("Failed to stat file: {}", e))?;

    if !file_metadata.is_file() {
        return Err(format!("Not a file: {}", path));
    }
    set_file_blocking(&file)?;

    let file_len = file_metadata.len();
    let file_mtime = file_metadata.modified().ok();
    let modified = file_mtime.map(mtime_to_rfc3339);

    // Small-file fast path. Prefer the in-flight fill over a competing
    // direct read: two readers of the same NFS file (live chunk + fill)
    // were turning each Hub round-trip into another metadata stall.
    let cache_cap = content_cache.map(|c| c.max_file_bytes() as u64).unwrap_or(0);
    if cache_cap > 0 && file_len <= cache_cap {
        if let (Some(cache), Some(mtime)) = (content_cache, file_mtime) {
            cache.remember_logical(root_name, rel_key, abs_path.clone(), file_len, mtime);
            if let Some(range) = serve_from_cache(
                cache,
                &abs_path,
                file_len,
                mtime,
                offset,
                length,
                cancelled,
            )? {
                cache.touch_logical(root_name, rel_key);
                return Ok(range);
            }
            // Do not wait on this fill: we already hold an open fd.
            cache.begin_fill(abs_path.clone(), file_len, mtime);
        }
    }

    if cancelled.is_some_and(|c| c.load(Ordering::Acquire)) {
        return Err("request_cancelled".to_string());
    }
    direct_range_read(&mut file, offset, length, file_len, modified)
}

/// Read one range directly from the open file (the streaming path). The
/// agent never slurps more than one WS chunk per request, but a single
/// `read()` syscall is looped until that chunk is full or EOF — a short
/// read is not a completed chunk.
fn direct_range_read(
    file: &mut fs::File,
    offset: u64,
    length: Option<u64>,
    file_len: u64,
    modified: Option<String>,
) -> Result<FileReadRange, String> {
    if offset >= file_len {
        return Ok(FileReadRange {
            data: vec![],
            done: true,
            file_size: Some(file_len),
            modified,
        });
    }

    file.seek(SeekFrom::Start(offset))
        .map_err(|e| format!("Failed to seek: {}", e))?;

    let remaining = file_len - offset;
    let to_read = length.unwrap_or(remaining).min(remaining);
    // Cap per WS FileChunk so slow/jittery links don't stall a single write.
    let to_read = to_read.min(FILE_CHUNK_MAX_BYTES);

    let mut buf = vec![0u8; to_read as usize];
    let bytes_read = read_at_least(file, &mut buf)
        .map_err(|e| format!("Failed to read: {}", e))?;

    buf.truncate(bytes_read);
    let done = offset + bytes_read as u64 >= file_len;

    Ok(FileReadRange {
        data: buf,
        done,
        file_size: Some(file_len),
        modified,
    })
}

#[cfg(test)]
pub fn read_file_range(
    roots: &[RootConfig],
    root_name: &str,
    path: &str,
    offset: u64,
    length: Option<u64>,
) -> Result<(Vec<u8>, bool), String> {
    let result = read_file_range_with_metadata(roots, root_name, path, offset, length, None, None)?;
    Ok((result.data, result.done))
}

#[cfg(test)]
mod tests {
    use super::*;
    use filebox_protocol::resources::{FsEntryType, RootConfig};
    use std::fs;
    use std::io::Write;
    use tempfile::tempdir;

    fn make_root(name: &str, path: std::path::PathBuf, enabled: bool) -> RootConfig {
        RootConfig {
            name: name.to_string(),
            path: path.to_string_lossy().to_string(),
            enabled,
            pinned_folders: vec![],
        }
    }

    struct Sandbox {
        _root_dir: tempfile::TempDir,
        root_path: std::path::PathBuf,
    }

    impl Sandbox {
        fn new() -> Self {
            let dir = tempdir().unwrap();
            let root_path = dir.path().canonicalize().unwrap();
            Self {
                _root_dir: dir,
                root_path,
            }
        }

        fn root(&self) -> RootConfig {
            make_root("test", self.root_path.clone(), true)
        }

        fn write_file(&self, rel: &str, contents: &[u8]) {
            let path = self.root_path.join(rel);
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).unwrap();
            }
            let mut f = fs::File::create(&path).unwrap();
            f.write_all(contents).unwrap();
        }

        fn mkdir(&self, rel: &str) {
            fs::create_dir_all(self.root_path.join(rel)).unwrap();
        }
    }

    #[test]
    fn list_directory_returns_empty_for_empty_dir() {
        let sb = Sandbox::new();
        let roots = vec![sb.root()];

        let (items, next) = list_directory(&roots, "test", "", 100, None, false).unwrap();
        assert!(items.is_empty());
        assert!(next.is_none());
    }

    #[test]
    fn list_directory_lists_files_and_dirs() {
        let sb = Sandbox::new();
        sb.write_file("a.txt", b"hello");
        sb.write_file("b.md", b"# hi");
        sb.mkdir("subdir");
        let roots = vec![sb.root()];

        let (items, _) = list_directory(&roots, "test", "", 100, None, false).unwrap();
        let names: Vec<_> = items.iter().map(|i| i.name.as_str()).collect();

        // Directory should come first, then files alphabetically
        assert_eq!(names, vec!["subdir", "a.txt", "b.md"]);

        // Types
        let subdir = items.iter().find(|i| i.name == "subdir").unwrap();
        assert_eq!(subdir.entry_type, FsEntryType::Directory);
        assert!(subdir.size.is_none());

        let a = items.iter().find(|i| i.name == "a.txt").unwrap();
        assert_eq!(a.entry_type, FsEntryType::File);
        assert_eq!(a.size, Some(5));
    }

    #[test]
    fn list_directory_marks_denied_files_with_flag() {
        let sb = Sandbox::new();
        sb.write_file(".env", b"SECRET=1");
        sb.write_file("safe.txt", b"safe");
        let roots = vec![sb.root()];

        let (items, _) = list_directory(&roots, "test", "", 100, None, false).unwrap();
        let env = items.iter().find(|i| i.name == ".env").unwrap();
        assert!(env.denied, ".env must be marked denied");
        assert!(env.size.is_none(), "denied file size must be hidden");
        assert!(env.modified.is_none(), "denied file mtime must be hidden");
        let safe = items.iter().find(|i| i.name == "safe.txt").unwrap();
        assert!(!safe.denied);
        assert_eq!(safe.size, Some(4));
        assert!(safe.modified.is_some());
    }

    #[test]
    fn list_directory_rejects_unknown_root_name() {
        let sb = Sandbox::new();
        let roots = vec![sb.root()];
        let result = list_directory(&roots, "other", "", 100, None, false);
        assert!(result.is_err());
    }

    #[test]
    fn list_directory_rejects_disabled_root() {
        let sb = Sandbox::new();
        let roots = vec![make_root("test", sb.root_path.clone(), false)];
        let result = list_directory(&roots, "test", "", 100, None, false);
        assert!(result.is_err());
    }

    #[test]
    fn list_directory_navigates_subdirs() {
        let sb = Sandbox::new();
        sb.write_file("sub/file.txt", b"x");
        let roots = vec![sb.root()];

        let (items, _) = list_directory(&roots, "test", "sub", 100, None, false).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].name, "file.txt");
    }

    #[test]
    fn list_directory_pagination_returns_cursor() {
        let sb = Sandbox::new();
        // Create 5 files: a, b, c, d, e
        for ch in ['a', 'b', 'c', 'd', 'e'] {
            sb.write_file(&format!("{}.txt", ch), b"x");
        }
        let roots = vec![sb.root()];

        // Page size 2: first page
        let (page1, next1) = list_directory(&roots, "test", "", 2, None, false).unwrap();
        assert_eq!(page1.len(), 2);
        assert!(next1.is_some());

        // Page 2
        let (page2, next2) =
            list_directory(&roots, "test", "", 2, next1.as_deref(), false).unwrap();
        assert_eq!(page2.len(), 2);
        assert!(next2.is_some());

        // Page 3 (partial)
        let (page3, next3) =
            list_directory(&roots, "test", "", 2, next2.as_deref(), false).unwrap();
        assert_eq!(page3.len(), 1);
        assert!(next3.is_none());
    }

    #[test]
    fn stat_file_returns_metadata() {
        let sb = Sandbox::new();
        sb.write_file("data.txt", b"1234567890");
        let roots = vec![sb.root()];

        let stat = stat_file(&roots, "test", "data.txt").unwrap();
        assert_eq!(stat.size, 10);
        assert_eq!(stat.entry_type, FsEntryType::File);
        assert!(!stat.denied);
        assert!(stat.modified.is_some());
    }

    #[test]
    fn stat_file_rejects_denied_files() {
        let sb = Sandbox::new();
        sb.write_file("server.key", b"PRIVATE KEY");
        let roots = vec![sb.root()];

        let err = stat_file(&roots, "test", "server.key").unwrap_err();
        assert!(err.contains("denied") || err.contains("sensitive"));
    }

    #[test]
    fn stat_file_rejects_path_outside_root() {
        let sb = Sandbox::new();
        let roots = vec![sb.root()];

        // Try to escape with ../
        let result = stat_file(&roots, "test", "../../../etc/passwd");
        assert!(result.is_err());
    }

    #[test]
    fn stat_file_returns_error_for_missing_file() {
        let sb = Sandbox::new();
        let roots = vec![sb.root()];
        let result = stat_file(&roots, "test", "nope.txt");
        assert!(result.is_err());
    }

    #[test]
    fn read_file_range_reads_whole_file_when_no_length() {
        let sb = Sandbox::new();
        sb.write_file("data.bin", b"hello world");
        let roots = vec![sb.root()];

        let (data, done) = read_file_range(&roots, "test", "data.bin", 0, None).unwrap();
        assert_eq!(data, b"hello world");
        assert!(done);
    }

    #[test]
    fn read_file_range_respects_length() {
        let sb = Sandbox::new();
        sb.write_file("data.bin", b"hello world");
        let roots = vec![sb.root()];

        let (data, done) = read_file_range(&roots, "test", "data.bin", 0, Some(5)).unwrap();
        assert_eq!(data, b"hello");
        assert!(!done);
    }

    #[test]
    fn read_file_range_reads_from_offset() {
        let sb = Sandbox::new();
        sb.write_file("data.bin", b"hello world");
        let roots = vec![sb.root()];

        let (data, done) = read_file_range(&roots, "test", "data.bin", 6, None).unwrap();
        assert_eq!(data, b"world");
        assert!(done);
    }

    #[test]
    fn read_file_range_returns_empty_when_offset_at_eof() {
        let sb = Sandbox::new();
        sb.write_file("data.bin", b"hi");
        let roots = vec![sb.root()];

        let (data, done) = read_file_range(&roots, "test", "data.bin", 2, None).unwrap();
        assert!(data.is_empty());
        assert!(done);
    }

    #[test]
    fn read_file_range_caps_at_file_chunk_max_per_chunk() {
        let sb = Sandbox::new();
        // Create a file larger than one chunk so the cap is observable.
        let big = vec![0xAAu8; (FILE_CHUNK_MAX_BYTES as usize) + 1024];
        sb.write_file("big.bin", &big);
        let roots = vec![sb.root()];

        let (data, done) = read_file_range(&roots, "test", "big.bin", 0, None).unwrap();
        assert_eq!(data.len(), FILE_CHUNK_MAX_BYTES as usize);
        assert!(!done, "done must be false when capped mid-file");
    }

    #[test]
    fn read_file_range_rejects_denied_file() {
        let sb = Sandbox::new();
        sb.write_file("secret.key", b"contents");
        let roots = vec![sb.root()];

        let result = read_file_range(&roots, "test", "secret.key", 0, None);
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.contains("denied") || err.contains("sensitive"));
    }

    #[test]
    fn read_file_range_rejects_path_escape() {
        let sb = Sandbox::new();
        let roots = vec![sb.root()];

        let result = read_file_range(&roots, "test", "../../../etc/passwd", 0, None);
        assert!(result.is_err());
    }

    #[test]
    fn read_file_range_rejects_directory_target() {
        let sb = Sandbox::new();
        sb.mkdir("somedir");
        let roots = vec![sb.root()];

        let result = read_file_range(&roots, "test", "somedir", 0, None);
        assert!(result.is_err());
    }

    #[test]
    fn read_file_range_respects_disabled_root() {
        let sb = Sandbox::new();
        sb.write_file("x.txt", b"x");
        let roots = vec![make_root("test", sb.root_path.clone(), false)];

        let result = read_file_range(&roots, "test", "x.txt", 0, None);
        assert!(result.is_err());
    }

    #[test]
    fn read_file_range_handles_leading_slash_in_path() {
        let sb = Sandbox::new();
        sb.write_file("x.txt", b"x");
        let roots = vec![sb.root()];

        // Leading / should be stripped, not treated as absolute
        let (data, _) = read_file_range(&roots, "test", "/x.txt", 0, None).unwrap();
        assert_eq!(data, b"x");
    }

    #[cfg(unix)]
    #[test]
    fn read_file_range_rejects_symlink_escape() {
        let sb = Sandbox::new();
        // Create a file outside the root via symlink
        let outside = tempfile::NamedTempFile::new().unwrap();
        let link_path = sb.root_path.join("escape");
        std::os::unix::fs::symlink(outside.path(), &link_path).unwrap();
        let roots = vec![sb.root()];

        // canonicalize() will resolve the symlink, then starts_with check fails
        let result = read_file_range(&roots, "test", "escape", 0, None);
        assert!(
            result.is_err(),
            "symlink escaping the root must be rejected"
        );
    }

    #[cfg(unix)]
    #[test]
    fn read_file_range_allows_stable_symlink_inside_root() {
        let sb = Sandbox::new();
        sb.write_file("target.txt", b"inside");
        let link_path = sb.root_path.join("link.txt");
        std::os::unix::fs::symlink(sb.root_path.join("target.txt"), &link_path).unwrap();
        let roots = vec![sb.root()];

        let (data, done) = read_file_range(&roots, "test", "link.txt", 0, None).unwrap();
        assert_eq!(data, b"inside");
        assert!(done);
    }

    #[cfg(unix)]
    #[test]
    fn safe_open_rejects_final_symlink_after_resolution() {
        let sb = Sandbox::new();
        sb.write_file("victim.txt", b"safe");
        let outside = tempfile::NamedTempFile::new().unwrap();
        fs::remove_file(sb.root_path.join("victim.txt")).unwrap();
        std::os::unix::fs::symlink(outside.path(), sb.root_path.join("victim.txt")).unwrap();

        let result = open_resolved_leaf(
            &sb.root_path,
            std::path::Path::new("victim.txt"),
            &sb.root_path.join("victim.txt"),
        );
        assert!(result.is_err(), "replaced final symlink must not be followed");
    }

    #[cfg(unix)]
    #[test]
    fn safe_open_rejects_intermediate_symlink_after_resolution() {
        let sb = Sandbox::new();
        sb.write_file("dir/file.txt", b"safe");
        let outside = tempdir().unwrap();
        fs::write(outside.path().join("file.txt"), b"outside").unwrap();
        fs::remove_dir_all(sb.root_path.join("dir")).unwrap();
        std::os::unix::fs::symlink(outside.path(), sb.root_path.join("dir")).unwrap();

        let result = open_resolved_leaf(
            &sb.root_path,
            std::path::Path::new("dir/file.txt"),
            &sb.root_path.join("dir/file.txt"),
        );
        assert!(result.is_err(), "replaced directory symlink must not be followed");
    }

    #[cfg(unix)]
    #[test]
    fn sensitive_virtual_path_detection_rejects_absolute_virtual_paths() {
        assert!(is_sensitive_virtual_path(Path::new("/proc")));
        assert!(is_sensitive_virtual_path(Path::new("/proc/self")));
        assert!(is_sensitive_virtual_path(Path::new("/sys/kernel")));
        assert!(is_sensitive_virtual_path(Path::new("/dev/fd")));
        assert!(!is_sensitive_virtual_path(Path::new("/tmp/project/proc/readme.txt")));
        assert!(!is_sensitive_virtual_path(Path::new("/tmp/project/src/sys/mod.rs")));
    }

    #[test]
    fn list_directory_returns_modified_timestamp_for_files() {
        let sb = Sandbox::new();
        sb.write_file("timestamped.txt", b"x");
        let roots = vec![sb.root()];

        let (items, _) = list_directory(&roots, "test", "", 100, None, false).unwrap();
        let entry = items.iter().find(|i| i.name == "timestamped.txt").unwrap();
        assert!(entry.modified.is_some(), "modified timestamp must be present");
    }

    #[test]
    fn list_directory_rejects_path_outside_root() {
        let sb = Sandbox::new();
        let roots = vec![sb.root()];

        // Try to list a path that escapes
        let result = list_directory(&roots, "test", "../../..", 100, None, false);
        assert!(result.is_err());
    }

    #[test]
    fn list_directory_fails_when_target_is_file_not_dir() {
        let sb = Sandbox::new();
        sb.write_file("afile.txt", b"x");
        let roots = vec![sb.root()];

        let result = list_directory(&roots, "test", "afile.txt", 100, None, false);
        assert!(result.is_err());
    }

    #[test]
    fn stat_directory_returns_directory_type() {
        let sb = Sandbox::new();
        sb.mkdir("adir");
        let roots = vec![sb.root()];

        let stat = stat_file(&roots, "test", "adir").unwrap();
        assert_eq!(stat.entry_type, FsEntryType::Directory);
    }

    // ── resolve_path error message tests ──
    // These verify the specific error strings that resolve_path now returns.
    // The messages are user-facing (they propagate to the frontend), so they
    // must be stable and distinguishable.

    #[test]
    fn resolve_path_error_for_unknown_root() {
        let sb = Sandbox::new();
        let roots = vec![sb.root()];
        let err = stat_file(&roots, "nonexistent", "").unwrap_err();
        assert!(
            err.contains("not found or disabled"),
            "expected root-not-found message, got: {err}"
        );
    }

    #[test]
    fn resolve_path_error_for_disabled_root() {
        let sb = Sandbox::new();
        let roots = vec![make_root("test", sb.root_path.clone(), false)];
        let err = stat_file(&roots, "test", "").unwrap_err();
        assert!(
            err.contains("not found or disabled"),
            "expected disabled-root message, got: {err}"
        );
    }

    #[test]
    fn resolve_path_error_for_missing_root_directory() {
        // Root path doesn't exist on disk — should say "not accessible"
        let roots = vec![RootConfig {
            name: "ghost".to_string(),
            path: "/nonexistent/path/xyz".to_string(),
            enabled: true,
            pinned_folders: vec![],
        }];
        let err = stat_file(&roots, "ghost", "").unwrap_err();
        assert!(
            err.contains("not accessible"),
            "expected root-not-accessible message, got: {err}"
        );
    }

    #[test]
    fn resolve_path_error_for_path_escape() {
        let sb = Sandbox::new();
        // Create a real file in the parent of the sandbox root, reachable
        // via "../" — canonicalize will succeed, triggering the starts_with
        // containment check which produces the "outside root" error.
        let sibling = tempfile::NamedTempFile::new_in(sb.root_path.parent().unwrap()).unwrap();
        let sibling_name = sibling.path().file_name().unwrap();
        let escape_path = format!("../{}", sibling_name.to_string_lossy());

        let roots = vec![sb.root()];
        let err = stat_file(&roots, "test", &escape_path).unwrap_err();
        assert!(
            err.contains("outside root"),
            "expected path-escape message, got: {err}"
        );
    }

    // ── content cache behavior ──

    fn small_cache() -> Arc<ContentCache> {
        Arc::new(ContentCache::new(1024 * 1024, 4 * 1024 * 1024))
    }

    #[test]
    fn read_file_range_caches_small_file_and_serves_slices() {
        let sb = Sandbox::new();
        let payload: Vec<u8> = (0..1000).map(|i| (i % 251) as u8).collect();
        sb.write_file("data.bin", &payload);
        let roots = vec![sb.root()];
        let cache = small_cache();

        // First read serves the slice directly; a background fill then
        // caches the whole file.
        let first = read_file_range_with_metadata(&roots, "test", "data.bin", 0, Some(100), Some(&cache), None)
            .unwrap();
        assert_eq!(first.data, payload[..100]);
        assert!(!first.done);

        // Wait for the background fill to complete, then a later chunk
        // reads from the cache — same bytes, and the whole file is now
        // resident (len reflects the cached entry).
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while cache.len() < 1 && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        let tail = read_file_range_with_metadata(&roots, "test", "data.bin", 900, None, Some(&cache), None)
            .unwrap();
        assert_eq!(tail.data, payload[900..]);
        assert!(tail.done);
        assert_eq!(tail.file_size, Some(1000));
        assert!(cache.len() >= 1);

        // Offset at EOF still returns an empty done chunk from the cache.
        let at_eof = read_file_range_with_metadata(&roots, "test", "data.bin", 1000, None, Some(&cache), None)
            .unwrap();
        assert!(at_eof.data.is_empty());
        assert!(at_eof.done);
    }

    #[test]
    fn read_file_range_invalidates_cache_when_file_changes() {
        let sb = Sandbox::new();
        sb.write_file("data.bin", b"version one");
        let roots = vec![sb.root()];
        let cache = small_cache();

        let first = read_file_range_with_metadata(&roots, "test", "data.bin", 0, None, Some(&cache), None)
            .unwrap();
        assert_eq!(first.data, b"version one");

        // Same size, different content + mtime: the cache must NOT serve the
        // stale body. Disable the logical-path restat cooldown so this
        // assertion is about content-key invalidation, not the sequential-
        // stream shortcut.
        cache.set_restat_cooldown_ms(0);
        std::thread::sleep(std::time::Duration::from_millis(10));
        sb.write_file("data.bin", b"version two");
        let second = read_file_range_with_metadata(&roots, "test", "data.bin", 0, None, Some(&cache), None)
            .unwrap();
        assert_eq!(second.data, b"version two");
    }

    #[test]
    fn read_file_range_skips_cache_for_files_over_cap() {
        let sb = Sandbox::new();
        let big = vec![0xBBu8; 2048];
        sb.write_file("big.bin", &big);
        let roots = vec![sb.root()];
        // Cap of 1 KiB: the 2 KiB file must stream per chunk, uncached.
        let cache = Arc::new(ContentCache::new(1024 * 1024, 1024));

        let first = read_file_range_with_metadata(&roots, "test", "big.bin", 0, Some(1024), Some(&cache), None)
            .unwrap();
        assert_eq!(first.data.len(), 1024);
        assert_eq!(cache.len(), 0, "over-cap files must not be cached");
    }

    #[test]
    fn read_file_range_cache_respects_denylist() {
        let sb = Sandbox::new();
        sb.write_file("secret.key", b"nope");
        let roots = vec![sb.root()];
        let cache = small_cache();

        let result = read_file_range_with_metadata(&roots, "test", "secret.key", 0, None, Some(&cache), None);
        assert!(result.is_err());
        assert_eq!(cache.len(), 0, "denied files must never reach the cache");
    }

    struct ShortReader<'a> {
        data: &'a [u8],
        max_per_read: usize,
        pos: usize,
    }

    impl std::io::Read for ShortReader<'_> {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            if self.pos >= self.data.len() {
                return Ok(0);
            }
            let n = (self.data.len() - self.pos)
                .min(buf.len())
                .min(self.max_per_read.max(1));
            buf[..n].copy_from_slice(&self.data[self.pos..self.pos + n]);
            self.pos += n;
            Ok(n)
        }
    }

    #[test]
    fn read_at_least_fills_the_buffer_across_short_reads() {
        let payload: Vec<u8> = (0..10_000).map(|i| (i % 251) as u8).collect();
        let mut reader = ShortReader {
            data: &payload,
            max_per_read: 50,
            pos: 0,
        };
        let mut buf = vec![0u8; 4_000];
        let n = read_at_least(&mut reader, &mut buf).unwrap();
        assert_eq!(n, 4_000, "must loop until the requested length is filled");
        assert_eq!(&buf, &payload[..4_000]);
        assert_eq!(reader.pos, 4_000);
    }

    #[test]
    fn read_at_least_stops_at_eof() {
        let payload = b"hello";
        let mut reader = ShortReader {
            data: payload,
            max_per_read: 1,
            pos: 0,
        };
        let mut buf = vec![0u8; 100];
        let n = read_at_least(&mut reader, &mut buf).unwrap();
        assert_eq!(n, 5);
        assert_eq!(&buf[..5], payload);
    }

    #[test]
    fn sequential_chunks_of_a_cached_file_match_the_source() {
        let sb = Sandbox::new();
        let payload: Vec<u8> = (0..8_000).map(|i| (i % 251) as u8).collect();
        sb.write_file("photo.bin", &payload);
        let roots = vec![sb.root()];
        let cache = small_cache();

        let first = read_file_range_with_metadata(
            &roots, "test", "photo.bin", 0, Some(3_000), Some(&cache), None,
        )
        .unwrap();
        assert_eq!(first.data, payload[..3_000]);
        assert!(!first.done);

        let second = read_file_range_with_metadata(
            &roots, "test", "photo.bin", 3_000, Some(3_000), Some(&cache), None,
        )
        .unwrap();
        assert_eq!(second.data, payload[3_000..6_000]);

        let tail = read_file_range_with_metadata(
            &roots, "test", "photo.bin", 6_000, None, Some(&cache), None,
        )
        .unwrap();
        assert_eq!(tail.data, payload[6_000..]);
        assert!(tail.done);
    }

    #[test]
    fn cancelled_read_returns_before_opening() {
        let sb = Sandbox::new();
        sb.write_file("photo.bin", b"hello");
        let roots = vec![sb.root()];
        let cache = small_cache();
        let _ = read_file_range_with_metadata(
            &roots, "test", "photo.bin", 0, None, Some(&cache), None,
        )
        .unwrap();
        let flag = std::sync::atomic::AtomicBool::new(true);
        let result = read_file_range_with_metadata(
            &roots, "test", "photo.bin", 0, None, Some(&cache), Some(&flag),
        );
        match result {
            Err(err) => assert!(err.contains("cancelled"), "{err}"),
            Ok(_) => panic!("cancelled read must not succeed"),
        }
    }
}
