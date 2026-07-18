//! Workspace find/content search (fd/rg-like) without shelling out.
//!
//! Uses the same crates ripgrep/fd are built on (`ignore` for walking,
//! `regex` for matching). Path safety matches `fs.rs`: enabled root,
//! canonicalize + starts_with, denylist, no symlink follow.

use std::collections::VecDeque;
use std::fs;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use filebox_protocol::denylist;
use filebox_protocol::resources::RootConfig;
use filebox_protocol::search::{
    SearchContextLine, SearchHit, SearchMode, SearchResult,
};
use ignore::WalkBuilder;
use regex::RegexBuilder;

const DEFAULT_MAX_RESULTS: usize = 80;
const HARD_MAX_RESULTS_FIND: usize = 500;
const HARD_MAX_RESULTS_CONTENT: usize = 80;
const DEFAULT_CONTEXT: usize = 10;
const HARD_MAX_CONTEXT: usize = 20;
const MAX_CONTENT_FILE_BYTES: u64 = 1024 * 1024; // 1 MiB — skip huge files
const MAX_LINE_CHARS: usize = 300;
const MAX_SCANNED_FIND: u64 = 200_000;
const MAX_SCANNED_CONTENT: u64 = 100_000;
/// Soft cap on serialized payload size (hub body limit is 1 MiB).
const MAX_RESULT_BYTES: usize = 512 * 1024;
/// Soft wall-clock cap; hub allows longer waits + cancel. Prefer truncated
/// results over hanging forever.
const SEARCH_DEADLINE: Duration = Duration::from_secs(9 * 60);
/// Coalesce progress so large trees don't flood the hub SSE fanout / UI.
const PROGRESS_EVERY_FILES: u64 = 256;
const PROGRESS_EVERY: Duration = Duration::from_millis(750);

pub struct SearchParams {
    pub mode: SearchMode,
    pub root: String,
    /// Directory within the root to search (rg/fd scope). Must be a directory.
    pub path: String,
    pub query: String,
    pub extensions: Vec<String>,
    pub max_results: Option<u32>,
    pub context: Option<u32>,
    /// Path-component names to prune (from the UI per request).
    pub ignore: Vec<String>,
    /// Max directory depth under the search start. `None` / `0` = unlimited.
    /// `1` = files in the start folder only (walkdir depth semantics).
    pub max_depth: Option<u32>,
    /// Cooperative cancel — checked between files.
    pub cancel: Option<Arc<AtomicBool>>,
    /// Optional progress hook: (scanned_files, hit_count).
    pub on_progress: Option<Arc<dyn Fn(u64, u64) + Send + Sync>>,
}

