//! Experimental generation-1 hc API adapter, carried by `hc connect`.
//! Only explicitly labelled, local live terminals are exposed; no run/exec/attach API.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use filebox_protocol::ai_agents::{
    validate_target, AiAgent, AiAgentBackendStatus, AiAgentReadSource, AiAgentStatus,
    AI_AGENT_OUTPUT_MAX_BYTES,
};
use filebox_protocol::resources::AiAgentFeatures;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};

use super::{AiAgentBackend, AiAgentList, BackendFuture};

const RPC_MAX_BYTES: usize = 2 * 1024 * 1024;
const METHODS: &[&str] = &[
    "terminal.list", "terminal.get", "terminal.read", "terminal.send", "terminal.keys",
];

pub struct HcBackend {
    bin: PathBuf,
    version: String,
}

impl HcBackend {
    pub async fn probe() -> Option<Self> {
        let bin = resolve_path()?;
        match probe_version(&bin).await {
            Ok(version) => Some(Self { bin, version }),
            Err(error) => {
                tracing::warn!("hc version probe failed: {error}");
                None
            }
        }
    }

    async fn execute(&self, op: Operation<'_>, cancel: &AtomicBool) -> Result<Value, String> {
        let budget = match &op {
            Operation::List => Duration::from_secs(8),
            Operation::Read { .. } => Duration::from_secs(20),
            Operation::Prompt { wait_ms, .. } => wait_ms
                .map(|ms| Duration::from_millis(ms + 5_000))
                .unwrap_or(Duration::from_secs(15)),
            Operation::Keys { .. } => Duration::from_secs(10),
        };
        bounded(budget, cancel, async {
            let mut rpc = RpcClient::start(&self.bin)?;
            let hello = rpc.call("hello", json!({"generation": 1})).await?;
            let core_id = check_hello(&hello)?;
            if matches!(op, Operation::List) {
                let result = rpc.call("terminal.list", json!({"labels": {"filebox": "ai-agent"}})).await?;
                let terminals = result["terminals"].as_array().ok_or_else(incompatible)?;
                let mut agents = Vec::new();
                for terminal in terminals {
                    if allowed(terminal) {
                        agents.push(to_agent(terminal, core_id)?);
                    }
                }
                let value = json!(agents);
                if value.to_string().len() > AI_AGENT_OUTPUT_MAX_BYTES {
                    return Err("ai_agent_failed: hc list exceeds output limit".into());
                }
                return Ok(value);
            }

            let target = match &op {
                Operation::Read { target, .. } | Operation::Prompt { target, .. }
                    | Operation::Keys { target, .. } => *target,
                Operation::List => unreachable!(),
            };
            validate_target(target).map_err(|_| "invalid_request".to_string())?;
            let terminal = rpc.call("terminal.get", json!({"terminal": target})).await?;
            if !allowed(&terminal) || terminal["address"].as_str() != Some(target) {
                return Err("ai_agent_missing".into());
            }
            match op {
                Operation::Read { lines, source, .. } => {
                    let history = if source == Some(AiAgentReadSource::Visible) { 0 } else { lines };
                    let result = rpc.call("terminal.read", json!({"terminal": target, "lines": history})).await?;
                    let text = result["text"].as_str().ok_or_else(incompatible)?;
                    if text.len() > AI_AGENT_OUTPUT_MAX_BYTES {
                        return Err("ai_agent_failed: hc read exceeds output limit".into());
                    }
                    // hc counts history above the screen; Filebox caps the entire snapshot.
                    let tail = text.lines().rev().take(lines as usize).collect::<Vec<_>>()
                        .into_iter().rev().collect::<Vec<_>>().join("\n");
                    Ok(json!(tail))
                }
                Operation::Prompt { text, wait_ms, .. } => {
                    let result = rpc.call("terminal.send", json!({
                        "terminal": target, "text": text, "force": false,
                        "wait": wait_ms.is_some(), "timeout": wait_ms.map(|ms| ms as f64 / 1000.0),
                    })).await?;
                    if result["turn"].as_u64().is_none() {
                        return Err(incompatible());
                    }
                    Ok(Value::Null)
                }
                Operation::Keys { keys, .. } => {
                    let result = rpc.call("terminal.keys", json!({"terminal": target, "keys": keys})).await?;
                    if result["turn"].as_u64().is_none() { return Err(incompatible()); }
                    Ok(Value::Null)
                }
                Operation::List => unreachable!(),
            }
        }).await
    }
}

