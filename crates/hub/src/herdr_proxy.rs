//! Relay a small whitelist of Herdr CLI commands to a connected agent.

use crate::agent_requests::{cleanup_pending, PendingResponseCleanup};
use std::time::Duration;

use axum::extract::{Extension, Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use filebox_protocol::herdr::{
    clamp_lines, clamp_wait_timeout_ms, validate_keys, validate_prompt_text, validate_target,
    HerdrOp, HerdrReadSource,
};
use filebox_protocol::message::HubMessage;
use serde::Deserialize;
use uuid::Uuid;

use crate::state::{AppState, AuthenticatedSession, PendingResponse, MAX_PENDING_RESPONSES};

#[derive(Debug, Deserialize)]
pub struct HerdrBody {
    pub op: HerdrOp,
    #[serde(default)]
    pub target: Option<String>,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub keys: Vec<String>,
    #[serde(default)]
    pub lines: Option<u32>,
    #[serde(default)]
    pub read_source: Option<HerdrReadSource>,
    #[serde(default)]
    pub wait: bool,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

pub async fn herdr_handler(
    State(state): State<AppState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path(agent_id): Path<String>,
    Json(body): Json<HerdrBody>,
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

    if !agent.capabilities.herdr {
        return error_response(
            StatusCode::NOT_IMPLEMENTED,
            "unsupported",
            "Herdr is unavailable on this agent. Check its installation and FILEBOX_AGENT_HERDR_ENABLED, then restart the Filebox Agent",
            false,
        );
    }

    let req_id = format!("herdr_{}", Uuid::new_v4());
    let wait_ms = if validated.wait {
        clamp_wait_timeout_ms(validated.timeout_ms)
    } else {
        0
    };
    let hub_timeout = hub_timeout_for(validated.op, validated.wait, wait_ms);
    let msg = HubMessage::HerdrRequest {
        req_id: req_id.clone(),
        op: validated.op,
        target: validated.target,
        text: validated.text,
        keys: validated.keys,
        lines: validated.lines,
        read_source: validated.read_source,
        wait: validated.wait,
        timeout_ms: validated.timeout_ms,
    };

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
                    connection_id: agent.connection_id,
                    session_id: Some(session.principal_id.clone()),
                    desired_roots: None,
                    desired_collections: None,
                },
            );
            inner.agents.send_to_agent(&agent_id, msg)
        }
    };

    drop(inner);
    if !send_ok {
        cleanup_pending(&state, &req_id).await;
        return error_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "backend_offline",
            "Failed to send request to agent",
            true,
        );
    }

    let guard = PendingResponseCleanup::new(
        state.clone(),
        req_id.clone(),
        Some(agent_id.clone()),
        response_owner,
    );
    let resp = tokio::time::timeout(hub_timeout, resp_rx.recv()).await;
    guard.finish(!matches!(resp, Ok(Some(_)))).await;

    match resp {
        Ok(Some(value)) => {
            let cancelled = value.get("state").and_then(|v| v.as_str()) == Some("cancelled")
                || value.get("error").and_then(|v| v.as_str()) == Some("cancelled");
            if cancelled {
                return error_response(
                    StatusCode::CONFLICT,
                    "cancelled",
                    "Herdr command was cancelled",
                    true,
                );
            }
            if let Some(error) = value.get("error").and_then(|v| v.as_str()) {
                if !error.is_empty() && error != "null" {
                    let (status, code) = http_for_herdr_error(error);
                    return error_response(status, code, human_herdr_error(error), status != StatusCode::BAD_REQUEST && status != StatusCode::UNPROCESSABLE_ENTITY);
                }
            }
            Json(value).into_response()
        }
        _ => error_response(
            StatusCode::GATEWAY_TIMEOUT,
            "request_timeout",
            "Agent did not respond in time",
            true,
        ),
    }
}

#[derive(Debug)]
struct ValidatedBody {
    op: HerdrOp,
    target: Option<String>,
    text: Option<String>,
    keys: Vec<String>,
    lines: Option<u32>,
    read_source: Option<HerdrReadSource>,
    wait: bool,
    timeout_ms: Option<u64>,
}

fn validate_body(body: HerdrBody) -> Result<ValidatedBody, &'static str> {
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
    let keys = if body.op == HerdrOp::SendKeys {
        validate_keys(&body.keys)?
    } else if !body.keys.is_empty() {
        return Err("keys are only valid for send_keys");
    } else {
        Vec::new()
    };
    match body.op {
        HerdrOp::Status => {
            if target.is_some() || text.is_some() {
                return Err("status does not take a target or text");
            }
        }
        HerdrOp::Read | HerdrOp::Prompt | HerdrOp::SendKeys => {
            if target.is_none() {
                return Err("target is required");
            }
        }
    }
    if body.op == HerdrOp::Prompt {
        validate_prompt_text(text.as_deref().unwrap_or(""))?;
    }
    if body.read_source.is_some() && body.op != HerdrOp::Read {
        return Err("read_source is only valid for read");
    }
    if body.wait && body.op != HerdrOp::Prompt {
        return Err("wait is only valid for prompt");
    }
    Ok(ValidatedBody {
        op: body.op,
        target,
        text,
        keys,
        lines: Some(clamp_lines(body.lines)),
        read_source: body.read_source,
        wait: body.wait,
        timeout_ms: body.timeout_ms,
    })
}

