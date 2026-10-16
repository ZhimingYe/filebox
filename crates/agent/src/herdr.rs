//! Local Herdr CLI probe and a whitelist of automation commands.
//!
//! The Filebox agent never speaks Herdr's socket itself. It looks up a
//! `herdr` binary (env override or PATH), confirms `--version`, and then
//! runs only `agent list` / `agent read` / `agent prompt` / `agent send-keys`.
//! User strings are argv, never a shell.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use filebox_protocol::herdr::{
    clamp_lines, clamp_wait_timeout_ms, validate_keys, validate_prompt_text, validate_target,
    HerdrAgent, HerdrAgentStatus, HerdrOp, HerdrReadSource, HerdrServerStatus, HERDR_OUTPUT_MAX_BYTES,
};
use filebox_protocol::message::AgentMessage;
use serde_json::Value;
use tokio::process::Command;

const STATUS_TIMEOUT: Duration = Duration::from_secs(8);
const READ_TIMEOUT: Duration = Duration::from_secs(20);
const PROMPT_TIMEOUT: Duration = Duration::from_secs(15);
const KEYS_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone)]
pub struct HerdrClient {
    pub bin: PathBuf,
    pub version: String,
}

impl HerdrClient {
    pub async fn probe() -> Option<Self> {
        // Operator-owned hard switch. Check before path discovery or --version;
        // a disabled integration never creates a client or advertises capability.
        match herdr_enabled(std::env::var_os("FILEBOX_AGENT_HERDR_ENABLED").as_deref()) {
            Ok(true) => {}
            Ok(false) => {
                tracing::info!("Herdr integration disabled by FILEBOX_AGENT_HERDR_ENABLED");
                return None;
            }
            Err(()) => {
                tracing::warn!("Invalid FILEBOX_AGENT_HERDR_ENABLED; Herdr integration disabled (use 0 or 1)");
                return None;
            }
        }
        let bin = resolve_herdr_path()?;
        match probe_version(&bin).await {
            Ok(version) => {
                tracing::info!(
                    "herdr enabled (bin={}, version={})",
                    bin.display(),
                    version
                );
                Some(Self { bin, version })
            }
            Err(error) => {
                tracing::warn!(
                    "herdr found at {} but --version failed: {} — herdr disabled",
                    bin.display(),
                    error
                );
                None
            }
        }
    }

    pub async fn handle(
        &self,
        req_id: String,
        op: HerdrOp,
        target: Option<String>,
        text: Option<String>,
        keys: Vec<String>,
        lines: Option<u32>,
        read_source: Option<HerdrReadSource>,
        wait: bool,
        timeout_ms: Option<u64>,
        cancel: Arc<AtomicBool>,
    ) -> AgentMessage {
        match self
            .run_op(op, target, text, keys, lines, read_source, wait, timeout_ms, &cancel)
            .await
        {
            Ok(msg) => AgentMessage::HerdrResponse {
                req_id,
                error: msg.error,
                status: msg.status,
                agents: msg.agents,
                agent: msg.agent,
                output: msg.output,
            },
            Err(error) => AgentMessage::HerdrResponse {
                req_id,
                error: Some(error),
                status: Some(HerdrServerStatus {
                    installed: true,
                    reachable: false,
                    version: Some(self.version.clone()),
                    message: None,
                }),
                agents: Vec::new(),
                agent: None,
                output: None,
            },
        }
    }

