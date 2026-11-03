use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use filebox_protocol::ai_agents::{
    clamp_lines, clamp_wait_timeout_ms, validate_keys, validate_prompt_text, validate_target,
    AiAgent, AiAgentBackendStatus, AiAgentOp, AiAgentReadSource,
};
use filebox_protocol::message::AgentMessage;
use filebox_protocol::resources::{AiAgentSettings, AiAgentsCapability};

pub mod herdr;

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

pub async fn probe() -> Option<Arc<dyn AiAgentBackend>> {
    if let Some(backend) = herdr::HerdrBackend::probe().await {
        return Some(Arc::new(backend));
    }
    None
}

pub fn capability(
    enabled: bool,
    environment_override: Option<bool>,
    backend: Option<&dyn AiAgentBackend>,
) -> AiAgentsCapability {
    AiAgentsCapability {
        available: effective_enabled(enabled, environment_override) && backend.is_some(),
        backend: backend.map(|backend| backend.kind().to_string()),
        version: backend.map(|backend| backend.version().to_string()),
        settings: AiAgentSettings {
            enabled,
            environment_override,
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
}