pub fn run_search(roots: &[RootConfig], params: SearchParams) -> Result<SearchResult, String> {
    let hard_max = match params.mode {
        SearchMode::Find => HARD_MAX_RESULTS_FIND,
        SearchMode::Content => HARD_MAX_RESULTS_CONTENT,
    };
    let max_results = params
        .max_results
        .map(|n| n as usize)
        .unwrap_or(DEFAULT_MAX_RESULTS)
        .clamp(1, hard_max);
    let context = params
        .context
        .map(|n| n as usize)
        .unwrap_or(DEFAULT_CONTEXT)
        .min(HARD_MAX_CONTEXT);

    let start_rel = if params.path.is_empty() {
        "/"
    } else {
        params.path.as_str()
    };
    if start_rel.contains('\0') {
        return Err("Path must not contain NUL".to_string());
    }
    let (start, root_canonical) = crate::fs::resolve_path(roots, &params.root, start_rel)?;

    if !start.is_dir() {
        return Err(format!(
            "Search path is not a directory: {}{}",
            params.root, start_rel
        ));
    }

    let exts: Vec<String> = params
        .extensions
        .iter()
        .map(|e| e.trim().trim_start_matches('.').to_ascii_lowercase())
        .filter(|e| !e.is_empty())
        .collect();

    let name_needle = params.query.to_ascii_lowercase();
    let content_re = if params.mode == SearchMode::Content {
        if params.query.is_empty() {
            return Err("Content search requires a non-empty query".to_string());
        }
        Some(
            RegexBuilder::new(&params.query)
                .case_insensitive(true)
                .size_limit(1 << 20)
                .dfa_size_limit(1 << 20)
                .build()
                .map_err(|e| format!("Invalid regex: {}", e))?,
        )
    } else {
        None
    };

    let mut hits = Vec::new();
    let mut scanned: u64 = 0;
    let mut truncated = false;
    let mut approx_bytes: usize = 64; // envelope overhead
    let deadline = Instant::now() + SEARCH_DEADLINE;
    let max_scanned = match params.mode {
        SearchMode::Find => MAX_SCANNED_FIND,
        SearchMode::Content => MAX_SCANNED_CONTENT,
    };
    let cancel = params.cancel.clone();
    let on_progress = params.on_progress.clone();
    let mut last_progress = Instant::now()
        .checked_sub(PROGRESS_EVERY)
        .unwrap_or_else(Instant::now);

    let root_canonical_for_filter = root_canonical.clone();
    let ignore_names = params.ignore.clone();
    let mut builder = WalkBuilder::new(&start);
    builder
        .hidden(false)
        .git_ignore(false)
        .git_global(false)
        .git_exclude(false)
        .follow_links(false)
        .standard_filters(false)
        // Threads help on large trees without starving the async runtime
        // (this runs inside spawn_blocking).
        .threads(2)
        // Prune during the walk (do not descend). Returning false here skips
        // the whole subtree so ignored dirs never burn scan budget or get
        // post-filtered out of hits.
        .filter_entry(move |entry| {
            let abs = entry.path();
            if !abs.starts_with(&root_canonical_for_filter) {
                return false;
            }
            let Ok(rel) = abs.strip_prefix(&root_canonical_for_filter) else {
                return false;
            };
            if rel.as_os_str().is_empty() {
                return true;
            }
            if path_has_ignored_component(rel, &ignore_names) {
                return false;
            }
            let rel_str = format_rel(rel);
            !denylist::is_denied(&rel_str)
        });
    // walkdir: depth 0 = start path; depth 1 = its immediate children.
    // UI "max depth" N means search at most N levels under the start folder.
    if let Some(depth) = params.max_depth.filter(|d| *d > 0) {
        builder.max_depth(Some(depth as usize));
    }
    let walker = builder.build();

    for entry in walker {
        if cancel.as_ref().is_some_and(|c| c.load(Ordering::Relaxed)) {
            return Err("cancelled".to_string());
        }

        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        // DirEntry::file_type does not follow symlinks — skip dirs, symlinks,
        // and unknown types so we never open a link that escapes the root.
        let is_file = entry.file_type().map(|t| t.is_file()).unwrap_or(false);
        if !is_file {
            continue;
        }

        let abs = entry.path();
        if !abs.starts_with(&root_canonical) || is_sensitive_virtual_path(abs) {
            continue;
        }

        let Ok(rel) = abs.strip_prefix(&root_canonical) else {
            continue;
        };
        let rel_str = format_rel(rel);

        // Count / deadline / progress before extension filtering so a narrow
        // type filter on a huge tree still terminates and stays visible.
        if Instant::now() >= deadline {
            truncated = true;
            break;
        }

        scanned += 1;
        if scanned > max_scanned {
            truncated = true;
            break;
        }

        if let Some(cb) = on_progress.as_ref() {
            if scanned == 1
                || scanned % PROGRESS_EVERY_FILES == 0
                || last_progress.elapsed() >= PROGRESS_EVERY
            {
                cb(scanned, hits.len() as u64);
                last_progress = Instant::now();
            }
        }

        if !exts.is_empty() {
            let ext = abs
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            if !exts.iter().any(|e| e == &ext) {
                continue;
            }
        }

        match params.mode {
            SearchMode::Find => {
                if !name_needle.is_empty() {
                    let name = abs
                        .file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or("")
                        .to_ascii_lowercase();
                    if !name.contains(&name_needle) {
                        continue;
                    }
                }
                approx_bytes += rel_str.len() + 32;
                hits.push(SearchHit {
                    root: params.root.clone(),
                    path: rel_str,
                    line: None,
                    context: vec![],
                });
                if hits.len() >= max_results || approx_bytes >= MAX_RESULT_BYTES {
                    truncated = true;
                    break;
                }
            }
            SearchMode::Content => {
                let re = content_re.as_ref().unwrap();
                let before = hits.len();
                match match_file_content(
                    &root_canonical,
                    abs,
                    &rel,
                    &params.root,
                    &rel_str,
                    re,
                    context,
                    max_results,
                    &mut hits,
                    cancel.as_deref(),
                ) {
                    Ok(()) => {}
                    Err(MatchFileError::Cancelled) => {
                        return Err("cancelled".to_string());
                    }
                }
                for hit in &hits[before..] {
                    approx_bytes += hit.path.len() + 48;
                    for line in &hit.context {
                        approx_bytes += line.text.len() + 24;
                    }
                }
                if hits.len() >= max_results || approx_bytes >= MAX_RESULT_BYTES {
                    truncated = true;
                    break;
                }
            }
        }
    }

    Ok(SearchResult {
        hits,
        truncated,
        scanned,
    })
}

