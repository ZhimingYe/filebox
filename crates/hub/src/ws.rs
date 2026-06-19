use std::sync::Arc;
use std::time::Duration;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use futures_util::{SinkExt, StreamExt};
use tokio::sync::{mpsc, Notify};
use uuid::Uuid;

use filebox_protocol::message::{AgentMessage, HubMessage};
use filebox_protocol::resources::Capabilities;

use crate::net::client_ip;
use crate::state::{AppState, PendingResponse};

/// Per-write timeout for outbound WS frames. A half-open TCP can keep a
/// `ws_sink.send()` future pending for the OS's TCP timeout (~hours on
/// default Linux), stalling send_task forever. This bounds it so a dead
/// agent is detected via write blockage within seconds.
const WS_WRITE_TIMEOUT: Duration = Duration::from_secs(10);

/// Liveness timeout for inbound agent messages. Agent sends Heartbeat every
/// 15s, so 90s = 6 missed heartbeats. If we get nothing in this window the
/// TCP is silently dead (NAT expiry, half-open after sleep) and we close
/// the connection — without this the read loop would block on
/// ws_stream.next() for the OS's TCP timeout, leaking the fd. Matches the
/// Slow→Offline threshold in update_heartbeats so the registry view and
/// the actual socket close stay in sync.
const NO_AGENT_MESSAGE_TIMEOUT: Duration = Duration::from_secs(90);
// Agent FileChunk payloads are capped at 4MiB raw bytes and serialize as
// base64, so normal file chunks stay well below this. Keep a generous bound
// for protocol overhead and rolling upgrades while still capping hostile
// agent->hub messages.
const MAX_AGENT_WS_MESSAGE_SIZE: usize = 24 * 1024 * 1024;

pub async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
) -> Response {
    let ip = client_ip(&headers, addr);
    if let Err(remaining) = state.ws_rate_limiter.check(&ip) {
        tracing::warn!("Agent WS pre-auth rate limited for {} ({}s remaining)", ip, remaining);
        return StatusCode::TOO_MANY_REQUESTS.into_response();
    }

    // Count the pre-auth connection immediately so clients that never send
    // Auth still consume from a bounded budget. A valid token clears it below.
    state.ws_rate_limiter.record_failure(&ip);

    ws.max_message_size(MAX_AGENT_WS_MESSAGE_SIZE)
        .max_frame_size(MAX_AGENT_WS_MESSAGE_SIZE)
        .on_upgrade(|socket| handle_socket(socket, state, ip))
        .into_response()
}

