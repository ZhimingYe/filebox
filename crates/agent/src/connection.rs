use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;

use filebox_protocol::message::{AgentMessage, HubMessage};
use filebox_protocol::resources::Capabilities;

use crate::config::AgentConfig;
use crate::dir_cache::DirCache;
use crate::resources::ResourceManager;
use crate::sysinfo::StatsCache;

// ── Timeouts and tunables ─────────────────────────────────────────────────
//
// Designed for very flaky networks (NAT timeouts, wireless drops, HPC
// interconnect hiccups). The agent must detect a dead hub quickly and
// reconnect without manual intervention.

/// Hard cap on TCP connect + TLS handshake + WS upgrade. Without this, a
/// black-holed route can hang `connect_async` indefinitely.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// How long to wait for the hub's AuthResult before giving up.
const AUTH_TIMEOUT: Duration = Duration::from_secs(10);

/// If the hub sends nothing (no Ping, no Heartbeat, no message) for this
/// window, consider the connection dead and reconnect. Hub normally pings
/// every 15s, so 45s = 3 missed pings. This is the key defense against
/// silently-dropped TCP (NAT expiry, half-open after sleep): without an
/// application-level liveness check the agent would otherwise wait forever
/// on `read.next()`.
const NO_MESSAGE_TIMEOUT: Duration = Duration::from_secs(45);

/// Per-write timeout. A blocked write would otherwise stall the entire
/// `tokio::select!` loop (including the read-side liveness check), so
/// every WS write is bounded.
const WS_WRITE_TIMEOUT: Duration = Duration::from_secs(10);

/// Best-effort grace period for sending a Close frame before tearing down.
/// Close lets the hub detect our disconnect immediately instead of waiting
/// for a TCP timeout.
const CLOSE_SEND_TIMEOUT: Duration = Duration::from_secs(2);

/// A connection that lasted at least this long is considered "stable" —
/// the next attempt resets backoff to 1s. A connection that flaps faster
/// keeps growing its backoff to avoid hammering a broken hub.
const STABLE_CONNECTION_THRESHOLD: Duration = Duration::from_secs(30);

const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(15);

/// Translate a user-facing hub URL (http/https/ws/wss) into a WebSocket URL
/// ending in /ws/agent.
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

fn stats_ttl() -> Duration {
    let secs = std::env::var("FILEBOX_AGENT_STATS_TTL_SECS")
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(15);
    Duration::from_secs(secs.max(1))
}

/// Send a WS message with a write timeout. Returns false on timeout or
/// error — caller should treat the connection as dead and reconnect.
async fn send_with_timeout<W>(write: &mut W, msg: Message) -> bool
where
    W: SinkExt<Message> + Unpin,
{
    match tokio::time::timeout(WS_WRITE_TIMEOUT, write.send(msg)).await {
        Ok(Ok(_)) => true,
        Ok(Err(_)) => {
            tracing::warn!("WS write failed");
            false
        }
        Err(_) => {
            tracing::warn!("WS write timed out after {}s", WS_WRITE_TIMEOUT.as_secs());
            false
        }
    }
}

pub async fn run_connection_loop(config: &AgentConfig) {
    let ws_url = build_ws_url(&config.hub_url);
    let mut backoff_secs = 1u64;
    let max_backoff = 300u64;

    if let Err(e) = std::fs::create_dir_all(&config.data_dir) {
        tracing::error!("Failed to create data directory {:?}: {}", config.data_dir, e);
        return;
    }

    let mut resource_mgr = ResourceManager::new(config.data_dir.clone());
    let stable_agent_id = resource_mgr.agent_id().to_string();
    let stats_cache: Arc<StatsCache> = StatsCache::new(stats_ttl());
    // Per-directory listing cache. Cuts the O(N)-per-page cost of paginating
    // large directories to O(1) on cache hits (mtime-validated), benefiting
    // both the main file list and the directory tree. Cleared on resource
    // reconfigure inside the connection loop.
    let dir_cache: Arc<DirCache> = DirCache::new();

    tracing::info!(
        "Agent ID: {}, data dir: {:?}",
        stable_agent_id,
        config.data_dir
    );

    loop {
        let connect_at = Instant::now();

        run_one_connection(
            &ws_url,
            config,
            &mut resource_mgr,
            &stable_agent_id,
            &stats_cache,
            &dir_cache,
        )
        .await;

        let conn_duration = connect_at.elapsed();
        let was_stable = conn_duration >= STABLE_CONNECTION_THRESHOLD;

        // Compute sleep duration for THIS retry. A connection that just
        // demonstrated the network is healthy (lasted ≥ threshold) gets a
        // 1s sleep; a flapping connection sleeps the current backoff.
        let base = if was_stable { 1 } else { backoff_secs };
        // Jitter prevents thundering herd when many agents drop at once
        // (e.g., hub restart or network partition healing).
        let jitter = if base > 1 {
            rand::random::<u64>() % (base / 2)
        } else {
            0
        };
        let sleep_secs = base + jitter;

        tracing::info!(
            "Reconnecting in {}s (base={}, jitter={}, last_conn_duration={:?}, stable={})",
            sleep_secs,
            base,
            jitter,
            conn_duration,
            was_stable,
        );

        tokio::time::sleep(Duration::from_secs(sleep_secs)).await;

        // Update backoff for the NEXT unstable iteration: stable resets to 1
        // (so a future flap starts from 1s, not the doubled value), unstable
        // doubles. Without this conditional, every iteration's "always
        // double" would ratchet the backoff up even after stable connections.
        if was_stable {
            backoff_secs = 1;
        } else {
            backoff_secs = (backoff_secs * 2).min(max_backoff);
        }
    }
}