    async fn run_op(
        &self,
        op: HerdrOp,
        target: Option<String>,
        text: Option<String>,
        keys: Vec<String>,
        lines: Option<u32>,
        read_source: Option<HerdrReadSource>,
        wait: bool,
        timeout_ms: Option<u64>,
        cancel: &AtomicBool,
    ) -> Result<OpResult, String> {
        match op {
            HerdrOp::Status => self.status(cancel).await,
            HerdrOp::Read => {
                let target = required_target(target)?;
                let n = clamp_lines(lines);
                // Full-screen agents refuse scrolled history (`agent_not_idle`)
                // while working, blocked, or unknown. Fall back to the visible
                // screen so "latest output" still works during a turn.
                let history = if let Some(source) = read_source {
                    let source = match source { HerdrReadSource::Visible => "visible", HerdrReadSource::Detection => "detection" };
                    vec!["agent".into(), "read".into(), target.clone(), "--source".into(), source.into(), "--lines".into(), n.to_string()]
                } else { vec![
                    "agent".into(),
                    "read".into(),
                    target.clone(),
                    "--source".into(),
                    "recent-unwrapped".into(),
                    "--lines".into(),
                    n.to_string(),
                ] };
                let started = tokio::time::Instant::now();
                let first = run_cli(&self.bin, &history, READ_TIMEOUT, cancel).await?;
                let out = if read_source.is_none() && !first.ok && is_not_idle(&first) {
                    let visible = vec![
                        "agent".into(),
                        "read".into(),
                        target,
                        "--source".into(),
                        "visible".into(),
                    ];
                    let remaining = READ_TIMEOUT.saturating_sub(started.elapsed());
                    run_cli(&self.bin, &visible, remaining, cancel).await?
                } else {
                    first
                };
                if !out.ok {
                    return Err(map_cli_error(&out));
                }
                Ok(OpResult {
                    error: None,
                    status: None,
                    agents: Vec::new(),
                    agent: None,
                    output: Some(read_output_text(&out)),
                })
            }
            HerdrOp::Prompt => {
                let target = required_target(target)?;
                let text = text.unwrap_or_default();
                validate_prompt_text(&text).map_err(|e| e.to_string())?;
                // Herdr 0.9.5 consumes target and text positionally before
                // parsing flags. It does not accept a `--` separator here.
                let mut args = vec!["agent".into(), "prompt".into(), target, text];
                let timeout = if wait {
                    let ms = clamp_wait_timeout_ms(timeout_ms);
                    args.push("--wait".into());
                    args.push("--timeout".into());
                    args.push(ms.to_string());
                    Duration::from_millis(ms + 5_000)
                } else {
                    PROMPT_TIMEOUT
                };
                let out = run_cli(&self.bin, &args, timeout, cancel).await?;
                if !out.ok {
                    return Err(map_cli_error(&out));
                }
                let parsed = parse_json_blob(&out.stdout).or_else(|| parse_json_blob(&out.stderr));
                Ok(OpResult {
                    error: None,
                    status: None,
                    agents: Vec::new(),
                    agent: parsed.as_ref().and_then(extract_agent),
                    output: None,
                })
            }
            HerdrOp::SendKeys => {
                let target = required_target(target)?;
                let keys = validate_keys(&keys).map_err(|e| e.to_string())?;
                let mut args = vec!["agent".into(), "send-keys".into(), target];
                args.extend(keys);
                let out = run_cli(&self.bin, &args, KEYS_TIMEOUT, cancel).await?;
                if !out.ok {
                    return Err(map_cli_error(&out));
                }
                let parsed = parse_json_blob(&out.stdout).or_else(|| parse_json_blob(&out.stderr));
                Ok(OpResult {
                    error: None,
                    status: None,
                    agents: Vec::new(),
                    agent: parsed.as_ref().and_then(extract_agent),
                    output: None,
                })
            }
        }
    }

    async fn status(&self, cancel: &AtomicBool) -> Result<OpResult, String> {
        let args = vec!["agent".into(), "list".into()];
        match run_cli(&self.bin, &args, STATUS_TIMEOUT, cancel).await {
            Ok(out) if out.ok => {
                let parsed = parse_json_blob(&out.stdout)
                    .or_else(|| parse_json_blob(&out.stderr))
                    .ok_or_else(|| "herdr_incompatible".to_string())?;
                if !result_object(&parsed).get("agents").is_some_and(Value::is_array) {
                    return Err("herdr_incompatible".to_string());
                }
                Ok(OpResult {
                    error: None,
                    status: Some(HerdrServerStatus {
                        installed: true,
                        reachable: true,
                        version: Some(self.version.clone()),
                        message: None,
                    }),
                    agents: extract_agents(&parsed),
                    agent: None,
                    output: None,
                })
            }
            Ok(out) => Ok(OpResult {
                error: Some(map_cli_error(&out)),
                status: Some(HerdrServerStatus {
                    installed: true,
                    reachable: false,
                    version: Some(self.version.clone()),
                    message: Some(trim_error_text(&out.combined())),
                }),
                agents: Vec::new(),
                agent: None,
                output: None,
            }),
            Err(error) => Ok(OpResult {
                error: Some(error.clone()),
                status: Some(HerdrServerStatus {
                    installed: true,
                    reachable: false,
                    version: Some(self.version.clone()),
                    message: Some(error),
                }),
                agents: Vec::new(),
                agent: None,
                output: None,
            }),
        }
    }
}

struct OpResult {
    error: Option<String>,
    status: Option<HerdrServerStatus>,
    agents: Vec<HerdrAgent>,
    agent: Option<HerdrAgent>,
    output: Option<String>,
}

#[derive(Debug)]
struct CliOutput {
    ok: bool,
    stdout: String,
    stderr: String,
}

impl CliOutput {
    fn combined(&self) -> String {
        if !self.stderr.trim().is_empty() {
            self.stderr.clone()
        } else {
            self.stdout.clone()
        }
    }
}

fn required_target(target: Option<String>) -> Result<String, String> {
    let Some(raw) = target else {
        return Err("invalid_request".to_string());
    };
    let trimmed = raw.trim().to_string();
    validate_target(&trimmed).map_err(|e| e.to_string())?;
    Ok(trimmed)
}

