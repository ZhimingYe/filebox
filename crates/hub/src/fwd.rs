use std::{collections::HashMap, sync::{Arc, Mutex}, time::{Duration, Instant}};
use axum::{extract::{State, WebSocketUpgrade, ws::{WebSocket, Message}}, http::{HeaderMap, StatusCode}, response::{IntoResponse, Response}, routing::any, Router};
use futures_util::{SinkExt, StreamExt};
use tokio::{io::{AsyncReadExt, AsyncWriteExt, DuplexStream}, sync::{oneshot, Semaphore, OwnedSemaphorePermit}};
use tokio_util::sync::CancellationToken;
use crate::{state::AppState, agent_registry::AgentStatus};
use filebox_protocol::{message::HubMessage, tunnel::{self, Frame}};

mod rewrite;
mod body;
mod proxy;
#[cfg(test)]
mod tests;
pub use proxy::referer_fallback;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/_fwd/{agent}/{port}", any(proxy::proxy))
        .route("/_fwd/{agent}/{port}/", any(proxy::proxy))
        .route("/_fwd/{agent}/{port}/{*rest}", any(proxy::proxy))
        .layer(axum::extract::DefaultBodyLimit::disable())
}

struct Generation { cancel: CancellationToken, limit: Arc<Semaphore> }
struct Ticket {
    agent: String, generation: u64, expires: Instant,
    tx: oneshot::Sender<WebSocket>,
}
#[derive(Default)]
pub struct TunnelStore {
    tickets: Mutex<HashMap<String, Ticket>>,
    generations: Mutex<HashMap<(String, u64), Generation>>,
}
impl TunnelStore {
    pub fn disconnect(&self, agent: &str, generation: u64) {
        if let Some(entry) = self.generations.lock().unwrap().remove(&(agent.into(), generation)) { entry.cancel.cancel(); }
        self.tickets.lock().unwrap().retain(|_, t| t.agent != agent || t.generation != generation);
    }
    pub fn fail(&self, ticket: &str, agent: &str, generation: u64) {
        let mut tickets = self.tickets.lock().unwrap();
        if tickets.get(ticket).is_some_and(|t| t.agent == agent && t.generation == generation) { tickets.remove(ticket); }
    }
    fn take(&self, ticket: &str, agent: &str, generation: u64) -> Option<Ticket> {
        let mut tickets = self.tickets.lock().unwrap();
        if !tickets.get(ticket).is_some_and(|t| t.agent == agent && t.generation == generation && t.expires > Instant::now()) { return None; }
        tickets.remove(ticket)
    }
}

struct TicketCleanup { store: Arc<TunnelStore>, ticket: String }
impl Drop for TicketCleanup {
    fn drop(&mut self) { self.store.tickets.lock().unwrap().remove(&self.ticket); }
}

pub async fn data_socket(State(state): State<AppState>, headers: HeaderMap, ws: WebSocketUpgrade) -> Response {
    let Some(ticket) = headers.get("x-filebox-ticket").and_then(|h| h.to_str().ok()) else { return StatusCode::UNAUTHORIZED.into_response(); };
    let Some(agent) = headers.get("x-filebox-agent").and_then(|h| h.to_str().ok()) else { return StatusCode::UNAUTHORIZED.into_response(); };
    let inner = state.inner.read().await;
    let Some(connection) = inner.agents.get(agent).filter(|a| a.status != AgentStatus::Offline) else { return StatusCode::UNAUTHORIZED.into_response(); };
    let Some(pending) = state.tunnels.take(ticket, agent, connection.connection_id) else { return StatusCode::UNAUTHORIZED.into_response(); };
    ws.max_message_size(tunnel::MAX_WS_MESSAGE).max_frame_size(tunnel::MAX_WS_MESSAGE)
        .on_upgrade(move |socket| async move { let _ = pending.tx.send(socket); })
}

pub(super) struct Opened { pub stream: DuplexStream, pub cancel: CancellationToken }

