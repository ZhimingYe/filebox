//! Relay a small whitelist of AI agent CLI commands to a connected agent.

use crate::agent_requests::{cleanup_pending, PendingResponseCleanup};
use std::time::Duration;

use axum::extract::{Extension, Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use filebox_protocol::ai_agents::{
    clamp_lines, clamp_wait_timeout_ms, validate_keys, validate_prompt_text, validate_target,
    AiAgentOp, AiAgentReadSource,
};
use filebox_protocol::message::HubMessage;
use serde::Deserialize;
use uuid::Uuid;

use crate::state::{AppState, AuthenticatedSession, PendingResponse, MAX_PENDING_RESPONSES};

#[derive(Debug, Deserialize)]
pub struct AiAgentBody {
    pub op: AiAgentOp,
    #[serde(default)]
    pub backend: Option<String>,
    #[serde(default)]
    pub target: Option<String>,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub keys: Vec<String>,
    #[serde(default)]
    pub lines: Option<u32>,
    #[serde(default)]
    pub read_source: Option<AiAgentReadSource>,
    #[serde(default)]
    pub wait: bool,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Deserialize)]
pub struct AiAgentsSettingsBody {
    pub enabled: bool,
    #[serde(default)]
    pub backend: Option<String>,
}

pub async fn ai_agents_settings_handler(
    State(state): State<AppState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path(agent_id): Path<String>,
    Json(body): Json<AiAgentsSettingsBody>,
) -> Response {
    let inner = state.inner.read().await;
    let agent = match inner.agents.get(&agent_id) {
        Some(agent) => agent,
        None => {
            return error_response(
                StatusCode::SERVICE_UNAVAILABLE,
                "backend_offline",
                &format!("Agent {agent_id} is offline"),
                true,
            );
        }
    };
    if agent.status == crate::agent_registry::AgentStatus::Offline {
        return error_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "backend_offline",
            &format!("Agent {agent_id} is offline"),
            true,
        );
    }
    let Some(settings) = agent.capabilities.ai_agents.as_ref() else {
        return error_response(
            StatusCode::NOT_IMPLEMENTED,
            "unsupported",
            "AI Agents settings are not supported by this Agent",
            false,
        );
    };
    let (enabled_locked, backend_locked) =
        settings_override_mismatches(&settings.settings, body.enabled, &body.backend);
    if enabled_locked || backend_locked {
        let controls = [
            enabled_locked.then_some("FILEBOX_AGENT_AI_AGENTS_ENABLED"),
            backend_locked.then_some("FILEBOX_AGENT_AI_AGENTS_BACKEND"),
        ]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(" and ");
        return error_response(
            StatusCode::CONFLICT,
            "ai_agents_environment_override",
            &format!("{controls} controls this AI Agents setting; change or unset it and restart the Filebox Agent"),
            false,
        );
    }
    if settings.settings.backend_environment_override.is_none()
        && body
            .backend
            .as_deref()
            .is_some_and(|kind| !valid_backend_kind(kind))
    {
        return error_response(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "Backend kind must contain 1–32 lowercase letters, digits, underscores, or hyphens",
            false,
        );
    }

    let req_id = format!("ai_agents_{}", Uuid::new_v4());
    let connection_id = agent.connection_id;
    let (resp_tx, mut resp_rx, response_owner) = crate::agent_requests::response_channel();
    let send_ok = {
        let mut pending = inner.pending_responses.write().await;
        if pending.len() >= MAX_PENDING_RESPONSES {
            false
        } else {
            pending.insert(
                req_id.clone(),
                PendingResponse {
                    tx: resp_tx,
                    agent_id: agent_id.clone(),
                    connection_id,
                    session_id: Some(session.principal_id.clone()),
                    desired_roots: None,
                    desired_collections: None,
                },
            );
            inner.agents.send_to_agent(
                &agent_id,
                HubMessage::AiAgentSettingsSet {
                    req_id: req_id.clone(),
                    enabled: body.enabled,
                    backend: body.backend,
                },
            )
        }
    };
    drop(inner);
    if !send_ok {
        cleanup_pending(&state, &req_id).await;
        return error_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "backend_offline",
            "Failed to send settings update to Agent",
            true,
        );
    }

    let guard = PendingResponseCleanup::new(
        state.clone(),
        req_id.clone(),
        Some(agent_id),
        response_owner,
    );
    let response = tokio::time::timeout(Duration::from_secs(8), resp_rx.recv()).await;
    guard
        .finish(!matches!(response, Ok(Some(_))))
        .await;
    match response {
        Ok(Some(value)) => {
            if let Some(error) = value.get("error").and_then(|value| value.as_str()) {
                let (status, code, message, retryable) = match error {
                    "ai_agents_environment_override" => (
                        StatusCode::CONFLICT,
                        "ai_agents_environment_override",
                        "FILEBOX_AGENT_AI_AGENTS_ENABLED or FILEBOX_AGENT_AI_AGENTS_BACKEND controls this AI Agents setting; change or unset it and restart the Filebox Agent",
                        false,
                    ),
                    "invalid_request" => (
                        StatusCode::BAD_REQUEST,
                        "invalid_request",
                        "Invalid AI agent backend selection",
                        false,
                    ),
                    "backend_offline" => (
                        StatusCode::SERVICE_UNAVAILABLE,
                        "backend_offline",
                        "Agent disconnected before applying the AI Agents setting; retry after it reconnects",
                        true,
                    ),
                    _ => (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        "ai_agents_settings_save_failed",
                        "Agent failed to persist the AI Agents setting",
                        false,
                    ),
                };
                return error_response(status, code, message, retryable);
            }
            Json(value["ai_agents"].clone()).into_response()
        }
        _ => error_response(
            StatusCode::GATEWAY_TIMEOUT,
            "request_timeout",
            "Agent did not apply the AI Agents setting in time",
            true,
        ),
    }
}

fn valid_backend_kind(kind: &str) -> bool {
    (1..=32).contains(&kind.len())
        && kind
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_' || byte == b'-')
}

