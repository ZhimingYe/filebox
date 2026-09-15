//! Remote terminal: TOTP 2FA endpoints and the browser↔hub terminal WS relay.
//!
//! The HTTP endpoints manage the per-user TOTP binding and mint short-lived
//! terminal tickets. The browser then upgrades
//! `GET /api/agents/{id}/terminal/ws` (registered outside the CSRF-protected
//! group because browsers cannot set headers on a WS upgrade) carrying the
//! ticket as a WebSocket subprotocol — never in the URL, which access logs,
//! browser history, and proxy logs would all record. The handler
//! authenticates the ticket AND the session cookie, then relays
//! JSON frames to the agent as `TerminalInput`/`TerminalResize`/
//! `TerminalClose` over the existing Hub↔Agent channel. Agent
//! `TerminalOpened`/`TerminalOutput`/`TerminalClosed` messages are routed
//! back into the browser socket via the session entry in
//! `state.terminal_sessions` (see `ws.rs`).

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
use tokio::sync::mpsc;
use uuid::Uuid;

use filebox_protocol::message::HubMessage;

use crate::agent_registry::AgentStatus;
use crate::net::client_ip;
use crate::state::{AppState, AuthenticatedSession, PendingResponse, MAX_PENDING_RESPONSES};
use crate::totp::BindConfirm;

/// Terminal tickets authorize a terminal WS upgrade without CSRF headers.
/// 30 minutes keeps a browser refresh (which loses the in-memory ticket)
/// from leaving a long-lived bearer token behind; the page renews it while
/// the session is alive.
pub const TERMINAL_TICKET_TTL_SECS: u64 = 30 * 60;
const TERMINAL_TICKET_TTL: Duration = Duration::from_secs(TERMINAL_TICKET_TTL_SECS);
const MAX_TERMINAL_TICKETS: usize = 1024;
/// Hub-wide bound on concurrent terminal sessions.
pub const MAX_TERMINAL_SESSIONS: usize = 16;
/// Buffered agent→browser frames per session. A slow browser must never stall
/// the agent's read loop: when this fills, output frames are dropped.
const TERMINAL_BROWSER_QUEUE_CAPACITY: usize = 256;
/// Per-write timeout for outbound browser WS frames (see `ws.rs`).
const TERMINAL_WS_WRITE_TIMEOUT: Duration = Duration::from_secs(10);
/// Browser frames carry base64 input; 64 KiB is far beyond any keystroke.
const MAX_BROWSER_WS_MESSAGE_SIZE: usize = 64 * 1024;

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
    /// Reusable within its TTL (a page may open several tabs/sessions).
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

    /// Extend a live ticket by the full TTL, returning the new lifetime in
    /// seconds. No fresh TOTP code is required — the session cookie + CSRF
    /// on this endpoint is the security boundary; the short TTL exists so a
    /// browser REFRESH (which loses the in-memory ticket) revokes access.
    pub fn renew(&self, token: &str) -> Option<u64> {
        let mut tickets = self.tickets.lock().unwrap_or_else(|e| e.into_inner());
        let now = Instant::now();
        if tickets.get(token)?.expires_at <= now {
            tickets.remove(token);
            return None;
        }
        let ticket = tickets.get_mut(token)?;
        ticket.expires_at = now + TERMINAL_TICKET_TTL;
        Some(TERMINAL_TICKET_TTL_SECS)
    }
}

