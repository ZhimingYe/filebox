//! Browser↔Hub↔Agent terminal relay. Hub authenticates the browser session
//! and single-use transport ticket; Agent alone enrolls and verifies TOTP.
//! Browser disconnect removes its attachment, never the Agent-owned shell.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, Extension, Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use rand::Rng;
use serde::Deserialize;
use tokio::sync::{mpsc, Notify};
use uuid::Uuid;

use filebox_protocol::message::{HubMessage, TERMINAL_CHUNK_MAX_BYTES};

use crate::agent_registry::AgentStatus;
use crate::fs_proxy::PendingResponseCleanup;
use crate::net::client_ip;
use crate::state::{AppState, AuthenticatedSession, PendingResponse, MAX_PENDING_RESPONSES};


/// Single-use transport authorization; this ticket is not proof of TOTP.
pub const TERMINAL_TICKET_TTL_SECS: u64 = 60;
const TERMINAL_TICKET_TTL: Duration = Duration::from_secs(TERMINAL_TICKET_TTL_SECS);
const MAX_TERMINAL_TICKETS: usize = 1024;
/// Hub-wide bound on concurrent terminal sessions.
pub const MAX_TERMINAL_SESSIONS: usize = 16;
/// Buffered agent→browser frames per session. A slow browser must never stall
/// the agent's read loop: when this fills, the browser detaches.
const TERMINAL_BROWSER_QUEUE_CAPACITY: usize = 256;
/// Per-write timeout for outbound browser WS frames (see `ws.rs`).
const TERMINAL_WS_WRITE_TIMEOUT: Duration = Duration::from_secs(10);
/// How long the browser waits for the agent to confirm an open before the hub
/// gives up and reports it. Generous (a loaded node can take seconds to fork a
/// shell) but finite: the alternative is a pane stuck on "Connecting…".
const TERMINAL_OPEN_TIMEOUT: Duration = Duration::from_secs(30);
/// Browser frames carry base64 input; 64 KiB is far beyond any keystroke.
const MAX_BROWSER_WS_MESSAGE_SIZE: usize = 64 * 1024;
const TERMINAL_DETACH_TIMEOUT: Duration = Duration::from_secs(5);
const BROWSER_PING_INTERVAL: Duration = Duration::from_secs(15);
const BROWSER_PONG_TIMEOUT: Duration = Duration::from_secs(45);
const SESSION_CHECK_INTERVAL: Duration = Duration::from_secs(30);

/// Only an answer to our outstanding probe proves the browser is reachable.
/// Shell output or queued input must not extend the browser's lease.
struct BrowserHeartbeat {
    last_pong: Instant,
    pending: Option<String>,
}

impl BrowserHeartbeat {
    fn new(now: Instant) -> Self { Self { last_pong: now, pending: None } }
    fn probe(&mut self) -> String {
        self.pending.get_or_insert_with(|| Uuid::new_v4().to_string()).clone()
    }
    fn acknowledge(&mut self, nonce: &str, now: Instant) {
        if self.pending.as_deref() == Some(nonce) {
            self.pending = None;
            self.last_pong = now;
        }
    }
    fn deadline(&self) -> Instant { self.last_pong + BROWSER_PONG_TIMEOUT }
}

/// Use the sender and abort handle captured when this attachment was opened.
/// Never resolve a replacement connection during delayed cleanup.
async fn detach_terminal(
    sender: &mpsc::Sender<HubMessage>,
    abort: &Notify,
    req_id: &str,
    timeout: Duration,
) {
    let message = HubMessage::TerminalDetach { req_id: req_id.to_string() };
    if !matches!(tokio::time::timeout(timeout, sender.send(message)).await, Ok(Ok(()))) {
        // Closing this transport runs Agent detach_connection(), preserving PTYs.
        // notify_one retains a permit even if the WS loop is currently writing.
        abort.notify_one();
    }
}

#[derive(Clone)]
pub struct TerminalTicket {
    pub principal_id: String,
    pub username: String,
    /// The ticket opens a terminal on this agent only.
    pub agent_id: String,
    pub expires_at: Instant,
}

pub struct TerminalTicketStore {
    tickets: Mutex<HashMap<String, TerminalTicket>>,
}

impl TerminalTicketStore {
    pub fn new() -> Self {
        Self {
            tickets: Mutex::new(HashMap::new()),
        }
    }

    /// Mint a 256-bit ticket bound to the login principal and one agent.
    /// Single-use within its TTL. Each attachment needs a new ticket.
    /// Returns `None` when the store is full of unexpired tickets.
    pub fn mint(&self, principal_id: &str, username: &str, agent_id: &str) -> Option<String> {
        let mut tickets = self.tickets.lock().unwrap_or_else(|e| e.into_inner());
        let now = Instant::now();
        tickets.retain(|_, t| t.expires_at > now);
        if tickets.len() >= MAX_TERMINAL_TICKETS {
            return None;
        }
        let mut rng = rand::rng();
        let mut bytes = [0u8; 32];
        rng.fill(&mut bytes);
        let token = hex::encode(bytes);
        tickets.insert(
            token.clone(),
            TerminalTicket {
                principal_id: principal_id.to_string(),
                username: username.to_string(),
                agent_id: agent_id.to_string(),
                expires_at: now + TERMINAL_TICKET_TTL,
            },
        );
        Some(token)
    }

    /// Check a ticket without consuming it.
    pub fn validate(&self, token: &str) -> Option<TerminalTicket> {
        let mut tickets = self.tickets.lock().unwrap_or_else(|e| e.into_inner());
        let ticket = tickets.get(token)?.clone();
        if ticket.expires_at <= Instant::now() {
            tickets.remove(token);
            return None;
        }
        Some(ticket)
    }

