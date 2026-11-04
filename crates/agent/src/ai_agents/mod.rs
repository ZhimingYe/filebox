use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use filebox_protocol::ai_agents::{
    clamp_lines, clamp_wait_timeout_ms, validate_keys, validate_prompt_text, validate_target,
    AiAgent, AiAgentBackendStatus, AiAgentOp, AiAgentReadSource,
};
use filebox_protocol::message::AgentMessage;
use filebox_protocol::resources::{
    AiAgentBackendInfo, AiAgentFeatures, AiAgentSettings, AiAgentsCapability,
};

pub mod hc;
pub mod herdr;

pub const BACKEND_KINDS: &[&str] = &["herdr", "hc"];

pub type BackendFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

#[derive(Debug)]
pub struct AiAgentList {
    pub status: AiAgentBackendStatus,
    pub error: Option<String>,
    pub agents: Vec<AiAgent>,
}

pub trait AiAgentBackend: Send + Sync {
    fn kind(&self) -> &'static str;
    fn version(&self) -> &str;
    fn features(&self) -> AiAgentFeatures;
    fn list<'a>(&'a self, cancel: &'a AtomicBool) -> BackendFuture<'a, Result<AiAgentList, String>>;
    fn read<'a>(
        &'a self,
        target: &'a str,
        lines: u32,
        source: Option<AiAgentReadSource>,
        cancel: &'a AtomicBool,
    ) -> BackendFuture<'a, Result<String, String>>;
    fn prompt<'a>(
        &'a self,
        target: &'a str,
        text: &'a str,
        wait_timeout_ms: Option<u64>,
        cancel: &'a AtomicBool,
    ) -> BackendFuture<'a, Result<Option<AiAgent>, String>>;
    fn send_keys<'a>(
        &'a self,
        target: &'a str,
        keys: &'a [String],
        cancel: &'a AtomicBool,
    ) -> BackendFuture<'a, Result<Option<AiAgent>, String>>;
}

pub fn environment_override() -> Option<bool> {
    let value = std::env::var_os("FILEBOX_AGENT_AI_AGENTS_ENABLED")?;
    let parsed = value.to_str().and_then(|value| parse_environment_override(value).ok());
    match parsed {
        Some(enabled) => Some(enabled),
        None => {
            tracing::warn!(
                "Invalid FILEBOX_AGENT_AI_AGENTS_ENABLED; AI Agents disabled (use 0 or 1)"
            );
            Some(false)
        }
    }
}

pub fn backend_environment_override() -> Option<String> {
    let value = std::env::var_os("FILEBOX_AGENT_AI_AGENTS_BACKEND")?;
    let kind = value.to_string_lossy().trim().to_string();
    if kind.is_empty() {
        return None;
    }
    if !BACKEND_KINDS.contains(&kind.as_str()) {
        tracing::warn!(
            "Unknown FILEBOX_AGENT_AI_AGENTS_BACKEND={kind}; the selection remains locked and unavailable"
        );
    }
    Some(kind)
}

fn parse_environment_override(value: &str) -> Result<bool, ()> {
    match value.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "on" | "yes" => Ok(true),
        "0" | "false" | "off" | "no" => Ok(false),
        _ => Err(()),
    }
}

pub fn effective_enabled(setting: bool, environment_override: Option<bool>) -> bool {
    environment_override.unwrap_or(setting)
}

pub async fn probe_all() -> Vec<Arc<dyn AiAgentBackend>> {
    let mut backends = Vec::new();
    for kind in BACKEND_KINDS {
        match *kind {
            "herdr" => {
                if let Some(backend) = herdr::HerdrBackend::probe().await {
                    backends.push(Arc::new(backend) as Arc<dyn AiAgentBackend>);
                }
            }
            "hc" => {
                if let Some(backend) = hc::HcBackend::probe().await {
                    backends.push(Arc::new(backend) as Arc<dyn AiAgentBackend>);
                }
            }
            _ => tracing::warn!("AI agent backend {kind} is registered without a probe"),
        }
    }
    backends
}

