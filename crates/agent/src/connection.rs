use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;

use filebox_protocol::message::{AgentMessage, HubMessage};
use filebox_protocol::resources::Capabilities;

use crate::config::AgentConfig;
use crate::resources::ResourceManager;
use crate::sysinfo::StatsCache;

/// Translate a user-facing hub URL (http/https/ws/wss) into a WebSocket URL
/// ending in /ws/agent. Accepts the forms the install script and CLAUDE.md
/// document (http/https) plus raw ws/wss for flexibility.
fn build_ws_url(hub_url: &str) -> String {
    let trimmed = hub_url.trim_end_matches('/');
    let (scheme, rest) = if let Some(rest) = trimmed.strip_prefix("https://") {
        ("wss://", rest)
    } else if let Some(rest) = trimmed.strip_prefix("http://") {
        ("ws://", rest)
    } else if let Some(rest) = trimmed.strip_prefix("wss://") {
        ("wss://", rest)
    } else if let Some(rest) = trimmed.strip_prefix("ws://") {
        ("ws://", rest)
    } else {
        ("ws://", trimmed)
    };
    format!("{}{}/ws/agent", scheme, rest)
}

/// Stats cache TTL. Override with FILEBOX_AGENT_STATS_TTL_SECS for hosts with
/// many processes (HPC: set to 30-60 to amortize the /proc sweep cost).
fn stats_ttl() -> Duration {
    let secs = std::env::var("FILEBOX_AGENT_STATS_TTL_SECS")
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(15);
    Duration::from_secs(secs.max(1))
}

