use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use filebox_protocol::resources::{FileStat, FsEntry, FsEntryType, RootConfig};
use filebox_protocol::denylist;

/// Resolve a root name + relative path to an absolute, canonical path.
/// Returns None if root not found or path escapes the root.
fn resolve_path(roots: &[RootConfig], root_name: &str, relative_path: &str) -> Option<PathBuf> {
    let root = roots.iter().find(|r| r.name == root_name && r.enabled)?;
    let root_path = Path::new(&root.path);

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
                    let file_name = joined.file_name()?;
                    parent_canon.join(file_name)
                } else {
                    return None;
                }
            } else {
                return None;
            }
        }
    };

    // Also canonicalize the root to compare
    let root_canonical = match root_path.canonicalize() {
        Ok(p) => p,
        Err(_) => return None,
    };

    // Verify the canonical path is inside the root
    if !canonical.starts_with(&root_canonical) {
        return None;
    }

    Some(canonical)
}

/// Check if a relative path is denied by the sensitive denylist.
fn is_path_denied(relative_path: &str) -> bool {
    denylist::is_denied(relative_path)
}

/// Compute the relative path from root to the given absolute path.
fn relative_path(root_path: &Path, abs_path: &Path) -> String {
    abs_path
        .strip_prefix(root_path)
        .unwrap_or(abs_path)
        .to_string_lossy()
        .to_string()
}

pub fn list_directory(
    roots: &[RootConfig],
    root_name: &str,
    path: &str,
    limit: usize,
    cursor: Option<&str>,
) -> Result<(Vec<FsEntry>, Option<String>), String> {
    let abs_path = resolve_path(roots, root_name, path)
        .ok_or_else(|| format!("Path not found or outside root: {}/{}", root_name, path))?;

    let root = roots
        .iter()
        .find(|r| r.name == root_name && r.enabled)
        .unwrap();
    let root_canonical = Path::new(&root.path)
        .canonicalize()
        .map_err(|e| format!("Cannot resolve root path: {}", e))?;

    if !abs_path.is_dir() {
        return Err(format!("Not a directory: {}", path));
    }

    let entries = fs::read_dir(&abs_path)
        .map_err(|e| format!("Failed to read directory: {}", e))?;

    let mut items: Vec<FsEntry> = Vec::new();

    for entry in entries {
        let entry = entry.map_err(|e| format!("Failed to read entry: {}", e))?;
        let file_name = entry.file_name().to_string_lossy().to_string();

        // Skip hidden files starting with . (but not the directory itself)
        // Actually, we show them but mark as denied if sensitive
        let rel = relative_path(&root_canonical, &entry.path());
        let denied = is_path_denied(&rel);

        let metadata = entry
            .file_type()
            .map_err(|e| format!("Failed to read file type: {}", e))?;

        let entry_type = if metadata.is_dir() {
            FsEntryType::Directory
        } else if metadata.is_symlink() {
            FsEntryType::Symlink
        } else {
            FsEntryType::File
        };

        let size = if metadata.is_file() {
            fs::metadata(entry.path()).ok().map(|m| m.len())
        } else {
            None
        };

        let modified = fs::metadata(entry.path())
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| {
                let dt: chrono::DateTime<chrono::Local> = t.into();
                Some(dt.to_rfc3339())
            });

        items.push(FsEntry {
            name: file_name,
            entry_type,
            size,
            modified,
            denied,
        });
    }

    // Sort: directories first, then alphabetically
    items.sort_by(|a, b| {
        let a_is_dir = a.entry_type == FsEntryType::Directory;
        let b_is_dir = b.entry_type == FsEntryType::Directory;
        b_is_dir
            .cmp(&a_is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    // Apply cursor pagination
    let start = if let Some(cursor) = cursor {
        items
            .iter()
            .position(|i| i.name == cursor)
            .map(|p| p + 1)
            .unwrap_or(0)
    } else {
        0
    };

    let page: Vec<FsEntry> = items.into_iter().skip(start).take(limit).collect();
    let next_cursor = if page.len() == limit {
        page.last().map(|e| e.name.clone())
    } else {
        None
    };

    Ok((page, next_cursor))
}

pub fn stat_file(
    roots: &[RootConfig],
    root_name: &str,
    path: &str,
) -> Result<FileStat, String> {
    let abs_path = resolve_path(roots, root_name, path)
        .ok_or_else(|| format!("Path not found or outside root: {}/{}", root_name, path))?;

    let root = roots
        .iter()
        .find(|r| r.name == root_name && r.enabled)
        .unwrap();
    let root_canonical = Path::new(&root.path)
        .canonicalize()
        .map_err(|e| format!("Cannot resolve root path: {}", e))?;

    let rel = relative_path(&root_canonical, &abs_path);
    let denied = is_path_denied(&rel);

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

pub fn read_file_range(
    roots: &[RootConfig],
    root_name: &str,
    path: &str,
    offset: u64,
    length: Option<u64>,
) -> Result<(Vec<u8>, bool), String> {
    let abs_path = resolve_path(roots, root_name, path)
        .ok_or_else(|| format!("Path not found or outside root: {}/{}", root_name, path))?;

    let root = roots
        .iter()
        .find(|r| r.name == root_name && r.enabled)
        .unwrap();
    let root_canonical = Path::new(&root.path)
        .canonicalize()
        .map_err(|e| format!("Cannot resolve root path: {}", e))?;

    let rel = relative_path(&root_canonical, &abs_path);
    if is_path_denied(&rel) {
        return Err("Access denied: sensitive file".to_string());
    }

    if !abs_path.is_file() {
        return Err(format!("Not a file: {}", path));
    }

    let mut file = fs::File::open(&abs_path)
        .map_err(|e| format!("Failed to open file: {}", e))?;

    let file_len = file
        .metadata()
        .map_err(|e| format!("Failed to stat file: {}", e))?
        .len();

    if offset >= file_len {
        return Ok((vec![], true));
    }

    file.seek(SeekFrom::Start(offset))
        .map_err(|e| format!("Failed to seek: {}", e))?;

    let remaining = file_len - offset;
    let to_read = length.unwrap_or(remaining).min(remaining);
    // Cap at 4MB per chunk
    let to_read = to_read.min(4 * 1024 * 1024);

    let mut buf = vec![0u8; to_read as usize];
    let bytes_read = file
        .read(&mut buf)
        .map_err(|e| format!("Failed to read: {}", e))?;

    buf.truncate(bytes_read);
    let done = offset + bytes_read as u64 >= file_len;

    Ok((buf, done))
}