    /// Consume only a ticket belonging to this browser principal and agent.
    pub fn consume(&self, token: &str, principal: &str, agent: &str) -> bool {
        let mut tickets = self.tickets.lock().unwrap_or_else(|e| e.into_inner());
        if tickets.get(token).is_some_and(|t| t.principal_id == principal && t.agent_id == agent && t.expires_at > Instant::now()) {
            tickets.remove(token);
            true
        } else { false }
    }

}

/// A live browser terminal session. `ws.rs` routes agent terminal messages
/// into `tx`; dropping/removing the entry closes the browser socket.
pub struct TerminalSessionEntry {
    pub agent_id: String,
    pub connection_id: u64,
    pub principal_id: String,
    pub revoked: std::sync::Arc<Notify>,
    /// Audit attribution: the session owner and where it came from.
    pub username: String,
    pub ip: String,
    pub user_agent: String,
    pub tx: mpsc::Sender<serde_json::Value>,
}

/// Owner details for audit records, looked up by session id. `None` when the
/// session is already gone (e.g. the browser left before the agent replied).
pub fn terminal_session_owner(state: &AppState, req_id: &str) -> Option<(String, String, String)> {
    let sessions = state
        .terminal_sessions
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    sessions
        .get(req_id)
        .map(|entry| (entry.username.clone(), entry.ip.clone(), entry.user_agent.clone()))
}

/// Relay agent terminal output to the browser, splitting anything larger than
/// the protocol chunk cap.
///
/// `TERMINAL_CHUNK_MAX_BYTES` is a contract the agent honors, but the hub is
/// the trust boundary: a buggy or hostile agent can send one frame up to the
/// 24 MiB agent-WebSocket cap, and the per-session browser queue holds 256
/// frames — so a single oversized message could otherwise pin hundreds of
/// megabytes of hub memory. Splitting keeps the queue bounded by bytes and
/// loses no output.
pub fn forward_terminal_output(
    state: &AppState,
    agent_id: &str,
    connection_id: u64,
    req_id: &str,
    data: &[u8],
) {
    for chunk in output_chunks(data) {
        let frame = serde_json::json!({
            "type": "output",
            "data": base64::engine::general_purpose::STANDARD.encode(chunk),
        });
        forward_to_terminal_session(state, agent_id, connection_id, req_id, frame, false);
    }
}

/// Split one agent output payload into protocol-sized chunks. Empty input
/// produces no frames.
fn output_chunks(data: &[u8]) -> impl Iterator<Item = &[u8]> {
    data.chunks(TERMINAL_CHUNK_MAX_BYTES)
}

/// Forward an agent terminal frame to the owning browser socket. Verifies the
/// session belongs to this agent connection (a stale/superseded connection
/// must not talk to a newer one's terminal). `close` also removes the
/// session, dropping the sender so the browser pump ends.
pub fn forward_to_terminal_session(
    state: &AppState,
    agent_id: &str,
    connection_id: u64,
    req_id: &str,
    frame: serde_json::Value,
    close: bool,
) {
    let tx = {
        let mut sessions = state
            .terminal_sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        match sessions.get(req_id) {
            Some(entry) if entry.agent_id == agent_id && entry.connection_id == connection_id => {
                let tx = entry.tx.clone();
                if close {
                    // Remove only for the verified owner. A superseded agent
                    // connection relaying a late frame must not be able to
                    // tear down the session that replaced it.
                    sessions.remove(req_id);
                }
                Some(tx)
            }
            Some(_) => {
                tracing::warn!(
                    "Ignoring terminal message for req_id {} from agent {} connection {}: owner mismatch",
                    req_id,
                    agent_id,
                    connection_id
                );
                None
            }
            None => None,
        }
    };
    if let Some(tx) = tx {
        if tx.try_send(frame).is_err() {
            let mut sessions = state.terminal_sessions.lock().unwrap_or_else(|e| e.into_inner());
            if sessions.get(req_id).is_some_and(|entry| entry.agent_id == agent_id && entry.connection_id == connection_id) {
                sessions.remove(req_id);
            }
        }
    }
}

/// Drop every terminal session owned by a dying agent connection so the
/// browser sockets close instead of hanging on a dead agent.
pub fn close_terminal_sessions_for_connection(
    state: &AppState,
    agent_id: &str,
    connection_id: u64,
) -> usize {
    let mut sessions = state
        .terminal_sessions
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let before = sessions.len();
    sessions.retain(|_, entry| {
        !(entry.agent_id == agent_id && entry.connection_id == connection_id)
    });
    before - sessions.len()
}

/// Wake pumps immediately, bypassing any queued output. Shells are detached,
/// not killed; each pump cleans up only its captured Agent connection.
pub fn revoke_terminal_sessions(state: &AppState, principal_id: &str) {
    let mut sessions = state.terminal_sessions.lock().unwrap_or_else(|e| e.into_inner());
    sessions.retain(|_, entry| {
        if entry.principal_id != principal_id { return true; }
        entry.revoked.notify_one();
        false
    });
}

async fn terminal_session_valid(state: &AppState, principal_id: &str) -> bool {
    state.inner.read().await.sessions.get_session_by_principal(principal_id).is_some()
}

async fn forward_terminal_input(
    state: &AppState, principal_id: &str, agent_id: &str, connection_id: u64,
    sender: &mpsc::Sender<HubMessage>, message: HubMessage,
) -> Result<(), &'static str> {
    // Validation and enqueue share the registry read: logout cannot complete
    // between them, and reconnect cannot redirect stale attachment input.
    let inner = state.inner.read().await;
    if inner.sessions.get_session_by_principal(principal_id).is_none() { return Err("unauthorized"); }
    if !inner.agents.is_current_connection(agent_id, connection_id) { return Err("backend_offline"); }
    sender.try_send(message).map_err(|_| "terminal_input_stalled")
}

// ── TOTP 2FA HTTP endpoints ─────────────────────────────────────────────────