pub fn select(
    backends: &[Arc<dyn AiAgentBackend>],
    selection: Option<&str>,
) -> Option<Arc<dyn AiAgentBackend>> {
    match selection {
        Some(kind) => backends.iter().find(|backend| backend.kind() == kind).cloned(),
        None => backends.first().cloned(),
    }
}

pub fn capability(
    enabled: bool,
    environment_override: Option<bool>,
    backends: &[Arc<dyn AiAgentBackend>],
    selection: Option<&str>,
    backend_environment_override: Option<&str>,
) -> AiAgentsCapability {
    let effective_selection = backend_environment_override.or(selection);
    let active_backend = select(backends, effective_selection);
    let selected_kind = effective_selection
        .map(str::to_string)
        .or_else(|| active_backend.as_ref().map(|backend| backend.kind().to_string()));
    AiAgentsCapability {
        available: effective_enabled(enabled, environment_override) && active_backend.is_some(),
        backend: selected_kind,
        version: active_backend.map(|backend| backend.version().to_string()),
        backends: backends
            .iter()
            .map(|backend| AiAgentBackendInfo {
                kind: backend.kind().to_string(),
                version: backend.version().to_string(),
                features: backend.features(),
            })
            .collect(),
        settings: AiAgentSettings {
            enabled: effective_enabled(enabled, environment_override),
            environment_override,
            backend: effective_selection.map(str::to_string),
            backend_environment_override: backend_environment_override.map(str::to_string),
        },
    }
}

pub async fn handle_request(
    backend: &dyn AiAgentBackend,
    req_id: String,
    op: AiAgentOp,
    target: Option<String>,
    text: Option<String>,
    keys: Vec<String>,
    lines: Option<u32>,
    read_source: Option<AiAgentReadSource>,
    wait: bool,
    timeout_ms: Option<u64>,
    cancel: Arc<AtomicBool>,
) -> AgentMessage {
    let features = backend.features();
    let response = match op {
        AiAgentOp::Status => match backend.list(&cancel).await {
            Ok(result) => AgentMessage::AiAgentResponse {
                req_id,
                error: result.error,
                status: Some(result.status),
                agents: result.agents,
                agent: None,
                output: None,
            },
            Err(error) => failure(req_id, error, backend),
        },
        AiAgentOp::Read => {
            if read_source == Some(AiAgentReadSource::Visible) && !features.read_visible {
                return rejected(req_id, "ai_agent_unsupported_operation");
            }
            let target = match required_target(target) {
                Ok(target) => target,
                Err(error) => return invalid(req_id, error),
            };
            match backend
                .read(&target, clamp_lines(lines), read_source, &cancel)
                .await
            {
                Ok(output) => AgentMessage::AiAgentResponse {
                    req_id,
                    error: None,
                    status: None,
                    agents: Vec::new(),
                    agent: None,
                    output: Some(output),
                },
                Err(error) => failure(req_id, error, backend),
            }
        }
        AiAgentOp::Prompt => {
            if wait && !features.prompt_wait {
                return rejected(req_id, "ai_agent_unsupported_operation");
            }
            let target = match required_target(target) {
                Ok(target) => target,
                Err(error) => return invalid(req_id, error),
            };
            let text = text.unwrap_or_default();
            if let Err(error) = validate_prompt_text(&text) {
                return invalid(req_id, error.to_string());
            }
            let wait_timeout_ms = wait.then(|| clamp_wait_timeout_ms(timeout_ms));
            match backend
                .prompt(&target, &text, wait_timeout_ms, &cancel)
                .await
            {
                Ok(agent) => AgentMessage::AiAgentResponse {
                    req_id,
                    error: None,
                    status: None,
                    agents: Vec::new(),
                    agent,
                    output: None,
                },
                Err(error) => failure(req_id, error, backend),
            }
        }
        AiAgentOp::SendKeys => {
            let target = match required_target(target) {
                Ok(target) => target,
                Err(error) => return invalid(req_id, error),
            };
            let keys = match validate_keys(&keys) {
                Ok(keys) => keys,
                Err(error) => return invalid(req_id, error.to_string()),
            };
            if features
                .keys
                .as_ref()
                .is_some_and(|allowed| keys.iter().any(|key| !allowed.contains(key)))
            {
                return rejected(req_id, "ai_agent_key_unsupported");
            }
            match backend.send_keys(&target, &keys, &cancel).await {
                Ok(agent) => AgentMessage::AiAgentResponse {
                    req_id,
                    error: None,
                    status: None,
                    agents: Vec::new(),
                    agent,
                    output: None,
                },
                Err(error) => failure(req_id, error, backend),
            }
        }
    };
    response
}

