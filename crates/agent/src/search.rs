//! Workspace find/content search (fd/rg-like) without shelling out.
//!
//! Uses the same crates ripgrep/fd are built on (`ignore` for walking,
//! `regex` for matching). Path safety matches `fs.rs`: enabled root,
//! canonicalize + starts_with, denylist, no symlink follow.

use std::collections::VecDeque;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::Path;

use filebox_protocol::denylist;
use filebox_protocol::resources::RootConfig;
use filebox_protocol::search::{
    SearchContextLine, SearchHit, SearchMode, SearchResult,
};
use ignore::WalkBuilder;
use regex::RegexBuilder;

const DEFAULT_MAX_RESULTS: usize = 100;
const HARD_MAX_RESULTS: usize = 500;
const DEFAULT_CONTEXT: usize = 10;
const HARD_MAX_CONTEXT: usize = 20;
const MAX_CONTENT_FILE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_LINE_CHARS: usize = 400;

pub struct SearchParams {
    pub mode: SearchMode,
    pub root: String,
    pub path: String,
    pub query: String,
    pub extensions: Vec<String>,
    pub max_results: Option<u32>,
    pub context: Option<u32>,
}

pub fn run_search(roots: &[RootConfig], params: SearchParams) -> Result<SearchResult, String> {
    let max_results = params
        .max_results
        .map(|n| n as usize)
        .unwrap_or(DEFAULT_MAX_RESULTS)
        .clamp(1, HARD_MAX_RESULTS);
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
    let (start, root_canonical) = crate::fs::resolve_path(roots, &params.root, start_rel)?;

    if !start.is_dir() {
        return Err(format!("Search path is not a directory: {}{}", params.root, start_rel));
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
                .build()
                .map_err(|e| format!("Invalid regex: {}", e))?,
        )
    } else {
        None
    };

    let mut hits = Vec::new();
    let mut scanned: u64 = 0;
    let mut truncated = false;

    let walker = WalkBuilder::new(&start)
        .hidden(false)
        .git_ignore(false)
        .git_global(false)
        .git_exclude(false)
        .follow_links(false)
        .standard_filters(false)
        .build();

    for entry in walker {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let abs = entry.path();
        if !abs.starts_with(&root_canonical) {
            continue;
        }
        if is_sensitive_virtual_path(abs) {
            continue;
        }

        let rel = match abs.strip_prefix(&root_canonical) {
            Ok(p) => p,
            Err(_) => continue,
        };
        let rel_str = format!("/{}", rel.to_string_lossy().replace('\\', "/"));
        if denylist::is_denied(&rel_str) {
            continue;
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
                scanned += 1;
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
                hits.push(SearchHit {
                    root: params.root.clone(),
                    path: rel_str,
                    line: None,
                    context: vec![],
                });
                if hits.len() >= max_results {
                    truncated = true;
                    break;
                }
            }
            SearchMode::Content => {
                let re = content_re.as_ref().unwrap();
                scanned += 1;
                let before = hits.len();
                match_file_content(abs, &params.root, &rel_str, re, context, max_results, &mut hits);
                if hits.len() >= max_results {
                    truncated = hits.len() > before || hits.len() >= max_results;
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

fn match_file_content(
    abs: &Path,
    root: &str,
    rel_str: &str,
    re: &regex::Regex,
    context: usize,
    max_results: usize,
    hits: &mut Vec<SearchHit>,
) {
    let meta = match abs.metadata() {
        Ok(m) => m,
        Err(_) => return,
    };
    if !meta.is_file() || meta.len() > MAX_CONTENT_FILE_BYTES {
        return;
    }

    let file = match File::open(abs) {
        Ok(f) => f,
        Err(_) => return,
    };
    let mut reader = BufReader::new(file);

    // Reject obvious binary: null in the first 8KiB.
    let mut probe = [0u8; 8192];
    let n = match std::io::Read::read(&mut reader, &mut probe) {
        Ok(n) => n,
        Err(_) => return,
    };
    if probe[..n].contains(&0) {
        return;
    }
    // Rewind and scan line-by-line.
    if std::io::Seek::seek(&mut reader, std::io::SeekFrom::Start(0)).is_err() {
        return;
    }

    let mut before: VecDeque<(u64, String)> = VecDeque::with_capacity(context + 1);
    let mut pending_after: usize = 0;
    let mut current: Option<SearchHit> = None;
    let mut line_no: u64 = 0;

    for line_res in reader.lines() {
        let raw = match line_res {
            Ok(l) => l,
            Err(_) => break,
        };
        line_no += 1;
        let text = truncate_line(&raw);
        let is_match = re.is_match(&raw);

        if let Some(hit) = current.as_mut() {
            if pending_after > 0 {
                hit.context.push(SearchContextLine {
                    line: line_no,
                    text: text.clone(),
                    is_match,
                });
                pending_after -= 1;
                if pending_after == 0 {
                    hits.push(current.take().unwrap());
                    if hits.len() >= max_results {
                        return;
                    }
                }
            }
        }

        if is_match {
            // Flush any open hit that still wanted more after-context.
            if let Some(hit) = current.take() {
                hits.push(hit);
                if hits.len() >= max_results {
                    return;
                }
            }
            let mut ctx = Vec::with_capacity(context * 2 + 1);
            for (ln, t) in before.iter() {
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
                    return;
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
    use std::fs;
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
            },
        )
        .unwrap();

        assert_eq!(result.hits.len(), 1);
        let hit = &result.hits[0];
        assert_eq!(hit.line, Some(15));
        assert_eq!(hit.context.len(), 5); // 2 before + match + 2 after
        assert!(hit.context.iter().any(|c| c.is_match && c.text.contains("line 15")));
        assert_eq!(hit.context.first().unwrap().line, 13);
        assert_eq!(hit.context.last().unwrap().line, 17);
    }

    #[test]
    fn denylist_skips_env_files() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join(".env"), "SECRET=1").unwrap();
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
            },
        )
        .unwrap();

        assert_eq!(result.hits.len(), 1);
        assert_eq!(result.hits[0].path, "/ok.txt");
    }
}
