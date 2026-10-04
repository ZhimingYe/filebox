use axum::extract::State;
use axum::Json;
use axum::http::{header, HeaderMap, HeaderName, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use crate::state::{AppState, GetAccessPurpose, GetAccessToken, AuthenticatedSession};

pub(super) async fn security_headers(
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> Response {
    // HSTS only makes sense over TLS: sending it on a plaintext HTTP response
    // poisons browsers (some engines remember it anyway, especially with
    // includeSubDomains), which then force-upgrade http://127.0.0.1 to https://
    // and break against a hub that only listens on plain HTTP. Only emit HSTS
    // when this request actually arrived over TLS — either directly (scheme
    // https) or behind a reverse proxy that advertised it via X-Forwarded-Proto.
    let is_https = req.uri().scheme_str() == Some("https")
        || req
            .headers()
            .get("x-forwarded-proto")
            .and_then(|v| v.to_str().ok())
            .map(|v| v.eq_ignore_ascii_case("https"))
            .unwrap_or(false);
    let mut resp = next.run(req).await;
    let headers = resp.headers_mut();
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    // Blanket clickjacking protection, except for preview document-mode
    // responses: those must render inside the sandboxed preview iframe and
    // the blob new-window wrapper (both opaque origins), so the preview
    // handler marks them with a sentinel header and this layer defers to it.
    // Their injected CSP keeps them locked to the token origin either way.
    if !headers.contains_key("x-filebox-preview-document") {
        headers.insert(
            HeaderName::from_static("x-frame-options"),
            HeaderValue::from_static("DENY"),
        );
    }
    if is_https {
        headers.insert(
            header::STRICT_TRANSPORT_SECURITY,
            HeaderValue::from_static("max-age=31536000; includeSubDomains"),
        );
    }
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("same-origin"),
    );
    if !headers.contains_key(header::CONTENT_SECURITY_POLICY) {
        headers.insert(
            header::CONTENT_SECURITY_POLICY,
            HeaderValue::from_static("frame-ancestors 'none'"),
        );
    }
    resp
}

// Set Cache-Control on frontend static responses. Skips /api/ and /ws/ so the
// existing API/SSE caching semantics are untouched. Only touches 2xx responses;
// errors keep their default headers.
pub(super) async fn cache_headers(
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> Response {
    let path = req.uri().path().to_string();
    let mut resp = next.run(req).await;
    if !resp.status().is_success() || path.starts_with("/api/") || path.starts_with("/ws/") {
        return resp;
    }
    // index.html must always be revalidated so a stale cached copy can never
    // reference hashed JS that has been removed by a newer deployment.
    // /assets/* filenames are content-hashed by Vite, so immutable is safe.
    let cc = if path == "/" || path.ends_with(".html") {
        "no-cache, must-revalidate"
    } else if path.starts_with("/assets/") {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    };
    if let Ok(v) = HeaderValue::from_str(cc) {
        resp.headers_mut().insert(header::CACHE_CONTROL, v);
    }
    resp
}

// ── Session Middleware ─────────────────────────────────────────────────────

pub(super) async fn require_session(
    State(state): State<AppState>,
    mut req: axum::extract::Request,
    next: axum::middleware::Next,
) -> Response {
    let is_logout = req.uri().path() == "/api/session/logout";
    let path = req.uri().path().to_string();
    let query = req.uri().query().map(|q| q.to_string());
    if req
        .headers()
        .get(header::ORIGIN)
        .and_then(|v| v.to_str().ok())
        == Some("null")
    {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({
                "error": "permission_denied",
                "message": "Sandboxed previews cannot call filebox control APIs",
                "retryable": false,
            })),
        )
            .into_response();
    }

    let session_id = session_cookie(req.headers());

    let Some(sid) = session_id else {
        return (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({
                "error": "unauthorized",
                "message": "No session cookie. Please login first.",
                "retryable": false,
            })),
        )
            .into_response();
    };

    // Header-only CSRF. Headerless GETs (download / PDF / EventSource) use a
    // short-lived `access_token` instead of putting the synchronizer in the URL.
    let provided_csrf = csrf_from_header(req.headers());
    let access_token = query.as_deref().and_then(access_token_from_query);

    // 1) Look up (grace-aware) WITHOUT rotating. CSRF/access-token must pass
    // before any cookie-id mutation — otherwise a deny response would retire
    // the browser's cookie without Set-Cookie.
    let (existing, tokens_arc) = {
        let inner = state.inner.read().await;
        let Some(session) = inner.sessions.get_session(&sid).cloned() else {
            return (
                StatusCode::UNAUTHORIZED,
                Json(serde_json::json!({
                    "error": "session_expired",
                    "message": "Session expired or invalid. Please login again.",
                    "retryable": false,
                })),
            )
                .into_response();
        };
        (session, inner.get_access_tokens.clone())
    };

    let csrf_ok = csrf_tokens_equal(
        provided_csrf.as_deref(),
        Some(existing.csrf_token.as_str()),
    );

    // 2) Fully authorize BEFORE refresh/rotate.
    // Claim access tokens against the stable principal first: if claim fails
    // (expired/wrong scope/exhausted), we must not mutate the session store or
    // the browser would keep a retired cookie without receiving Set-Cookie.
    if !csrf_ok {
        let Some(token) = access_token.as_deref() else {
            return (
                StatusCode::FORBIDDEN,
                Json(serde_json::json!({
                    "error": "csrf_denied",
                    "message": "Missing or invalid CSRF / access token. Reload the page and try again.",
                    "retryable": false,
                })),
            )
                .into_response();
        };
        if let Err(resp) = claim_get_access_token(
            &tokens_arc,
            token,
            &existing.principal_id,
            &path,
            query.as_deref(),
        )
        .await
        {
            return resp;
        }
    }

    // 3) Refresh / rotate only after auth (CSRF or access token) succeeded.
    let (session, cookie_refresh) = {
        let mut inner = state.inner.write().await;
        if is_logout {
            match inner.sessions.get_session(&sid).cloned() {
                Some(s) => (s, None),
                None => {
                    return (
                        StatusCode::UNAUTHORIZED,
                        Json(serde_json::json!({
                            "error": "session_expired",
                            "message": "Session expired or invalid. Please login again.",
                            "retryable": false,
                        })),
                    )
                        .into_response();
                }
            }
        } else {
            match inner.sessions.refresh_session_after_auth(&sid) {
                Some(pair) => pair,
                None => {
                    return (
                        StatusCode::UNAUTHORIZED,
                        Json(serde_json::json!({
                            "error": "session_expired",
                            "message": "Session expired or invalid. Please login again.",
                            "retryable": false,
                        })),
                    )
                        .into_response();
                }
            }
        }
    };

    req.extensions_mut().insert(AuthenticatedSession {
        id: session.session_id.clone(),
        principal_id: session.principal_id.clone(),
    });

    let mut resp = next.run(req).await;
    if let Some(refresh) = cookie_refresh {
        resp.headers_mut().append(
            header::SET_COOKIE,
            session_cookie_header(&refresh.session_id, refresh.max_age, state.secure_cookies),
        );
        resp.headers_mut().append(
            header::SET_COOKIE,
            csrf_cookie_header(&refresh.csrf_token, refresh.max_age, state.secure_cookies),
        );
    }
    resp
}