async fn session_username(state: &AppState, session: &AuthenticatedSession) -> String {
    let inner = state.inner.read().await;
    inner
        .sessions
        .get_session(&session.id)
        .map(|s| s.username.clone())
        .unwrap_or_default()
}

fn user_agent(headers: &HeaderMap) -> String {
    headers
        .get(axum::http::header::USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string()
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

fn mint_ticket_response(
    state: &AppState,
    principal_id: &str,
    username: &str,
    agent_id: &str,
) -> Response {
    match state.terminal_tickets.mint(principal_id, username, agent_id) {
        Some(ticket) => Json(serde_json::json!({
            "ticket": ticket,
            "expires_in_sec": TERMINAL_TICKET_TTL_SECS,
        }))
        .into_response(),
        None => error_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "terminal_overloaded",
            "Too many outstanding terminal tickets. Retry shortly.",
            true,
        ),
    }
}

/// Session + CSRF-protected transport ticket. TOTP is checked only by Agent.
pub async fn terminal_ticket_handler(
    State(state): State<AppState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path(agent_id): Path<String>,
) -> Response {
    let inner = state.inner.read().await;
    let Some(agent) = inner.agents.get(&agent_id) else {
        return error_response(StatusCode::NOT_FOUND, "backend_offline", "Agent unavailable", true);
    };
    if !agent.capabilities.terminal_persistent || !agent.capabilities.terminal_agent_2fa {
        return error_response(StatusCode::BAD_REQUEST, "terminal_2fa_not_configured", "Upgrade the Agent and run agent --setup-terminal-2fa locally", false);
    }
    drop(inner);
    let username = session_username(&state, &session).await;
    mint_ticket_response(&state, &session.principal_id, &username, &agent_id)
}

// ── Terminal session management ─────────────────────────────────────────────

/// A session id is the `term_<uuid>` minted when the session opened. Bounded
/// length and charset so the path segment can never be an arbitrary relay key.
fn is_valid_terminal_session_id(req_id: &str) -> bool {
    let Some(rest) = req_id.strip_prefix("term_") else {
        return false;
    };
    (8..=48).contains(&rest.len())
        && rest
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// `GET /api/agents/{id}/terminals` — ask the agent (the source of truth) for
/// its live terminal sessions. This is the zombie-recovery path: it may list
/// sessions the hub no longer tracks. No TOTP ticket is required — listing and
/// killing shells is strictly less dangerous than opening one, and the
/// endpoint sits behind the login session + CSRF like every other control API.
pub async fn terminals_list_handler(
    State(state): State<AppState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path(agent_id): Path<String>,
) -> Response {
    let inner = state.inner.read().await;
    let Some(agent) = inner.agents.get(&agent_id) else {
        return error_response(
            StatusCode::NOT_FOUND,
            "backend_offline",
            &format!("Agent {} not found or offline", agent_id),
            true,
        );
    };
    if agent.status == AgentStatus::Offline {
        return error_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "backend_offline",
            &format!("Agent {} is offline", agent_id),
            true,
        );
    }
    if !agent.capabilities.terminal_manage {
        return error_response(
            StatusCode::BAD_REQUEST,
            "unsupported_feature",
            "This agent does not support terminal session management — upgrade the agent",
            false,
        );
    }

    let req_id = format!("term_list_{}", Uuid::new_v4());
    let (resp_tx, mut resp_rx) = mpsc::channel(1);
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
            inner.agents.send_to_agent(
                &agent_id,
                HubMessage::TerminalListRequest {
                    req_id: req_id.clone(),
                },
            )
        }
    };
    drop(inner);
    if !send_ok {
        let pending = state.inner.read().await.pending_responses.clone();
        pending.write().await.remove(&req_id);
        return error_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "backend_offline",
            "Failed to send request to agent",
            true,
        );
    }

    // Frees the pending slot even if this handler is dropped mid-wait.
    let cleanup = PendingResponseCleanup::new(state.clone(), req_id.clone(), Some(agent_id.clone()));
    let resp = tokio::time::timeout(Duration::from_secs(30), resp_rx.recv()).await;
    let cancelled = !matches!(resp, Ok(Some(_)));
    cleanup.finish(cancelled).await;

    match resp {
        Ok(Some(value)) => {
            // The connection teardown (`fail_pending_for_connection`) and the
            // agent both report failures as an `error` payload. Answering 200
            // with an empty list here would be a lie exactly when the operator
            // is hunting zombie sessions.
            if let Some(error) = value.get("error").and_then(|e| e.as_str()) {
                return error_response(
                    StatusCode::SERVICE_UNAVAILABLE,
                    error,
                    "The backend could not list its terminal sessions",
                    true,
                );
            }
            Json(serde_json::json!({
                "sessions": value.get("sessions").cloned().unwrap_or_else(|| serde_json::json!([])),
            }))
            .into_response()
        }
        _ => error_response(
            StatusCode::GATEWAY_TIMEOUT,
            "request_timeout",
            "Agent did not respond in time",
            true,
        ),
    }
}