async fn open(state: &AppState, agent: &str, port: u16) -> Result<Opened, StatusCode> {
    let inner = state.inner.read().await;
    let connection = inner.agents.get(agent).ok_or(StatusCode::NOT_FOUND)?;
    if !connection.capabilities.port_forward || !connection.forwards.iter().any(|f| f.port == port) { return Err(StatusCode::NOT_FOUND); }
    if connection.status == AgentStatus::Offline { return Err(StatusCode::SERVICE_UNAVAILABLE); }
    let (cancel, permit) = {
        let mut generations = state.tunnels.generations.lock().unwrap();
        let entry = generations.entry((agent.into(), connection.connection_id)).or_insert_with(|| Generation {
            cancel: CancellationToken::new(), limit: Arc::new(Semaphore::new(64)),
        });
        (entry.cancel.child_token(), entry.limit.clone().try_acquire_owned().map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?)
    };
    let ticket = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = oneshot::channel();
    state.tunnels.tickets.lock().unwrap().insert(ticket.clone(), Ticket {
        agent: agent.into(), generation: connection.connection_id,
        expires: Instant::now() + Duration::from_secs(300), tx,
    });
    let _cleanup = TicketCleanup { store: state.tunnels.clone(), ticket: ticket.clone() };
    if !inner.agents.send_to_agent(agent, HubMessage::TunnelOpen { ticket, port, compression: true }) { return Err(StatusCode::SERVICE_UNAVAILABLE); }
    drop(inner);
    let mut socket = tokio::select! {
        _ = cancel.cancelled() => return Err(StatusCode::SERVICE_UNAVAILABLE),
        result = tokio::time::timeout(Duration::from_secs(300), rx) => result.map_err(|_| StatusCode::GATEWAY_TIMEOUT)?.map_err(|_| StatusCode::BAD_GATEWAY)?,
    };
    let ready = tokio::time::timeout(Duration::from_secs(300), socket.recv()).await;
    if !matches!(ready, Ok(Some(Ok(Message::Binary(ref data)))) if tunnel::decode_frame(data, true).is_ok_and(|(kind, _)| kind == Frame::Ready)) { return Err(StatusCode::BAD_GATEWAY); }
    let (stream, peer) = tokio::io::duplex(256 * 1024);
    let bridge_cancel = cancel.clone();
    tokio::spawn(async move {
        bridge(socket, peer, bridge_cancel.clone(), permit).await;
        bridge_cancel.cancel();
    });
    Ok(Opened { stream, cancel })
}

async fn bridge(socket: WebSocket, stream: DuplexStream, cancel: CancellationToken, _permit: OwnedSemaphorePermit) {
    let (sink, mut source) = socket.split();
    let sink = Arc::new(tokio::sync::Mutex::new(sink));
    let (mut read, mut write) = tokio::io::split(stream);
    let send = async {
        let mut buffer = vec![0; tunnel::MAX_DATA_CHUNK];
        let mut heartbeat = tokio::time::interval(Duration::from_secs(15));
        loop {
            let count = tokio::select! {
                result = read.read(&mut buffer) => result?,
                _ = heartbeat.tick() => {
                    tokio::time::timeout(Duration::from_secs(10), sink.lock().await.send(Message::Ping(Vec::new().into()))).await.map_err(std::io::Error::other)?.map_err(std::io::Error::other)?;
                    continue;
                }
            };
            let frame = if count == 0 { tunnel::encode_eof() } else { tunnel::encode_data(&buffer[..count], true).map_err(std::io::Error::other)? };
            tokio::time::timeout(Duration::from_secs(10), sink.lock().await.send(Message::Binary(frame.into()))).await.map_err(std::io::Error::other)?.map_err(std::io::Error::other)?;
            if count == 0 { return Ok::<_, std::io::Error>(()); }
        }
    };
    let receive = async {
        loop {
            let frame = tokio::time::timeout(Duration::from_secs(45), source.next()).await.map_err(std::io::Error::other)?;
            match frame {
                Some(Ok(Message::Binary(data))) => match tunnel::decode_frame(&data, true).map_err(std::io::Error::other)? {
                    (Frame::Data, bytes) => write.write_all(&bytes).await?,
                    (Frame::Eof, _) => { write.shutdown().await?; return Ok::<_, std::io::Error>(()); }
                    _ => return Err(std::io::Error::other("Unexpected Ready")),
                },
                Some(Ok(Message::Ping(data))) => { tokio::time::timeout(Duration::from_secs(10), sink.lock().await.send(Message::Pong(data))).await.map_err(std::io::Error::other)?.map_err(std::io::Error::other)?; }
                Some(Ok(Message::Pong(_))) => {}
                _ => return Err(std::io::Error::other("Data socket closed")),
            }
        }
    };
    tokio::select! { _ = cancel.cancelled() => {}, _ = async { let _ = tokio::try_join!(send, receive); } => {} }
}