fn format_rel(rel: &Path) -> String {
    let s = rel.to_string_lossy().replace('\\', "/");
    if s.is_empty() {
        "/".to_string()
    } else {
        format!("/{s}")
    }
}

/// True when any path component equals an ignore name (case-insensitive).
fn path_has_ignored_component(rel: &Path, names: &[String]) -> bool {
    if names.is_empty() {
        return false;
    }
    for component in rel.components() {
        let std::path::Component::Normal(os) = component else {
            continue;
        };
        let Some(name) = os.to_str() else {
            continue;
        };
        if names
            .iter()
            .any(|ignored| ignored.eq_ignore_ascii_case(name))
        {
            return true;
        }
    }
    false
}

enum MatchFileError {
    Cancelled,
}

/// Check cancel every N lines inside a single file so a huge file cannot
/// ignore Cancel until EOF (still cooperative — blocked reads may stall).
const CANCEL_CHECK_EVERY_LINES: u64 = 256;

fn match_file_content(
    root_canonical: &Path,
    abs: &Path,
    rel: &Path,
    root: &str,
    rel_str: &str,
    re: &regex::Regex,
    context: usize,
    max_results: usize,
    hits: &mut Vec<SearchHit>,
    cancel: Option<&AtomicBool>,
) -> Result<(), MatchFileError> {
    // symlink_metadata does not follow — reject links / non-regular files.
    let meta = match fs::symlink_metadata(abs) {
        Ok(m) => m,
        Err(_) => return Ok(()),
    };
    if !meta.file_type().is_file() || meta.len() > MAX_CONTENT_FILE_BYTES {
        return Ok(());
    }

    // Same openat + O_NOFOLLOW chain as fs reads: refuse intermediate symlink
    // swaps that could redirect past the root after the walker's canonicalize.
    let file = match crate::fs::open_resolved_leaf(root_canonical, rel, abs) {
        Ok(f) => f,
        Err(_) => return Ok(()),
    };
    let mut reader = BufReader::new(file);

    // Reject obvious binary: null in the first 8KiB.
    let mut probe = [0u8; 8192];
    let n = match reader.read(&mut probe) {
        Ok(n) => n,
        Err(_) => return Ok(()),
    };
    if probe[..n].contains(&0) {
        return Ok(());
    }
    if reader.seek(SeekFrom::Start(0)).is_err() {
        return Ok(());
    }

    let mut before: VecDeque<(u64, String)> = VecDeque::with_capacity(context + 1);
    let mut pending_after: usize = 0;
    let mut current: Option<SearchHit> = None;
    let mut line_no: u64 = 0;

    for line_res in reader.lines() {
        if line_no > 0
            && line_no % CANCEL_CHECK_EVERY_LINES == 0
            && cancel.is_some_and(|c| c.load(Ordering::Relaxed))
        {
            return Err(MatchFileError::Cancelled);
        }
        let raw = match line_res {
            Ok(l) => l,
            Err(_) => break,
        };
        line_no += 1;
        let text = truncate_line(&raw);
        let is_match = re.is_match(&raw);

        if is_match {
            // Close any open hit (even if after-context was incomplete).
            if let Some(hit) = current.take() {
                hits.push(hit);
                if hits.len() >= max_results {
                    return Ok(());
                }
            }
            let mut ctx = Vec::with_capacity(context * 2 + 1);
            for (ln, t) in &before {
                ctx.push(SearchContextLine {
                    line: *ln,
                    text: t.clone(),
                    is_match: false,
                });
            }
            ctx.push(SearchContextLine {
                line: line_no,
                text: text.clone(),
                is_match: true,
            });
            current = Some(SearchHit {
                root: root.to_string(),
                path: rel_str.to_string(),
                line: Some(line_no),
                context: ctx,
            });
            pending_after = context;
            if pending_after == 0 {
                hits.push(current.take().unwrap());
                if hits.len() >= max_results {
                    return Ok(());
                }
            }
        } else if let Some(hit) = current.as_mut() {
            if pending_after > 0 {
                hit.context.push(SearchContextLine {
                    line: line_no,
                    text: text.clone(),
                    is_match: false,
                });
                pending_after -= 1;
                if pending_after == 0 {
                    hits.push(current.take().unwrap());
                    if hits.len() >= max_results {
                        return Ok(());
                    }
                }
            }
        }

        before.push_back((line_no, text));
        if before.len() > context {
            before.pop_front();
        }
    }

    if let Some(hit) = current {
        hits.push(hit);
    }
    Ok(())
}