fn required_target(target: Option<String>) -> Result<String, String> {
    let target = target.ok_or_else(|| "target is required".to_string())?;
    let target = target.trim().to_string();
    validate_target(&target).map_err(str::to_string)?;
    Ok(target)
}

fn invalid(req_id: String, error: String) -> AgentMessage {
    AgentMessage::AiAgentResponse {
        req_id,
        error: Some(format!("invalid_request: {error}")),
        status: None,
        agents: Vec::new(),
        agent: None,
        output: None,
    }
}

fn rejected(req_id: String, error: &str) -> AgentMessage {
    AgentMessage::AiAgentResponse {
        req_id,
        error: Some(error.to_string()),
        status: None,
        agents: Vec::new(),
        agent: None,
        output: None,
    }
}

fn failure(req_id: String, error: String, backend: &dyn AiAgentBackend) -> AgentMessage {
    AgentMessage::AiAgentResponse {
        req_id,
        error: Some(error),
        status: Some(AiAgentBackendStatus {
            installed: true,
            reachable: false,
            version: Some(backend.version().to_string()),
            message: None,
        }),
        agents: Vec::new(),
        agent: None,
        output: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct FakeBackend;

    impl AiAgentBackend for FakeBackend {
        fn kind(&self) -> &'static str {
            "fake"
        }

        fn version(&self) -> &str {
            "test"
        }

        fn features(&self) -> AiAgentFeatures {
            AiAgentFeatures::default()
        }

        fn list<'a>(
            &'a self,
            _cancel: &'a AtomicBool,
        ) -> BackendFuture<'a, Result<AiAgentList, String>> {
            Box::pin(async {
                Ok(AiAgentList {
                    status: AiAgentBackendStatus {
                        installed: true,
                        reachable: true,
                        version: Some("test".into()),
                        message: None,
                    },
                    error: None,
                    agents: vec![agent()],
                })
            })
        }

        fn read<'a>(
            &'a self,
            target: &'a str,
            lines: u32,
            _source: Option<AiAgentReadSource>,
            _cancel: &'a AtomicBool,
        ) -> BackendFuture<'a, Result<String, String>> {
            Box::pin(async move { Ok(format!("{target}:{lines}")) })
        }

        fn prompt<'a>(
            &'a self,
            _target: &'a str,
            _text: &'a str,
            _wait_timeout_ms: Option<u64>,
            _cancel: &'a AtomicBool,
        ) -> BackendFuture<'a, Result<Option<AiAgent>, String>> {
            Box::pin(async { Ok(Some(agent())) })
        }

        fn send_keys<'a>(
            &'a self,
            _target: &'a str,
            _keys: &'a [String],
            _cancel: &'a AtomicBool,
        ) -> BackendFuture<'a, Result<Option<AiAgent>, String>> {
            Box::pin(async { Ok(Some(agent())) })
        }
    }

    fn agent() -> AiAgent {
        AiAgent {
            target: "reviewer".into(),
            name: Some("reviewer".into()),
            kind: Some("fake".into()),
            status: filebox_protocol::ai_agents::AiAgentStatus::Idle,
            completion_seq: None,
            id: "reviewer-id".into(),
            scope: "test".into(),
            cwd: None,
            title: None,
            focused: true,
        }
    }

    #[test]
    fn environment_override_parses_supported_values_and_invalid_values_disable() {
        for value in ["1", "true", "on", "yes"] {
            assert_eq!(parse_environment_override(value), Ok(true));
        }
        for value in ["0", "false", "off", "no"] {
            assert_eq!(parse_environment_override(value), Ok(false));
        }
        assert_eq!(parse_environment_override("invalid"), Err(()));
        assert!(effective_enabled(false, Some(true)));
        assert!(!effective_enabled(true, Some(false)));
        assert!(!effective_enabled(false, None));
        assert!(effective_enabled(true, None));
    }

    #[test]
    fn capability_settings_enabled_reflects_the_environment_override() {
        let backends: Vec<Arc<dyn AiAgentBackend>> = vec![Arc::new(FakeBackend)];
        let disabled = capability(true, Some(false), &backends, None, None);
        assert!(!disabled.settings.enabled);
        assert!(!disabled.available);

        let enabled = capability(false, Some(true), &backends, None, None);
        assert!(enabled.settings.enabled);
        assert!(enabled.available);
    }

    #[test]
    fn backend_selection_is_explicit_or_automatically_uses_first_detected() {
        struct NamedBackend(&'static str);

        impl AiAgentBackend for NamedBackend {
            fn kind(&self) -> &'static str { self.0 }
            fn version(&self) -> &str { "test" }
            fn features(&self) -> AiAgentFeatures { AiAgentFeatures::default() }
            fn list<'a>(&'a self, _cancel: &'a AtomicBool) -> BackendFuture<'a, Result<AiAgentList, String>> {
                unreachable!()
            }
            fn read<'a>(&'a self, _target: &'a str, _lines: u32, _source: Option<AiAgentReadSource>, _cancel: &'a AtomicBool) -> BackendFuture<'a, Result<String, String>> {
                unreachable!()
            }
            fn prompt<'a>(&'a self, _target: &'a str, _text: &'a str, _wait_timeout_ms: Option<u64>, _cancel: &'a AtomicBool) -> BackendFuture<'a, Result<Option<AiAgent>, String>> {
                unreachable!()
            }
            fn send_keys<'a>(&'a self, _target: &'a str, _keys: &'a [String], _cancel: &'a AtomicBool) -> BackendFuture<'a, Result<Option<AiAgent>, String>> {
                unreachable!()
            }
        }

        let backends: Vec<Arc<dyn AiAgentBackend>> =
            vec![Arc::new(NamedBackend("a")), Arc::new(NamedBackend("b"))];
        assert_eq!(select(&backends, None).unwrap().kind(), "a");
        assert_eq!(select(&backends, Some("b")).unwrap().kind(), "b");
        assert!(select(&backends, Some("missing")).is_none());

        let missing = capability(true, None, &backends[..1], Some("b"), None);
        assert!(!missing.available);
        assert_eq!(missing.backend.as_deref(), Some("b"));
        assert_eq!(missing.version, None);
        assert_eq!(missing.backends.len(), 1);

        let locked = capability(true, None, &backends, Some("a"), Some("b"));
        assert_eq!(locked.backend.as_deref(), Some("b"));
        assert_eq!(locked.settings.backend.as_deref(), Some("b"));
        assert_eq!(locked.settings.backend_environment_override.as_deref(), Some("b"));
        assert_eq!(locked.version.as_deref(), Some("test"));

        let unknown_lock = capability(true, None, &backends, Some("a"), Some("unknown"));
        assert!(!unknown_lock.available);
        assert_eq!(unknown_lock.backend.as_deref(), Some("unknown"));
        assert_eq!(unknown_lock.version, None);
    }

    #[tokio::test]
    async fn backend_switch_keeps_an_in_flight_request_on_its_original_backend() {
        struct WaitingBackend {
            started: Arc<tokio::sync::Notify>,
            release: Arc<tokio::sync::Notify>,
        }
        impl AiAgentBackend for WaitingBackend {
            fn kind(&self) -> &'static str { "a" }
            fn version(&self) -> &str { "test" }
            fn features(&self) -> AiAgentFeatures { AiAgentFeatures::default() }
            fn list<'a>(&'a self, _: &'a AtomicBool) -> BackendFuture<'a, Result<AiAgentList, String>> {
                Box::pin(async { Err("unused".into()) })
            }
            fn read<'a>(&'a self, _: &'a str, _: u32, _: Option<AiAgentReadSource>, _: &'a AtomicBool) -> BackendFuture<'a, Result<String, String>> {
                let started = self.started.clone();
                let release = self.release.clone();
                Box::pin(async move {
                    started.notify_one();
                    release.notified().await;
                    Ok("a-output".into())
                })
            }
            fn prompt<'a>(&'a self, _: &'a str, _: &'a str, _: Option<u64>, _: &'a AtomicBool) -> BackendFuture<'a, Result<Option<AiAgent>, String>> {
                Box::pin(async { Err("unused".into()) })
            }
            fn send_keys<'a>(&'a self, _: &'a str, _: &'a [String], _: &'a AtomicBool) -> BackendFuture<'a, Result<Option<AiAgent>, String>> {
                Box::pin(async { Err("unused".into()) })
            }
        }

        let started = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());
        let backends: Vec<Arc<dyn AiAgentBackend>> = vec![
            Arc::new(WaitingBackend { started: started.clone(), release: release.clone() }),
            Arc::new(FakeBackend),
        ];
        let original = select(&backends, None).unwrap();
        let request = tokio::spawn(async move {
            handle_request(
                original.as_ref(), "in-flight".into(), AiAgentOp::Read,
                Some("reviewer".into()), None, Vec::new(), Some(10), None,
                false, None, Arc::new(AtomicBool::new(false)),
            ).await
        });
        started.notified().await;
        assert_eq!(select(&backends, Some("fake")).unwrap().kind(), "fake");
        release.notify_one();
        assert!(matches!(
            request.await.unwrap(),
            AgentMessage::AiAgentResponse { output: Some(output), .. } if output == "a-output"
        ));
    }

    #[tokio::test]
    async fn generic_handler_drives_status_read_prompt_and_send_keys() {
        let backend = FakeBackend;
        let cancel = Arc::new(AtomicBool::new(false));
        let status = handle_request(
            &backend, "status".into(), AiAgentOp::Status, None, None, Vec::new(),
            None, None, false, None, cancel.clone(),
        ).await;
        assert!(matches!(status, AgentMessage::AiAgentResponse {
            status: Some(AiAgentBackendStatus { reachable: true, .. }),
            agents, ..
        } if agents.len() == 1));

        let read = handle_request(
            &backend, "read".into(), AiAgentOp::Read, Some(" reviewer ".into()),
            None, Vec::new(), Some(999), Some(AiAgentReadSource::Bottom), false, None,
            cancel.clone(),
        ).await;
        assert!(matches!(read, AgentMessage::AiAgentResponse {
            output: Some(output), ..
        } if output == format!("reviewer:{}", filebox_protocol::ai_agents::AI_AGENT_LINES_MAX)));

        let prompt = handle_request(
            &backend, "prompt".into(), AiAgentOp::Prompt, Some("reviewer".into()),
            Some("test prompt".into()), Vec::new(), None, None, false, None, cancel.clone(),
        ).await;
        assert!(matches!(prompt, AgentMessage::AiAgentResponse {
            agent: Some(_), ..
        }));

        let keys = handle_request(
            &backend, "keys".into(), AiAgentOp::SendKeys, Some("reviewer".into()),
            None, vec!["ENTER".into()], None, None, false, None, cancel,
        ).await;
        assert!(matches!(keys, AgentMessage::AiAgentResponse {
            agent: Some(_), ..
        }));
    }

    #[tokio::test]
    async fn limited_backend_features_are_enforced_before_dispatch() {
        use std::sync::Mutex;

        struct LimitedBackend(Arc<Mutex<Vec<&'static str>>>);

        impl AiAgentBackend for LimitedBackend {
            fn kind(&self) -> &'static str { "limited" }
            fn version(&self) -> &str { "test" }
            fn features(&self) -> AiAgentFeatures {
                AiAgentFeatures {
                    prompt_wait: false,
                    read_visible: false,
                    keys: Some(vec!["enter".into(), "esc".into()]),
                    status_detection: false,
                }
            }
            fn list<'a>(&'a self, _: &'a AtomicBool) -> BackendFuture<'a, Result<AiAgentList, String>> {
                self.0.lock().unwrap().push("status");
                Box::pin(async { unreachable!() })
            }
            fn read<'a>(&'a self, target: &'a str, _: u32, _: Option<AiAgentReadSource>, _: &'a AtomicBool) -> BackendFuture<'a, Result<String, String>> {
                self.0.lock().unwrap().push("read");
                Box::pin(async move { Ok(target.into()) })
            }
            fn prompt<'a>(&'a self, _: &'a str, _: &'a str, _: Option<u64>, _: &'a AtomicBool) -> BackendFuture<'a, Result<Option<AiAgent>, String>> {
                self.0.lock().unwrap().push("prompt");
                Box::pin(async { Ok(Some(agent())) })
            }
            fn send_keys<'a>(&'a self, _: &'a str, _: &'a [String], _: &'a AtomicBool) -> BackendFuture<'a, Result<Option<AiAgent>, String>> {
                self.0.lock().unwrap().push("keys");
                Box::pin(async { Ok(Some(agent())) })
            }
        }

        let calls = Arc::new(Mutex::new(Vec::new()));
        let backend = LimitedBackend(calls.clone());
        let cancel = Arc::new(AtomicBool::new(false));
        let rejected_wait = handle_request(
            &backend, "wait".into(), AiAgentOp::Prompt, Some("reviewer".into()),
            Some("prompt".into()), Vec::new(), None, None, true, None, cancel.clone(),
        ).await;
        assert!(matches!(rejected_wait, AgentMessage::AiAgentResponse {
            error: Some(error), status: None, .. } if error == "ai_agent_unsupported_operation"));
        assert!(calls.lock().unwrap().is_empty());

        let prompt = handle_request(
            &backend, "prompt".into(), AiAgentOp::Prompt, Some("reviewer".into()),
            Some("prompt".into()), Vec::new(), None, None, false, None, cancel.clone(),
        ).await;
        assert!(matches!(prompt, AgentMessage::AiAgentResponse { agent: Some(_), .. }));
        let rejected_visible = handle_request(
            &backend, "visible".into(), AiAgentOp::Read, Some("reviewer".into()),
            None, Vec::new(), None, Some(AiAgentReadSource::Visible), false, None, cancel.clone(),
        ).await;
        assert!(matches!(rejected_visible, AgentMessage::AiAgentResponse {
            error: Some(error), status: None, .. } if error == "ai_agent_unsupported_operation"));
        assert_eq!(*calls.lock().unwrap(), ["prompt"]);

        let bottom = handle_request(
            &backend, "bottom".into(), AiAgentOp::Read, Some("reviewer".into()),
            None, Vec::new(), None, Some(AiAgentReadSource::Bottom), false, None, cancel.clone(),
        ).await;
        assert!(matches!(bottom, AgentMessage::AiAgentResponse { output: Some(output), .. }
            if output == "reviewer"));
        let rejected_keys = handle_request(
            &backend, "ctrl-c".into(), AiAgentOp::SendKeys, Some("reviewer".into()),
            None, vec!["ctrl+c".into()], None, None, false, None, cancel.clone(),
        ).await;
        assert!(matches!(rejected_keys, AgentMessage::AiAgentResponse {
            error: Some(error), status: None, .. } if error == "ai_agent_key_unsupported"));
        assert_eq!(*calls.lock().unwrap(), ["prompt", "read"]);

        let enter = handle_request(
            &backend, "enter".into(), AiAgentOp::SendKeys, Some("reviewer".into()),
            None, vec!["ENTER".into()], None, None, false, None, cancel,
        ).await;
        assert!(matches!(enter, AgentMessage::AiAgentResponse { agent: Some(_), .. }));
        assert_eq!(*calls.lock().unwrap(), ["prompt", "read", "keys"]);
        let capability = capability(true, None, &[Arc::new(LimitedBackend(calls))], None, None);
        assert_eq!(capability.backends[0].features, backend.features());
    }

    #[test]
    fn herdr_declares_default_features() {
        let backend = herdr::HerdrBackend {
            bin: std::path::PathBuf::new(),
            version: "test".into(),
        };
        assert_eq!(backend.features(), AiAgentFeatures::default());
    }
}