fn settings_override_mismatches(
    settings: &filebox_protocol::resources::AiAgentSettings,
    enabled: bool,
    backend: &Option<String>,
) -> (bool, bool) {
    (
        settings.environment_override.is_some() && enabled != settings.enabled,
        settings.backend_environment_override.is_some() && backend != &settings.backend,
    )
}

pub async fn ai_agents_handler(
    State(state): State<AppState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path(agent_id): Path<String>,
    Json(body): Json<AiAgentBody>,
) -> Response {
    let validated = match validate_body(body) {
        Ok(v) => v,
        Err(msg) => {
            return error_response(StatusCode::BAD_REQUEST, "invalid_request", msg, false);
        }
    };

    let inner = state.inner.read().await;
    let agent = match inner.agents.get(&agent_id) {
        Some(a) => a,
        None => {
            return error_response(
                StatusCode::NOT_FOUND,
                "backend_offline",
                &format!("Agent {agent_id} not found or offline"),
                true,
            );
        }
    };

    if agent.status == crate::agent_registry::AgentStatus::Offline {
        return error_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "backend_offline",
            &format!("Agent {agent_id} is offline"),
            true,
        );
    }

    let Some(capability) = agent.capabilities.ai_agents.as_ref().filter(|capability| capability.available) else {
        return error_response(
            StatusCode::NOT_IMPLEMENTED,
            "unsupported",
            "AI Agents are unavailable on this agent. Check its backend installation and FILEBOX_AGENT_AI_AGENTS_ENABLED, then restart the Filebox Agent",
            false,
        );
    };
    let Some(active_backend) = capability.backend.as_deref().map(str::to_owned) else {
        return error_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "ai_agent_backend_not_detected",
            "The selected AI agent backend is not detected on this Agent. Install it or choose another backend in Settings.",
            true,
        );
    };
    if validated
        .backend
        .as_deref()
        .is_some_and(|backend| backend != active_backend.as_str())
    {
        return error_response(
            StatusCode::CONFLICT,
            "ai_agent_backend_changed",
            "The AI agent backend changed on this Agent. Refresh and retry.",
            false,
        );
    }
    let bound_backend = validated.backend.clone().unwrap_or(active_backend);

    drop(inner);
    let req_id = format!("ai_agents_{}", Uuid::new_v4());
    let wait_ms = if validated.wait { clamp_wait_timeout_ms(validated.timeout_ms) } else { 0 };
    let hub_timeout = hub_timeout_for(validated.op, validated.wait, wait_ms);
    let is_status = validated.op == AiAgentOp::Status;
    let msg = match reviewed_message(
        &state,
        &session.principal_id,
        &agent_id,
        validated,
        &req_id,
        bound_backend,
    )
    .await
    {
        Ok(msg) => msg,
        Err(response) => return response,
    };
    match relay_ai_agents(&state, &session.principal_id, &agent_id, &req_id, msg, hub_timeout).await {
        Ok(mut value) => {
            if is_status {
                if let Some(object) = value.as_object_mut() {
                    object.insert("prompt_review".into(), prompt_review_status(&state));
                }
            }
            Json(value).into_response()
        }
        Err(response) => response,
    }
}

/// Read-only prompt-review state for the AI Agents UI; configuration stays file-only.
fn prompt_review_status(state: &AppState) -> serde_json::Value {
    match (state.prompt_review_mode, &state.prompt_reviewer) {
        (crate::prompt_review::ReviewMode::Disabled, _) => serde_json::json!({"state": "off"}),
        (_, Some(reviewer)) => serde_json::json!({"state": "on", "model": reviewer.model()}),
        (_, None) => serde_json::json!({"state": "not_configured"}),
    }
}

async fn relay_ai_agents(
    state: &AppState, principal_id: &str, agent_id: &str, req_id: &str,
    msg: HubMessage, hub_timeout: Duration,
) -> Result<serde_json::Value, Response> {
    let inner = state.inner.read().await;
    let agent = match inner.agents.get(agent_id) {
        Some(agent) if agent.status != crate::agent_registry::AgentStatus::Offline && agent.capabilities.ai_agents.as_ref().is_some_and(|capability| capability.available) => agent,
        _ => return Err(error_response(StatusCode::SERVICE_UNAVAILABLE, "backend_offline",
            "Agent disconnected or AI Agents became unavailable during review", true)),
    };

    let (resp_tx, mut resp_rx, response_owner) = crate::agent_requests::response_channel();
    let send_ok = {
        let mut pending = inner.pending_responses.write().await;
        if pending.len() >= MAX_PENDING_RESPONSES {
            false
        } else {
            pending.insert(
                req_id.to_owned(),
                PendingResponse {
                    tx: resp_tx,
                    agent_id: agent_id.to_owned(),
                    connection_id: agent.connection_id,
                    session_id: Some(principal_id.to_owned()),
                    desired_roots: None,
                    desired_collections: None,
                },
            );
            inner.agents.send_to_agent(agent_id, msg)
        }
    };

    drop(inner);
    if !send_ok {
        cleanup_pending(state, req_id).await;
        return Err(error_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "backend_offline",
            "Failed to send request to agent",
            true,
        ));
    }

    let guard = PendingResponseCleanup::new(
        state.clone(),
        req_id.to_owned(),
        Some(agent_id.to_owned()),
        response_owner,
    );
    let resp = tokio::time::timeout(hub_timeout, resp_rx.recv()).await;
    guard.finish(!matches!(resp, Ok(Some(_)))).await;

    match resp {
        Ok(Some(value)) => {
            let cancelled = value.get("state").and_then(|v| v.as_str()) == Some("cancelled")
                || value.get("error").and_then(|v| v.as_str()) == Some("cancelled");
            if cancelled {
                return Err(error_response(
                    StatusCode::CONFLICT,
                    "cancelled",
                    "AI agent command was cancelled",
                    true,
                ));
            }
            if let Some(error) = value.get("error").and_then(|v| v.as_str()) {
                if !error.is_empty() && error != "null" {
                    let (status, code) = http_for_ai_agents_error(error);
                    return Err(error_response(status, code, human_ai_agents_error(error), status != StatusCode::BAD_REQUEST && status != StatusCode::UNPROCESSABLE_ENTITY));
                }
            }
            Ok(value)
        }
        _ => Err(error_response(
            StatusCode::GATEWAY_TIMEOUT,
            "request_timeout",
            "Agent did not respond in time",
            true,
        )),
    }
}