impl AiAgentBackend for HcBackend {
    fn kind(&self) -> &'static str { "hc" }
    fn version(&self) -> &str { &self.version }
    fn features(&self) -> AiAgentFeatures { AiAgentFeatures::default() }

    fn list<'a>(&'a self, cancel: &'a AtomicBool) -> BackendFuture<'a, Result<AiAgentList, String>> {
        Box::pin(async move {
            match self.execute(Operation::List, cancel).await {
                Ok(agents) => Ok(AiAgentList {
                    status: AiAgentBackendStatus {
                        installed: true, reachable: true, version: Some(self.version.clone()), message: None,
                    },
                    error: None,
                    agents: serde_json::from_value(agents).map_err(|_| incompatible())?,
                }),
                Err(error) => Ok(AiAgentList {
                    status: AiAgentBackendStatus {
                        installed: true, reachable: false, version: Some(self.version.clone()),
                        message: Some(error.clone()),
                    },
                    error: Some(error), agents: Vec::new(),
                }),
            }
        })
    }

    fn read<'a>(&'a self, target: &'a str, lines: u32, source: Option<AiAgentReadSource>, cancel: &'a AtomicBool)
        -> BackendFuture<'a, Result<String, String>> {
        Box::pin(async move {
            let value = self.execute(Operation::Read { target, lines, source }, cancel).await?;
            value.as_str().map(str::to_string).ok_or_else(incompatible)
        })
    }

    fn prompt<'a>(&'a self, target: &'a str, text: &'a str, wait_ms: Option<u64>, cancel: &'a AtomicBool)
        -> BackendFuture<'a, Result<Option<AiAgent>, String>> {
        Box::pin(async move {
            self.execute(Operation::Prompt { target, text, wait_ms }, cancel).await?;
            Ok(None)
        })
    }

    fn send_keys<'a>(&'a self, target: &'a str, keys: &'a [String], cancel: &'a AtomicBool)
        -> BackendFuture<'a, Result<Option<AiAgent>, String>> {
        Box::pin(async move {
            self.execute(Operation::Keys { target, keys }, cancel).await?;
            Ok(None)
        })
    }
}

enum Operation<'a> {
    List,
    Read { target: &'a str, lines: u32, source: Option<AiAgentReadSource> },
    Prompt { target: &'a str, text: &'a str, wait_ms: Option<u64> },
    Keys { target: &'a str, keys: &'a [String] },
}

fn check_hello(hello: &Value) -> Result<&str, String> {
    if hello["generation"] != 1 || hello["framed"] != false
        || !METHODS.iter().all(|method| hello["methods"].as_array()
            .is_some_and(|methods| methods.iter().any(|value| value.as_str() == Some(method)))) {
        return Err(incompatible());
    }
    hello["core"]["id"].as_str().filter(|id| !id.is_empty()).ok_or_else(incompatible)
}

fn allowed(terminal: &Value) -> bool {
    terminal["labels"]["filebox"] == "ai-agent" && terminal["state"] == "live"
        && terminal["address"].as_str().is_some_and(|address| validate_target(address).is_ok())
}

fn to_agent(terminal: &Value, core: &str) -> Result<AiAgent, String> {
    let target = terminal["address"].as_str().ok_or_else(incompatible)?.to_string();
    let created = terminal["created_ms"].as_u64().ok_or_else(incompatible)?;
    let status = terminal.get("status").filter(|status| !status.is_null());
    let string = |value: &Value| value.as_str().filter(|s| !s.is_empty()).map(str::to_string);
    Ok(AiAgent {
        target: target.clone(),
        name: string(&terminal["name"]),
        kind: status.and_then(|s| string(&s["app"])).or_else(|| string(&terminal["template"])),
        status: status.and_then(|s| s["state"].as_str()).map(AiAgentStatus::parse_label).unwrap_or_default(),
        completion_seq: terminal["turn"].as_u64(),
        id: target,
        scope: format!("{core}:{created}"),
        cwd: string(&terminal["foreground"]["cwd"]).or_else(|| string(&terminal["cwd"])),
        title: string(&terminal["title"]),
        focused: false,
    })
}

fn incompatible() -> String { "ai_agent_backend_incompatible".into() }
fn unavailable(_: std::io::Error) -> String { "ai_agent_backend_unavailable".into() }

fn rpc_error(error: &Value) -> String {
    match error["data"]["kind"].as_str().unwrap_or("") {
        "not_found" | "finished" | "machine_unknown" => "ai_agent_missing",
        "blocked" => "ai_agent_blocked",
        "status_mismatch" => "ai_agent_not_ready",
        "unavailable" => "ai_agent_backend_unavailable",
        "unsupported_generation" => "ai_agent_backend_incompatible",
        "invalid_params" => "invalid_request",
        _ if error["code"] == -32601 => "ai_agent_backend_incompatible",
        _ => "ai_agent_failed",
    }.into()
}

