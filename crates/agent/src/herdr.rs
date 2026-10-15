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
    HerdrAgent, HerdrAgentStatus, HerdrOp, HerdrServerStatus, HERDR_OUTPUT_MAX_BYTES,
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
        wait: bool,
        timeout_ms: Option<u64>,
        cancel: Arc<AtomicBool>,
    ) -> AgentMessage {
        match self
            .run_op(op, target, text, keys, lines, wait, timeout_ms, &cancel)
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
                let history = vec![
                    "agent".into(),
                    "read".into(),
                    target.clone(),
                    "--source".into(),
                    "recent-unwrapped".into(),
                    "--lines".into(),
                    n.to_string(),
                ];
                let first = run_cli(&self.bin, &history, READ_TIMEOUT, cancel).await?;
                let out = if !first.ok && is_not_idle(&first) {
                    let visible = vec![
                        "agent".into(),
                        "read".into(),
                        target,
                        "--source".into(),
                        "visible".into(),
                    ];
                    run_cli(&self.bin, &visible, READ_TIMEOUT, cancel).await?
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
                // Flags before `--`; the prompt is positional so a message
                // that starts with `-` is not parsed as a CLI option.
                let mut args = vec!["agent".into(), "prompt".into(), target];
                let timeout = if wait {
                    let ms = clamp_wait_timeout_ms(timeout_ms);
                    args.push("--wait".into());
                    args.push("--timeout".into());
                    args.push(ms.to_string());
                    Duration::from_millis(ms + 5_000)
                } else {
                    PROMPT_TIMEOUT
                };
                args.push("--".into());
                args.push(text);
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
                    .unwrap_or(Value::Null);
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
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let out_fut = drain_capped(stdout, HERDR_OUTPUT_MAX_BYTES);
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
                kill_herdr_group(pid);
                let _ = child.start_kill();
                return Err("herdr_timeout".to_string());
            }
            _ = wait_until_cancel(cancel), if status.is_none() => {
                kill_herdr_group(pid);
                let _ = child.start_kill();
                return Err("cancelled".to_string());
            }
        }
        if status.is_some() && stdout_buf.is_some() && stderr_buf.is_some() {
            break;
        }
    }
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
    if let Some(json) = parse_json_blob(&out.stdout) {
        if let Some(text) = json
            .pointer("/result/read/text")
            .or_else(|| json.pointer("/read/text"))
            .and_then(|v| v.as_str())
        {
            return truncate_output(text);
        }
    }
    truncate_output(out.stdout.trim_end())
}

fn truncate_output(text: &str) -> String {
    if text.len() <= HERDR_OUTPUT_MAX_BYTES {
        return text.to_string();
    }
    let mut end = HERDR_OUTPUT_MAX_BYTES;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    let mut s = text[..end].to_string();
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
        "agent_blocked" => "herdr_blocked".to_string(),
        "agent_not_found" | "agent_not_running" => "herdr_agent_missing".to_string(),
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
            .or_else(|| v.get("cwd"))
            .and_then(|x| x.as_str())
            .map(|s| s.to_string())
            .filter(|s| !s.is_empty()),
        title: v
            .get("title")
            .or_else(|| v.get("display_agent"))
            .and_then(|x| x.as_str())
            .map(|s| s.to_string())
            .filter(|s| !s.is_empty()),
        focused: v.get("focused").and_then(|x| x.as_bool()).unwrap_or(false),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn parse_read_text_from_json_or_plain() {
        let json = CliOutput {
            ok: true,
            stdout: r#"{"result":{"read":{"text":"hello from pane"}}}"#.into(),
            stderr: String::new(),
        };
        assert_eq!(read_output_text(&json), "hello from pane");
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
    async fn prompt_places_text_after_double_dash() {
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("herdr");
        let log = dir.path().join("args");
        std::fs::write(
            &bin,
            format!(
                "#!/bin/sh\nprintf '%s\\n' \"$*\" > {}\nif [ \"$2\" = prompt ]; then echo '{{}}'; exit 0; fi\nexit 1\n",
                log.display()
            ),
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let client = HerdrClient { bin, version: "1".into() };
        let cancel = Arc::new(AtomicBool::new(false));
        let msg = client
            .handle(
                "p1".into(),
                HerdrOp::Prompt,
                Some("reviewer".into()),
                Some("--help".into()),
                Vec::new(),
                None,
                false,
                None,
                cancel,
            )
            .await;
        match msg {
            AgentMessage::HerdrResponse { error, .. } => assert!(error.is_none(), "{error:?}"),
            _ => panic!("unexpected"),
        }
        let logged = std::fs::read_to_string(&log).unwrap();
        assert!(
            logged.contains("prompt reviewer -- --help"),
            "argv was: {logged}"
        );
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
}