fn truncate_line(s: &str) -> String {
    let mut out = String::new();
    for (i, ch) in s.chars().enumerate() {
        if i >= MAX_LINE_CHARS {
            out.push('…');
            break;
        }
        // Keep output JSON-friendly / UI-safe: drop control chars except tab.
        if ch == '\t' || !ch.is_control() {
            out.push(ch);
        }
    }
    out
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

#[cfg(test)]
mod tests {
    use super::*;
    use filebox_protocol::resources::RootConfig;
    use std::path::PathBuf;
    use tempfile::tempdir;

    fn root(name: &str, path: PathBuf) -> RootConfig {
        RootConfig {
            name: name.to_string(),
            path: path.to_string_lossy().to_string(),
            enabled: true,
            pinned_folders: vec![],
        }
    }

    #[test]
    fn find_filters_by_extension_and_name() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("alpha.rs"), "fn a() {}").unwrap();
        fs::write(dir.path().join("beta.ts"), "export {}").unwrap();
        fs::write(dir.path().join("gamma.rs"), "fn g() {}").unwrap();
        fs::create_dir(dir.path().join("sub")).unwrap();
        fs::write(dir.path().join("sub/alpha_util.rs"), "fn u() {}").unwrap();

        let roots = vec![root("ws", dir.path().to_path_buf())];
        let result = run_search(
            &roots,
            SearchParams {
                mode: SearchMode::Find,
                root: "ws".into(),
                path: "/".into(),
                query: "alpha".into(),
                extensions: vec!["rs".into()],
                max_results: Some(50),
                context: None,
                ignore: vec![],
                max_depth: None,
                cancel: None,
                on_progress: None,
            },
        )
        .unwrap();

        let names: Vec<_> = result.hits.iter().map(|h| h.path.as_str()).collect();
        assert!(names.contains(&"/alpha.rs"));
        assert!(names.contains(&"/sub/alpha_util.rs"));
        assert!(!names.iter().any(|p| p.ends_with("beta.ts")));
        assert!(!names.iter().any(|p| p.ends_with("gamma.rs")));
    }

    #[test]
    fn content_returns_context_lines() {
        let dir = tempdir().unwrap();
        let body = (1..=30)
            .map(|i| format!("line {i}"))
            .collect::<Vec<_>>()
            .join("\n");
        fs::write(dir.path().join("notes.txt"), body).unwrap();

        let roots = vec![root("ws", dir.path().to_path_buf())];
        let result = run_search(
            &roots,
            SearchParams {
                mode: SearchMode::Content,
                root: "ws".into(),
                path: "/".into(),
                query: "line 15".into(),
                extensions: vec!["txt".into()],
                max_results: Some(10),
                context: Some(2),
                ignore: vec![],
                max_depth: None,
                cancel: None,
                on_progress: None,
            },
        )
        .unwrap();

        assert_eq!(result.hits.len(), 1);
        let hit = &result.hits[0];
        assert_eq!(hit.line, Some(15));
        assert_eq!(hit.context.len(), 5); // 2 before + match + 2 after
        assert!(hit
            .context
            .iter()
            .any(|c| c.is_match && c.text.contains("line 15")));
        assert_eq!(hit.context.first().unwrap().line, 13);
        assert_eq!(hit.context.last().unwrap().line, 17);
    }

    #[test]
    fn content_adjacent_matches_do_not_duplicate_hits() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("a.txt"), "foo\nfoo\nbar\n").unwrap();
        let roots = vec![root("ws", dir.path().to_path_buf())];
        let result = run_search(
            &roots,
            SearchParams {
                mode: SearchMode::Content,
                root: "ws".into(),
                path: "/".into(),
                query: "foo".into(),
                extensions: vec!["txt".into()],
                max_results: Some(20),
                context: Some(1),
                ignore: vec![],
                max_depth: None,
                cancel: None,
                on_progress: None,
            },
        )
        .unwrap();
        assert_eq!(result.hits.len(), 2);
        assert_eq!(result.hits[0].line, Some(1));
        assert_eq!(result.hits[1].line, Some(2));
    }

    #[test]
    fn denylist_skips_env_files_and_git_dir() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join(".env"), "SECRET=1").unwrap();
        fs::create_dir_all(dir.path().join(".git")).unwrap();
        fs::write(dir.path().join(".git/config"), "SECRET=1").unwrap();
        fs::write(dir.path().join("ok.txt"), "SECRET=1").unwrap();

        let roots = vec![root("ws", dir.path().to_path_buf())];
        let result = run_search(
            &roots,
            SearchParams {
                mode: SearchMode::Content,
                root: "ws".into(),
                path: "/".into(),
                query: "SECRET".into(),
                extensions: vec![],
                max_results: Some(20),
                context: Some(1),
                ignore: vec![],
                max_depth: None,
                cancel: None,
                on_progress: None,
            },
        )
        .unwrap();

        assert_eq!(result.hits.len(), 1);
        assert_eq!(result.hits[0].path, "/ok.txt");
    }

    #[test]
    fn find_skips_symlinks() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("real.rs"), "fn r() {}").unwrap();
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(
                dir.path().join("real.rs"),
                dir.path().join("link.rs"),
            )
            .unwrap();
        }
        let roots = vec![root("ws", dir.path().to_path_buf())];
        let result = run_search(
            &roots,
            SearchParams {
                mode: SearchMode::Find,
                root: "ws".into(),
                path: "/".into(),
                query: "".into(),
                extensions: vec!["rs".into()],
                max_results: Some(50),
                context: None,
                ignore: vec![],
                max_depth: None,
                cancel: None,
                on_progress: None,
            },
        )
        .unwrap();
        let names: Vec<_> = result.hits.iter().map(|h| h.path.as_str()).collect();
        assert!(names.contains(&"/real.rs"));
        assert!(
            !names.iter().any(|p| p.ends_with("link.rs")),
            "symlinks must not appear as find hits"
        );
    }

    #[cfg(unix)]
    #[test]
    fn content_does_not_follow_symlink_escape() {
        let dir = tempdir().unwrap();
        let outside = tempdir().unwrap();
        fs::write(outside.path().join("secret.txt"), "LEAK_MARKER").unwrap();
        std::os::unix::fs::symlink(
            outside.path().join("secret.txt"),
            dir.path().join("trap.txt"),
        )
        .unwrap();
        fs::write(dir.path().join("safe.txt"), "safe").unwrap();

        let roots = vec![root("ws", dir.path().to_path_buf())];
        let result = run_search(
            &roots,
            SearchParams {
                mode: SearchMode::Content,
                root: "ws".into(),
                path: "/".into(),
                query: "LEAK_MARKER".into(),
                extensions: vec![],
                max_results: Some(20),
                context: Some(1),
                ignore: vec![],
                max_depth: None,
                cancel: None,
                on_progress: None,
            },
        )
        .unwrap();
        assert!(
            result.hits.is_empty(),
            "must not read symlink targets outside the root"
        );
    }

    #[test]
    fn max_results_sets_truncated() {
        let dir = tempdir().unwrap();
        for i in 0..10 {
            fs::write(dir.path().join(format!("f{i}.txt")), "needle").unwrap();
        }
        let roots = vec![root("ws", dir.path().to_path_buf())];
        let result = run_search(
            &roots,
            SearchParams {
                mode: SearchMode::Content,
                root: "ws".into(),
                path: "/".into(),
                query: "needle".into(),
                extensions: vec!["txt".into()],
                max_results: Some(3),
                context: Some(0),
                ignore: vec![],
                max_depth: None,
                cancel: None,
                on_progress: None,
            },
        )
        .unwrap();
        assert_eq!(result.hits.len(), 3);
        assert!(result.truncated);
    }

    #[test]
    fn content_is_scoped_to_folder_path() {
        let dir = tempdir().unwrap();
        fs::create_dir_all(dir.path().join("src")).unwrap();
        fs::create_dir_all(dir.path().join("docs")).unwrap();
        fs::write(dir.path().join("src/a.rs"), "MARKER_IN_SRC").unwrap();
        fs::write(dir.path().join("docs/a.md"), "MARKER_IN_DOCS").unwrap();

        let roots = vec![root("ws", dir.path().to_path_buf())];
        let result = run_search(
            &roots,
            SearchParams {
                mode: SearchMode::Content,
                root: "ws".into(),
                path: "/src".into(),
                query: "MARKER_IN".into(),
                extensions: vec![],
                max_results: Some(20),
                context: Some(0),
                ignore: vec![],
                max_depth: None,
                cancel: None,
                on_progress: None,
            },
        )
        .unwrap();
        assert_eq!(result.hits.len(), 1);
        assert_eq!(result.hits[0].path, "/src/a.rs");
    }

    #[test]
    fn extensions_are_case_insensitive() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("Main.RS"), "fn main() { TODO }").unwrap();
        fs::write(dir.path().join("notes.TXT"), "TODO here").unwrap();
        let roots = vec![root("ws", dir.path().to_path_buf())];
        let result = run_search(
            &roots,
            SearchParams {
                mode: SearchMode::Content,
                root: "ws".into(),
                path: "/".into(),
                query: "TODO".into(),
                extensions: vec!["Rs".into(), "tXt".into()],
                max_results: Some(20),
                context: Some(0),
                ignore: vec![],
                max_depth: None,
                cancel: None,
                on_progress: None,
            },
        )
        .unwrap();
        let paths: Vec<_> = result.hits.iter().map(|h| h.path.as_str()).collect();
        assert!(paths.iter().any(|p| p.eq_ignore_ascii_case("/Main.RS") || p.ends_with(".RS") || p.ends_with(".rs")));
        assert_eq!(result.hits.len(), 2, "both .RS and .TXT should match case-insensitively: {paths:?}");
    }

    #[test]
    fn cancel_flag_stops_search() {
        let dir = tempdir().unwrap();
        for i in 0..200 {
            fs::write(dir.path().join(format!("f{i}.txt")), "needle here").unwrap();
        }
        let roots = vec![root("ws", dir.path().to_path_buf())];
        let cancel = Arc::new(AtomicBool::new(true));
        let err = run_search(
            &roots,
            SearchParams {
                mode: SearchMode::Content,
                root: "ws".into(),
                path: "/".into(),
                query: "needle".into(),
                extensions: vec!["txt".into()],
                max_results: Some(50),
                context: Some(0),
                ignore: vec![],
                max_depth: None,
                cancel: Some(cancel),
                on_progress: None,
            },
        )
        .unwrap_err();
        assert_eq!(err, "cancelled");
    }

    #[test]
    fn scanned_counts_files_skipped_by_extension_filter() {
        let dir = tempdir().unwrap();
        for i in 0..20 {
            fs::write(dir.path().join(format!("n{i}.txt")), "needle").unwrap();
        }
        fs::write(dir.path().join("hit.rs"), "needle").unwrap();
        let roots = vec![root("ws", dir.path().to_path_buf())];
        let result = run_search(
            &roots,
            SearchParams {
                mode: SearchMode::Content,
                root: "ws".into(),
                path: "/".into(),
                query: "needle".into(),
                extensions: vec!["rs".into()],
                max_results: Some(20),
                context: Some(0),
                ignore: vec![],
                max_depth: None,
                cancel: None,
                on_progress: None,
            },
        )
        .unwrap();
        assert_eq!(result.hits.len(), 1);
        assert_eq!(result.hits[0].path, "/hit.rs");
        assert!(
            result.scanned >= 21,
            "extension skips must still count toward scanned (got {})",
            result.scanned
        );
    }

    #[test]
    fn ignore_names_prune_venv_and_renv_trees() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("app.R"), "MARK").unwrap();
        fs::create_dir_all(dir.path().join("renv/library")).unwrap();
        fs::write(dir.path().join("renv/library/pkg.R"), "MARK").unwrap();
        fs::create_dir_all(dir.path().join("venv/lib")).unwrap();
        fs::write(dir.path().join("venv/lib/site.py"), "MARK").unwrap();
        fs::create_dir_all(dir.path().join("src")).unwrap();
        fs::write(dir.path().join("src/ok.py"), "MARK").unwrap();

        let roots = vec![root("ws", dir.path().to_path_buf())];
        let result = run_search(
            &roots,
            SearchParams {
                mode: SearchMode::Content,
                root: "ws".into(),
                path: "/".into(),
                query: "MARK".into(),
                extensions: vec![],
                max_results: Some(20),
                context: Some(0),
                ignore: vec!["renv".into(), "venv".into()],
                max_depth: None,
                cancel: None,
                on_progress: None,
            },
        )
        .unwrap();

        let paths: Vec<_> = result.hits.iter().map(|h| h.path.as_str()).collect();
        assert!(paths.contains(&"/app.R"));
        assert!(paths.contains(&"/src/ok.py"));
        assert!(
            !paths.iter().any(|p| p.contains("renv") || p.contains("venv")),
            "dependency trees must be pruned: {paths:?}"
        );
        assert!(
            result.scanned <= 3,
            "expected only project files scanned, got {}",
            result.scanned
        );
    }

    #[test]
    fn max_depth_limits_directory_layers() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("root.txt"), "NEEDLE").unwrap();
        fs::create_dir_all(dir.path().join("a/b")).unwrap();
        fs::write(dir.path().join("a/mid.txt"), "NEEDLE").unwrap();
        fs::write(dir.path().join("a/b/deep.txt"), "NEEDLE").unwrap();

        let roots = vec![root("ws", dir.path().to_path_buf())];
        // depth 1 = start folder files only (immediate children of walk root).
        let shallow = run_search(
            &roots,
            SearchParams {
                mode: SearchMode::Content,
                root: "ws".into(),
                path: "/".into(),
                query: "NEEDLE".into(),
                extensions: vec![],
                max_results: Some(20),
                context: Some(0),
                ignore: vec![],
                max_depth: Some(1),
                cancel: None,
                on_progress: None,
            },
        )
        .unwrap();
        let shallow_paths: Vec<_> = shallow.hits.iter().map(|h| h.path.as_str()).collect();
        assert_eq!(shallow_paths, vec!["/root.txt"]);

        let deeper = run_search(
            &roots,
            SearchParams {
                mode: SearchMode::Content,
                root: "ws".into(),
                path: "/".into(),
                query: "NEEDLE".into(),
                extensions: vec![],
                max_results: Some(20),
                context: Some(0),
                ignore: vec![],
                max_depth: Some(2),
                cancel: None,
                on_progress: None,
            },
        )
        .unwrap();
        let deeper_paths: Vec<_> = deeper.hits.iter().map(|h| h.path.as_str()).collect();
        assert!(deeper_paths.contains(&"/root.txt"));
        assert!(deeper_paths.contains(&"/a/mid.txt"));
        assert!(!deeper_paths.iter().any(|p| p.ends_with("deep.txt")));
    }


    #[test]
    fn ignore_still_applies_when_folder_is_ignored_name() {
        let dir = tempdir().unwrap();
        fs::create_dir_all(dir.path().join("node_modules/pkg")).unwrap();
        fs::write(dir.path().join("node_modules/pkg/lib.js"), "NEEDLE").unwrap();
        fs::write(dir.path().join("app.js"), "NEEDLE").unwrap();

        let roots = vec![root("ws", dir.path().to_path_buf())];
        let result = run_search(
            &roots,
            SearchParams {
                mode: SearchMode::Content,
                root: "ws".into(),
                path: "/node_modules".into(),
                query: "NEEDLE".into(),
                extensions: vec![],
                max_results: Some(20),
                context: Some(0),
                ignore: vec!["node_modules".into()],
                max_depth: None,
                cancel: None,
                on_progress: None,
            },
        )
        .unwrap();
        assert!(
            result.hits.is_empty(),
            "explicit folder under an ignored name must still be pruned, got {:?}",
            result.hits.iter().map(|h| h.path.as_str()).collect::<Vec<_>>()
        );
    }

    #[test]
    fn cancel_flag_stops_inside_large_file() {
        let dir = tempdir().unwrap();
        let mut body = String::new();
        for i in 0..800 {
            // No matches until late — cancel must fire mid-read, not via max_results.
            body.push_str(&format!("line {i}\n"));
        }
        body.push_str("needle at end\n");
        fs::write(dir.path().join("big.txt"), body).unwrap();
        let cancel = Arc::new(AtomicBool::new(true));
        let abs = dir.path().join("big.txt");
        let re = regex::RegexBuilder::new("needle")
            .case_insensitive(true)
            .build()
            .unwrap();
        let mut hits = Vec::new();
        let root_canonical = dir.path();
        let rel = Path::new("big.txt");
        let err = match_file_content(
            root_canonical,
            &abs,
            rel,
            "ws",
            "/big.txt",
            &re,
            0,
            50,
            &mut hits,
            Some(cancel.as_ref()),
        )
        .unwrap_err();
        assert!(matches!(err, MatchFileError::Cancelled));
        assert!(hits.is_empty());
    }
}