async fn review_context(
    state: &AppState,
    principal_id: &str,
    agent_id: &str,
    backend: &str,
    target: Option<String>,
) -> Option<String> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    for attempt in 0..2 {
        let req_id = format!("ai_agents_context_{}", Uuid::new_v4());
        let msg = HubMessage::AiAgentRequest {
            req_id: req_id.clone(), op: AiAgentOp::Read, backend: Some(backend.into()), target: target.clone(),
            text: None, keys: Vec::new(), lines: Some(120),
            read_source: Some(AiAgentReadSource::Bottom), wait: false, timeout_ms: None,
        };
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        match relay_ai_agents(state, principal_id, agent_id, &req_id, msg, remaining).await {
            Ok(value) => return value["output"].as_str().and_then(clean_context),
            Err(response) if attempt == 0 && response.status() == StatusCode::TOO_MANY_REQUESTS => {
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
            Err(_) => return None,
        }
    }
    None
}

fn clean_context(text: &str) -> Option<String> {
    let mut clean = String::new();
    let mut chars = text.chars().peekable();
    while let Some(ch) = chars.next() {
        match ch {
            '\u{1b}' => match chars.next() {
                Some('[') => {
                    for c in chars.by_ref() { if ('@'..='~').contains(&c) { break; } }
                }
                Some(']' | 'P' | 'X' | '^' | '_') => {
                    while let Some(c) = chars.next() {
                        if c == '\u{7}' || (c == '\u{1b}' && chars.next_if_eq(&'\\').is_some()) { break; }
                    }
                }
                Some(c) if (' '..='/').contains(&c) => {
                    for c in chars.by_ref() { if !(' '..='/').contains(&c) { break; } }
                }
                _ => {}
            },
            '\n' | '\t' => clean.push(ch),
            c if c.is_control() => {}
            c => clean.push(c),
        }
    }
    let mut start = clean.len().saturating_sub(16 * 1024);
    while !clean.is_char_boundary(start) { start += 1; }
    let tail = clean[start..].trim();
    if tail.is_empty() { None } else { Some(tail.to_owned()) }
}

async fn reviewed_message(
    state: &AppState,
    principal_id: &str,
    agent_id: &str,
    validated: ValidatedBody,
    req_id: &str,
    backend: String,
) -> Result<HubMessage, Response> {
    if matches!(validated.op, AiAgentOp::Prompt) && state.prompt_review_mode == crate::prompt_review::ReviewMode::Mandatory {
        if let Some(reviewer) = &state.prompt_reviewer {
            let context =
                review_context(state, principal_id, agent_id, &backend, validated.target.clone()).await;
            match reviewer.review(validated.text.as_deref().unwrap_or_default(), context.as_deref()).await {
                Ok(verdict) if matches!(verdict.decision, crate::prompt_review::Decision::Block) => {
                    tracing::warn!(agent_id = %agent_id, target = ?validated.target,
                        category = %verdict.category, reason = %verdict.reason,
                        prompt_bytes = validated.text.as_deref().unwrap_or_default().len(),
                        "AI agent prompt blocked");
                    return Err(error_response(StatusCode::FORBIDDEN, "ai_agent_prompt_blocked",
                        &format!("Prompt blocked: {}", verdict.reason), false));
                }
                Ok(_) => {}
                Err(()) => return Err(error_response(StatusCode::SERVICE_UNAVAILABLE,
                    "prompt_review_unavailable", "Prompt review is unavailable; retry later", true)),
            }
        } else {
            return Err(error_response(StatusCode::SERVICE_UNAVAILABLE, "prompt_review_not_configured",
                "AI agent prompts are disabled; ask the administrator to configure prompt_review in hub.json", true));
        }
    }
    Ok(HubMessage::AiAgentRequest {
        req_id: req_id.to_owned(),
        op: validated.op,
        backend: Some(backend),
        target: validated.target,
        text: validated.text,
        keys: validated.keys,
        lines: validated.lines,
        read_source: validated.read_source,
        wait: validated.wait,
        timeout_ms: validated.timeout_ms,
    })
}

#[derive(Debug)]
struct ValidatedBody {
    op: AiAgentOp,
    backend: Option<String>,
    target: Option<String>,
    text: Option<String>,
    keys: Vec<String>,
    lines: Option<u32>,
    read_source: Option<AiAgentReadSource>,
    wait: bool,
    timeout_ms: Option<u64>,
}

fn validate_body(body: AiAgentBody) -> Result<ValidatedBody, &'static str> {
    if body
        .backend
        .as_deref()
        .is_some_and(|kind| !valid_backend_kind(kind))
    {
        return Err("Backend kind must contain 1–32 lowercase letters, digits, underscores, or hyphens");
    }
    let backend = body.backend;
    let target = match body.target {
        Some(t) => {
            let t = t.trim().to_string();
            if t.is_empty() {
                None
            } else {
                validate_target(&t)?;
                Some(t)
            }
        }
        None => None,
    };
    let text = body
        .text
        .as_deref()
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(|t| t.to_string());
    let keys = if body.op == AiAgentOp::SendKeys {
        validate_keys(&body.keys)?
    } else if !body.keys.is_empty() {
        return Err("keys are only valid for send_keys");
    } else {
        Vec::new()
    };
    match body.op {
        AiAgentOp::Status => {
            if target.is_some() || text.is_some() {
                return Err("status does not take a target or text");
            }
        }
        AiAgentOp::Read | AiAgentOp::Prompt | AiAgentOp::SendKeys => {
            if target.is_none() {
                return Err("target is required");
            }
        }
    }
    if body.op == AiAgentOp::Prompt {
        validate_prompt_text(text.as_deref().unwrap_or(""))?;
    }
    if body.read_source.is_some() && body.op != AiAgentOp::Read {
        return Err("read_source is only valid for read");
    }
    if body.wait && body.op != AiAgentOp::Prompt {
        return Err("wait is only valid for prompt");
    }
    Ok(ValidatedBody {
        op: body.op,
        backend,
        target,
        text,
        keys,
        lines: Some(clamp_lines(body.lines)),
        read_source: body.read_source,
        wait: body.wait,
        timeout_ms: body.timeout_ms,
    })
}

