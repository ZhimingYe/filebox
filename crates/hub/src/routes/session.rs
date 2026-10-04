use axum::extract::{Extension, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use crate::net::client_ip;
use crate::pow::{VerifyOutcome, CHALLENGE_TTL};
use crate::state::{AppState, AuthenticatedSession};
use super::middleware::{session_cookie_header, csrf_cookie_header, clear_session_cookie_headers};

// ── Session ──────────────────────────────────────────────────────────────────

#[derive(serde::Deserialize)]
pub(super) struct SessionExchangeRequest {
    username: String,
    password: String,
    remember: Option<bool>,
    /// Proof-of-work challenge id from `GET /api/pow/challenge`. Required.
    pow_id: Option<String>,
    /// Nonce proving the required work for that challenge. Required.
    pow_nonce: Option<String>,
}

/// Self-hosted login proof-of-work: issue a fresh challenge. Public (needed
/// before any session exists), rate-limited per IP, and never cached.
pub(super) async fn pow_challenge_handler(
    State(state): State<AppState>,
    axum::extract::ConnectInfo(addr): axum::extract::ConnectInfo<std::net::SocketAddr>,
    headers: axum::http::HeaderMap,
) -> Response {
    let ip = client_ip(&headers, addr);
    if let Err(remaining) = state.pow_rate_limiter.check(&ip) {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            Json(serde_json::json!({
                "error": "pow_rate_limited",
                "message": format!("Too many challenge requests. Try again in {} seconds.", remaining),
                "retryable": true,
            })),
        )
            .into_response();
    }
    // Count the issuance toward the per-IP cap (reuses the login limiter's
    // counter/cooldown semantics).
    state.pow_rate_limiter.record_failure(&ip);

    let challenge = state.pow.issue(&ip);
    let mut resp = Json(serde_json::json!({
        "id": challenge.id,
        "salt": challenge.salt,
        "difficulty": challenge.difficulty,
        "expires_in_secs": CHALLENGE_TTL.as_secs(),
    }))
    .into_response();
    resp.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    resp
}

pub(super) async fn session_exchange_handler(
    State(state): State<AppState>,
    axum::extract::ConnectInfo(addr): axum::extract::ConnectInfo<std::net::SocketAddr>,
    headers: axum::http::HeaderMap,
    Json(req): Json<SessionExchangeRequest>,
) -> Response {
    let ip = client_ip(&headers, addr);
    let user_agent = user_agent(&headers);

    // Raw request-rate bound. Password attempts are counted separately (the
    // per-IP 5/30s limiter below), and proof failures deliberately do not
    // consume that budget — otherwise five zero-work requests could burn the
    // whole window and lock out a NAT-sharing user. This bound instead caps
    // how often the endpoint can be hit at all, keeping the per-request
    // audit/tracing writes bounded.
    if let Err(remaining) = state.login_request_limiter.check(&ip) {
        state
            .audit
            .record("login_rate_limited", &req.username, &ip, &user_agent);
        return (
            StatusCode::TOO_MANY_REQUESTS,
            Json(serde_json::json!({
                "error": "login_rate_limited",
                "message": format!("Too many login requests. Try again in {} seconds.", remaining),
                "retryable": true,
            })),
        )
            .into_response();
    }
    state.login_request_limiter.record_failure(&ip);

    // Password-attempt rate limit check
    if let Err(remaining) = state.rate_limiter.check(&ip) {
        state
            .audit
            .record("login_rate_limited", &req.username, &ip, &user_agent);
        return (
            StatusCode::TOO_MANY_REQUESTS,
            Json(serde_json::json!({
                "error": "login_rate_limited",
                "message": format!("Too many login attempts. Try again in {} seconds.", remaining),
                "retryable": true,
            })),
        )
            .into_response();
    }

    // Proof of work comes before any password verification: a failed proof
    // burns a login request (bounded above) but NOT a password attempt, so
    // password guessers still pay ~2^difficulty hashes per guess and hit the
    // password rate limit, while zero-work garbage cannot lock users out.
    // The challenge is single-use — the browser must fetch + solve a fresh
    // one after every attempt.
    let pow = match (req.pow_id.as_deref(), req.pow_nonce.as_deref()) {
        (Some(id), Some(nonce)) if !id.is_empty() && !nonce.is_empty() => {
            state.pow.verify(id, nonce)
        }
        _ => VerifyOutcome::UnknownOrExpired,
    };
    if pow != VerifyOutcome::Valid {
        // Usernames are attacker-controlled up to the 1MB body limit — keep
        // them out of the log untruncated (the audit ring truncates itself).
        let display_user: String = req.username.chars().take(64).collect();
        tracing::warn!(target: "audit", ip = %ip, user = %display_user, "pow_failed");
        state
            .audit
            .record("pow_failed", &req.username, &ip, &user_agent);
        let (status, message) = match pow {
            VerifyOutcome::Insufficient => (
                StatusCode::UNAUTHORIZED,
                "Insufficient proof of work",
            ),
            _ => (
                StatusCode::UNAUTHORIZED,
                "Verification challenge missing or expired. Refresh and try again.",
            ),
        };
        return (
            status,
            Json(serde_json::json!({
                "error": "pow_failed",
                "message": message,
                "retryable": true,
            })),
        )
            .into_response();
    }

    let mut inner = state.inner.write().await;

    if !inner.sessions.validate_login(&req.username, &req.password) {
        drop(inner);
        state.rate_limiter.record_failure(&ip);
        tracing::warn!(target: "audit", ip = %ip, user = %req.username, "login_failed");
        state
            .audit
            .record("login_failed", &req.username, &ip, &user_agent);
        return (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({
                "error": "invalid_credentials",
                "message": "Invalid username or password",
                "retryable": false,
            })),
        )
            .into_response();
    }

    let remember = req.remember.unwrap_or(false);
    let (session, ttl) = inner.sessions.create_session(&req.username, remember);
    let session_id = session.session_id.clone();
    let csrf_token = session.csrf_token.clone();
    drop(inner);

    // Clear rate limits on successful login (password attempts, login
    // requests, and challenge fetches — a success proves a human at this IP).
    state.rate_limiter.clear(&ip);
    state.login_request_limiter.clear(&ip);
    state.pow_rate_limiter.clear(&ip);

    tracing::info!(target: "audit", ip = %ip, user = %req.username, "login_success");
    state
        .audit
        .record("login_success", &req.username, &ip, &user_agent);

    let mut resp = (
        StatusCode::OK,
        Json(serde_json::json!({
            "ok": true,
            "permissions": session.permissions,
            "csrf_token": csrf_token,
        })),
    )
        .into_response();
    resp.headers_mut()
        .append(header::SET_COOKIE, session_cookie_header(&session_id, ttl, state.secure_cookies));
    resp.headers_mut()
        .append(header::SET_COOKIE, csrf_cookie_header(&csrf_token, ttl, state.secure_cookies));
    resp
}