async fn handle_socket(socket: WebSocket, state: AppState, client_ip: String) {
    let (mut ws_sink, mut ws_stream) = socket.split();

    let (tx, mut rx) = mpsc::unbounded_channel::<HubMessage>();
    let abort_notify = Arc::new(Notify::new());

    // Step 1: Wait for Auth
    let auth_msg = tokio::time::timeout(Duration::from_secs(10), ws_stream.next()).await;

    let token = match auth_msg {
        Ok(Some(Ok(Message::Text(text)))) => match serde_json::from_str::<AgentMessage>(&text) {
            Ok(AgentMessage::Auth { token }) => token,
            _ => {
                send_auth_fail(&mut ws_sink).await;
                return;
            }
        },
        _ => return,
    };

    // Validate agent token against bcrypt hash from config
    {
        let inner = state.inner.read().await;
        if !inner.sessions.validate_agent_token(&token) {
            tracing::warn!("Agent auth failed from {}: invalid token", client_ip);
            tracing::warn!(target: "audit", ip = %client_ip, "agent_auth_failed");
            send_auth_fail(&mut ws_sink).await;
            return;
        }
    }
    state.ws_rate_limiter.clear(&client_ip);

    let temp_id = Uuid::new_v4().to_string();

    // Send auth success (agent_id is temporary until Register)
    let auth_result = HubMessage::AuthResult {
        success: true,
        agent_id: Some(temp_id.clone()),
    };
    if ws_sink
        .send(Message::Text(
            serde_json::to_string(&auth_result).unwrap().into(),
        ))
        .await
        .is_err()
    {
        return;
    }

    // Step 2: Wait for Register
    let reg_msg = tokio::time::timeout(Duration::from_secs(10), ws_stream.next()).await;

    let (agent_id, name, resource_revision, roots, capabilities) = match reg_msg {
        Ok(Some(Ok(Message::Text(text)))) => match serde_json::from_str::<AgentMessage>(&text) {
            Ok(AgentMessage::Register {
                agent_id: Some(provided_id),
                name,
                resource_revision,
                roots,
                capabilities,
                ..
            }) => {
                // Use the agent's stable ID if provided
                let id = if provided_id.is_empty() {
                    temp_id.clone()
                } else {
                    provided_id
                };
                (id, name, resource_revision, roots, capabilities)
            }
            Ok(AgentMessage::Register {
                name,
                resource_revision,
                roots,
                capabilities,
                ..
            }) => (
                temp_id.clone(),
                name,
                resource_revision,
                roots,
                capabilities,
            ),
            _ => (
                temp_id.clone(),
                "unknown".to_string(),
                0,
                vec![],
                Capabilities::default(),
            ),
        },
        _ => (
            temp_id.clone(),
            "unknown".to_string(),
            0,
            vec![],
            Capabilities::default(),
        ),
    };

    tracing::info!("Agent registered: {} ({})", name, agent_id);
    tracing::info!(
        target: "audit",
        ip = %client_ip,
        agent_id = %agent_id,
        name = %name,
        "agent_registered"
    );

    // Emit SSE event for agent connection
    state.emit_sse("agent_connected", serde_json::json!({
        "agent_id": agent_id,
        "name": name,
    })).await;

    // Register in agent registry (replaces existing entry if agent reconnects)
    {
        let mut inner = state.inner.write().await;

        // If this agent_id already has a live connection, this is suspicious —
        // either the real agent is reconnecting after a brief network blip, or
        // someone with the shared token is trying to impersonate it. We allow
        // replacement (so real reconnects keep working) but log a warning so
        // operators can spot impersonation patterns.
        if let Some(existing) = inner.agents.get(&agent_id) {
            let since_heartbeat = existing.last_seen.elapsed().as_secs();
            tracing::warn!(
                "Agent {} re-registering while existing connection is {} (last heartbeat {}s ago, status={:?})",
                agent_id,
                if existing.status == crate::agent_registry::AgentStatus::Online {
                    "Online"
                } else {
                    "Offline"
                },
                since_heartbeat,
                existing.status
            );
            // Wake the old connection's read loop so it exits cleanly. Without
            // this, the old read loop would block on ws_stream.next() for the
            // OS's TCP timeout (~hours on default Linux), leaking an fd per
            // reconnect on a flaky network.
            existing.abort_notify.notify_one();
        }

        inner.agents.register(
            agent_id.clone(),
            name.clone(),
            tx.clone(),
            abort_notify.clone(),
            resource_revision,
            roots.clone(),
            capabilities,
        );

        // Send pending update if any
        if let Some(agent) = inner.agents.get(&agent_id) {
            if let Some(pending) = &agent.pending_update {
                if let Some(desired_revision) = agent.resource_revision.checked_add(1) {
                    let req_id = format!("pending_{}", Uuid::new_v4());
                    let _ = tx.send(HubMessage::ResourcesSetDesired {
                        req_id,
                        desired_revision,
                        roots: pending.roots.clone(),
                    });
                } else {
                    tracing::error!(
                        "Cannot send pending resource update to agent {}: revision overflow",
                        agent_id
                    );
                }
            }
        }
    }

    // Spawn task to forward channel messages to WebSocket. Each write is
    // bounded by WS_WRITE_TIMEOUT so a half-open agent TCP can't stall this
    // task indefinitely.
    let send_task = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            let text = serde_json::to_string(&msg).unwrap();
            let send_result = tokio::time::timeout(
                WS_WRITE_TIMEOUT,
                ws_sink.send(Message::Text(text.into())),
            )
            .await;
            match send_result {
                Ok(Ok(_)) => {}
                Ok(Err(_)) => break,
                Err(_) => {
                    tracing::warn!(
                        "WS write to agent timed out after {}s, closing connection",
                        WS_WRITE_TIMEOUT.as_secs()
                    );
                    break;
                }
            }
        }
    });

    // Main message read loop. Three exits:
    //   1. abort_notify fires — a newer connection for this agent_id has
    //      replaced this entry, so this read loop must exit to release its
    //      fd instead of waiting hours for OS TCP timeout.
    //   2. ws_stream ends (TCP drop / close frame) — normal cleanup path.
    //   3. Liveness timeout — agent hasn't sent anything in
    //      NO_AGENT_MESSAGE_TIMEOUT, meaning its TCP is silently dead.
    let agent_id_for_msgs = agent_id.clone();
    let mut exited_via_abort = false;
    loop {
        tokio::select! {
            biased;  // check abort first so a re-register doesn't race
            _ = abort_notify.notified() => {
                tracing::info!(
                    "Agent {} connection superseded by new connection, exiting",
                    agent_id_for_msgs
                );
                exited_via_abort = true;
                break;
            }
            msg = tokio::time::timeout(NO_AGENT_MESSAGE_TIMEOUT, ws_stream.next()) => {
                match msg {
                    Err(_) => {
                        tracing::warn!(
                            "Agent {} silent for {}s, closing connection",
                            agent_id_for_msgs,
                            NO_AGENT_MESSAGE_TIMEOUT.as_secs()
                        );
                        break;
                    }
                    Ok(None) => break,
                    Ok(Some(Err(_))) => break,
                    Ok(Some(Ok(msg))) => {
                        match msg {
                    Message::Text(text) => {
                        match serde_json::from_str::<AgentMessage>(&text) {
                            Ok(AgentMessage::Pong) | Ok(AgentMessage::Heartbeat) => {
                                let mut inner = state.inner.write().await;
                                inner.agents.record_pong(&agent_id_for_msgs);
                            }
                            Ok(AgentMessage::ResourcesApplied {
                                req_id,
                                agent_id: _aid,
                                resource_revision,
                            }) => {
                                let pending_resp =
                                    take_pending_for_agent(&state, &req_id, &agent_id_for_msgs).await;
                                if let Some(pending_resp) = pending_resp {
                                    let roots = pending_resp.desired_roots.unwrap_or_default();
                                    {
                                        let mut inner = state.inner.write().await;
                                        inner.agents.update_resources(
                                            &agent_id_for_msgs,
                                            resource_revision,
                                            roots,
                                        );
                                    }
                                    let _ = pending_resp.tx
                                        .send(serde_json::json!({
                                            "ok": true,
                                            "state": "applied",
                                            "resource_revision": resource_revision,
                                        }))
                                        .await;

                                    state.emit_sse("resources_updated", serde_json::json!({
                                        "agent_id": agent_id_for_msgs,
                                        "resource_revision": resource_revision,
                                        "state": "applied",
                                    })).await;
                                }
                            }
                            Ok(AgentMessage::ResourcesRejected {
                                req_id,
                                agent_id: _aid,
                                error,
                                message,
                                ..
                            }) => {
                                let pending_resp =
                                    take_pending_for_agent(&state, &req_id, &agent_id_for_msgs).await;
                                {
                                    let mut inner = state.inner.write().await;
                                    let err_msg = if message.is_empty() { error.clone() } else { message.clone() };
                                    inner.agents.set_config_error(&agent_id_for_msgs, err_msg);
                                }
                                if let Some(pending_resp) = pending_resp {
                                    let _ = pending_resp.tx
                                        .send(serde_json::json!({
                                            "ok": false,
                                            "state": "rejected",
                                            "error": error,
                                            "message": message,
                                        }))
                                        .await;
                                }

                                state.emit_sse("resources_updated", serde_json::json!({
                                    "agent_id": agent_id_for_msgs,
                                    "state": "rejected",
                                })).await;
                            }
                            Ok(AgentMessage::ResourcesUpdated {
                                agent_id: _aid,
                                resource_revision,
                                roots,
                            }) => {
                                {
                                    let mut inner = state.inner.write().await;
                                    inner
                                        .agents
                                        .update_resources(&agent_id_for_msgs, resource_revision, roots);
                                }
                                state.emit_sse("resources_updated", serde_json::json!({
                                    "agent_id": agent_id_for_msgs,
                                    "resource_revision": resource_revision,
                                    "state": "applied",
                                })).await;
                            }
                            Ok(AgentMessage::FsListResponse { req_id, .. })
                            | Ok(AgentMessage::FsStatResponse { req_id, .. })
                            | Ok(AgentMessage::FileChunk { req_id, .. })
                            | Ok(AgentMessage::SysStatsResponse { req_id, .. }) => {
                                let pending_resp =
                                    take_pending_for_agent(&state, &req_id, &agent_id_for_msgs).await;
                                if let Some(pending_resp) = pending_resp {
                                    let parsed: serde_json::Value =
                                        serde_json::from_str(&text).unwrap_or_default();
                                    let _ = pending_resp.tx.send(parsed).await;
                                }
                            }
                            Ok(AgentMessage::Progress {
                                req_id,
                                phase,
                                processed,
                                total,
                                message,
                            }) => {
                                state.emit_sse("progress", serde_json::json!({
                                    "req_id": req_id,
                                    "phase": phase,
                                    "processed": processed,
                                    "total": total,
                                    "message": message,
                                })).await;
                            }
                            _ => {
                                tracing::debug!("Unknown agent message: {}", text);
                            }
                        }
                    }
                    Message::Ping(_data) => {
                        let inner = state.inner.read().await;
                        if let Some(agent) = inner.agents.get(&agent_id_for_msgs) {
                            let _ = agent.sender.send(HubMessage::Ping);
                        }
                    }
                    Message::Close(_) => break,
                    _ => {}
                }
                    }
                }
            }
        }
    }

    // Cleanup
    send_task.abort();

    let mut inner = state.inner.write().await;
    // Only mark offline if the registry entry still belongs to THIS
    // connection. A reconnect may have already replaced the entry with a
    // new sender, in which case marking it offline would break the live
    // connection (reconnect race condition).
    inner.agents.unregister(&agent_id, &tx);
    drop(inner);
    tracing::info!("Agent disconnected: {} ({})", name, agent_id);

    // If we exited because a new connection replaced this one, the new
    // connection already emitted "agent_connected" with the same agent_id.
    // Emitting "agent_disconnected" here would make the frontend briefly
    // flap the agent's status, so skip it.
    if !exited_via_abort {
        state.emit_sse("agent_disconnected", serde_json::json!({
            "agent_id": agent_id,
            "name": name,
        })).await;
    }
}

