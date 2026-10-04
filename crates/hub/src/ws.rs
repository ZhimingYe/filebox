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

use crate::agent_registry::AGENT_OUTBOUND_QUEUE_CAPACITY;
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
// Current agents cap FileChunk at FILE_CHUNK_MAX_BYTES (512KiB) raw, then
// base64. Keep a generous bound so older agents still sending up to 4MiB
// during rolling upgrades are accepted, while still capping hostile
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

mod handshake;
mod registration;
mod session;
mod dispatch;
mod updates;
mod responses;
mod terminal;

pub(super) type AgentSink = futures_util::stream::SplitSink<WebSocket, Message>;
pub(super) type AgentReader = futures_util::stream::SplitStream<WebSocket>;

/// Immutable routing identity for exactly one registered socket generation.
#[derive(Clone)]
pub(super) struct AgentContext {
    state: AppState,
    agent_id: String,
    connection_id: u64,
}

async fn handle_socket(socket: WebSocket, state: AppState, client_ip: String) {
    let (mut sink, mut reader) = socket.split();
    let Some(registration) = handshake::authenticate(&mut sink, &mut reader, &state, &client_ip).await else {
        return;
    };
    let (tx, rx) = mpsc::channel(AGENT_OUTBOUND_QUEUE_CAPACITY);
    let abort = Arc::new(Notify::new());
    let context = registration.install(state, tx.clone(), abort.clone()).await;
    session::run(context, sink, reader, tx, rx, abort).await;
}

async fn send_auth_fail(ws_sink: &mut futures_util::stream::SplitSink<WebSocket, Message>) {
    let _ = send_hub_frame(
        ws_sink,
        &HubMessage::AuthResult {
            success: false,
            agent_id: None,
        },
    )
    .await;
}

async fn send_hub_frame(
    ws_sink: &mut futures_util::stream::SplitSink<WebSocket, Message>,
    message: &HubMessage,
) -> bool {
    let text = match serde_json::to_string(message) {
        Ok(text) => text,
        Err(error) => {
            tracing::error!("Failed to serialize Hub WS message: {}", error);
            return false;
        }
    };
    matches!(
        tokio::time::timeout(
            WS_WRITE_TIMEOUT,
            ws_sink.send(Message::Text(text.into())),
        )
        .await,
        Ok(Ok(()))
    )
}

#[cfg(test)]
use updates::reconcile_roots_after_apply;
#[cfg(test)]
mod tests;
