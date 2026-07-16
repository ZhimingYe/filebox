use serde::{Deserialize, Serialize};

/// Workspace search mode — find ≈ fd (path/name), content ≈ rg (line matches).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SearchMode {
    Find,
    Content,
}

/// One line of ±context around a content match (or the match itself).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SearchContextLine {
    pub line: u64,
    pub text: String,
    pub is_match: bool,
}

/// A single hit. Find mode fills `root`/`path` only; content mode adds line + context.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SearchHit {
    pub root: String,
    /// Root-relative path with a leading `/`.
    pub path: String,
    /// 1-based match line for content search; omitted for find.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line: Option<u64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub context: Vec<SearchContextLine>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SearchResult {
    pub hits: Vec<SearchHit>,
    /// True when the agent stopped early because `max_results` was hit.
    pub truncated: bool,
    /// Files walked (find) or opened for content (content). Best-effort.
    #[serde(default)]
    pub scanned: u64,
}