pub(crate) fn session_cookie(headers: &HeaderMap) -> Option<String> {
    let cookies = headers
        .get(header::COOKIE)
        .and_then(|v| v.to_str().ok())
        ?;

    cookie_value(cookies, "__Host-filebox_session")
        .or_else(|| cookie_value(cookies, "filebox_session"))
}

pub(super) fn cookie_value(cookies: &str, name: &str) -> Option<String> {
    let prefix = format!("{}=", name);
    cookies.split(';').find_map(|c| {
        c.trim()
            .strip_prefix(&prefix)
            .map(|sid| sid.to_string())
    })
}

pub(super) fn csrf_from_header(headers: &HeaderMap) -> Option<String> {
    headers
        .get("x-csrf-token")
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
}

pub(super) fn access_token_from_query(query: &str) -> Option<String> {
    query_param(query, "access_token")
}

/// Parse a query param with the same decoder axum's `Query` extractor uses
/// (`form_urlencoded` / `serde_urlencoded`), so access-token scope checks
/// cannot diverge from the values the handler later extracts.
pub(super) fn query_param(query: &str, name: &str) -> Option<String> {
    for (key, value) in form_urlencoded::parse(query.as_bytes()) {
        if key.as_ref() != name {
            continue;
        }
        let owned = value.into_owned();
        if !owned.is_empty() {
            return Some(owned);
        }
    }
    None
}