fn hub_timeout_for(op: HerdrOp, wait: bool, wait_ms: u64) -> Duration {
    match op {
        HerdrOp::Status => Duration::from_secs(12),
        HerdrOp::Read => Duration::from_secs(25),
        HerdrOp::SendKeys => Duration::from_secs(15),
        HerdrOp::Prompt if wait => Duration::from_millis(wait_ms + 8_000),
        HerdrOp::Prompt => Duration::from_secs(20),
    }
}

fn http_for_herdr_error(error: &str) -> (StatusCode, &'static str) {
    let code = error.split(':').next().unwrap_or(error);
    match code {
        "herdr_unavailable" => (StatusCode::SERVICE_UNAVAILABLE, "herdr_unavailable"),
        "herdr_key_unsupported" => (StatusCode::UNPROCESSABLE_ENTITY, "herdr_key_unsupported"),
        "herdr_incompatible" => (StatusCode::BAD_GATEWAY, "herdr_incompatible"),
        "herdr_timeout" => (StatusCode::GATEWAY_TIMEOUT, "herdr_timeout"),
        "herdr_blocked" => (StatusCode::CONFLICT, "herdr_blocked"),
        "herdr_agent_missing" => (StatusCode::NOT_FOUND, "herdr_agent_missing"),
        "herdr_not_ready" => (StatusCode::CONFLICT, "herdr_not_ready"),
        "herdr_not_idle" => (StatusCode::CONFLICT, "herdr_not_idle"),
        "agent_busy" => (StatusCode::TOO_MANY_REQUESTS, "agent_busy"),
        "invalid_request" => (StatusCode::BAD_REQUEST, "invalid_request"),
        "cancelled" => (StatusCode::CONFLICT, "cancelled"),
        _ => (StatusCode::BAD_GATEWAY, "herdr_failed"),
    }
}

fn human_herdr_error(error: &str) -> &'static str {
    match error.split(':').next().unwrap_or(error) {
        "herdr_unavailable" => "Herdr is installed but the server is not running on this backend",
        "herdr_key_unsupported" => "This Herdr server does not support that key. Herdr v0.9.5 lacks Home, End, PageUp, PageDown and Delete; use a server build with navigation-key support.",
        "herdr_incompatible" => "Herdr returned an incompatible response. Update its CLI and restart the Herdr server with a matching version.",
        "herdr_timeout" => "The Herdr command timed out",
        "herdr_blocked" => "That agent is waiting for an approval. Inspect the output, then send a key.",
        "herdr_agent_missing" => "That Herdr agent is no longer running",
        "herdr_not_ready" => "The agent did not become ready in time. Read the output before retrying.",
        "herdr_not_idle" => "That agent is busy, so its latest output could not be read. Retry in a moment.",
        "agent_busy" => "Another Herdr command is already running on this backend",
        "invalid_request" => "Invalid Herdr request",
        "cancelled" => "Herdr command was cancelled",
        _ => "The Herdr command failed",
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

    #[test]
    fn read_source_is_optional_and_read_only() {
        for source in [None, Some("visible"), Some("detection")] {
            let mut body = serde_json::json!({"op": "read", "target": "w1:p1"});
            if let Some(source) = source { body["read_source"] = source.into(); }
            assert!(validate_body(serde_json::from_value(body).unwrap()).is_ok());
        }
        assert!(validate_body(serde_json::from_value(serde_json::json!({
            "op": "status", "read_source": "detection"
        })).unwrap()).is_err());
        assert!(serde_json::from_value::<HerdrBody>(serde_json::json!({
            "op": "read", "target": "w1:p1", "read_source": "arbitrary"
        })).is_err());
        assert_eq!(http_for_herdr_error("herdr_key_unsupported").0,
            StatusCode::UNPROCESSABLE_ENTITY);
    }

    #[test]
    fn incompatible_cli_is_distinct_from_an_unavailable_server() {
        assert_eq!(http_for_herdr_error("herdr_incompatible"),
            (StatusCode::BAD_GATEWAY, "herdr_incompatible"));
        assert_eq!(http_for_herdr_error("herdr_unavailable"),
            (StatusCode::SERVICE_UNAVAILABLE, "herdr_unavailable"));
        assert!(human_herdr_error("herdr_incompatible").contains("matching version"));
    }

    #[test]
    fn status_rejects_target() {
        let err = validate_body(HerdrBody {
            op: HerdrOp::Status,
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
        assert!(validate_body(HerdrBody {
            op: HerdrOp::Prompt,
            target: Some("reviewer".into()),
            text: Some("look at this".into()),
            keys: Vec::new(),
            lines: None,
            read_source: None,
            wait: false,
            timeout_ms: None,
        })
        .is_ok());
        assert!(validate_body(HerdrBody {
            op: HerdrOp::Prompt,
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
        assert!(validate_body(HerdrBody {
            op: HerdrOp::SendKeys,
            target: Some("w1:p1".into()),
            text: None,
            keys: vec!["esc".into(), "enter".into()],
            lines: None,
            read_source: None,
            wait: false,
            timeout_ms: None,
        })
        .is_ok());
        assert!(validate_body(HerdrBody {
            op: HerdrOp::SendKeys,
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
