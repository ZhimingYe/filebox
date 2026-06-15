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

        let (items, next) = list_directory(&roots, "test", "", 100, None).unwrap();
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

        let (items, _) = list_directory(&roots, "test", "", 100, None).unwrap();
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

        let (items, _) = list_directory(&roots, "test", "", 100, None).unwrap();
        let env = items.iter().find(|i| i.name == ".env").unwrap();
        assert!(env.denied, ".env must be marked denied");
        let safe = items.iter().find(|i| i.name == "safe.txt").unwrap();
        assert!(!safe.denied);
    }

    #[test]
    fn list_directory_rejects_unknown_root_name() {
        let sb = Sandbox::new();
        let roots = vec![sb.root()];
        let result = list_directory(&roots, "other", "", 100, None);
        assert!(result.is_err());
    }

    #[test]
    fn list_directory_rejects_disabled_root() {
        let sb = Sandbox::new();
        let roots = vec![make_root("test", sb.root_path.clone(), false)];
        let result = list_directory(&roots, "test", "", 100, None);
        assert!(result.is_err());
    }

    #[test]
    fn list_directory_navigates_subdirs() {
        let sb = Sandbox::new();
        sb.write_file("sub/file.txt", b"x");
        let roots = vec![sb.root()];

        let (items, _) = list_directory(&roots, "test", "sub", 100, None).unwrap();
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
        let (page1, next1) = list_directory(&roots, "test", "", 2, None).unwrap();
        assert_eq!(page1.len(), 2);
        assert!(next1.is_some());

        // Page 2
        let (page2, next2) =
            list_directory(&roots, "test", "", 2, next1.as_deref()).unwrap();
        assert_eq!(page2.len(), 2);
        assert!(next2.is_some());

        // Page 3 (partial)
        let (page3, next3) =
            list_directory(&roots, "test", "", 2, next2.as_deref()).unwrap();
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
    fn stat_file_marks_denied_files() {
        let sb = Sandbox::new();
        sb.write_file("server.key", b"PRIVATE KEY");
        let roots = vec![sb.root()];

        let stat = stat_file(&roots, "test", "server.key").unwrap();
        assert!(stat.denied);
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
    fn read_file_range_caps_at_4mb_per_chunk() {
        let sb = Sandbox::new();
        // Create a 5MB file
        let big = vec![0xAAu8; 5 * 1024 * 1024];
        sb.write_file("big.bin", &big);
        let roots = vec![sb.root()];

        let (data, done) = read_file_range(&roots, "test", "big.bin", 0, None).unwrap();
        // Capped at 4MB
        assert_eq!(data.len(), 4 * 1024 * 1024);
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

    #[test]
    fn list_directory_returns_modified_timestamp_for_files() {
        let sb = Sandbox::new();
        sb.write_file("timestamped.txt", b"x");
        let roots = vec![sb.root()];

        let (items, _) = list_directory(&roots, "test", "", 100, None).unwrap();
        let entry = items.iter().find(|i| i.name == "timestamped.txt").unwrap();
        assert!(entry.modified.is_some(), "modified timestamp must be present");
    }

    #[test]
    fn list_directory_rejects_path_outside_root() {
        let sb = Sandbox::new();
        let roots = vec![sb.root()];

        // Try to list a path that escapes
        let result = list_directory(&roots, "test", "../../..", 100, None);
        assert!(result.is_err());
    }

    #[test]
    fn list_directory_fails_when_target_is_file_not_dir() {
        let sb = Sandbox::new();
        sb.write_file("afile.txt", b"x");
        let roots = vec![sb.root()];

        let result = list_directory(&roots, "test", "afile.txt", 100, None);
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
}