pub async fn run_connection_loop(config: &AgentConfig) {
    let ws_url = build_ws_url(&config.hub_url);
    let mut backoff_secs = 1u64;
    let max_backoff = 300u64;

    // Ensure data directory exists
    if let Err(e) = std::fs::create_dir_all(&config.data_dir) {
        tracing::error!("Failed to create data directory {:?}: {}", config.data_dir, e);
        return;
    }

    // Load or initialize resource manager (persists agent_id and resources)
    let mut resource_mgr = ResourceManager::new(config.data_dir.clone());
    let stable_agent_id = resource_mgr.agent_id().to_string();

    // Stats cache lives across reconnects so a brief network blip doesn't
    // throw away the cached System / fresh stats.
    let stats_cache: Arc<StatsCache> = StatsCache::new(stats_ttl());

    tracing::info!(
        "Agent ID: {}, data dir: {:?}",
        stable_agent_id,
        config.data_dir
    );

    loop {
        tracing::info!("Connecting to {}", ws_url);

        match connect_async(&ws_url).await {
            Ok((ws_stream, _)) => {
                tracing::info!("Connected to Hub");
                backoff_secs = 1;

                let (mut write, mut read) = ws_stream.split();

                // Step 1: Send Auth
                let auth = AgentMessage::Auth {
                    token: config.token.clone(),
                };
                if write
                    .send(Message::Text(serde_json::to_string(&auth).unwrap().into()))
                    .await
                    .is_err()
                {
                    tracing::warn!("Failed to send auth, reconnecting...");
                    continue;
                }

                // Step 2: Wait for AuthResult
                let auth_result = tokio::time::timeout(
                    std::time::Duration::from_secs(10),
                    read.next(),
                )
                .await;

                let assigned_agent_id = match auth_result {
                    Ok(Some(Ok(Message::Text(text)))) => {
                        match serde_json::from_str::<HubMessage>(&text) {
                            Ok(HubMessage::AuthResult {
                                success: true,
                                agent_id: Some(id),
                            }) => {
                                tracing::info!("Authenticated as agent {}", id);
                                id
                            }
                            Ok(HubMessage::AuthResult {
                                success: false, ..
                            }) => {
                                tracing::error!("Authentication failed");
                                continue;
                            }
                            _ => {
                                tracing::warn!("Unexpected auth response: {}", text);
                                continue;
                            }
                        }
                    }
                    _ => {
                        tracing::warn!("Timeout waiting for auth result");
                        continue;
                    }
                };

                // Step 3: Send Register with persisted resource state
                let (rev, roots) = resource_mgr.current_state();
                let register = AgentMessage::Register {
                    agent_id: Some(stable_agent_id.clone()),
                    name: config.agent_name.clone(),
                    resource_revision: rev,
                    roots,
                    capabilities: Capabilities::default(),
                };
                if write
                    .send(Message::Text(
                        serde_json::to_string(&register).unwrap().into(),
                    ))
                    .await
                    .is_err()
                {
                    tracing::warn!("Failed to send register, reconnecting...");
                    continue;
                }

                tracing::info!(
                    "Registered as {} (rev={})",
                    config.agent_name,
                    resource_mgr.resource_revision()
                );

                // Step 4: Main message loop
                let mut ping_interval = tokio::time::interval(std::time::Duration::from_secs(15));

                loop {
                    tokio::select! {
                        msg = read.next() => {
                            match msg {
                                Some(Ok(Message::Text(text))) => {
                                    match serde_json::from_str::<HubMessage>(&text) {
                                        Ok(HubMessage::Ping) => {
                                            let _ = write.send(Message::Text(
                                                serde_json::to_string(&AgentMessage::Pong).unwrap().into(),
                                            )).await;
                                        }
                                        Ok(HubMessage::ResourcesSetDesired {
                                            req_id,
                                            desired_revision,
                                            roots,
                                        }) => {
                                            tracing::info!(
                                                "Received resource update: rev={}, {} roots",
                                                desired_revision,
                                                roots.len()
                                            );

                                            let response = match resource_mgr.apply_desired(desired_revision, roots) {
                                                Ok(new_rev) => {
                                                    // Also send ResourcesUpdated so Hub syncs
                                                    let update = AgentMessage::ResourcesUpdated {
                                                        agent_id: assigned_agent_id.clone(),
                                                        resource_revision: new_rev,
                                                        roots: resource_mgr.roots().to_vec(),
                                                    };
                                                    let _ = write.send(Message::Text(
                                                        serde_json::to_string(&update).unwrap().into(),
                                                    )).await;

                                                    AgentMessage::ResourcesApplied {
                                                        req_id: req_id.clone(),
                                                        agent_id: assigned_agent_id.clone(),
                                                        resource_revision: new_rev,
                                                    }
                                                }
                                                Err(err_msg) => {
                                                    tracing::warn!("Resource update rejected: {}", err_msg);
                                                    AgentMessage::ResourcesRejected {
                                                        req_id: req_id.clone(),
                                                        agent_id: assigned_agent_id.clone(),
                                                        current_resource_revision: resource_mgr.resource_revision(),
                                                        error: "invalid_resource".to_string(),
                                                        message: err_msg,
                                                    }
                                                }
                                            };

                                            let _ = write.send(Message::Text(
                                                serde_json::to_string(&response).unwrap().into(),
                                            )).await;
                                        }
                                        Ok(HubMessage::FsListRequest { req_id, root, path, limit, cursor }) => {
                                            tracing::debug!("FS list: root={}, path={}", root, path);
                                            let roots_vec = resource_mgr.roots().to_vec();
                                            let result = tokio::task::spawn_blocking(move || {
                                                crate::fs::list_directory(
                                                    &roots_vec, &root, &path, limit as usize, cursor.as_deref(),
                                                )
                                            }).await;
                                            let response = match result {
                                                Ok(Ok((items, next_cursor))) => AgentMessage::FsListResponse {
                                                    req_id,
                                                    items,
                                                    next_cursor,
                                                    error: None,
                                                },
                                                Ok(Err(e)) => AgentMessage::FsListResponse {
                                                    req_id,
                                                    items: vec![],
                                                    next_cursor: None,
                                                    error: Some(e),
                                                },
                                                Err(join_err) => AgentMessage::FsListResponse {
                                                    req_id,
                                                    items: vec![],
                                                    next_cursor: None,
                                                    error: Some(format!("agent worker panicked: {}", join_err)),
                                                },
                                            };
                                            let _ = write.send(Message::Text(
                                                serde_json::to_string(&response).unwrap().into(),
                                            )).await;
                                        }
                                        Ok(HubMessage::FsStatRequest { req_id, root, path }) => {
                                            tracing::debug!("FS stat: root={}, path={}", root, path);
                                            let roots_vec = resource_mgr.roots().to_vec();
                                            let result = tokio::task::spawn_blocking(move || {
                                                crate::fs::stat_file(&roots_vec, &root, &path)
                                            }).await;
                                            let response = match result {
                                                Ok(Ok(stat)) => AgentMessage::FsStatResponse {
                                                    req_id, stat: Some(stat), error: None,
                                                },
                                                Ok(Err(e)) => AgentMessage::FsStatResponse {
                                                    req_id, stat: None, error: Some(e),
                                                },
                                                Err(join_err) => AgentMessage::FsStatResponse {
                                                    req_id, stat: None,
                                                    error: Some(format!("agent worker panicked: {}", join_err)),
                                                },
                                            };
                                            let _ = write.send(Message::Text(
                                                serde_json::to_string(&response).unwrap().into(),
                                            )).await;
                                        }
                                        Ok(HubMessage::FileReadRequest { req_id, root, path, offset, length }) => {
                                            tracing::debug!("FS read: root={}, path={}, offset={}, len={:?}", root, path, offset, length);
                                            let roots_vec = resource_mgr.roots().to_vec();
                                            let result = tokio::task::spawn_blocking(move || {
                                                crate::fs::read_file_range(&roots_vec, &root, &path, offset, length)
                                            }).await;
                                            let response = match result {
                                                Ok(Ok((data, done))) => AgentMessage::FileChunk {
                                                    req_id, offset, data, done, error: None,
                                                },
                                                Ok(Err(e)) => AgentMessage::FileChunk {
                                                    req_id, offset: 0, data: vec![], done: true, error: Some(e),
                                                },
                                                Err(join_err) => AgentMessage::FileChunk {
                                                    req_id, offset: 0, data: vec![], done: true,
                                                    error: Some(format!("agent worker panicked: {}", join_err)),
                                                },
                                            };
                                            let _ = write.send(Message::Text(
                                                serde_json::to_string(&response).unwrap().into(),
                                            )).await;
                                        }
                                        Ok(HubMessage::Cancel { req_id }) => {
                                            tracing::debug!("Cancel request: {}", req_id);
                                        }
                                        Ok(HubMessage::SysStatsRequest { req_id }) => {
                                            tracing::debug!("Sys stats request");
                                            let stats = stats_cache.get().await;
                                            let response = AgentMessage::SysStatsResponse {
                                                req_id, stats: Some(stats), error: None,
                                            };
                                            let _ = write.send(Message::Text(
                                                serde_json::to_string(&response).unwrap().into(),
                                            )).await;
                                        }
                                        Ok(HubMessage::Error { message }) => {
                                            tracing::warn!("Hub error: {}", message);
                                        }
                                        Err(e) => {
                                            tracing::debug!("Failed to parse hub message: {}", e);
                                        }
                                        _ => {}
                                    }
                                }
                                Some(Ok(Message::Ping(data))) => {
                                    let _ = write.send(Message::Pong(data)).await;
                                }
                                Some(Ok(Message::Close(_))) => {
                                    tracing::info!("Hub closed connection");
                                    break;
                                }
                                None => {
                                    tracing::info!("Connection stream ended");
                                    break;
                                }
                                _ => {}
                            }
                        }
                        _ = ping_interval.tick() => {
                            let _ = write.send(Message::Text(
                                serde_json::to_string(&AgentMessage::Heartbeat).unwrap().into(),
                            )).await;
                        }
                    }
                }

                tracing::info!("Disconnected from Hub");
            }
            Err(e) => {
                tracing::warn!("Connection failed: {}", e);
            }
        }

        tracing::info!("Reconnecting in {}s...", backoff_secs);
        tokio::time::sleep(std::time::Duration::from_secs(backoff_secs)).await;
        backoff_secs = (backoff_secs * 2).min(max_backoff);
    }
}

#[cfg(test)]
mod tests {
    use super::build_ws_url;

    #[test]
    fn translates_https_to_wss() {
        assert_eq!(
            build_ws_url("https://hub.example.com"),
            "wss://hub.example.com/ws/agent"
        );
    }

    #[test]
    fn translates_http_to_ws() {
        assert_eq!(
            build_ws_url("http://192.168.1.10:3000"),
            "ws://192.168.1.10:3000/ws/agent"
        );
    }

    #[test]
    fn passes_through_wss_and_ws() {
        assert_eq!(
            build_ws_url("wss://hub.example.com"),
            "wss://hub.example.com/ws/agent"
        );
        assert_eq!(
            build_ws_url("ws://hub.local:3000"),
            "ws://hub.local:3000/ws/agent"
        );
    }

    #[test]
    fn strips_trailing_slash() {
        assert_eq!(
            build_ws_url("https://hub.example.com/"),
            "wss://hub.example.com/ws/agent"
        );
    }

    #[test]
    fn falls_back_to_ws_without_scheme() {
        assert_eq!(build_ws_url("hub.example.com:3000"), "ws://hub.example.com:3000/ws/agent");
    }
}