fn hub_timeout_for(op: AiAgentOp, wait: bool, wait_ms: u64) -> Duration {
    match op {
        AiAgentOp::Status => Duration::from_secs(12),
        AiAgentOp::Read => Duration::from_secs(25),
        AiAgentOp::SendKeys => Duration::from_secs(15),
        AiAgentOp::Prompt if wait => Duration::from_millis(wait_ms + 8_000),
        AiAgentOp::Prompt => Duration::from_secs(20),
    }
}

fn http_for_ai_agents_error(error: &str) -> (StatusCode, &'static str) {
    let code = error.split(':').next().unwrap_or(error);
    match code {
        "ai_agent_backend_changed" => (StatusCode::CONFLICT, "ai_agent_backend_changed"),
        "ai_agent_backend_not_detected" => {
            (StatusCode::SERVICE_UNAVAILABLE, "ai_agent_backend_not_detected")
        }
        "ai_agent_backend_unavailable" => (StatusCode::SERVICE_UNAVAILABLE, "ai_agent_backend_unavailable"),
        "ai_agent_key_unsupported" => (StatusCode::UNPROCESSABLE_ENTITY, "ai_agent_key_unsupported"),
        "ai_agent_backend_incompatible" => (StatusCode::BAD_GATEWAY, "ai_agent_backend_incompatible"),
        "ai_agent_timeout" => (StatusCode::GATEWAY_TIMEOUT, "ai_agent_timeout"),
        "ai_agent_blocked" => (StatusCode::CONFLICT, "ai_agent_blocked"),
        "ai_agent_missing" => (StatusCode::NOT_FOUND, "ai_agent_missing"),
        "ai_agent_not_ready" => (StatusCode::CONFLICT, "ai_agent_not_ready"),
        "ai_agent_not_idle" => (StatusCode::CONFLICT, "ai_agent_not_idle"),
        "agent_busy" => (StatusCode::TOO_MANY_REQUESTS, "agent_busy"),
        "invalid_request" => (StatusCode::BAD_REQUEST, "invalid_request"),
        "cancelled" => (StatusCode::CONFLICT, "cancelled"),
        _ => (StatusCode::BAD_GATEWAY, "ai_agent_failed"),
    }
}

fn human_ai_agents_error(error: &str) -> &'static str {
    match error.split(':').next().unwrap_or(error) {
        "ai_agent_backend_changed" => "The AI agent backend changed on this Agent. Refresh and retry.",
        "ai_agent_backend_not_detected" => "The selected AI agent backend is not detected on this Agent. Install it or choose another backend in Settings.",
        "ai_agent_backend_unavailable" => "The AI agent backend is installed but the server is not running on this backend",
        "ai_agent_key_unsupported" => "This AI agent backend does not support that key.",
        "ai_agent_backend_incompatible" => "The AI agent backend returned an incompatible response. Update its CLI and restart the AI agent backend with a matching version.",
        "ai_agent_timeout" => "The AI agent command timed out",
        "ai_agent_blocked" => "That agent is waiting for an approval. Inspect the output, then send a key.",
        "ai_agent_missing" => "That AI agent is no longer running",
        "ai_agent_not_ready" => "The agent did not become ready in time. Read the output before retrying.",
        "ai_agent_not_idle" => "That agent is busy, so its latest output could not be read. Retry in a moment.",
        "agent_busy" => "Another AI agent command is already running on this backend",
        "invalid_request" => "Invalid AI agent request",
        "cancelled" => "AI agent command was cancelled",
        _ => "The AI agent command failed",
    }
}