struct RpcClient {
    _child: Child,
    _group: ProcessGroup,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    next_id: u64,
}

impl RpcClient {
    fn start(bin: &Path) -> Result<Self, String> {
        let mut command = command(bin);
        command.arg("connect").stdin(Stdio::piped());
        let mut child = command.spawn().map_err(unavailable)?;
        let group = ProcessGroup(child.id().unwrap_or(0));
        let stdin = child.stdin.take().ok_or_else(incompatible)?;
        let stdout = BufReader::new(child.stdout.take().ok_or_else(incompatible)?);
        Ok(Self { _child: child, _group: group, stdin, stdout, next_id: 0 })
    }

    async fn call(&mut self, method: &str, params: Value) -> Result<Value, String> {
        self.next_id += 1;
        let request = json!({"jsonrpc": "2.0", "id": self.next_id, "method": method, "params": params});
        self.stdin.write_all(format!("{request}\n").as_bytes()).await.map_err(unavailable)?;
        let mut line = Vec::new();
        (&mut self.stdout).take((RPC_MAX_BYTES + 1) as u64).read_until(b'\n', &mut line)
            .await.map_err(unavailable)?;
        if line.is_empty() { return Err("ai_agent_backend_unavailable".into()); }
        if line.len() > RPC_MAX_BYTES || line.last() != Some(&b'\n') { return Err(incompatible()); }
        let reply: Value = serde_json::from_slice(&line).map_err(|_| incompatible())?;
        if reply["jsonrpc"] != "2.0" || reply["id"] != self.next_id
            || reply.get("result").is_some() == reply.get("error").is_some() {
            return Err(incompatible());
        }
        if let Some(error) = reply.get("error") { return Err(rpc_error(error)); }
        reply.get("result").cloned().ok_or_else(incompatible)
    }
}

fn command(bin: &Path) -> Command {
    let mut command = Command::new(bin);
    command.kill_on_drop(true).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    #[cfg(unix)]
    command.process_group(0);
    command
}

struct ProcessGroup(u32);
impl Drop for ProcessGroup {
    fn drop(&mut self) {
        #[cfg(unix)]
        if self.0 > 0 {
            unsafe { libc::kill(-(self.0 as i32), libc::SIGKILL); }
        }
    }
}

async fn bounded<T>(budget: Duration, cancel: &AtomicBool, future: impl std::future::Future<Output = Result<T, String>>) -> Result<T, String> {
    if cancel.load(Ordering::Relaxed) { return Err("cancelled".into()); }
    tokio::select! {
        result = tokio::time::timeout(budget, future) => result.unwrap_or_else(|_| Err("ai_agent_timeout".into())),
        _ = async {
            while !cancel.load(Ordering::Relaxed) { tokio::time::sleep(Duration::from_millis(50)).await; }
        } => Err("cancelled".into()),
    }
}

async fn probe_version(bin: &Path) -> Result<String, String> {
    bounded(Duration::from_secs(3), &AtomicBool::new(false), async {
        let mut child = command(bin).arg("--version").spawn().map_err(unavailable)?;
        let _group = ProcessGroup(child.id().unwrap_or(0));
        let mut bytes = Vec::new();
        child.stdout.take().ok_or_else(incompatible)?.take(129).read_to_end(&mut bytes).await.map_err(unavailable)?;
        if bytes.len() > 128 { return Err(incompatible()); }
        if !child.wait().await.map_err(unavailable)?.success() { return Err(incompatible()); }
        let raw = std::str::from_utf8(&bytes).map_err(|_| incompatible())?.trim();
        let version = raw.strip_prefix("hc ").filter(|v| !v.is_empty()
            && v.len() <= 64 && v.chars().all(|ch| ch.is_ascii_graphic())).ok_or_else(incompatible)?;
        Ok(version.to_string())
    }).await
}

fn resolve_path() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("FILEBOX_AGENT_HC") {
        let path = PathBuf::from(path);
        return path.is_file().then_some(path);
    }
    for directory in std::env::split_paths(&std::env::var_os("PATH")?) {
        let path = directory.join("hc");
        if path.is_file() { return Some(path); }
        #[cfg(windows)]
        {
            let path = directory.join("hc.exe");
            if path.is_file() { return Some(path); }
        }
    }
    None
}

#[cfg(test)]
#[path = "hc_tests.rs"]
mod tests;