/// A live browser terminal session. `ws.rs` routes agent terminal messages
/// into `tx`; dropping/removing the entry closes the browser socket.
pub struct TerminalSessionEntry {
    pub agent_id: String,
    pub connection_id: u64,
    #[allow(dead_code)]
    pub principal_id: String,
    #[allow(dead_code)]
    pub username: String,
    pub tx: mpsc::Sender<serde_json::Value>,
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
        let sessions = state
            .terminal_sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        match sessions.get(req_id) {
            Some(entry) if entry.agent_id == agent_id && entry.connection_id == connection_id => {
                Some(entry.tx.clone())
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
            tracing::warn!(
                "Terminal session {} browser queue full or closed; dropping frame",
                req_id
            );
        }
    }
    if close {
        state
            .terminal_sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(req_id);
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

/// Validate the agent a ticket will be bound to: must name a known agent
/// (any status — the ticket may outlive a transient disconnect).
async fn validate_ticket_agent(state: &AppState, agent_id: &str) -> Option<Response> {
    if agent_id.trim().is_empty() {
        return Some(error_response(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "agent_id is required",
            false,
        ));
    }
    let inner = state.inner.read().await;
    if inner.agents.get(agent_id).is_none() {
        return Some(error_response(
            StatusCode::NOT_FOUND,
            "backend_offline",
            &format!("Agent {} not found or offline", agent_id),
            true,
        ));
    }
    None
}

pub async fn totp_status_handler(
    State(state): State<AppState>,
    Extension(session): Extension<AuthenticatedSession>,
) -> Response {
    let username = session_username(&state, &session).await;
    Json(serde_json::json!({
        "bound": state.totp.is_bound(&username),
    }))
    .into_response()
}

pub async fn totp_bind_start_handler(
    State(state): State<AppState>,
    Extension(session): Extension<AuthenticatedSession>,
) -> Response {
    let username = session_username(&state, &session).await;
    match state.totp.start_bind(&username) {
        Ok(secret) => Json(serde_json::json!({
            "secret": secret,
            "otpauth_uri": crate::totp::otpauth_uri(&username, &secret),
        }))
        .into_response(),
        Err(()) => error_response(
            StatusCode::CONFLICT,
            "totp_already_bound",
            "An authenticator is already bound to this account",
            false,
        ),
    }
}

#[derive(Deserialize)]
pub struct TotpCodeRequest {
    pub code: String,
    #[serde(default)]
    pub agent_id: String,
}

pub async fn totp_bind_confirm_handler(
    State(state): State<AppState>,
    Extension(session): Extension<AuthenticatedSession>,
    ConnectInfo(addr): ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
    Json(req): Json<TotpCodeRequest>,
) -> Response {
    let username = session_username(&state, &session).await;
    let ip = client_ip(&headers, addr);
    if let Some(error) = validate_ticket_agent(&state, &req.agent_id).await {
        return error;
    }
    match state.totp.confirm_bind(&username, &req.code) {
        BindConfirm::Confirmed => {
            tracing::info!(target: "audit", ip = %ip, user = %username, "terminal_2fa_bound");
            state
                .audit
                .record("terminal_2fa_bound", &username, &ip, &user_agent(&headers));
            mint_ticket_response(&state, &session.principal_id, &username, &req.agent_id)
        }
        BindConfirm::NoPendingBind => error_response(
            StatusCode::BAD_REQUEST,
            "totp_no_pending_bind",
            "No authenticator bind is in progress. Start one first.",
            false,
        ),
        BindConfirm::InvalidCode => {
            tracing::warn!(target: "audit", ip = %ip, user = %username, "terminal_2fa_failed");
            state
                .audit
                .record("terminal_2fa_failed", &username, &ip, &user_agent(&headers));
            error_response(
                StatusCode::UNAUTHORIZED,
                "totp_invalid",
                "Invalid code",
                false,
            )
        }
    }
}

pub async fn totp_verify_handler(
    State(state): State<AppState>,
    Extension(session): Extension<AuthenticatedSession>,
    ConnectInfo(addr): ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
    Json(req): Json<TotpCodeRequest>,
) -> Response {
    let username = session_username(&state, &session).await;
    let ip = client_ip(&headers, addr);
    if !state.totp.is_bound(&username) {
        return error_response(
            StatusCode::BAD_REQUEST,
            "totp_not_bound",
            "No authenticator is bound to this account",
            false,
        );
    }
    if let Some(error) = validate_ticket_agent(&state, &req.agent_id).await {
        return error;
    }
    // Per-IP budget on code guesses; only failures consume it.
    if let Err(remaining) = state.terminal_verify_limiter.check(&ip) {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            Json(serde_json::json!({
                "error": "totp_rate_limited",
                "message": format!("Too many attempts. Try again in {} seconds.", remaining),
                "retryable": true,
                "retry_after": remaining,
            })),
        )
            .into_response();
    }
    if !state.totp.verify_code(&username, &req.code) {
        state.terminal_verify_limiter.record_failure(&ip);
        tracing::warn!(target: "audit", ip = %ip, user = %username, "terminal_2fa_failed");
        state
            .audit
            .record("terminal_2fa_failed", &username, &ip, &user_agent(&headers));
        return error_response(
            StatusCode::UNAUTHORIZED,
            "totp_invalid",
            "Invalid code",
            false,
        );
    }
    state.terminal_verify_limiter.clear(&ip);
    mint_ticket_response(&state, &session.principal_id, &username, &req.agent_id)
}

#[derive(Deserialize)]
pub struct TotpRenewRequest {
    pub ticket: String,
}

/// Extend a live terminal ticket by the full TTL. No rate limiter and no
/// fresh TOTP code: the session cookie + CSRF middleware is the boundary,
/// and the ticket itself is the proof of a recent 2FA check.
pub async fn totp_renew_handler(
    State(state): State<AppState>,
    Extension(_session): Extension<AuthenticatedSession>,
    Json(req): Json<TotpRenewRequest>,
) -> Response {
    match state.terminal_tickets.renew(&req.ticket) {
        Some(expires_in_sec) => Json(serde_json::json!({
            "expires_in_sec": expires_in_sec,
        }))
        .into_response(),
        None => error_response(
            StatusCode::UNAUTHORIZED,
            "terminal_ticket_invalid",
            "Terminal ticket missing or expired. Verify 2FA again.",
            true,
        ),
    }
}

// ── Terminal session management ─────────────────────────────────────────────

/// A session id is the `term_<uuid>` minted when the session opened. Bounded
/// length so the path segment can never be an arbitrary relay key.
fn is_valid_terminal_session_id(req_id: &str) -> bool {
    req_id.starts_with("term_") && req_id.len() <= 80
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

    let resp = tokio::time::timeout(Duration::from_secs(30), resp_rx.recv()).await;
    let pending = state.inner.read().await.pending_responses.clone();
    pending.write().await.remove(&req_id);

    match resp {
        Ok(Some(value)) => Json(serde_json::json!({
            "sessions": value.get("sessions").cloned().unwrap_or_else(|| serde_json::json!([])),
        }))
        .into_response(),
        _ => error_response(
            StatusCode::GATEWAY_TIMEOUT,
            "request_timeout",
            "Agent did not respond in time",
            true,
        ),
    }
}

/// `DELETE /api/agents/{id}/terminals/{req_id}` — force-kill a live session.
/// Fire-and-forget like `/api/cancel`: the agent owns the shell, and a lost
/// `TerminalClose` only means the zombie survives until the next reconnect.
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
        if !agent.capabilities.terminal {
            return error_response(
                StatusCode::NOT_IMPLEMENTED,
                "unsupported_feature",
                "This agent does not support remote terminals — upgrade the agent",
                false,
            );
        }
        let _ = inner.agents.send_to_agent(
            &agent_id,
            HubMessage::TerminalClose {
                req_id: req_id.clone(),
            },
        );
    }

    tracing::info!(target: "audit", ip = %ip, user = %username, agent_id = %agent_id, req_id = %req_id, "terminal_kill");
    state
        .audit
        .record("terminal_kill", &username, &ip, &user_agent(&headers));

    (StatusCode::ACCEPTED, Json(serde_json::json!({ "ok": true }))).into_response()
}