fn error_response(status: StatusCode, error: &str, message: &str, retryable: bool) -> Response {
    (
        status,
        Json(serde_json::json!({
            "error": error,
            "message": message,
            "retryable": retryable,
        })),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn state_with_ai_agents_settings(
        settings: filebox_protocol::resources::AiAgentSettings,
        active_backend: &str,
    ) -> (AppState, tokio::sync::mpsc::Receiver<HubMessage>, u64) {
        let state = AppState::new(
            &crate::config::HubConfig {
                prompt_review_mode: crate::prompt_review::ReviewMode::Disabled,
                prompt_review: None,
                listen_addr: "127.0.0.1:0".parse().unwrap(),
                agent_token_hash: "fake".into(),
                users: vec![],
            },
            false,
        );
        let (sender, receiver) = tokio::sync::mpsc::channel(8);
        let mut capabilities = filebox_protocol::resources::Capabilities::default();
        capabilities.ai_agents = Some(filebox_protocol::resources::AiAgentsCapability {
            available: active_backend == "herdr",
            backend: Some(active_backend.into()),
            version: (active_backend == "herdr").then(|| "0.9.5".into()),
            backends: vec![filebox_protocol::resources::AiAgentBackendInfo {
                kind: "herdr".into(),
                version: "0.9.5".into(),
            }],
            settings,
        });
        let connection_id = {
            let mut inner = state.inner.write().await;
            inner.agents.register(
                "agent".into(),
                "agent".into(),
                sender,
                std::sync::Arc::new(tokio::sync::Notify::new()),
                0,
                vec![],
                0,
                vec![],
                capabilities,
                None,
            );
            inner.agents.get("agent").unwrap().connection_id
        };
        (state, receiver, connection_id)
    }

    #[test]
    fn backend_kind_validation_matches_the_settings_contract() {
        for kind in ["a", "backend-1", "agent_backend"] {
            assert!(valid_backend_kind(kind));
        }
        for kind in ["", "A", "bad value", "x".repeat(33).as_str()] {
            assert!(!valid_backend_kind(kind));
        }
        assert_eq!(http_for_ai_agents_error("invalid_request").0, StatusCode::BAD_REQUEST);
    }

    #[test]
    fn settings_environment_locks_are_checked_per_field() {
        let settings = filebox_protocol::resources::AiAgentSettings {
            enabled: true,
            environment_override: Some(true),
            backend: Some("herdr".into()),
            backend_environment_override: Some("herdr".into()),
        };
        assert_eq!(settings_override_mismatches(&settings, true, &Some("herdr".into())), (false, false));
        assert_eq!(settings_override_mismatches(&settings, false, &Some("herdr".into())), (true, false));
        assert_eq!(settings_override_mismatches(&settings, true, &None), (false, true));
    }

    #[tokio::test]
    async fn invalid_backend_setting_returns_bad_request() {
        let (state, _receiver, _) = state_with_ai_agents_settings(
            filebox_protocol::resources::AiAgentSettings {
                enabled: true,
                environment_override: None,
                backend: None,
                backend_environment_override: None,
            },
            "herdr",
        )
        .await;
        let response = ai_agents_settings_handler(
            State(state),
            Extension(AuthenticatedSession { id: "s".into(), principal_id: "p".into() }),
            Path("agent".into()),
            Json(AiAgentsSettingsBody { enabled: true, backend: Some("Bad Kind".into()) }),
        ).await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let body = axum::body::to_bytes(response.into_body(), 4096).await.unwrap();
        let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["error"], "invalid_request");
    }

    #[tokio::test]
    async fn ai_agent_request_rejects_invalid_and_stale_backends_before_forwarding() {
        let (state, mut receiver, _) = state_with_ai_agents_settings(
            filebox_protocol::resources::AiAgentSettings {
                enabled: true,
                environment_override: None,
                backend: Some("herdr".into()),
                backend_environment_override: None,
            },
            "herdr",
        )
        .await;
        let invalid = ai_agents_handler(
            State(state.clone()),
            Extension(AuthenticatedSession { id: "s".into(), principal_id: "p".into() }),
            Path("agent".into()),
            Json(AiAgentBody {
                op: AiAgentOp::Status,
                backend: Some("Not-valid".into()),
                target: None,
                text: None,
                keys: Vec::new(),
                lines: None,
                read_source: None,
                wait: false,
                timeout_ms: None,
            }),
        )
        .await;
        assert_eq!(invalid.status(), StatusCode::BAD_REQUEST);
        let body: serde_json::Value =
            serde_json::from_slice(&axum::body::to_bytes(invalid.into_body(), 4096).await.unwrap())
                .unwrap();
        assert_eq!(body["error"], "invalid_request");

        let stale = ai_agents_handler(
            State(state),
            Extension(AuthenticatedSession { id: "s".into(), principal_id: "p".into() }),
            Path("agent".into()),
            Json(AiAgentBody {
                op: AiAgentOp::Status,
                backend: Some("other".into()),
                target: None,
                text: None,
                keys: Vec::new(),
                lines: None,
                read_source: None,
                wait: false,
                timeout_ms: None,
            }),
        )
        .await;
        assert_eq!(stale.status(), StatusCode::CONFLICT);
        let body: serde_json::Value =
            serde_json::from_slice(&axum::body::to_bytes(stale.into_body(), 4096).await.unwrap())
                .unwrap();
        assert_eq!(body["error"], "ai_agent_backend_changed");
        assert!(receiver.try_recv().is_err());
    }

    #[tokio::test]
    async fn unknown_locked_backend_setting_is_forwarded_and_mismatches_conflict() {
        let (state, mut receiver, connection_id) = state_with_ai_agents_settings(
            filebox_protocol::resources::AiAgentSettings {
                enabled: true,
                environment_override: None,
                backend: Some("UNKNOWN".into()),
                backend_environment_override: Some("UNKNOWN".into()),
            },
            "UNKNOWN",
        )
        .await;
        let request_state = state.clone();
        let request = tokio::spawn(async move {
            ai_agents_settings_handler(
                State(request_state),
                Extension(AuthenticatedSession { id: "s".into(), principal_id: "p".into() }),
                Path("agent".into()),
                Json(AiAgentsSettingsBody { enabled: false, backend: Some("UNKNOWN".into()) }),
            )
            .await
        });
        let Some(HubMessage::AiAgentSettingsSet { enabled, backend, .. }) = receiver.recv().await else {
            panic!("expected AI Agents settings message");
        };
        assert!(!enabled);
        assert_eq!(backend.as_deref(), Some("UNKNOWN"));
        state.fail_pending_for_connection("agent", connection_id).await;
        let _ = request.await.unwrap();

        let response = ai_agents_settings_handler(
            State(state),
            Extension(AuthenticatedSession { id: "s".into(), principal_id: "p".into() }),
            Path("agent".into()),
            Json(AiAgentsSettingsBody { enabled: false, backend: Some("herdr".into()) }),
        )
        .await;
        assert_eq!(response.status(), StatusCode::CONFLICT);
        let body = axum::body::to_bytes(response.into_body(), 4096).await.unwrap();
        let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["error"], "ai_agents_environment_override");
    }

    #[tokio::test]
    async fn unlocked_backend_setting_is_forwarded_when_enabled_is_locked() {
        let state = AppState::new(
            &crate::config::HubConfig {
                prompt_review_mode: crate::prompt_review::ReviewMode::Disabled,
                prompt_review: None,
                listen_addr: "127.0.0.1:0".parse().unwrap(),
                agent_token_hash: "fake".into(),
                users: vec![],
            },
            false,
        );
        let (sender, mut receiver) = tokio::sync::mpsc::channel(8);
        let mut capabilities = filebox_protocol::resources::Capabilities::default();
        capabilities.ai_agents = Some(filebox_protocol::resources::AiAgentsCapability {
            available: true,
            backend: Some("herdr".into()),
            version: Some("0.9.5".into()),
            backends: vec![filebox_protocol::resources::AiAgentBackendInfo {
                kind: "herdr".into(),
                version: "0.9.5".into(),
            }],
            settings: filebox_protocol::resources::AiAgentSettings {
                enabled: true,
                environment_override: Some(true),
                backend: None,
                backend_environment_override: None,
            },
        });
        let connection_id = {
            let mut inner = state.inner.write().await;
            inner.agents.register(
                "agent".into(), "agent".into(), sender,
                std::sync::Arc::new(tokio::sync::Notify::new()), 0, vec![], 0, vec![],
                capabilities, None,
            );
            inner.agents.get("agent").unwrap().connection_id
        };
        let request_state = state.clone();
        let request = tokio::spawn(async move {
            ai_agents_settings_handler(
                State(request_state),
                Extension(AuthenticatedSession { id: "s".into(), principal_id: "p".into() }),
                Path("agent".into()),
                Json(AiAgentsSettingsBody { enabled: true, backend: Some("herdr".into()) }),
            ).await
        });
        let Some(HubMessage::AiAgentSettingsSet { enabled, backend, .. }) = receiver.recv().await else {
            panic!("expected AI Agents settings message");
        };
        assert!(enabled);
        assert_eq!(backend.as_deref(), Some("herdr"));
        state.fail_pending_for_connection("agent", connection_id).await;
        let _ = request.await.unwrap();
    }

    #[tokio::test]
    async fn prompt_review_gates_agent_relay() {
        for (decision, expected, relay) in [
            ("block", StatusCode::FORBIDDEN, false),
            ("allow", StatusCode::OK, true),
            ("down", StatusCode::SERVICE_UNAVAILABLE, false),
            ("garbage", StatusCode::SERVICE_UNAVAILABLE, false),
            ("unconfigured", StatusCode::SERVICE_UNAVAILABLE, false),
            ("off", StatusCode::OK, true),
            ("read_error", StatusCode::OK, true),
            ("read_empty", StatusCode::OK, true),
            ("read_busy", StatusCode::OK, true),
            ("yes", StatusCode::FORBIDDEN, false),
        ] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            let calls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let mock_calls = calls.clone();
            let app = axum::Router::new().route("/chat/completions", axum::routing::post(move |headers: axum::http::HeaderMap, Json(body): Json<serde_json::Value>| async move {
                mock_calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                assert_eq!(headers["authorization"], "Bearer test-key");
                assert_eq!(body["model"], "deepseek-flash");
                let context = match decision {
                    "read_error" | "read_empty" => "[Window context unavailable]",
                    "yes" => "Shall I run rm -rf /home/data?",
                    _ => "Current window output",
                };
                let prompt = if decision == "yes" { "yes" } else { "Analyze the data" };
                assert_eq!(body["messages"][1]["content"], format!("<<<CONTEXT\n{context}\nCONTEXT>>>\n\n<<<PROMPT\n{prompt}\nPROMPT>>>"));
                if decision == "down" { return StatusCode::BAD_GATEWAY.into_response(); }
                let verdict = match decision { "read_error" | "read_empty" | "read_busy" => "allow", "yes" => "block", _ => decision };
                Json(serde_json::json!({"choices":[{"message":{"content":serde_json::json!({"decision":verdict,"category":"test","reason":"Review reason."}).to_string()}}]})).into_response()
            }));
            let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
            let mut review: crate::prompt_review::PromptReviewConfig = serde_json::from_value(serde_json::json!({
                "protocol":"chat_completions", "base_url":format!("http://{addr}"), "api_key":"test-key"
            })).unwrap();
            review.validate().unwrap();
            let state = AppState::new(&crate::config::HubConfig {
                prompt_review_mode: if decision == "off" { crate::prompt_review::ReviewMode::Disabled } else { crate::prompt_review::ReviewMode::Mandatory },
                prompt_review: if decision == "unconfigured" { None } else { Some(review) }, listen_addr: "127.0.0.1:0".parse().unwrap(),
                agent_token_hash: "fake".into(), users: vec![],
            }, false);
            let (sender, mut receiver) = tokio::sync::mpsc::channel(8);
            let capabilities = filebox_protocol::resources::Capabilities { ai_agents: Some(filebox_protocol::resources::AiAgentsCapability { available: true, backend: Some("herdr".into()), version: None, backends: vec![filebox_protocol::resources::AiAgentBackendInfo { kind: "herdr".into(), version: "0.9.5".into() }], settings: filebox_protocol::resources::AiAgentSettings { enabled: true, environment_override: None, backend: None, backend_environment_override: None } }), ..Default::default() };
            state.inner.write().await.agents.register("a".into(), "agent".into(), sender,
                std::sync::Arc::new(tokio::sync::Notify::new()), 0, vec![], 0, vec![], capabilities, None);
            let request_state = state.clone();
            let request = tokio::spawn(async move {
                ai_agents_handler(State(request_state), Extension(AuthenticatedSession {
                    id: "session".into(), principal_id: "principal".into(),
                }), Path("a".into()), Json(serde_json::from_value(serde_json::json!({
                    "op":"prompt", "target":"reviewer", "text":if decision == "yes" { " yes " } else { "  Analyze the data  " },
                    "context":"Browser context must not be used"
                })).unwrap())).await
            });
            if !matches!(decision, "off" | "unconfigured") {
                let attempts = if decision == "read_busy" { 2 } else { 1 };
                for attempt in 0..attempts {
                    let msg = tokio::time::timeout(Duration::from_secs(3), receiver.recv()).await.unwrap().unwrap();
                    let HubMessage::AiAgentRequest { req_id, op, backend, target, text, keys, lines, read_source, wait, .. } = msg else { panic!("expected context Read") };
                    assert_eq!(op, AiAgentOp::Read);
                    assert_eq!(backend.as_deref(), Some("herdr"));
                    assert_eq!(target.as_deref(), Some("reviewer"));
                    assert!(text.is_none() && keys.is_empty() && !wait);
                    assert_eq!(lines, Some(120));
                    assert_eq!(read_source, Some(AiAgentReadSource::Bottom));
                    let value = match decision {
                        "read_busy" if attempt == 0 => serde_json::json!({"error":"agent_busy"}),
                        "read_error" => serde_json::json!({"error":"ai_agent_timeout"}),
                        "read_empty" => serde_json::json!({"output":"\u{1b}[0m\n"}),
                        "yes" => serde_json::json!({"output":"Shall I run rm -rf /home/data?"}),
                        _ => serde_json::json!({"output":"\u{1b}[32mCurrent window output\u{1b}[0m"}),
                    };
                    let inner = state.inner.read().await;
                    inner.pending_responses.write().await.remove(&req_id).unwrap().deliver(value);
                }
            }
            if relay {
                let msg = tokio::time::timeout(Duration::from_secs(3), receiver.recv()).await.unwrap().unwrap();
                let HubMessage::AiAgentRequest { req_id, backend, text, .. } = msg else { panic!("expected AI agent request") };
                assert_eq!(backend.as_deref(), Some("herdr"));
                assert_eq!(text.as_deref(), Some("Analyze the data"));
                let inner = state.inner.read().await;
                inner.pending_responses.write().await.remove(&req_id).unwrap().deliver(serde_json::json!({"ok":true}));
            }
            let response = request.await.unwrap();
            assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), usize::from(!matches!(decision, "off" | "unconfigured")));
            assert_eq!(response.status(), expected);
            if !relay {
                assert!(receiver.try_recv().is_err());
                let bytes = axum::body::to_bytes(response.into_body(), 4096).await.unwrap();
                let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
                assert_eq!(body["retryable"], !matches!(decision, "block" | "yes"));
                assert_eq!(body["error"], match decision { "block" | "yes" => "ai_agent_prompt_blocked", "unconfigured" => "prompt_review_not_configured", _ => "prompt_review_unavailable" });
                if matches!(decision, "block" | "yes") { assert!(body["message"].as_str().unwrap().contains("Review reason.")); }
            }
            server.abort();
        }
    }

    #[tokio::test]
    async fn status_reports_prompt_review_state() {
        for (mode, configured, expected) in [
            (crate::prompt_review::ReviewMode::Mandatory, true, serde_json::json!({"state":"on","model":"deepseek-flash"})),
            (crate::prompt_review::ReviewMode::Mandatory, false, serde_json::json!({"state":"not_configured"})),
            (crate::prompt_review::ReviewMode::Disabled, true, serde_json::json!({"state":"off"})),
        ] {
            let mut review: crate::prompt_review::PromptReviewConfig = serde_json::from_value(serde_json::json!({
                "protocol":"chat_completions", "base_url":"http://127.0.0.1:9", "api_key":"test-key"
            })).unwrap();
            review.validate().unwrap();
            let state = AppState::new(&crate::config::HubConfig {
                prompt_review_mode: mode,
                prompt_review: configured.then_some(review), listen_addr: "127.0.0.1:0".parse().unwrap(),
                agent_token_hash: "fake".into(), users: vec![],
            }, false);
            let (sender, mut receiver) = tokio::sync::mpsc::channel(8);
            let capabilities = filebox_protocol::resources::Capabilities { ai_agents: Some(filebox_protocol::resources::AiAgentsCapability { available: true, backend: Some("herdr".into()), version: None, backends: vec![filebox_protocol::resources::AiAgentBackendInfo { kind: "herdr".into(), version: "0.9.5".into() }], settings: filebox_protocol::resources::AiAgentSettings { enabled: true, environment_override: None, backend: None, backend_environment_override: None } }), ..Default::default() };
            state.inner.write().await.agents.register("a".into(), "agent".into(), sender,
                std::sync::Arc::new(tokio::sync::Notify::new()), 0, vec![], 0, vec![], capabilities, None);
            let request_state = state.clone();
            let request = tokio::spawn(async move {
                ai_agents_handler(State(request_state), Extension(AuthenticatedSession {
                    id: "session".into(), principal_id: "principal".into(),
                }), Path("a".into()), Json(serde_json::from_value(serde_json::json!({"op":"status"})).unwrap())).await
            });
            let msg = tokio::time::timeout(Duration::from_secs(3), receiver.recv()).await.unwrap().unwrap();
            let HubMessage::AiAgentRequest { req_id, op, backend, .. } = msg else { panic!("expected AI agent request") };
            assert_eq!(op, AiAgentOp::Status);
            assert_eq!(backend.as_deref(), Some("herdr"));
            state.inner.read().await.pending_responses.write().await.remove(&req_id).unwrap()
                .deliver(serde_json::json!({"agents":[]}));
            let response = request.await.unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            let body: serde_json::Value = serde_json::from_slice(&axum::body::to_bytes(response.into_body(), 4096).await.unwrap()).unwrap();
            assert_eq!(body["prompt_review"], expected);
        }
    }

    #[test]
    fn review_context_strips_terminal_controls_and_keeps_utf8_tail() {
        assert_eq!(clean_context("\u{1b}[31mhello\u{1b}[0m\r\0\u{7}\tworld\n"), Some("hello\tworld".into()));
        assert_eq!(clean_context("\u{1b}]0;window title\u{7}shown\u{1b}]8;;url\u{1b}\\link\u{1b}]8;;\u{1b}\\"), Some("shownlink".into()));
        assert_eq!(clean_context("\u{1b}[0m\n\t"), None);
        assert_eq!(clean_context(""), None);
        let input = format!("old prefix{}tail", "中".repeat(10_000));
        let tail = clean_context(&input).unwrap();
        assert!(tail.len() <= 16 * 1024);
        assert!(tail.ends_with("tail"));
        assert!(!tail.contains("old prefix") && !tail.contains('\u{fffd}'));
    }

    #[tokio::test]
    async fn ai_agents_disconnect_returns_retryable_backend_offline() {
        use filebox_protocol::resources::{Capabilities, AiAgentsCapability};
        use tokio::sync::mpsc;

        let config = crate::config::HubConfig {
            prompt_review_mode: crate::prompt_review::ReviewMode::Mandatory,
            prompt_review: None,
            listen_addr: "127.0.0.1:0".parse().unwrap(),
            agent_token_hash: "fake-hash".to_string(),
            users: vec![],
        };
        let state = AppState::new(&config, false);
        let (sender, mut receiver) = mpsc::channel(8);
        let mut capabilities = Capabilities::default();
        capabilities.ai_agents = Some(AiAgentsCapability {
            available: true,
            backend: Some("herdr".into()),
            version: None,
            backends: vec![filebox_protocol::resources::AiAgentBackendInfo {
                kind: "herdr".into(),
                version: "0.9.5".into(),
            }],
            settings: filebox_protocol::resources::AiAgentSettings {
                enabled: true,
                environment_override: None,
                backend: None,
                backend_environment_override: None,
            },
        });
        let connection_id = {
            let mut inner = state.inner.write().await;
            inner.agents.register(
                "a".to_string(),
                "agent".to_string(),
                sender,
                std::sync::Arc::new(tokio::sync::Notify::new()),
                0,
                vec![],
                0,
                vec![],
                capabilities,
                None,
            );
            inner.agents.get("a").unwrap().connection_id
        };

        let request_state = state.clone();
        let request = tokio::spawn(async move {
            ai_agents_settings_handler(
                State(request_state),
                Extension(AuthenticatedSession {
                    id: "session".to_string(),
                    principal_id: "principal".to_string(),
                }),
                Path("a".to_string()),
                Json(AiAgentsSettingsBody { enabled: false, backend: None }),
            )
            .await
        });

        assert!(matches!(
            receiver.recv().await,
            Some(HubMessage::AiAgentSettingsSet { .. })
        ));
        assert_eq!(state.fail_pending_for_connection("a", connection_id).await, 1);

        let response = request.await.unwrap();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        let body = axum::body::to_bytes(response.into_body(), 4096)
            .await
            .unwrap();
        let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["error"], "backend_offline");
        assert_eq!(body["retryable"], true);
    }

    #[test]
    fn read_source_is_optional_and_read_only() {
        for source in [None, Some("visible"), Some("bottom")] {
            let mut body = serde_json::json!({"op": "read", "target": "w1:p1"});
            if let Some(source) = source { body["read_source"] = source.into(); }
            assert!(validate_body(serde_json::from_value(body).unwrap()).is_ok());
        }
        assert!(validate_body(serde_json::from_value(serde_json::json!({
            "op": "status", "read_source": "bottom"
        })).unwrap()).is_err());
        assert!(serde_json::from_value::<AiAgentBody>(serde_json::json!({
            "op": "read", "target": "w1:p1", "read_source": "detection"
        })).is_err());
        assert_eq!(http_for_ai_agents_error("ai_agent_key_unsupported").0,
            StatusCode::UNPROCESSABLE_ENTITY);
    }

    #[test]
    fn incompatible_cli_is_distinct_from_an_unavailable_server() {
        assert_eq!(http_for_ai_agents_error("ai_agent_backend_incompatible"),
            (StatusCode::BAD_GATEWAY, "ai_agent_backend_incompatible"));
        assert_eq!(http_for_ai_agents_error("ai_agent_backend_unavailable"),
            (StatusCode::SERVICE_UNAVAILABLE, "ai_agent_backend_unavailable"));
        assert_eq!(http_for_ai_agents_error("ai_agent_backend_not_detected"),
            (StatusCode::SERVICE_UNAVAILABLE, "ai_agent_backend_not_detected"));
        assert_eq!(http_for_ai_agents_error("ai_agent_backend_changed"),
            (StatusCode::CONFLICT, "ai_agent_backend_changed"));
        assert!(human_ai_agents_error("ai_agent_backend_incompatible").contains("matching version"));
        assert_eq!(
            human_ai_agents_error("ai_agent_key_unsupported"),
            "This AI agent backend does not support that key."
        );
        assert_eq!(
            human_ai_agents_error("ai_agent_backend_changed"),
            "The AI agent backend changed on this Agent. Refresh and retry."
        );
        assert_eq!(
            human_ai_agents_error("ai_agent_backend_not_detected"),
            "The selected AI agent backend is not detected on this Agent. Install it or choose another backend in Settings."
        );
    }

    #[test]
    fn status_rejects_target() {
        let err = validate_body(AiAgentBody {
            op: AiAgentOp::Status,
            backend: None,
            target: Some("w1:p1".into()),
            text: None,
            keys: Vec::new(),
            lines: None,
            read_source: None,
            wait: false,
            timeout_ms: None,
        })
        .unwrap_err();
        assert!(err.contains("status"));
    }

    #[test]
    fn prompt_requires_text_and_target() {
        assert!(validate_body(AiAgentBody {
            op: AiAgentOp::Prompt,
            backend: None,
            target: Some("reviewer".into()),
            text: Some("look at this".into()),
            keys: Vec::new(),
            lines: None,
            read_source: None,
            wait: false,
            timeout_ms: None,
        })
        .is_ok());
        assert!(validate_body(AiAgentBody {
            op: AiAgentOp::Prompt,
            backend: None,
            target: None,
            text: Some("x".into()),
            keys: Vec::new(),
            lines: None,
            read_source: None,
            wait: false,
            timeout_ms: None,
        })
        .is_err());
    }

    #[test]
    fn send_keys_allowlist() {
        assert!(validate_body(AiAgentBody {
            op: AiAgentOp::SendKeys,
            backend: None,
            target: Some("w1:p1".into()),
            text: None,
            keys: vec!["esc".into(), "enter".into()],
            lines: None,
            read_source: None,
            wait: false,
            timeout_ms: None,
        })
        .is_ok());
        assert!(validate_body(AiAgentBody {
            op: AiAgentOp::SendKeys,
            backend: None,
            target: Some("w1:p1".into()),
            text: None,
            keys: vec!["rm -rf".into()],
            lines: None,
            read_source: None,
            wait: false,
            timeout_ms: None,
        })
        .is_err());
    }
}
