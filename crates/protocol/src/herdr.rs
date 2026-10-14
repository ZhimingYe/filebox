//! Herdr CLI automation relayed through a Filebox agent.
//!
//! The agent probes a local `herdr` binary at register time and, when
//! present, answers a small whitelist of commands (`status`/`list`, `read`,
//! `prompt`, `send_keys`). The hub and browser never talk to Herdr directly.

use serde::{Deserialize, Serialize};

/// Whitelisted Herdr operations the Filebox agent will run.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum HerdrOp {
    /// Probe the CLI + running server and list live coding agents.
    Status,
    /// Latest terminal snapshot for one live agent (name or pane id).
    Read,
    /// Submit a prompt (text + Enter) to a live agent.
    Prompt,
    /// Send logical keys (`esc`, `enter`, `ctrl+c`, …) to a live agent.
    SendKeys,
}

/// Lifecycle state as reported by Herdr.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum HerdrAgentStatus {
    Idle,
    Working,
    Blocked,
    Done,
    Unknown,
}

impl HerdrAgentStatus {
    pub fn parse_label(raw: &str) -> Self {
        match raw.trim().to_ascii_lowercase().as_str() {
            "idle" => Self::Idle,
            "working" => Self::Working,
            "blocked" => Self::Blocked,
            "done" => Self::Done,
            _ => Self::Unknown,
        }
    }
}

impl Default for HerdrAgentStatus {
    fn default() -> Self {
        Self::Unknown
    }
}

/// One live coding agent inside Herdr, flattened for the Filebox UI.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct HerdrAgent {
    /// Address used for later `read` / `prompt` / `send_keys` (name, else pane id).
    pub target: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// Detected kind (`claude`, `codex`, `opencode`, …) when Herdr knows it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    pub status: HerdrAgentStatus,
    pub pane_id: String,
    #[serde(default)]
    pub workspace_id: String,
    #[serde(default)]
    pub tab_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default)]
    pub focused: bool,
}

/// Whether the Filebox agent can reach a running Herdr server.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct HerdrServerStatus {
    pub installed: bool,
    pub reachable: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

pub const HERDR_TARGET_MAX_LEN: usize = 64;
pub const HERDR_PROMPT_MAX_BYTES: usize = 32 * 1024;
pub const HERDR_KEYS_MAX: usize = 8;
pub const HERDR_LINES_DEFAULT: u32 = 80;
pub const HERDR_LINES_MAX: u32 = 200;
pub const HERDR_WAIT_TIMEOUT_MAX_MS: u64 = 120_000;
pub const HERDR_WAIT_TIMEOUT_MIN_MS: u64 = 3_001;
pub const HERDR_OUTPUT_MAX_BYTES: usize = 256 * 1024;

const ALLOWED_KEYS: &[&str] = &[
    "enter", "esc", "escape", "tab", "space", "backspace", "delete",
    "up", "down", "left", "right",
    "y", "n",
    "ctrl+c", "ctrl+d", "ctrl+z", "ctrl+l",
    "shift+tab",
];

/// Pane ids (`w1:p2`) or live agent names (`reviewer`).
pub fn validate_target(target: &str) -> Result<(), &'static str> {
    let t = target.trim();
    if t.is_empty() {
        return Err("target is required");
    }
    if t.len() > HERDR_TARGET_MAX_LEN {
        return Err("target is too long");
    }
    if t.contains('\0') {
        return Err("target must not contain NUL");
    }
    let mut chars = t.chars();
    let Some(first) = chars.next() else {
        return Err("target is required");
    };
    if !first.is_ascii_alphanumeric() {
        return Err("target must start with a letter or digit");
    }
    if !t
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-' | ':' | '.'))
    {
        return Err("target contains invalid characters");
    }
    Ok(())
}

pub fn validate_prompt_text(text: &str) -> Result<(), &'static str> {
    if text.is_empty() {
        return Err("prompt text is required");
    }
    if text.len() > HERDR_PROMPT_MAX_BYTES {
        return Err("prompt text is too long");
    }
    if text.contains('\0') {
        return Err("prompt text must not contain NUL");
    }
    Ok(())
}

pub fn normalize_key(raw: &str) -> Result<String, &'static str> {
    let key = raw.trim().to_ascii_lowercase().replace('_', "+");
    if key.is_empty() {
        return Err("empty key");
    }
    if ALLOWED_KEYS.contains(&key.as_str()) {
        // Canonical spelling Herdr documents: `esc` (escape is an alias).
        if key == "escape" {
            return Ok("esc".to_string());
        }
        return Ok(key);
    }
    Err("unsupported key")
}

pub fn validate_keys(keys: &[String]) -> Result<Vec<String>, &'static str> {
    if keys.is_empty() {
        return Err("at least one key is required");
    }
    if keys.len() > HERDR_KEYS_MAX {
        return Err("too many keys");
    }
    let mut out = Vec::with_capacity(keys.len());
    for k in keys {
        out.push(normalize_key(k)?);
    }
    Ok(out)
}

pub fn clamp_lines(lines: Option<u32>) -> u32 {
    lines
        .unwrap_or(HERDR_LINES_DEFAULT)
        .clamp(1, HERDR_LINES_MAX)
}

pub fn clamp_wait_timeout_ms(timeout_ms: Option<u64>) -> u64 {
    timeout_ms
        .unwrap_or(30_000)
        .clamp(HERDR_WAIT_TIMEOUT_MIN_MS, HERDR_WAIT_TIMEOUT_MAX_MS)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn target_accepts_pane_ids_and_names() {
        assert!(validate_target("w1:p2").is_ok());
        assert!(validate_target("reviewer").is_ok());
        assert!(validate_target("bot_01").is_ok());
        assert!(validate_target("").is_err());
        assert!(validate_target("../etc").is_err());
        assert!(validate_target("a b").is_err());
        assert!(validate_target("a;rm").is_err());
    }

    #[test]
    fn keys_are_allowlisted() {
        assert_eq!(validate_keys(&["Esc".into(), "ENTER".into()]).unwrap(), ["esc", "enter"]);
        assert!(validate_keys(&["ctrl+c".into()]).is_ok());
        assert!(validate_keys(&["rm -rf".into()]).is_err());
        assert!(validate_keys(&[]).is_err());
    }

    #[test]
    fn prompt_rejects_empty_and_nul() {
        assert!(validate_prompt_text("review this").is_ok());
        assert!(validate_prompt_text("").is_err());
        assert!(validate_prompt_text("a\0b").is_err());
    }

    #[test]
    fn status_parse_is_case_insensitive() {
        assert_eq!(HerdrAgentStatus::parse_label("Working"), HerdrAgentStatus::Working);
        assert_eq!(HerdrAgentStatus::parse_label("DONE"), HerdrAgentStatus::Done);
        assert_eq!(HerdrAgentStatus::parse_label("???"), HerdrAgentStatus::Unknown);
    }
}