// ── Browser terminal WebSocket ──────────────────────────────────────────────

#[derive(Deserialize)]
pub struct TerminalWsParams {
    pub cols: Option<u16>,
    pub rows: Option<u16>,
    /// Agent-side secondary 2FA code (6 digits); malformed values are
    /// treated as absent and rejected agent-side if the agent requires one.
    pub agent_code: Option<String>,
}

/// Pass through only a well-formed 6-digit agent TOTP code.
fn sanitize_agent_code(code: Option<String>) -> Option<String> {
    code.filter(|c| c.len() == 6 && c.bytes().all(|b| b.is_ascii_digit()))
}

/// Browser→hub terminal frames (JSON text).
#[derive(Deserialize)]
#[serde(tag = "type")]
enum BrowserTerminalFrame {
    #[serde(rename = "input")]
    Input { data: String },
    #[serde(rename = "resize")]
    Resize { cols: u16, rows: u16 },
    #[serde(rename = "close")]
    Close,
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

    // 1) Ticket: 256-bit, TTL-bound to the login principal AND the path
    // agent — a ticket minted for another agent must not open a terminal
    // here (same error as unknown/expired to avoid leaking ticket validity).
    // It rides the Sec-WebSocket-Protocol handshake header (browsers cannot
    // set arbitrary WS headers); a URL query ticket would end up in access
    // logs and browser history.
    let ticket_token = headers
        .get(axum::http::header::SEC_WEBSOCKET_PROTOCOL)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(',').map(str::trim).find(|s| !s.is_empty()));
    let Some(ticket_token) = ticket_token else {
        return error_response(
            StatusCode::UNAUTHORIZED,
            "terminal_ticket_invalid",
            "Terminal ticket missing or expired. Verify 2FA again.",
            true,
        );
    };
    let Some(ticket) = state.terminal_tickets.validate(ticket_token) else {
        return error_response(
            StatusCode::UNAUTHORIZED,
            "terminal_ticket_invalid",
            "Terminal ticket missing or expired. Verify 2FA again.",
            true,
        );
    };
    if ticket.agent_id != agent_id {
        return error_response(
            StatusCode::UNAUTHORIZED,
            "terminal_ticket_invalid",
            "Terminal ticket missing or expired. Verify 2FA again.",
            true,
        );
    }

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

    let connection_id = {
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
        if !agent.capabilities.terminal {
            return error_response(
                StatusCode::NOT_IMPLEMENTED,
                "unsupported_feature",
                "This agent does not support remote terminals — upgrade the agent",
                false,
            );
        }
        agent.connection_id
    };

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
    let agent_totp_code = sanitize_agent_code(params.agent_code);

    ws.max_message_size(MAX_BROWSER_WS_MESSAGE_SIZE)
        .max_frame_size(MAX_BROWSER_WS_MESSAGE_SIZE)
        // Echo the ticket subprotocol back so the negotiated protocol
        // matches what the browser offered in the handshake.
        .protocols([ticket_token.to_string()])
        .on_upgrade(move |socket| {
            handle_terminal_socket(
                socket,
                state,
                agent_id,
                connection_id,
                ticket,
                cols,
                rows,
                agent_totp_code,
                ip,
            )
        })
        .into_response()
}

