use super::*;
use serde::Deserialize;

pub(super) async fn dispatch(context: &AgentContext, text: &str) {
    // Parse JSON once. Forward response values intact, including extension
    // fields used by rolling-upgrade peers. File bytes are decoded only by the
    // actual HTTP consumer, avoiding a redundant large base64 decode here.
    let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else { return; };
    if value["type"] == "file_chunk" {
        if valid_file_chunk(&value) {
            deliver_response(context, value).await;
        }
        return;
    }
    let Ok(message) = AgentMessage::deserialize(&value) else {
        // Never log raw text: an unexpected Auth can contain a token.
        tracing::debug!(agent_id = %context.agent_id, bytes = text.len(), "Invalid agent message");
        return;
    };
    match message {
        AgentMessage::Pong | AgentMessage::Heartbeat => {
            context.state.inner.write().await.agents.record_pong_for_connection(
                &context.agent_id, context.connection_id,
            );
        }
        message @ (AgentMessage::ResourcesApplied { .. }
        | AgentMessage::ResourcesRejected { .. }
        | AgentMessage::ResourcesUpdated { .. }
        | AgentMessage::CollectionsApplied { .. }
        | AgentMessage::CollectionsRejected { .. }
        | AgentMessage::CollectionsUpdated { .. }) => updates::dispatch(context, message).await,
        message @ (AgentMessage::TerminalOpened { .. }
        | AgentMessage::TerminalOutput { .. }
        | AgentMessage::TerminalInputAck { .. }
        | AgentMessage::TerminalClosed { .. }) => {
            let inner = context.state.inner.read().await;
            if inner.agents.is_current_connection(&context.agent_id, context.connection_id) {
                terminal::dispatch(context, message);
            }
        }
        AgentMessage::FsListResponse { .. }
        | AgentMessage::FsStatResponse { .. }
        | AgentMessage::SysStatsResponse { .. }
        | AgentMessage::WorkspaceSearchResponse { .. }
        | AgentMessage::OfficeConvertResponse { .. }
        | AgentMessage::TempUploadResponse { .. }
        | AgentMessage::TempCleanupResponse { .. }
        | AgentMessage::TerminalListResponse { .. } => deliver_response(context, value).await,
        AgentMessage::Progress { req_id, phase, processed, total, message } => {
            let inner = context.state.inner.write().await;
            if !inner.agents.is_current_connection(&context.agent_id, context.connection_id) {
                return;
            }
            // Ignore late progress from cancelled/finished jobs. A stale Office
            // request id must not update a newer request after a reconnect.
            let owned = inner.pending_responses.read().await.get(&req_id).is_some_and(|p| {
                p.agent_id == context.agent_id && p.connection_id == context.connection_id
            });
            if owned {
                AppState::emit_sse_locked(&inner, "progress", serde_json::json!({
                    "req_id": req_id, "phase": phase, "processed": processed,
                    "total": total, "message": message,
                })).await;
            }
        }
        AgentMessage::Auth { .. } | AgentMessage::Register { .. } => {
            tracing::debug!(agent_id = %context.agent_id, "Ignoring post-handshake Auth/Register");
        }
        AgentMessage::FileChunk { .. } => unreachable!("file chunks use the wire-value path"),
    }
}

async fn deliver_response(context: &AgentContext, value: serde_json::Value) {
    let Some(req_id) = value["req_id"].as_str() else { return; };
    if let Some(pending) = responses::take_pending_for_connection(context, req_id).await {
        pending.deliver(value);
    }
}

fn valid_file_chunk(value: &serde_json::Value) -> bool {
    let optional = |name: &str, valid: fn(&serde_json::Value) -> bool| {
        value.get(name).is_none_or(|v| v.is_null() || valid(v))
    };
    value["req_id"].is_string() && value["offset"].as_u64().is_some()
        && value["done"].is_boolean()
        && optional("error", serde_json::Value::is_string)
        && optional("file_size", |v| v.as_u64().is_some())
        && optional("modified", serde_json::Value::is_string)
        && (value["data"].is_string() || value["data"].as_array().is_some_and(|items| {
            items.iter().all(|v| v.as_u64().is_some_and(|n| n <= u8::MAX as u64))
        }))
}