/// `DELETE /api/agents/{id}/terminals/{req_id}` — force-kill a live session.
/// The Agent owns the shell; refetch to confirm delivery before retrying.
pub async fn terminal_kill_handler(
    State(state): State<AppState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path((agent_id, req_id)): Path<(String, String)>,
    ConnectInfo(addr): ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
) -> Response {
    if !is_valid_terminal_session_id(&req_id) {
        return error_response(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "Invalid terminal session id",
            false,
        );
    }

    let username = session_username(&state, &session).await;
    let ip = client_ip(&headers, addr);

    {
        let inner = state.inner.read().await;
        let Some(agent) = inner.agents.get(&agent_id) else {
            return error_response(
                StatusCode::NOT_FOUND,
                "backend_offline",
                &format!("Agent {} not found or offline", agent_id),
                true,
            );
        };
        if agent.status == AgentStatus::Offline {
            return error_response(
                StatusCode::SERVICE_UNAVAILABLE,
                "backend_offline",
                &format!("Agent {} is offline", agent_id),
                true,
            );
        }
        if !agent.capabilities.terminal_manage {
            return error_response(
                StatusCode::NOT_IMPLEMENTED,
                "unsupported_feature",
                "This agent does not support terminal session management — upgrade the agent",
                false,
            );
        }
        let sent = inner.agents.send_to_agent(
            &agent_id,
            HubMessage::TerminalClose {
                req_id: req_id.clone(),
            },
        );
        if !sent {
            return error_response(StatusCode::SERVICE_UNAVAILABLE, "backend_offline", "Could not deliver the end request; retry", true);
        }
    }

    tracing::info!(target: "audit", ip = %ip, user = %username, agent_id = %agent_id, req_id = %req_id, "terminal_kill");
    state
        .audit
        .record("terminal_kill", &username, &ip, &user_agent(&headers));

    (StatusCode::ACCEPTED, Json(serde_json::json!({ "ok": true }))).into_response()
}

// ── Browser terminal WebSocket ──────────────────────────────────────────────

/// Prefix of the subprotocol token carrying the agent-side TOTP code. The
/// WebSocket handshake is the only place a browser may put a header, and a
/// query parameter would be recorded by every proxy access log — the same
/// reason the terminal ticket travels here instead of in the URL.
const AGENT_CODE_PROTOCOL_PREFIX: &str = "filebox-agent-code.";

#[derive(Deserialize)]
pub struct TerminalWsParams {
    pub cols: Option<u16>,
    pub rows: Option<u16>,
    pub session_id: Option<String>,
}