async fn handle_terminal_socket(
    socket: WebSocket,
    state: AppState,
    agent_id: String,
    connection_id: u64,
    ticket: TerminalTicket,
    cols: u16,
    rows: u16,
    agent_totp_code: Option<String>,
    ip: String,
) {
    let req_id = format!("term_{}", Uuid::new_v4());
    let (tx, mut rx) = mpsc::channel::<serde_json::Value>(TERMINAL_BROWSER_QUEUE_CAPACITY);
    let (mut ws_sink, mut ws_stream) = socket.split();

    let inserted = {
        let mut sessions = state
            .terminal_sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if sessions.len() >= MAX_TERMINAL_SESSIONS {
            false
        } else {
            sessions.insert(
                req_id.clone(),
                TerminalSessionEntry {
                    agent_id: agent_id.clone(),
                    connection_id,
                    principal_id: ticket.principal_id.clone(),
                    username: ticket.username.clone(),
                    tx,
                },
            );
            true
        }
    };
    if !inserted {
        send_terminal_frame(
            &mut ws_sink,
            serde_json::json!({"type": "error", "error": "terminal_overloaded"}),
        )
        .await;
        return;
    }

    let sent = {
        let inner = state.inner.read().await;
        inner.agents.send_to_agent(
            &agent_id,
            HubMessage::TerminalOpen {
                req_id: req_id.clone(),
                cols,
                rows,
                agent_totp_code,
            },
        )
    };
    if !sent {
        state
            .terminal_sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&req_id);
        send_terminal_frame(
            &mut ws_sink,
            serde_json::json!({"type": "error", "error": "backend_offline"}),
        )
        .await;
        return;
    }

    tracing::info!(target: "audit", ip = %ip, user = %ticket.username, agent_id = %agent_id, "terminal_opened");
    state.audit.record(
        "terminal_opened",
        &ticket.username,
        &ip,
        "",
    );

    // Pump both directions in one loop: agent→browser frames arrive on `rx`
    // (routed from ws.rs via the session entry); browser→agent frames are
    // parsed here and forwarded as Terminal* hub messages. The loop ends when
    // the browser socket closes/errors, or when `rx` closes because the
    // session entry was removed (agent TerminalClosed / agent disconnect).
    loop {
        tokio::select! {
            frame = rx.recv() => {
                match frame {
                    Some(value) => {
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
                            Ok(BrowserTerminalFrame::Input { data }) => {
                                let Ok(bytes) =
                                    base64::engine::general_purpose::STANDARD.decode(&data)
                                else {
                                    continue;
                                };
                                let sent = {
                                    let inner = state.inner.read().await;
                                    inner.agents.send_to_agent(
                                        &agent_id,
                                        HubMessage::TerminalInput {
                                            req_id: req_id.clone(),
                                            data: bytes,
                                        },
                                    )
                                };
                                if !sent {
                                    break;
                                }
                            }
                            Ok(BrowserTerminalFrame::Resize { cols, rows }) => {
                                let inner = state.inner.read().await;
                                let _ = inner.agents.send_to_agent(
                                    &agent_id,
                                    HubMessage::TerminalResize {
                                        req_id: req_id.clone(),
                                        cols: cols.clamp(1, 500),
                                        rows: rows.clamp(1, 500),
                                    },
                                );
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

    // Cleanup: stop agent→browser routing, then tell the agent to kill the
    // shell (best effort — the agent may already be gone).
    state
        .terminal_sessions
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&req_id);
    {
        let inner = state.inner.read().await;
        let _ = inner.agents.send_to_agent(
            &agent_id,
            HubMessage::TerminalClose {
                req_id: req_id.clone(),
            },
        );
    }
    tracing::info!(target: "audit", ip = %ip, user = %ticket.username, agent_id = %agent_id, "terminal_closed");
    state
        .audit
        .record("terminal_closed", &ticket.username, &ip, "");
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
    use super::*;

    #[test]
    fn mint_validate_and_renew_round_trip() {
        let store = TerminalTicketStore::new();
        let token = store.mint("p1", "alice", "agent-a").unwrap();
        let ticket = store.validate(&token).unwrap();
        assert_eq!(ticket.principal_id, "p1");
        assert_eq!(ticket.username, "alice");
        assert_eq!(ticket.agent_id, "agent-a");
        // Renew extends the ticket and reports the full TTL.
        assert_eq!(store.renew(&token), Some(TERMINAL_TICKET_TTL_SECS));
        assert!(store.validate(&token).is_some());
        // Unknown tokens neither validate nor renew.
        assert!(store.validate("nope").is_none());
        assert_eq!(store.renew("nope"), None);
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
    fn expired_ticket_neither_validates_nor_renews() {
        let store = TerminalTicketStore::new();
        let token = store.mint("p1", "alice", "agent-a").unwrap();
        {
            let mut tickets = store.tickets.lock().unwrap_or_else(|e| e.into_inner());
            tickets.get_mut(&token).unwrap().expires_at =
                Instant::now() - Duration::from_secs(1);
        }
        assert!(store.validate(&token).is_none());
        assert_eq!(store.renew(&token), None);
    }

    #[test]
    fn terminal_session_id_validation() {
        assert!(is_valid_terminal_session_id("term_550e8400-e29b-41d4-a716-446655440000"));
        assert!(is_valid_terminal_session_id(&format!("term_{}", "x".repeat(75))));
        // Wrong prefix and over-length ids are rejected.
        assert!(!is_valid_terminal_session_id("fs_list_abc"));
        assert!(!is_valid_terminal_session_id("term"));
        assert!(!is_valid_terminal_session_id(&format!("term_{}", "x".repeat(76))));
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
}