pub(super) async fn session_logout_handler(
    State(state): State<AppState>,
    Extension(session): Extension<AuthenticatedSession>,
    headers: HeaderMap,
    axum::extract::ConnectInfo(addr): axum::extract::ConnectInfo<std::net::SocketAddr>,
) -> Response {
    let ip = client_ip(&headers, addr);
    let user_agent = user_agent(&headers);
    let mut inner = state.inner.write().await;
    // Attribute the audit record to the account before the session is gone.
    let username = inner
        .sessions
        .get_session(&session.id)
        .map(|s| s.username.clone())
        .unwrap_or_default();
    inner.sessions.remove(&session.id);
    crate::terminal_proxy::revoke_terminal_sessions(&state, &session.principal_id);
    let preview_sessions = inner.preview_sessions.clone();
    let get_access_tokens = inner.get_access_tokens.clone();
    drop(inner);
    {
        let mut previews = preview_sessions.write().await;
        previews.retain(|_, preview| preview.session_id != session.principal_id);
    }
    {
        let mut tokens = get_access_tokens.write().await;
        tokens.retain(|_, tok| tok.principal_id != session.principal_id);
    }

    tracing::info!(target: "audit", ip = %ip, user = %username, "logout");
    state.audit.record("logout", &username, &ip, &user_agent);

    let mut resp = (
        StatusCode::OK,
        Json(serde_json::json!({ "ok": true })),
    )
        .into_response();
    for cookie in clear_session_cookie_headers(state.secure_cookies) {
        resp.headers_mut().append(header::SET_COOKIE, cookie);
    }
    resp
}

// ── Login audit ──────────────────────────────────────────────────────────────

/// Newest-first page of login audit records. `limit` (default 100, max 500)
/// bounds the page; `before` (exclusive entry id) walks backwards through
/// older records. Session-protected like every other control API.
#[derive(serde::Deserialize)]
pub(super) struct LoginAuditQuery {
    limit: Option<usize>,
    before: Option<u64>,
}

pub(super) async fn login_audit_handler(
    State(state): State<AppState>,
    Query(query): Query<LoginAuditQuery>,
) -> Response {
    let limit = query.limit.unwrap_or(100).clamp(1, 500);
    let (entries, has_more) = state.audit.recent(limit, query.before);
    Json(serde_json::json!({
        "entries": entries,
        "has_more": has_more,
    }))
    .into_response()
}

pub(super) fn user_agent(headers: &HeaderMap) -> String {
    headers
        .get(header::USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string()
}