pub(super) async fn claim_get_access_token(
    tokens: &std::sync::Arc<tokio::sync::RwLock<std::collections::HashMap<String, GetAccessToken>>>,
    token: &str,
    principal_id: &str,
    path: &str,
    query: Option<&str>,
) -> Result<(), Response> {
    let now = std::time::Instant::now();
    let mut map = tokens.write().await;
    map.retain(|_, t| t.expires_at > now);
    let Some(record) = map.get_mut(token) else {
        return Err((
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({
                "error": "access_token_invalid",
                "message": "Access token missing or expired. Retry the download.",
                "retryable": true,
            })),
        )
            .into_response());
    };
    if record.principal_id != principal_id {
        return Err((
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({
                "error": "access_token_invalid",
                "message": "Access token does not belong to this session",
                "retryable": false,
            })),
        )
            .into_response());
    }

    match record.purpose {
        GetAccessPurpose::Events => {
            if path != "/api/events" {
                return Err((
                    StatusCode::FORBIDDEN,
                    Json(serde_json::json!({
                        "error": "access_token_invalid",
                        "message": "Access token is not valid for this endpoint",
                        "retryable": false,
                    })),
                )
                    .into_response());
            }
        }
        GetAccessPurpose::FileRaw => {
            if path != "/api/file/raw" {
                return Err((
                    StatusCode::FORBIDDEN,
                    Json(serde_json::json!({
                        "error": "access_token_invalid",
                        "message": "Access token is not valid for this endpoint",
                        "retryable": false,
                    })),
                )
                    .into_response());
            }
            let q = query.unwrap_or("");
            let agent_id = query_param(q, "agent_id").unwrap_or_default();
            let root = query_param(q, "root").unwrap_or_default();
            let file_path = query_param(q, "path").unwrap_or_default();
            if record.agent_id.as_deref() != Some(agent_id.as_str())
                || record.root.as_deref() != Some(root.as_str())
                || record.path.as_deref() != Some(file_path.as_str())
            {
                return Err((
                    StatusCode::FORBIDDEN,
                    Json(serde_json::json!({
                        "error": "access_token_invalid",
                        "message": "Access token is not valid for this file",
                        "retryable": false,
                    })),
                )
                    .into_response());
            }
            record.requests_served = record.requests_served.saturating_add(1);
        }
    }
    Ok(())
}

pub(super) fn csrf_tokens_equal(provided: Option<&str>, expected: Option<&str>) -> bool {
    match (provided, expected) {
        (Some(a), Some(b)) if a.len() == b.len() && !a.is_empty() => a
            .as_bytes()
            .iter()
            .zip(b.as_bytes())
            .fold(0u8, |acc, (x, y)| acc | (x ^ y))
            == 0,
        _ => false,
    }
}

pub(super) fn session_cookie_header(session_id: &str, max_age: u64, secure: bool) -> HeaderValue {
    let name = if secure { "__Host-filebox_session" } else { "filebox_session" };
    let secure_flag = if secure { "; Secure" } else { "" };
    HeaderValue::from_str(&format!(
        "{}={}; HttpOnly{}; SameSite=Strict; Path=/; Max-Age={}",
        name, session_id, secure_flag, max_age
    ))
    .unwrap()
}

/// Readable by same-origin JS so a refreshed tab can recover the synchronizer
/// token without a round-trip. Sibling hosts cannot read this cookie.
pub(super) fn csrf_cookie_header(csrf_token: &str, max_age: u64, secure: bool) -> HeaderValue {
    let name = if secure { "__Host-filebox_csrf" } else { "filebox_csrf" };
    let secure_flag = if secure { "; Secure" } else { "" };
    HeaderValue::from_str(&format!(
        "{}={}{}; SameSite=Strict; Path=/; Max-Age={}",
        name, csrf_token, secure_flag, max_age
    ))
    .unwrap()
}

pub(super) fn clear_session_cookie_headers(secure: bool) -> [HeaderValue; 4] {
    let secure_flag = if secure { "; Secure" } else { "" };
    let host_session = HeaderValue::from_str(&format!(
        "__Host-filebox_session=; HttpOnly{}; SameSite=Strict; Path=/; Max-Age=0",
        secure_flag
    )).unwrap();
    let plain_session = HeaderValue::from_str(&format!(
        "filebox_session=; HttpOnly{}; SameSite=Strict; Path=/; Max-Age=0",
        secure_flag
    )).unwrap();
    let host_csrf = HeaderValue::from_str(&format!(
        "__Host-filebox_csrf=; SameSite=Strict; Path=/; Max-Age=0{}",
        secure_flag
    )).unwrap();
    let plain_csrf = HeaderValue::from_str(&format!(
        "filebox_csrf=; SameSite=Strict; Path=/; Max-Age=0{}",
        secure_flag
    )).unwrap();
    [host_session, plain_session, host_csrf, plain_csrf]
}