fn herdr_enabled(value: Option<&std::ffi::OsStr>) -> Result<bool, ()> {
    let Some(value) = value else { return Ok(true); };
    match value.to_str().ok_or(())?.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "on" | "yes" => Ok(true),
        "0" | "false" | "off" | "no" => Ok(false),
        _ => Err(()),
    }
}

fn resolve_herdr_path() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("FILEBOX_AGENT_HERDR") {
        let path = PathBuf::from(p.trim());
        if path.is_file() {
            return Some(path);
        }
        tracing::warn!(
            "FILEBOX_AGENT_HERDR is set but not a file: {}",
            path.display()
        );
        return None;
    }
    find_in_path("herdr")
}

fn find_in_path(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
        #[cfg(windows)]
        {
            let exe = dir.join(format!("{name}.exe"));
            if exe.is_file() {
                return Some(exe);
            }
        }
    }
    None
}

const VERSION_PROBE_TIMEOUT: Duration = Duration::from_secs(3);

async fn probe_version(bin: &Path) -> Result<String, String> {
    probe_version_timeout(bin, VERSION_PROBE_TIMEOUT).await
}

/// Bounded so a hung `herdr --version` cannot block agent registration.
async fn probe_version_timeout(bin: &Path, timeout: Duration) -> Result<String, String> {
    // Drain both pipes with bounded buffers under the same deadline as the
    // child. A wrapper may exit while a helper still holds either pipe open.
    let out = run_cli(bin, &["--version".into()], timeout, &AtomicBool::new(false))
        .await
        .map_err(|error| if error == "herdr_timeout" {
            "herdr --version timed out".to_string()
        } else {
            error
        })?;
    let version = sanitize_version(&out.stdout);
    if !out.ok && version == "unknown" {
        return Err("herdr --version failed".to_string());
    }
    Ok(version)
}

fn sanitize_version(raw: &str) -> String {
    let line = raw.lines().next().unwrap_or("").trim();
    let line = line.trim_start_matches("herdr").trim();
    let mut out = String::new();
    for ch in line.chars() {
        if out.len() >= 64 {
            break;
        }
        if ch.is_ascii_graphic() || ch == ' ' {
            out.push(ch);
        }
    }
    let out = out.trim().to_string();
    if out.is_empty() {
        "unknown".to_string()
    } else {
        out
    }
}

async fn run_cli(
    bin: &Path,
    args: &[String],
    timeout: Duration,
    cancel: &AtomicBool,
) -> Result<CliOutput, String> {
    if cancel.load(Ordering::Relaxed) {
        return Err("cancelled".to_string());
    }
    let mut cmd = Command::new(bin);
    cmd.args(args)
        .kill_on_drop(true)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null());
    #[cfg(unix)]
    {
        // New group so timeout/cancel can reap helpers herdr spawned.
        cmd.process_group(0);
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("herdr_unavailable: failed to spawn herdr: {e}"))?;
    let pid = child.id().unwrap_or(0);
    // Connection teardown aborts the entire future, bypassing the select arms.
    // kill_on_drop only kills the direct child; also reap its helper group.
    let mut group_guard = HerdrProcessGroup(pid);
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    // One overflow byte distinguishes truncated output from an exact fit.
    let out_fut = drain_capped(stdout, HERDR_OUTPUT_MAX_BYTES + 1);
    let err_fut = drain_capped(stderr, 16 * 1024);
    tokio::pin!(out_fut);
    tokio::pin!(err_fut);
    let mut stdout_buf: Option<Vec<u8>> = None;
    let mut stderr_buf: Option<Vec<u8>> = None;
    let mut status = None;
    let deadline = tokio::time::sleep(timeout);
    tokio::pin!(deadline);

    loop {
        tokio::select! {
            biased;
            res = child.wait(), if status.is_none() => {
                status = Some(res.map_err(|e| format!("herdr_unavailable: wait failed: {e}"))?);
            }
            buf = &mut out_fut, if stdout_buf.is_none() => {
                stdout_buf = Some(buf);
            }
            buf = &mut err_fut, if stderr_buf.is_none() => {
                stderr_buf = Some(buf);
            }
            _ = &mut deadline, if status.is_none() || stdout_buf.is_none() || stderr_buf.is_none() => {
                return Err("herdr_timeout".to_string());
            }
            _ = wait_until_cancel(cancel) => {
                return Err("cancelled".to_string());
            }
        }
        if status.is_some() && stdout_buf.is_some() && stderr_buf.is_some() {
            break;
        }
    }
    group_guard.0 = 0;
    let code = status.unwrap();
    Ok(CliOutput {
        ok: code.success(),
        stdout: String::from_utf8_lossy(&stdout_buf.unwrap_or_default()).into_owned(),
        stderr: String::from_utf8_lossy(&stderr_buf.unwrap_or_default()).into_owned(),
    })
}