/// Open one WebSocket connection, authenticate, register, run the main
/// message loop until something fails. Always returns (caller applies
/// backoff and reconnects).
async fn run_one_connection(
    ws_url: &str,
    config: &AgentConfig,
    resource_mgr: &mut ResourceManager,
    stable_agent_id: &str,
    stats_cache: &Arc<StatsCache>,
    dir_cache: &Arc<DirCache>,
) {
    tracing::info!("Connecting to {}", ws_url);

    // Step 1: Connect with hard timeout. Without this, a black-holed route
    // can leave us hung in DNS/TCP/TLS forever.
    let ws_stream = match tokio::time::timeout(CONNECT_TIMEOUT, connect_async(ws_url)).await {
        Ok(Ok((s, _))) => {
            tracing::info!("Connected to Hub");
            s
        }
        Ok(Err(e)) => {
            tracing::warn!("Connection failed: {}", e);
            return;
        }
        Err(_) => {
            tracing::warn!("Connection timed out after {}s", CONNECT_TIMEOUT.as_secs());
            return;
        }
    };

    let (mut write, mut read) = ws_stream.split();

    // Step 2: Send Auth
    let auth = AgentMessage::Auth {
        token: config.token.clone(),
    };
    let auth_msg = Message::Text(serde_json::to_string(&auth).unwrap().into());
    if !send_with_timeout(&mut write, auth_msg).await {
        tracing::warn!("Failed to send auth");
        return;
    }

    // Step 3: Wait for AuthResult
    let auth_result = tokio::time::timeout(AUTH_TIMEOUT, read.next()).await;
    let assigned_agent_id = match auth_result {
        Ok(Some(Ok(Message::Text(text)))) => match serde_json::from_str::<HubMessage>(&text) {
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
                return;
            }
            _ => {
                tracing::warn!("Unexpected auth response: {}", text);
                return;
            }
        },
        _ => {
            tracing::warn!("Timeout or error waiting for auth result");
            return;
        }
    };

    // Step 4: Send Register with persisted resource state
    let (rev, roots) = resource_mgr.current_state();
    let (collections_rev, collections) = resource_mgr.current_collections_state();
    // Advertise pinned_folders support explicitly. Capabilities::default()
    // leaves it false (the legacy-detection sentinel), so a NEW agent must opt
    // in here — this is what lets the hub tell a new agent from a pre-pin
    // agent during a rolling upgrade and avoid pushing pins to one that can't
    // store them.
    let mut capabilities = Capabilities::default();
    capabilities.pinned_folders = true;
    capabilities.collections = true;
    let register = AgentMessage::Register {
        agent_id: Some(stable_agent_id.to_string()),
        name: config.agent_name.clone(),
        resource_revision: rev,
        roots,
        capabilities,
        collections_revision: collections_rev,
        collections,
    };
    let register_msg = Message::Text(serde_json::to_string(&register).unwrap().into());
    if !send_with_timeout(&mut write, register_msg).await {
        tracing::warn!("Failed to send register");
        return;
    }

    tracing::info!(
        "Registered as {} (rev={})",
        config.agent_name,
        resource_mgr.resource_revision()
    );

    // Step 5: Main message loop with liveness timeout.
    let mut ping_interval = tokio::time::interval(HEARTBEAT_INTERVAL);

    loop {
        tokio::select! {
            // Wrap read.next() in a timeout so a silent half-open TCP is
            // detected within NO_MESSAGE_TIMEOUT rather than waiting for the
            // OS's TCP keepalive (~2 hours on default Linux).
            msg = tokio::time::timeout(NO_MESSAGE_TIMEOUT, read.next()) => {
                match msg {
                    Err(_) => {
                        tracing::warn!(
                            "No message from hub in {}s, reconnecting",
                            NO_MESSAGE_TIMEOUT.as_secs()
                        );
                        break;
                    }
                    Ok(None) => {
                        tracing::info!("Connection stream ended");
                        break;
                    }
                    Ok(Some(Err(e))) => {
                        tracing::info!("Read error: {}", e);
                        break;
                    }
                    Ok(Some(Ok(Message::Text(text)))) => {
                        match serde_json::from_str::<HubMessage>(&text) {
                            Ok(HubMessage::Ping) => {
                                let _ = send_with_timeout(&mut write, Message::Text(
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
                                        // Roots may have changed (path/name/enabled/denylist
                                        // semantics via root config), so cached listings could
                                        // describe the wrong tree. Drop them all — they re-warm
                                        // lazily on the next request. Cheaper and safer than
                                        // trying to invalidate granularly.
                                        dir_cache.clear();

                                        let update = AgentMessage::ResourcesUpdated {
                                            agent_id: assigned_agent_id.clone(),
                                            resource_revision: new_rev,
                                            roots: resource_mgr.roots().to_vec(),
                                        };
                                        let _ = send_with_timeout(&mut write, Message::Text(
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

                                let _ = send_with_timeout(&mut write, Message::Text(
                                    serde_json::to_string(&response).unwrap().into(),
                                )).await;
                            }
                            Ok(HubMessage::CollectionsSetDesired {
                                req_id,
                                desired_revision,
                                collections,
                            }) => {
                                tracing::info!(
                                    "Received collections update: rev={}, {} collections",
                                    desired_revision,
                                    collections.len()
                                );

                                let response = match resource_mgr.apply_collections_desired(
                                    desired_revision,
                                    collections,
                                ) {
                                    Ok(new_rev) => {
                                        let update = AgentMessage::CollectionsUpdated {
                                            agent_id: assigned_agent_id.clone(),
                                            collections_revision: new_rev,
                                            collections: resource_mgr.collections().to_vec(),
                                        };
                                        let _ = send_with_timeout(&mut write, Message::Text(
                                            serde_json::to_string(&update).unwrap().into(),
                                        )).await;

                                        AgentMessage::CollectionsApplied {
                                            req_id: req_id.clone(),
                                            agent_id: assigned_agent_id.clone(),
                                            collections_revision: new_rev,
                                        }
                                    }
                                    Err(err_msg) => {
                                        tracing::warn!("Collections update rejected: {}", err_msg);
                                        AgentMessage::CollectionsRejected {
                                            req_id: req_id.clone(),
                                            agent_id: assigned_agent_id.clone(),
                                            current_collections_revision: resource_mgr
                                                .collections_revision(),
                                            error: "invalid_collection".to_string(),
                                            message: err_msg,
                                        }
                                    }
                                };

                                let _ = send_with_timeout(&mut write, Message::Text(
                                    serde_json::to_string(&response).unwrap().into(),
                                )).await;
                            }
                            Ok(HubMessage::FsListRequest { req_id, root, path, limit, cursor, dirs_only }) => {
                                tracing::debug!("FS list: root={}, path={}, dirs_only={:?}", root, path, dirs_only);
                                let roots_vec = resource_mgr.roots().to_vec();
                                let dirs_only_flag = dirs_only.unwrap_or(false);
                                let cache_clone = dir_cache.clone();
                                let result = tokio::task::spawn_blocking(move || {
                                    cache_clone.list(
                                        &roots_vec, &root, &path, limit as usize,
                                        cursor.as_deref(), dirs_only_flag,
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
                                let _ = send_with_timeout(&mut write, Message::Text(
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
                                let _ = send_with_timeout(&mut write, Message::Text(
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
                                let _ = send_with_timeout(&mut write, Message::Text(
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
                                    req_id, stats: Some((*stats).clone()), error: None,
                                };
                                let _ = send_with_timeout(&mut write, Message::Text(
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
                    Ok(Some(Ok(Message::Ping(data)))) => {
                        let _ = send_with_timeout(&mut write, Message::Pong(data)).await;
                    }
                    Ok(Some(Ok(Message::Close(_)))) => {
                        tracing::info!("Hub closed connection");
                        break;
                    }
                    _ => {}
                }
            }
            _ = ping_interval.tick() => {
                let heartbeat = Message::Text(
                    serde_json::to_string(&AgentMessage::Heartbeat).unwrap().into(),
                );
                if !send_with_timeout(&mut write, heartbeat).await {
                    tracing::warn!("Heartbeat send failed/timed out, reconnecting");
                    break;
                }
            }
        }
    }

    // Best-effort Close frame so the hub can run cleanup immediately instead
    // of waiting for TCP timeout. Ignore errors — we're tearing down anyway.
    let _ = tokio::time::timeout(CLOSE_SEND_TIMEOUT, write.send(Message::Close(None))).await;
    tracing::info!("Disconnected from Hub");
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
