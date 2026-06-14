use std::time::Duration;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use uuid::Uuid;

use filebox_protocol::message::{AgentMessage, HubMessage};
use filebox_protocol::resources::Capabilities;

use crate::state::AppState;

pub async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
) -> impl axum::response::IntoResponse {
    ws.on_upgrade(|socket| handle_socket(socket, state))
}

async fn handle_socket(socket: WebSocket, state: AppState) {
    let (mut ws_sink, mut ws_stream) = socket.split();

    let (tx, mut rx) = mpsc::unbounded_channel::<HubMessage>();

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
            tracing::warn!("Agent auth failed: invalid token");
            send_auth_fail(&mut ws_sink).await;
            return;
        }
    }

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

    // Emit SSE event for agent connection
    state.emit_sse("agent_connected", serde_json::json!({
        "agent_id": agent_id,
        "name": name,
    })).await;

    // Register in agent registry (replaces existing entry if agent reconnects)
    {
        let mut inner = state.inner.write().await;

        // If this agent_id already exists (reconnect), unregister old connection first
        if inner.agents.get(&agent_id).is_some() {
            tracing::info!("Replacing existing connection for agent {}", agent_id);
        }

        inner.agents.register(
            agent_id.clone(),
            name.clone(),
            tx.clone(),
            resource_revision,
            roots.clone(),
            capabilities,
        );

        // Send pending update if any
        if let Some(agent) = inner.agents.get(&agent_id) {
            if let Some(pending) = &agent.pending_update {
                let req_id = format!("pending_{}", Uuid::new_v4());
                let _ = tx.send(HubMessage::ResourcesSetDesired {
                    req_id,
                    desired_revision: agent.resource_revision + 1,
                    roots: pending.roots.clone(),
                });
            }
        }
    }

    // Spawn task to forward channel messages to WebSocket
    let send_task = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            let text = serde_json::to_string(&msg).unwrap();
            if ws_sink.send(Message::Text(text.into())).await.is_err() {
                break;
            }
        }
    });

    // Main message read loop
    let agent_id_for_msgs = agent_id.clone();
    while let Some(Ok(msg)) = ws_stream.next().await {
        match msg {
            Message::Text(text) => {
                match serde_json::from_str::<AgentMessage>(&text) {
                    Ok(AgentMessage::Pong) | Ok(AgentMessage::Heartbeat) => {
                        let mut inner = state.inner.write().await;
                        inner.agents.record_pong(&agent_id_for_msgs);
                    }
                    Ok(AgentMessage::ResourcesApplied {
                        req_id,
                        agent_id: aid,
                        resource_revision,
                    }) => {
                        // Extract pending response first, then update registry
                        let pending_resp = {
                            let inner = state.inner.read().await;
                            let mut pending = inner.pending_responses.write().await;
                            pending.remove(&req_id)
                        };
                        if let Some(pending_resp) = pending_resp {
                            let roots = pending_resp.desired_roots.unwrap_or_default();
                            {
                                let mut inner = state.inner.write().await;
                                inner.agents.update_resources(&aid, resource_revision, roots);
                            }
                            let _ = pending_resp.tx
                                .send(serde_json::json!({
                                    "ok": true,
                                    "state": "applied",
                                    "resource_revision": resource_revision,
                                }))
                                .await;

                            state.emit_sse("resources_updated", serde_json::json!({
                                "agent_id": aid,
                                "resource_revision": resource_revision,
                                "state": "applied",
                            })).await;
                        }
                    }
                    Ok(AgentMessage::ResourcesRejected {
                        req_id,
                        agent_id: aid,
                        error,
                        message,
                        ..
                    }) => {
                        let pending_resp = {
                            let inner = state.inner.read().await;
                            let mut pending = inner.pending_responses.write().await;
                            pending.remove(&req_id)
                        };
                        // Store config error on agent
                        {
                            let mut inner = state.inner.write().await;
                            let err_msg = if message.is_empty() { error.clone() } else { message.clone() };
                            inner.agents.set_config_error(&aid, err_msg);
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
                            "agent_id": aid,
                            "state": "rejected",
                        })).await;
                    }
                    Ok(AgentMessage::ResourcesUpdated {
                        agent_id: aid,
                        resource_revision,
                        roots,
                    }) => {
                        {
                            let mut inner = state.inner.write().await;
                            inner
                                .agents
                                .update_resources(&aid, resource_revision, roots);
                        }
                        state.emit_sse("resources_updated", serde_json::json!({
                            "agent_id": aid,
                            "resource_revision": resource_revision,
                            "state": "applied",
                        })).await;
                    }
                    Ok(AgentMessage::FsListResponse { req_id, .. })
                    | Ok(AgentMessage::FsStatResponse { req_id, .. })
                    | Ok(AgentMessage::FileChunk { req_id, .. })
                    | Ok(AgentMessage::SysStatsResponse { req_id, .. }) => {
                        let pending_resp = {
                            let inner = state.inner.read().await;
                            let mut pending = inner.pending_responses.write().await;
                            pending.remove(&req_id)
                        };
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

    // Cleanup
    send_task.abort();

    let mut inner = state.inner.write().await;
    inner.agents.unregister(&agent_id);
    drop(inner);
    tracing::info!("Agent disconnected: {} ({})", name, agent_id);

    state.emit_sse("agent_disconnected", serde_json::json!({
        "agent_id": agent_id,
        "name": name,
    })).await;
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