async fn take_pending_for_agent(
    state: &AppState,
    req_id: &str,
    agent_id: &str,
) -> Option<PendingResponse> {
    let pending_arc = {
        let inner = state.inner.read().await;
        inner.pending_responses.clone()
    };
    let mut pending = pending_arc.write().await;
    match pending.remove(req_id) {
        Some(resp) => {
            if resp.agent_id == agent_id {
                Some(resp)
            } else {
                let owner = resp.agent_id.clone();
                tracing::warn!(
                    "Ignoring response for req_id {} from agent {}; pending owner is {}",
                    req_id,
                    agent_id,
                    owner
                );
                pending.insert(req_id.to_string(), resp);
                None
            }
        }
        None => None,
    }
}

async fn send_auth_fail(ws_sink: &mut futures_util::stream::SplitSink<WebSocket, Message>) {
    let _ = ws_sink
        .send(Message::Text(
            serde_json::to_string(&HubMessage::AuthResult {
                success: false,
                agent_id: None,
            })
            .unwrap()
            .into(),
        ))
        .await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn max_ws_message_size_allows_worst_case_agent_file_chunk() {
        let chunk = AgentMessage::FileChunk {
            req_id: "file_test".to_string(),
            offset: 0,
            data: vec![255; 4 * 1024 * 1024],
            done: false,
            error: None,
        };

        let serialized = serde_json::to_string(&chunk).unwrap();

        assert!(
            serialized.len() < MAX_AGENT_WS_MESSAGE_SIZE,
            "serialized 4MiB FileChunk was {} bytes; WS limit is {}",
            serialized.len(),
            MAX_AGENT_WS_MESSAGE_SIZE
        );
    }
}