async fn drain_capped(pipe: Option<impl tokio::io::AsyncRead + Unpin>, cap: usize) -> Vec<u8> {
    let Some(mut reader) = pipe else {
        return Vec::new();
    };
    let mut kept = Vec::new();
    let mut tmp = [0u8; 8192];
    loop {
        match tokio::io::AsyncReadExt::read(&mut reader, &mut tmp).await {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                if kept.len() < cap {
                    let room = cap - kept.len();
                    kept.extend_from_slice(&tmp[..n.min(room)]);
                }
            }
        }
    }
    kept
}

struct HerdrProcessGroup(u32);

impl Drop for HerdrProcessGroup {
    fn drop(&mut self) {
        kill_herdr_group(self.0);
    }
}

fn kill_herdr_group(pid: u32) {
    if pid == 0 {
        return;
    }
    #[cfg(unix)]
    unsafe {
        let _ = libc::kill(-(pid as i32), libc::SIGKILL);
    }
}

async fn wait_until_cancel(cancel: &AtomicBool) {
    let mut interval = tokio::time::interval(Duration::from_millis(50));
    loop {
        interval.tick().await;
        if cancel.load(Ordering::Relaxed) {
            return;
        }
    }
}

fn read_output_text(out: &CliOutput) -> String {
    // `agent read` prints terminal text, not the socket API JSON envelope.
    // JSON in this text belongs to the coding agent and must stay intact.
    truncate_output(&out.stdout)
}

fn truncate_output(text: &str) -> String {
    if text.len() <= HERDR_OUTPUT_MAX_BYTES {
        return text.trim_end().to_string();
    }
    let mut end = HERDR_OUTPUT_MAX_BYTES;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    let mut s = text[..end].trim_end().to_string();
    s.push_str("\n… truncated");
    s
}

fn map_cli_error(out: &CliOutput) -> String {
    if let Some(json) = parse_json_blob(&out.stderr).or_else(|| parse_json_blob(&out.stdout)) {
        if let Some(code) = json.pointer("/error/code").and_then(|v| v.as_str()) {
            return normalize_herdr_code(code);
        }
        if let Some(code) = json.get("error").and_then(|v| v.as_str()) {
            return normalize_herdr_code(code);
        }
    }
    let blob = out.combined().to_ascii_lowercase();
    if blob.contains("connect")
        || blob.contains("not running")
        || blob.contains("unavailable")
        || blob.contains("socket")
    {
        return "herdr_unavailable".to_string();
    }
    if blob.contains("timeout") {
        return "herdr_timeout".to_string();
    }
    if blob.contains("blocked") {
        return "herdr_blocked".to_string();
    }
    if blob.contains("not_idle") || blob.contains("not idle") {
        return "herdr_not_idle".to_string();
    }
    if blob.contains("not found") {
        return "herdr_agent_missing".to_string();
    }
    "herdr_failed".to_string()
}

fn is_not_idle(out: &CliOutput) -> bool {
    map_cli_error(out) == "herdr_not_idle"
}

fn normalize_herdr_code(code: &str) -> String {
    match code {
        "server_not_running" => "herdr_unavailable".to_string(),
        "invalid_key" => "herdr_key_unsupported".to_string(),
        "protocol_mismatch" => "herdr_incompatible".to_string(),
        "agent_blocked" => "herdr_blocked".to_string(),
        "agent_not_found" | "agent_not_running" | "agent_name_not_found" | "pane_not_found" => "herdr_agent_missing".to_string(),
        "agent_not_ready" | "agent_prompt_stalled" => "herdr_not_ready".to_string(),
        "agent_not_idle" => "herdr_not_idle".to_string(),
        "timeout" => "herdr_timeout".to_string(),
        other => {
            if other.starts_with("herdr_") {
                other.to_string()
            } else {
                "herdr_failed".to_string()
            }
        }
    }
}

fn trim_error_text(raw: &str) -> String {
    let t = raw.trim();
    if t.len() <= 400 {
        return t.to_string();
    }
    let mut end = 400;
    while end > 0 && !t.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &t[..end])
}

fn parse_json_blob(raw: &str) -> Option<Value> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Ok(v) = serde_json::from_str::<Value>(trimmed) {
        return Some(v);
    }
    // CLI may print a banner then JSON.
    let start = trimmed.find('{')?;
    serde_json::from_str::<Value>(&trimmed[start..]).ok()
}

fn result_object(v: &Value) -> &Value {
    v.get("result").unwrap_or(v)
}

fn extract_agents(v: &Value) -> Vec<HerdrAgent> {
    let root = result_object(v);
    let list = root
        .get("agents")
        .and_then(|a| a.as_array())
        .cloned()
        .unwrap_or_default();
    let mut agents: Vec<HerdrAgent> = list.iter().filter_map(parse_agent).collect();
    let mut seen = std::collections::HashSet::new();
    agents.retain(|agent| seen.insert(agent.target.clone()));
    agents
}