/// The `Sec-WebSocket-Protocol` tokens the browser offered, in order.
fn subprotocol_tokens(headers: &HeaderMap) -> Vec<String> {
    headers
        .get(axum::http::header::SEC_WEBSOCKET_PROTOCOL)
        .and_then(|value| value.to_str().ok())
        .map(|value| {
            value
                .split(',')
                .map(str::trim)
                .filter(|token| !token.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// Pass through only a well-formed 6-digit agent TOTP code.
fn sanitize_agent_code(code: Option<String>) -> Option<String> {
    code.filter(|c| c.len() == 6 && c.bytes().all(|b| b.is_ascii_digit()))
}

/// The agent code offered as a subprotocol token, when well-formed.
fn agent_code_from_tokens(tokens: &[String]) -> Option<String> {
    sanitize_agent_code(
        tokens
            .iter()
            .find_map(|token| token.strip_prefix(AGENT_CODE_PROTOCOL_PREFIX))
            .map(str::to_string),
    )
}

/// Browser→hub terminal frames (JSON text).
#[derive(Deserialize)]
#[serde(tag = "type")]
enum BrowserTerminalFrame {
    #[serde(rename = "input")]
    Input { data: String, #[serde(default)] seq: Option<u64> },
    #[serde(rename = "resize")]
    Resize { cols: u16, rows: u16 },
    #[serde(rename = "close")]
    Close,
    #[serde(rename = "pong")]
    Pong { nonce: String },
}

pub async fn terminal_ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    Path(agent_id): Path<String>,
    Query(params): Query<TerminalWsParams>,
    ConnectInfo(addr): ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
) -> Response {
    let ip = client_ip(&headers, addr);

    // Same sandbox guard as every protected route: a sandboxed preview iframe
    // (Origin: null) must not be able to drive the terminal API even with a
    // ticket it somehow obtained.
    if headers
        .get(axum::http::header::ORIGIN)
        .and_then(|v| v.to_str().ok())
        == Some("null")
    {
        return error_response(
            StatusCode::FORBIDDEN,
            "permission_denied",
            "Sandboxed previews cannot open terminals",
            false,
        );
    }

    // 1) Ticket: 256-bit, TTL-bound to the login principal AND the path
    // agent — a ticket minted for another agent must not open a terminal
    // here (same error as unknown/expired to avoid leaking ticket validity).
    // It rides the Sec-WebSocket-Protocol handshake header (browsers cannot
    // set arbitrary WS headers); a URL query ticket would end up in access
    // logs and browser history.
    //
    // Every offered token is tried: an intermediary may list another protocol
    // first, and only the ticket store knows which token is a live ticket.
    let tokens = subprotocol_tokens(&headers);
    let Some((ticket_token, ticket)) = tokens.iter().find_map(|token| {
        state
            .terminal_tickets
            .validate(token)
            .filter(|ticket| ticket.agent_id == agent_id)
            .map(|ticket| (token.clone(), ticket))
    }) else {
        return error_response(
            StatusCode::UNAUTHORIZED,
            "terminal_ticket_invalid",
            "Terminal ticket missing or expired. Verify 2FA again.",
            true,
        );
    };

    // 2) Session cookie must be present, valid, and owned by the ticket's
    // principal — the ticket alone must not suffice from another browser.
    let cookie_ok = match crate::routes::session_cookie(&headers) {
        Some(sid) => {
            let inner = state.inner.read().await;
            inner
                .sessions
                .get_session(&sid)
                .is_some_and(|s| s.principal_id == ticket.principal_id)
        }
        None => false,
    };
    if !cookie_ok {
        return error_response(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "No session cookie. Please login first.",
            false,
        );
    }

    {
        let inner = state.inner.read().await;
        let Some(agent) = inner.agents.get(&agent_id) else {
            return error_response(
                StatusCode::NOT_FOUND,
                "backend_offline",
                &format!("Agent {} not found or offline", agent_id),
                true,
            );
        };
        if agent.status == AgentStatus::Offline {
            return error_response(
                StatusCode::SERVICE_UNAVAILABLE,
                "backend_offline",
                &format!("Agent {} is offline", agent_id),
                true,
            );
        }
        if !agent.capabilities.terminal || !agent.capabilities.terminal_persistent || !agent.capabilities.terminal_agent_2fa {
            return error_response(
                StatusCode::NOT_IMPLEMENTED,
                "unsupported_feature",
                "This agent does not support remote terminals — upgrade the agent",
                false,
            );
        }
        // `connection_id` is deliberately NOT captured here: the agent may
        // re-register before the open below, which rotates it. It is resolved
        // under the same lock as the send (see `handle_terminal_socket`).
    }

    // Advisory only. The authoritative capacity check runs after the upgrade,
    // under the session-registry lock, because only there can the failure be
    // reported to the browser as an in-band error frame (an HTTP 503 body is
    // unreadable by `new WebSocket`).
    {
        let sessions = state
            .terminal_sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if sessions.len() >= MAX_TERMINAL_SESSIONS {
            return error_response(
                StatusCode::SERVICE_UNAVAILABLE,
                "terminal_overloaded",
                "Too many concurrent terminal sessions. Close one and retry.",
                true,
            );
        }
    }

    let cols = params.cols.unwrap_or(80).clamp(1, 500);
    let rows = params.rows.unwrap_or(24).clamp(1, 500);
    let agent_totp_code =
        agent_code_from_tokens(&tokens);
    if params.session_id.as_ref().is_some_and(|id| !is_valid_terminal_session_id(id)) {
        return error_response(StatusCode::BAD_REQUEST, "invalid_request", "Invalid terminal session id", false);
    }
    if !state.terminal_tickets.consume(&ticket_token, &ticket.principal_id, &agent_id) {
        return error_response(StatusCode::UNAUTHORIZED, "terminal_ticket_invalid", "Ticket already used or expired", true);
    }
    let agent_ua = user_agent(&headers);

    ws.max_message_size(MAX_BROWSER_WS_MESSAGE_SIZE)
        .max_frame_size(MAX_BROWSER_WS_MESSAGE_SIZE)
        // Echo the ticket subprotocol back so the negotiated protocol
        // matches what the browser offered in the handshake.
        .protocols([ticket_token])
        .on_upgrade(move |socket| {
            handle_terminal_socket(
                socket,
                state,
                agent_id,
                ticket,
                cols,
                rows,
                agent_totp_code,
                ip,
                agent_ua,
                params.session_id,
            )
        })
        .into_response()
}

#[allow(clippy::too_many_arguments)]
async fn handle_terminal_socket(
    socket: WebSocket,
    state: AppState,
    agent_id: String,
    ticket: TerminalTicket,
    cols: u16,
    rows: u16,
    agent_totp_code: Option<String>,
    ip: String,
    user_agent: String,
    session_id: Option<String>,
) {
    let req_id = format!("term_{}", Uuid::new_v4());
    let stable_id = session_id.clone().unwrap_or_else(|| req_id.clone());
    let (tx, mut rx) = mpsc::channel::<serde_json::Value>(TERMINAL_BROWSER_QUEUE_CAPACITY);
    let (mut ws_sink, mut ws_stream) = socket.split();
    let revoked = std::sync::Arc::new(Notify::new());

    // Register the session and queue the open under ONE registry read. The
    // agent can re-register at any moment (abort-on-reregister is routine),
    // which rotates its `connection_id`; binding the entry to the id the
    // message was actually queued on is what keeps the replies routable.
    // Capturing the id earlier and sending later would make every reply look
    // like it came from a stranger — dropped, slot leaked, pane hung forever.
    let outcome = {
        let inner = state.inner.read().await;
        let mut sessions = state
            .terminal_sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if inner.sessions.get_session_by_principal(&ticket.principal_id).is_none() {
            Err("unauthorized")
        } else if !inner.agents.get(&agent_id).is_some_and(|a| a.capabilities.terminal_persistent && a.capabilities.terminal_agent_2fa) {
            Err("unsupported_feature")
        } else if sessions.len() >= MAX_TERMINAL_SESSIONS {
            Err("terminal_overloaded")
        } else {
            match inner.agents.send_to_agent_current(
                &agent_id,
                match session_id {
                    Some(session_id) => HubMessage::TerminalAttach { req_id: req_id.clone(), session_id, agent_totp_code },
                    None => HubMessage::TerminalOpen { req_id: req_id.clone(), cols, rows, agent_totp_code },
                },
            ) {
                Some(connection_id) => {
                    sessions.insert(
                        req_id.clone(),
                        TerminalSessionEntry {
                            agent_id: agent_id.clone(),
                            connection_id,
                            principal_id: ticket.principal_id.clone(),
                            revoked: revoked.clone(),
                            username: ticket.username.clone(),
                            ip: ip.clone(),
                            user_agent: user_agent.clone(),
                            tx,
                        },
                    );
                    let agent = inner.agents.get(&agent_id).expect("Agent was just resolved under this registry lock");
                    Ok((agent.sender.clone(), agent.abort_notify.clone(), connection_id))
                }
                None => Err("backend_offline"),
            }
        }
    };
    let (agent_sender, agent_abort, connection_id) = match outcome {
        Ok(connection) => connection,
        Err(code) => {
            send_terminal_frame(&mut ws_sink, serde_json::json!({"type": "error", "error": code})).await;
            return;
        }
    };

    // `terminal_opened` is audited by `ws.rs` when the agent CONFIRMS the
    // session, so a rejected open (agent-side 2FA, no PTY) is not recorded as
    // a shell that was handed out.

    // Pump both directions in one loop: agent→browser frames arrive on `rx`
    // (routed from ws.rs via the session entry); browser→agent frames are
    // parsed here and forwarded as Terminal* hub messages. The loop ends when
    // the browser socket closes/errors, or when `rx` closes because the
    // session entry was removed (agent TerminalClosed / agent disconnect).
    //
    // The open itself is on a deadline: without one a lost reply (wedged
    // agent, dropped frame) leaves the browser on "Connecting…" forever and
    // holds one of the 16 session slots.
    let open_deadline = tokio::time::sleep(TERMINAL_OPEN_TIMEOUT);
    tokio::pin!(open_deadline);
    let mut confirmed = false;
    let mut heartbeat = BrowserHeartbeat::new(Instant::now());
    let mut session_check = tokio::time::interval(SESSION_CHECK_INTERVAL);
    let mut ping_interval = tokio::time::interval_at(
        tokio::time::Instant::now() + BROWSER_PING_INTERVAL, BROWSER_PING_INTERVAL,
    );
    ping_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            () = revoked.notified() => {
                send_terminal_frame(&mut ws_sink, serde_json::json!({"type": "error", "error": "unauthorized"})).await;
                break;
            }
            _ = session_check.tick() => {
                if !terminal_session_valid(&state, &ticket.principal_id).await {
                    send_terminal_frame(&mut ws_sink, serde_json::json!({"type": "error", "error": "unauthorized"})).await;
                    break;
                }
            }
            () = tokio::time::sleep_until(tokio::time::Instant::from_std(heartbeat.deadline())) => {
                // No keyboard-idle timeout: only a missing heartbeat detaches.
                break;
            }
            _ = ping_interval.tick() => {
                if !send_terminal_frame(&mut ws_sink, serde_json::json!({
                    "type": "ping", "nonce": heartbeat.probe(),
                })).await { break; }
            }
            () = &mut open_deadline, if !confirmed => {
                tracing::warn!(
                    "Terminal session {} was not confirmed by agent {} within {:?}; closing",
                    req_id,
                    agent_id,
                    TERMINAL_OPEN_TIMEOUT
                );
                let _ = send_terminal_frame(
                    &mut ws_sink,
                    serde_json::json!({"type": "error", "error": "terminal_open_timeout"}),
                )
                .await;
                break;
            }
            frame = rx.recv() => {
                match frame {
                    Some(mut value) => {
                        if !terminal_session_valid(&state, &ticket.principal_id).await {
                            send_terminal_frame(&mut ws_sink, serde_json::json!({"type": "error", "error": "unauthorized"})).await;
                            break;
                        }
                        if value.get("type").and_then(|v| v.as_str()) == Some("opened") { value["session_id"] = serde_json::json!(stable_id); }
                        // The open is confirmed by the agent's first word on the
                        // session (`opened`, or an `error` about the open).
                        if matches!(
                            value.get("type").and_then(|kind| kind.as_str()),
                            Some("opened") | Some("error")
                        ) {
                            confirmed = true;
                        }
                        if !send_terminal_frame(&mut ws_sink, value).await {
                            break;
                        }
                    }
                    None => {
                        let _ = tokio::time::timeout(
                            TERMINAL_WS_WRITE_TIMEOUT,
                            ws_sink.send(Message::Close(None)),
                        )
                        .await;
                        break;
                    }
                }
            }
            msg = ws_stream.next() => {
                match msg {
                    None => break,
                    Some(Err(_)) => break,
                    Some(Ok(Message::Close(_))) => break,
                    Some(Ok(Message::Text(text))) => {
                        match serde_json::from_str::<BrowserTerminalFrame>(&text) {
                            Ok(BrowserTerminalFrame::Input { data, seq }) => {
                                let Ok(bytes) =
                                    base64::engine::general_purpose::STANDARD.decode(&data)
                                else {
                                    continue;
                                };
                                if let Err(error) = forward_terminal_input(
                                    &state, &ticket.principal_id, &agent_id, connection_id, &agent_sender,
                                    HubMessage::TerminalInput { req_id: req_id.clone(), data: bytes, seq },
                                ).await {
                                    send_terminal_frame(&mut ws_sink, serde_json::json!({"type": "error", "error": error})).await;
                                    break;
                                }
                            }
                            Ok(BrowserTerminalFrame::Resize { cols, rows }) => {
                                if let Err(error) = forward_terminal_input(
                                    &state, &ticket.principal_id, &agent_id, connection_id, &agent_sender,
                                    HubMessage::TerminalResize { req_id: req_id.clone(), cols: cols.clamp(1, 500), rows: rows.clamp(1, 500) },
                                ).await {
                                    send_terminal_frame(&mut ws_sink, serde_json::json!({"type": "error", "error": error})).await;
                                    break;
                                }
                            }
                            Ok(BrowserTerminalFrame::Pong { nonce }) => {
                                heartbeat.acknowledge(&nonce, Instant::now());
                            }
                            Ok(BrowserTerminalFrame::Close) => break,
                            Err(_) => {}
                        }
                    }
                    _ => {}
                }
            }
        }
    }

    // Stop routing and close the browser transport before bounded Agent cleanup.
    state.terminal_sessions.lock().unwrap_or_else(|e| e.into_inner()).remove(&req_id);
    drop(ws_sink);
    drop(ws_stream);
    detach_terminal(&agent_sender, &agent_abort, &req_id, TERMINAL_DETACH_TIMEOUT).await;
    tracing::info!(target: "audit", ip = %ip, user = %ticket.username, agent_id = %agent_id, "terminal_detached");
    state
        .audit
        .record("terminal_detached", &ticket.username, &ip, &user_agent);
}

async fn send_terminal_frame(
    ws_sink: &mut futures_util::stream::SplitSink<WebSocket, Message>,
    frame: serde_json::Value,
) -> bool {
    matches!(
        tokio::time::timeout(
            TERMINAL_WS_WRITE_TIMEOUT,
            ws_sink.send(Message::Text(frame.to_string().into())),
        )
        .await,
        Ok(Ok(()))
    )
}

#[cfg(test)]
mod tests {
    use futures_util::FutureExt;
    use super::*;

    fn test_state() -> AppState {
        AppState::new(&crate::config::HubConfig {
            listen_addr: "127.0.0.1:0".parse().unwrap(), agent_token_hash: "fake-hash".into(), users: vec![],
        }, false)
    }

    #[tokio::test]
    async fn terminal_input_checks_live_principal_and_captured_connection() {
        let state = test_state();
        let (sender, mut receiver) = mpsc::channel(8);
        let (mut session, connection_id) = {
            let mut inner = state.inner.write().await;
            let (session, _) = inner.sessions.create_session("alice", false);
            inner.agents.register("a".into(), "agent".into(), sender.clone(),
                std::sync::Arc::new(Notify::new()), 0, vec![], 0, vec![], Default::default(), None);
            (session, inner.agents.get("a").unwrap().connection_id)
        };
        let input = || HubMessage::TerminalInput { req_id: "route".into(), data: b"command".to_vec(), seq: Some(1) };
        assert_eq!(forward_terminal_input(&state, &session.principal_id, "a", connection_id, &sender, input()).await, Ok(()));
        assert!(matches!(receiver.try_recv(), Ok(HubMessage::TerminalInput { seq: Some(1), .. })));
        // Cookie rotation retains the stable principal authorizing the socket.
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs();
        session.created_at = now - 100;
        session.expires_at = now + 10;
        {
            let mut inner = state.inner.write().await;
            inner.sessions.sessions_insert_for_test(session.clone());
            let (rotated, cookie) = inner.sessions.refresh_session_after_auth(&session.session_id).unwrap();
            assert!(cookie.is_some());
            assert_ne!(rotated.session_id, session.session_id);
            session = rotated;
        }
        assert!(terminal_session_valid(&state, &session.principal_id).await);
        assert_eq!(forward_terminal_input(&state, &session.principal_id, "a", connection_id, &sender, input()).await, Ok(()));
        receiver.try_recv().unwrap();
        session.expires_at = 0;
        state.inner.write().await.sessions.sessions_insert_for_test(session.clone());
        assert!(!terminal_session_valid(&state, &session.principal_id).await);
        assert_eq!(forward_terminal_input(&state, &session.principal_id, "a", connection_id, &sender, input()).await, Err("unauthorized"));
        session.expires_at = now + 100;
        state.inner.write().await.sessions.sessions_insert_for_test(session.clone());
        let (replacement, mut replacement_rx) = mpsc::channel(8);
        state.inner.write().await.agents.register("a".into(), "replacement".into(), replacement,
            std::sync::Arc::new(Notify::new()), 0, vec![], 0, vec![], Default::default(), None);
        assert_eq!(forward_terminal_input(&state, &session.principal_id, "a", connection_id, &sender, input()).await, Err("backend_offline"));
        state.inner.write().await.sessions.remove(&session.session_id);
        assert_eq!(forward_terminal_input(&state, &session.principal_id, "a", connection_id, &sender, input()).await, Err("unauthorized"));
        assert!(receiver.try_recv().is_err());
        assert!(replacement_rx.try_recv().is_err());
    }

    #[test]
    fn tickets_are_single_use_and_principal_bound() {
        let store = TerminalTicketStore::new();
        let token = store.mint("p1", "alice", "agent-a").unwrap();
        let ticket = store.validate(&token).unwrap();
        assert_eq!(ticket.principal_id, "p1");
        assert_eq!(ticket.username, "alice");
        assert_eq!(ticket.agent_id, "agent-a");
        // A different principal cannot consume the ticket.
        assert!(!store.consume(&token, "p2", "agent-a"));
        assert!(store.validate(&token).is_some());
        // Another principal must not be able to keep someone else's ticket
        // alive, even though it holds a valid session of its own.
        assert!(store.consume(&token, "p1", "agent-a"));
        assert!(!store.consume(&token, "p1", "agent-a"));
        // Unknown tokens cannot validate or be consumed.
        assert!(store.validate("nope").is_none());
        assert!(!store.consume("nope", "p1", "agent-a"));
    }

    #[test]
    fn tickets_are_agent_bound() {
        let store = TerminalTicketStore::new();
        let token = store.mint("p1", "alice", "agent-a").unwrap();
        let ticket = store.validate(&token).unwrap();
        // The WS handler rejects the upgrade when this doesn't match the
        // path agent id.
        assert!(ticket.agent_id != "agent-b");
    }

    #[test]
    fn expired_ticket_cannot_be_consumed() {
        let store = TerminalTicketStore::new();
        let token = store.mint("p1", "alice", "agent-a").unwrap();
        {
            let mut tickets = store.tickets.lock().unwrap_or_else(|e| e.into_inner());
            tickets.get_mut(&token).unwrap().expires_at =
                Instant::now() - Duration::from_secs(1);
        }
        assert!(store.validate(&token).is_none());
        assert!(!store.consume(&token, "p1", "agent-a"));
    }

    #[test]
    fn terminal_session_id_validation() {
        assert!(is_valid_terminal_session_id(
            "term_550e8400-e29b-41d4-a716-446655440000"
        ));
        assert!(is_valid_terminal_session_id("term_0123456789abcdef"));
        // Wrong prefix, empty/short payloads, over-length ids and path-ish
        // payloads are all rejected (the id becomes a relay key).
        assert!(!is_valid_terminal_session_id("fs_list_abc"));
        assert!(!is_valid_terminal_session_id("term"));
        assert!(!is_valid_terminal_session_id("term_"));
        assert!(!is_valid_terminal_session_id("term_short"));
        assert!(!is_valid_terminal_session_id(&format!("term_{}", "x".repeat(49))));
        assert!(!is_valid_terminal_session_id("term_../../etc/passwd"));
        assert!(!is_valid_terminal_session_id(""));
    }

    #[test]
    fn sanitize_agent_code_accepts_only_six_digits() {
        assert_eq!(
            sanitize_agent_code(Some("123456".to_string())),
            Some("123456".to_string())
        );
        assert_eq!(sanitize_agent_code(Some("12345".to_string())), None);
        assert_eq!(sanitize_agent_code(Some("1234567".to_string())), None);
        assert_eq!(sanitize_agent_code(Some("abcdef".to_string())), None);
        assert_eq!(sanitize_agent_code(None), None);
    }

    #[test]
    fn subprotocol_tokens_are_read_in_order() {
        let mut headers = HeaderMap::new();
        assert!(subprotocol_tokens(&headers).is_empty());
        headers.insert(
            axum::http::header::SEC_WEBSOCKET_PROTOCOL,
            axum::http::HeaderValue::from_static(" filebox-agent-code.123456 , ticket-a,,ticket-b "),
        );
        assert_eq!(
            subprotocol_tokens(&headers),
            vec![
                "filebox-agent-code.123456".to_string(),
                "ticket-a".to_string(),
                "ticket-b".to_string()
            ]
        );
    }

    #[test]
    fn agent_code_comes_from_the_handshake_not_the_url() {
        let tokens = vec![
            "filebox-agent-code.123456".to_string(),
            "ticket-a".to_string(),
        ];
        assert_eq!(agent_code_from_tokens(&tokens), Some("123456".to_string()));
        // A malformed or absent code is passed through as "no code", which the
        // agent rejects when it requires one.
        assert_eq!(
            agent_code_from_tokens(&["filebox-agent-code.12345".to_string()]),
            None
        );
        assert_eq!(
            agent_code_from_tokens(&["filebox-agent-code.abcdef".to_string()]),
            None
        );
        assert_eq!(agent_code_from_tokens(&["ticket-a".to_string()]), None);
    }

    #[tokio::test]
    async fn detach_waits_for_queue_capacity_instead_of_dropping() {
        let (sender, mut receiver) = mpsc::channel(1);
        sender.send(HubMessage::Ping).await.unwrap();
        let abort = std::sync::Arc::new(Notify::new());
        let task_abort = abort.clone();
        let cleanup = tokio::spawn(async move {
            detach_terminal(&sender, &task_abort, "attachment", Duration::from_secs(1)).await;
        });
        tokio::task::yield_now().await;
        assert!(!cleanup.is_finished());
        assert!(matches!(receiver.recv().await, Some(HubMessage::Ping)));
        cleanup.await.unwrap();
        assert!(matches!(receiver.recv().await, Some(HubMessage::TerminalDetach { req_id }) if req_id == "attachment"));
        assert!(abort.notified().now_or_never().is_none());
    }

    #[tokio::test]
    async fn stuck_detach_aborts_only_its_captured_connection() {
        let (sender, mut receiver) = mpsc::channel(1);
        sender.send(HubMessage::Ping).await.unwrap();
        let old_abort = Notify::new();
        let replacement_abort = Notify::new();
        detach_terminal(&sender, &old_abort, "old-attachment", Duration::from_millis(10)).await;
        assert!(old_abort.notified().now_or_never().is_some());
        assert!(replacement_abort.notified().now_or_never().is_none());
        assert!(matches!(receiver.recv().await, Some(HubMessage::Ping)));
        assert!(receiver.try_recv().is_err()); // Timed-out send was cancelled.
    }

    #[tokio::test]
    async fn closed_agent_queue_does_not_leave_cleanup_waiting() {
        let (sender, receiver) = mpsc::channel(1);
        drop(receiver);
        let abort = Notify::new();
        tokio::time::timeout(Duration::from_secs(1), detach_terminal(
            &sender, &abort, "attachment", Duration::from_secs(5),
        )).await.unwrap();
        assert!(abort.notified().now_or_never().is_some());
    }

    #[test]
    fn heartbeat_requires_a_matching_fresh_reply_and_does_not_use_shell_activity() {
        let start = Instant::now();
        let mut heartbeat = BrowserHeartbeat::new(start);
        let nonce = heartbeat.probe();
        assert_eq!(heartbeat.probe(), nonce); // Retries do not replace a pending probe.
        heartbeat.acknowledge("wrong", start + Duration::from_secs(20));
        assert_eq!(heartbeat.deadline(), start + BROWSER_PONG_TIMEOUT);
        heartbeat.acknowledge(&nonce, start + Duration::from_secs(25));
        let healthy_deadline = start + Duration::from_secs(25) + BROWSER_PONG_TIMEOUT;
        assert_eq!(heartbeat.deadline(), healthy_deadline);
        heartbeat.acknowledge(&nonce, start + Duration::from_secs(40));
        assert_eq!(heartbeat.deadline(), healthy_deadline); // Replayed pong is ignored.
        assert_ne!(heartbeat.probe(), nonce);
    }

    #[test]
    fn output_chunks_split_at_the_protocol_cap() {
        let sizes = |len: usize| {
            output_chunks(&vec![0u8; len])
                .map(<[u8]>::len)
                .collect::<Vec<_>>()
        };
        assert_eq!(sizes(0), Vec::<usize>::new());
        assert_eq!(sizes(16), vec![16]);
        assert_eq!(
            sizes(TERMINAL_CHUNK_MAX_BYTES),
            vec![TERMINAL_CHUNK_MAX_BYTES]
        );
        assert_eq!(
            sizes(TERMINAL_CHUNK_MAX_BYTES + 1),
            vec![TERMINAL_CHUNK_MAX_BYTES, 1]
        );
        // 40 KiB must not survive as one frame in a 256-deep queue.
        assert_eq!(sizes(40 * 1024), vec![16384, 16384, 8192]);
    }
}