/// Prefer a validated live name (it follows the agent across pane moves).
/// Fall back to the pane id when the name is missing or not a safe argv target.
fn address_target(name: Option<&str>, pane_id: &str) -> Option<String> {
    if let Some(name) = name.map(str::trim).filter(|s| !s.is_empty()) {
        if validate_target(name).is_ok() {
            return Some(name.to_string());
        }
    }
    let pane_id = pane_id.trim();
    if validate_target(pane_id).is_ok() {
        Some(pane_id.to_string())
    } else {
        None
    }
}

fn extract_agent(v: &Value) -> Option<HerdrAgent> {
    let root = result_object(v);
    root.get("agent").and_then(parse_agent).or_else(|| parse_agent(root))
}

fn parse_agent(v: &Value) -> Option<HerdrAgent> {
    let pane_id = v.get("pane_id")?.as_str()?.to_string();
    let name = v
        .get("name")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty());
    let kind = v
        .get("agent")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| {
            v.get("kind")
                .and_then(|x| x.as_str())
                .map(|s| s.to_string())
                .filter(|s| !s.is_empty())
        });
    let status = v
        .get("agent_status")
        .or_else(|| v.get("status"))
        .and_then(|x| x.as_str())
        .map(HerdrAgentStatus::parse_label)
        .unwrap_or_default();
    let target = address_target(name.as_deref(), &pane_id)?;
    Some(HerdrAgent {
        target,
        name,
        kind,
        status,
        completion_seq: v.get("completion_seq").and_then(Value::as_u64),
        pane_id,
        workspace_id: v
            .get("workspace_id")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
        tab_id: v
            .get("tab_id")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
        cwd: v
            .get("foreground_cwd")
            .and_then(|x| x.as_str())
            .filter(|s| !s.is_empty())
            .or_else(|| v.get("cwd").and_then(Value::as_str))
            .map(|s| s.to_string())
            .filter(|s| !s.is_empty()),
        title: v
            .get("title")
            .and_then(|x| x.as_str())
            .filter(|s| !s.is_empty())
            .or_else(|| v.get("display_agent").and_then(Value::as_str))
            .map(|s| s.to_string())
            .filter(|s| !s.is_empty()),
        focused: v.get("focused").and_then(|x| x.as_bool()).unwrap_or(false),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_herdr_switch_accepts_boolean_values_and_rejects_typos() {
        use std::ffi::OsStr;
        assert_eq!(herdr_enabled(None), Ok(true));
        for value in ["0", "false", "OFF", " no "] {
            assert_eq!(herdr_enabled(Some(OsStr::new(value))), Ok(false));
        }
        for value in ["1", "true", "ON", " yes "] {
            assert_eq!(herdr_enabled(Some(OsStr::new(value))), Ok(true));
        }
        for value in ["", "flase", "2"] {
            assert_eq!(herdr_enabled(Some(OsStr::new(value))), Err(()));
        }
    }

    // Run probe in a separate test process so environment overrides cannot race
    // with other tests. Both explicit binary and PATH discovery are covered.
    #[cfg(unix)]
    #[test]
    fn disabled_probe_never_executes_an_installed_binary() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("herdr");
        let marker = dir.path().join("invoked");
        std::fs::write(&bin, r#"#!/bin/sh
printf x >> "$FILEBOX_TEST_HERDR_MARKER"
echo 'herdr 9.9.9'
"#).unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        for explicit in [false, true] {
            for (value, expect_client) in [("0", false), ("false", false), ("flase", false), ("1", true)] {
                let _ = std::fs::remove_file(&marker);
                let mut child = std::process::Command::new(std::env::current_exe().unwrap());
                child.args(["--exact", "herdr::tests::probe_environment_child"])
                    .env("FILEBOX_TEST_HERDR_CHILD", if expect_client { "enabled" } else { "disabled" })
                    .env("FILEBOX_AGENT_HERDR_ENABLED", value)
                    .env("FILEBOX_TEST_HERDR_MARKER", &marker).env("PATH", dir.path());
                if explicit { child.env("FILEBOX_AGENT_HERDR", &bin); }
                else { child.env_remove("FILEBOX_AGENT_HERDR"); }
                let output = child.output().unwrap();
                assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
                assert_eq!(marker.exists(), expect_client, "explicit={explicit}, value={value}");
            }
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn probe_environment_child() {
        let Ok(expected) = std::env::var("FILEBOX_TEST_HERDR_CHILD") else { return; };
        assert_eq!(HerdrClient::probe().await.is_some(), expected == "enabled");
    }

    #[test]
    fn parse_agent_list_json() {
        let v = serde_json::json!({
            "id": "1",
            "result": {
                "type": "agent_list",
                "agents": [{
                    "name": "reviewer",
                    "agent": "codex",
                    "agent_status": "working",
                    "pane_id": "w1:p2",
                    "workspace_id": "w1",
                    "tab_id": "w1:t1",
                    "cwd": "/repo",
                    "focused": false
                }]
            }
        });
        let agents = extract_agents(&v);
        assert_eq!(agents.len(), 1);
        assert_eq!(agents[0].target, "reviewer");
        assert_eq!(agents[0].kind.as_deref(), Some("codex"));
        assert_eq!(agents[0].status, HerdrAgentStatus::Working);
        assert_eq!(agents[0].pane_id, "w1:p2");
    }

    #[test]
    fn read_preserves_json_in_terminal_output() {
        let json = CliOutput {
            ok: true,
            stdout: r#"{"result":{"read":{"text":"hello from pane"}}}"#.into(),
            stderr: String::new(),
        };
        assert_eq!(read_output_text(&json), json.stdout);
        let plain = CliOutput {
            ok: true,
            stdout: "plain output\n".into(),
            stderr: String::new(),
        };
        assert_eq!(read_output_text(&plain), "plain output");
    }

    #[test]
    fn map_connection_errors() {
        let out = CliOutput {
            ok: false,
            stdout: String::new(),
            stderr: "Error: failed to connect to herdr socket".into(),
        };
        assert_eq!(map_cli_error(&out), "herdr_unavailable");
        let json = CliOutput {
            ok: false,
            stdout: String::new(),
            stderr: r#"{"id":"x","error":{"code":"agent_blocked","message":"needs input"}}"#.into(),
        };
        assert_eq!(map_cli_error(&json), "herdr_blocked");
    }

    #[test]
    fn find_in_path_skips_missing() {
        assert!(find_in_path("definitely-not-a-filebox-herdr-binary-xyz").is_none());
    }

    #[tokio::test]
    async fn status_parses_fake_cli() {
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("herdr");
        std::fs::write(
            &bin,
            r#"#!/bin/sh
if [ "$1" = "--version" ]; then echo "herdr 9.9.9"; exit 0; fi
if [ "$1" = "agent" ] && [ "$2" = "list" ]; then
  printf '%s\n' '{"result":{"type":"agent_list","agents":[{"name":"bot","agent":"claude","agent_status":"idle","pane_id":"w1:p1","workspace_id":"w1","tab_id":"w1:t1","focused":false}]}}'
  exit 0
fi
exit 1
"#,
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let client = HerdrClient {
            bin,
            version: "9.9.9".into(),
        };
        let cancel = AtomicBool::new(false);
        let res = client.status(&cancel).await.unwrap();
        assert!(res.status.unwrap().reachable);
        assert_eq!(res.agents[0].target, "bot");
        assert_eq!(res.agents[0].kind.as_deref(), Some("claude"));
    }

    #[test]
    fn unsafe_name_falls_back_to_pane_id() {
        let v = serde_json::json!({
            "name": "code review",
            "agent": "codex",
            "agent_status": "idle",
            "pane_id": "w1:p9",
            "focused": false
        });
        let agent = parse_agent(&v).unwrap();
        assert_eq!(agent.target, "w1:p9");
        assert_eq!(agent.name.as_deref(), Some("code review"));
    }

    #[test]
    fn trim_error_text_keeps_char_boundary() {
        let raw = format!("{}€", "a".repeat(399));
        let trimmed = trim_error_text(&raw);
        assert!(trimmed.ends_with('…'));
        assert!(trimmed.is_char_boundary(trimmed.len()));
    }

    #[tokio::test]
    async fn version_probe_times_out() {
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("herdr");
        std::fs::write(&bin, "#!/bin/sh\nsleep 30\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let started = std::time::Instant::now();
        let err = probe_version_timeout(&bin, Duration::from_millis(400)).await.unwrap_err();
        assert!(err.contains("timed out"), "{err}");
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn version_probe_deadline_includes_inherited_pipes() {
        use std::os::unix::fs::PermissionsExt;
        for redirection in ["2>/dev/null", "1>/dev/null"] {
            let dir = tempfile::tempdir().unwrap();
            let bin = dir.path().join("herdr");
            // The wrapper exits successfully, but a helper keeps stdout or
            // stderr open. Waiting for EOF must still obey the probe deadline.
            std::fs::write(&bin, format!(
                "#!/bin/sh\nsleep 3 {redirection} &\necho 'herdr 9.9.9'\nexit 0\n"
            )).unwrap();
            std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
            let started = std::time::Instant::now();
            let err = probe_version_timeout(&bin, Duration::from_millis(400)).await.unwrap_err();
            assert!(err.contains("timed out"), "{err}");
            assert!(started.elapsed() < Duration::from_secs(2));
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn version_probe_drains_both_pipes_beyond_buffer_limits() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("herdr");
        std::fs::write(&bin, "#!/bin/sh\necho 'herdr 9.9.9'\ndd if=/dev/zero bs=65536 count=8 2>/dev/null\ndd if=/dev/zero bs=65536 count=8 >&2 2>/dev/null\n").unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        let version = probe_version_timeout(&bin, Duration::from_secs(3)).await.unwrap();
        assert_eq!(version, "9.9.9");
    }

    #[tokio::test]
    async fn visible_read_does_not_scroll_history_and_keys_remain_literal_arguments() {
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("herdr");
        std::fs::write(&bin, "#!/bin/sh\nprintf '%s\\0' \"$@\" > \"$0.args\"\necho '{}'\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let client = HerdrClient { bin: bin.clone(), version: "0.9.5".into() };
        let cancel = AtomicBool::new(false);
        let result = client.run_op(HerdrOp::Read, Some("reviewer".into()), None,
            vec![], Some(120), Some(HerdrReadSource::Visible), false, None, &cancel).await;
        assert!(result.is_ok());
        assert_eq!(std::fs::read(dir.path().join("herdr.args")).unwrap(),
            b"agent\0read\0reviewer\0--source\0visible\0--lines\0120\0");
        let result = client.run_op(HerdrOp::SendKeys, Some("reviewer".into()), None,
            vec!["Ctrl+End".into(), "Ctrl+Shift+P".into()], None, None, false, None, &cancel).await;
        assert!(result.is_ok());
        assert_eq!(std::fs::read(dir.path().join("herdr.args")).unwrap(),
            b"agent\0send-keys\0reviewer\0ctrl+end\0ctrl+shift+p\0");
        assert_eq!(map_cli_error(&CliOutput { ok: false, stdout: String::new(),
            stderr: r#"{"error":{"code":"invalid_key","message":"unsupported key ctrl+end"}}"#.into() }),
            "herdr_key_unsupported");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn herdr_reads_mark_cli_output_overflow_without_breaking_utf8() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("herdr");
        std::fs::write(&bin, "#!/bin/sh\ncat \"$0.output\"\n").unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        let client = HerdrClient { bin, version: "0.9.5".into() };
        let cap = HERDR_OUTPUT_MAX_BYTES;
        for (input, expected) in [
            ("small output\n\n".to_string(), "small output".to_string()),
            ("x".repeat(cap), "x".repeat(cap)),
            (format!("{}LATEST QUESTION", "x".repeat(cap)), format!("{}\n… truncated", "x".repeat(cap))),
            (format!("{}\n", "x".repeat(cap)), format!("{}\n… truncated", "x".repeat(cap))),
            ("中".repeat(cap / 3 + 10), format!("{}\n… truncated", "中".repeat(cap / 3))),
            ("😀".repeat(cap / 4 + 10), format!("{}\n… truncated", "😀".repeat(cap / 4))),
            (format!("x{}", "中".repeat((cap - 1) / 3)), format!("x{}", "中".repeat((cap - 1) / 3))),
            (format!("{}😀tail", "x".repeat(cap - 2)), format!("{}\n… truncated", "x".repeat(cap - 2))),
        ] {
            std::fs::write(dir.path().join("herdr.output"), input).unwrap();
            let result = client.run_op(HerdrOp::Read, Some("w1:p2".into()), None,
                Vec::new(), Some(120), Some(HerdrReadSource::Detection), false, None,
                &AtomicBool::new(false)).await.unwrap();
            let output = result.output.unwrap();
            assert!(output == expected, "length={}, expected={}, marker={}",
                output.len(), expected.len(), output.ends_with("… truncated"));
            assert!(!output.contains('\u{fffd}'));
        }
    }

    #[tokio::test]
    async fn herdr_capped_drain_consumes_the_entire_stream() {
        let mut reader = std::io::Cursor::new(vec![b'x'; 100_000]);
        let kept = drain_capped(Some(&mut reader), 1024).await;
        assert_eq!(kept.len(), 1024);
        assert_eq!(reader.position(), 100_000);
    }

    #[tokio::test]
    async fn read_falls_back_when_history_requires_idle() {
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("herdr");
        std::fs::write(
            &bin,
            r#"#!/bin/sh
src=""
prev=""
for a in "$@"; do
  if [ "$prev" = "--source" ]; then src="$a"; fi
  prev="$a"
done
if [ "$src" = "recent-unwrapped" ]; then
  echo '{"error":{"code":"agent_not_idle","message":"working"}}' >&2
  exit 1
fi
if [ "$src" = "visible" ]; then
  echo 'visible screen'
  exit 0
fi
exit 1
"#,
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let client = HerdrClient { bin, version: "1".into() };
        let cancel = AtomicBool::new(false);
        let msg = client
            .handle(
                "r1".into(),
                HerdrOp::Read,
                Some("reviewer".into()),
                None,
                Vec::new(),
                Some(40),
                None,
                false,
                None,
                Arc::new(cancel),
            )
            .await;
        match msg {
            AgentMessage::HerdrResponse { output, error, .. } => {
                assert!(error.is_none(), "{error:?}");
                assert_eq!(output.as_deref(), Some("visible screen"));
            }
            _ => panic!("unexpected message"),
        }
    }

    #[tokio::test]
    async fn prompt_matches_herdr_positional_text_then_options() {
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("herdr");
        std::fs::write(&bin, "#!/bin/sh\nprintf '%s\\0' \"$@\" > \"$0.args\"\necho '{}'\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let client = HerdrClient { bin, version: "0.9.5".into() };
        for text in ["--help", "--", "--check the diff\n中文"] {
            for wait in [false, true] {
                let msg = client.handle(
                    "p1".into(), HerdrOp::Prompt, Some("reviewer".into()),
                    Some(text.into()), Vec::new(), None, None, wait, Some(60_000),
                    Arc::new(AtomicBool::new(false)),
                ).await;
                match msg {
                    AgentMessage::HerdrResponse { error, .. } => assert!(error.is_none(), "{error:?}"),
                    _ => panic!("unexpected response"),
                }
                let logged = std::fs::read(dir.path().join("herdr.args")).unwrap();
                let args: Vec<_> = logged.split(|b| *b == 0).filter(|part| !part.is_empty())
                    .map(|part| std::str::from_utf8(part).unwrap()).collect();
                let mut expected = vec!["agent", "prompt", "reviewer", text];
                if wait { expected.extend(["--wait", "--timeout", "60000"]); }
                assert_eq!(args, expected);
            }
        }
    }

    #[test]
    fn maps_current_herdr_error_codes() {
        for (code, expected) in [
            ("server_not_running", "herdr_unavailable"),
            ("protocol_mismatch", "herdr_incompatible"),
            ("agent_name_not_found", "herdr_agent_missing"),
            ("pane_not_found", "herdr_agent_missing"),
        ] {
            let out = CliOutput { ok: false, stdout: String::new(),
                stderr: serde_json::json!({"id": "cli", "error": {"code": code, "message": "test"}}).to_string() };
            assert_eq!(map_cli_error(&out), expected);
        }
    }

    #[test]
    fn parses_optional_completion_and_nullable_display_metadata() {
        let mut v = serde_json::json!({"pane_id": "w1:p2", "agent_status": "done",
            "completion_seq": 42, "foreground_cwd": null, "cwd": "/repo",
            "title": null, "display_agent": "Reviewer"});
        let agent = parse_agent(&v).unwrap();
        assert_eq!(agent.completion_seq, Some(42));
        assert_eq!(agent.cwd.as_deref(), Some("/repo"));
        assert_eq!(agent.title.as_deref(), Some("Reviewer"));
        v.as_object_mut().unwrap().remove("completion_seq");
        assert_eq!(parse_agent(&v).unwrap().completion_seq, None);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn rejects_unrecognized_list_output_instead_of_showing_no_agents() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("herdr");
        std::fs::write(&bin, "#!/bin/sh\necho 'unexpected CLI output'\n").unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        let client = HerdrClient { bin, version: "unknown".into() };
        let result = client.status(&AtomicBool::new(false)).await;
        assert!(matches!(result, Err(error) if error == "herdr_incompatible"));
    }

    #[tokio::test]
    async fn cli_timeout_returns_before_the_child_finishes() {
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("herdr");
        std::fs::write(&bin, "#!/bin/sh\nsleep 30\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let cancel = AtomicBool::new(false);
        let started = std::time::Instant::now();
        let err = run_cli(
            &bin,
            &["agent".into(), "list".into()],
            Duration::from_millis(400),
            &cancel,
        )
        .await
        .unwrap_err();
        assert_eq!(err, "herdr_timeout");
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn aborting_cli_task_stops_wrapper_helpers() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("herdr");
        // The helper outlives its wrapper unless teardown kills the group.
        std::fs::write(&bin, "#!/bin/sh\n(touch \"$0.ready\"; sleep 1; touch \"$0.leaked\") &\nwait\n").unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        let task = tokio::spawn(async move {
            run_cli(&bin, &[], Duration::from_secs(30), &AtomicBool::new(false)).await
        });
        tokio::time::timeout(Duration::from_secs(5), async {
            while !dir.path().join("herdr.ready").exists() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        }).await.unwrap();
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        tokio::time::sleep(Duration::from_millis(1300)).await;
        assert!(!dir.path().join("herdr.leaked").exists(), "helper survived connection teardown");
    }
}
