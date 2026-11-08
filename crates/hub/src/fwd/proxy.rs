use axum::{body::Body, extract::{Request, State}, http::{header, HeaderMap, HeaderValue, Method, StatusCode}, middleware::Next, response::{IntoResponse, Redirect, Response}};
use futures_util::StreamExt;
use hyper_util::rt::TokioIo;
use crate::{state::AppState, routes::middleware::{session_cookie, session_cookie_name, csrf_cookie_name}};
use super::rewrite;

const FIRST_BYTE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(300);

fn origin(headers: &HeaderMap, secure: bool) -> Option<url::Url> {
    let host = headers.get(header::HOST)?.to_str().ok()?;
    let scheme = if secure { "https" } else { "http" };
    let url = url::Url::parse(&format!("{scheme}://{host}" )).ok()?;
    if url.username().is_empty() && url.password().is_none() { Some(url) } else { None }
}

fn safe_origin(headers: &HeaderMap, own: &url::Url, check_site: bool) -> bool {
    if check_site && headers.get("sec-fetch-site").is_some_and(|v| v != "same-origin" && v != "none") { return false; }
    if let Some(value) = headers.get(header::ORIGIN) {
        return value.to_str().ok().is_some_and(|value| value == own.origin().ascii_serialization());
    }
    true
}

fn request_is_https(request: &Request) -> bool {
    request.uri().scheme_str() == Some("https") || request.headers().get("x-forwarded-proto").is_some_and(|v| v == "https")
}

fn failure(status: StatusCode) -> Response {
    (status, axum::response::Html(format!("<!doctype html><html><head><title>Forward unavailable</title></head><body><h1>{}</h1><p>Check the agent and local web service, then retry.</p></body></html>", status.canonical_reason().unwrap_or("Forward unavailable")))).into_response()
}

pub async fn proxy(State(state): State<AppState>, mut request: Request) -> Response {
    let document = super::body::document(request.method(), request.headers());
    let sid = session_cookie(request.headers(), &state.cookie_suffix);
    let principal = if let Some(sid) = sid { state.inner.read().await.sessions.get_session(&sid).map(|s| s.principal_id.clone()) } else { None };
    let Some(principal) = principal else {
        return if document && request.method() == Method::GET { Redirect::to("/").into_response() } else { StatusCode::UNAUTHORIZED.into_response() };
    };
    let websocket = request.headers().get(header::UPGRADE).is_some_and(|v| v.as_bytes().eq_ignore_ascii_case(b"websocket"))
        && request.headers().get(header::CONNECTION).and_then(|v| v.to_str().ok()).is_some_and(|v| v.split(',').any(|v| v.trim().eq_ignore_ascii_case("upgrade")));
    let Some(own) = origin(request.headers(), request_is_https(&request)) else { return StatusCode::BAD_REQUEST.into_response(); };
    if !safe_origin(request.headers(), &own, websocket || !matches!(*request.method(), Method::GET | Method::HEAD))
        || request.headers().get("sec-fetch-dest").is_some_and(|v| v == "serviceworker") {
        return StatusCode::FORBIDDEN.into_response();
    }
    if request.method() == Method::CONNECT { return StatusCode::METHOD_NOT_ALLOWED.into_response(); }
    let path = request.uri().path().to_string();
    let mut segments = path.trim_start_matches("/_fwd/").splitn(3, '/');
    let agent = segments.next().unwrap_or_default();
    let Some(port) = segments.next().and_then(|p| p.parse::<u16>().ok()).filter(|p| *p != 0) else { return StatusCode::NOT_FOUND.into_response(); };
    let rest = segments.next();
    if rest.is_none() {
        let query = request.uri().query().map(|q| format!("?{q}")).unwrap_or_default();
        return Redirect::permanent(&format!("{path}/{query}")).into_response();
    }
    let prefix = format!("/_fwd/{agent}/{port}");
    let (keep_prefix, scope) = {
        let inner = state.inner.read().await;
        let Some(forward) = inner.agents.get(agent).filter(|a| a.status != crate::agent_registry::AgentStatus::Offline && a.capabilities.port_forward)
            .and_then(|a| a.pending_forwards.as_ref().map(|(_, forwards)| forwards).unwrap_or(&a.forwards).iter().find(|f| f.port == port)) else { return StatusCode::NOT_FOUND.into_response(); };
        (forward.keep_prefix, state.tunnels.scope(state.clone(), principal, agent.into(), port))
    };
    let target = if keep_prefix { request.uri().path_and_query().unwrap().as_str().to_string() }
        else { format!("/{}{}", rest.unwrap_or_default(), request.uri().query().map(|q| format!("?{q}")).unwrap_or_default()) };
    let mut headers = rewrite::sanitize(request.headers(), websocket);
    let reserved = [session_cookie_name(true, &state.cookie_suffix), session_cookie_name(false, &state.cookie_suffix), csrf_cookie_name(true, &state.cookie_suffix), csrf_cookie_name(false, &state.cookie_suffix)];
    let cookies = headers.get_all(header::COOKIE).iter().filter_map(|v| v.to_str().ok()).flat_map(|v| v.split(';')).map(str::trim)
        .filter(|v| v.split_once('=').is_some_and(|(name, _)| !reserved.iter().any(|r| r == name.trim()))).collect::<Vec<_>>().join("; ");
    let cookies = rewrite::request_cookie(&cookies);
    headers.remove(header::COOKIE);
    if !cookies.is_empty() { if let Ok(value) = HeaderValue::from_str(&cookies) { headers.insert(header::COOKIE, value); } }
    let forwarding: Vec<_> = headers.keys().filter(|n| n.as_str() == "forwarded" || n.as_str().starts_with("x-forwarded-") || matches!(n.as_str(), "x-real-ip" | "x-original-url" | "x-original-uri" | "x-rewrite-url" | "x-client-ip" | "true-client-ip") || n.as_str().starts_with("x-filebox-")).cloned().collect();
    for name in forwarding { headers.remove(name); }
    if let Ok(value) = HeaderValue::from_str(&prefix) { headers.insert("x-forwarded-prefix", value); }
    if document { headers.insert(header::ACCEPT_ENCODING, HeaderValue::from_static("identity")); }
    let mut connection = tokio::select! {
        _ = scope.cancel.cancelled() => return StatusCode::UNAUTHORIZED.into_response(),
        result = tokio::time::timeout(FIRST_BYTE_TIMEOUT, super::pool::connect(&state, agent, port, !websocket)) => match result {
            Ok(Ok(connection)) => connection, Ok(Err(status)) => return failure(status), Err(_) => return failure(StatusCode::GATEWAY_TIMEOUT),
        }
    };
    scope.attach(&connection.cancel);
    let cancel = connection.cancel.clone();
    let browser_upgrade = websocket.then(|| hyper::upgrade::on(&mut request));
    let body = std::mem::replace(request.body_mut(), Body::empty());
    let mut upstream = match Request::builder().method(request.method().clone()).uri(target).body(body) {
        Ok(request) => request, Err(_) => return StatusCode::BAD_REQUEST.into_response(),
    };
    *upstream.headers_mut() = headers;
    let mut upstream = tokio::select! {
        _ = scope.cancel.cancelled() => return StatusCode::UNAUTHORIZED.into_response(),
        result = tokio::time::timeout(FIRST_BYTE_TIMEOUT, connection.sender.send_request(upstream)) => match result {
            Ok(Ok(response)) => response, Ok(Err(_)) => return StatusCode::BAD_GATEWAY.into_response(), Err(_) => return StatusCode::GATEWAY_TIMEOUT.into_response(),
        }
    };
    let host = request.headers().get(header::HOST).and_then(|v| v.to_str().ok()).unwrap_or_default();
    let mut headers = rewrite::response_headers(upstream.headers(), websocket, &prefix, host, port, request_is_https(&request));
    let status = upstream.status();
    let reusable = !websocket && !status.is_client_error() && !status.is_server_error();
    if status == StatusCode::SWITCHING_PROTOCOLS {
        let Some(browser) = browser_upgrade else { return StatusCode::BAD_GATEWAY.into_response(); };
        let service = hyper::upgrade::on(&mut upstream);
        tokio::spawn(async move {
            let _connection = connection;
            let _scope = scope;
            tokio::select! {
                _ = cancel.cancelled() => {},
                _ = async {
                    if let (Ok(browser), Ok(service)) = (browser.await, service.await) {
                        let _ = tokio::io::copy_bidirectional(&mut TokioIo::new(browser), &mut TokioIo::new(service)).await;
                    }
                } => {}
            }
        });
        let mut response = Response::new(Body::empty());
        *response.status_mut() = status;
        *response.headers_mut() = headers;
        return response;
    }
    let body = super::body::transform(Body::new(upstream.into_body()), &mut headers, request.method(), status, request.headers(), (prefix, host.into(), port));
    let mut stream = body.into_data_stream();
    let pool_key = (agent.to_string(), port);
    let body = {
        let body_stream: std::pin::Pin<Box<dyn futures_util::Stream<Item = Result<axum::body::Bytes, std::io::Error>> + Send>> = Box::pin(async_stream::try_stream! {
            let scope = scope;
            let mut connection = Some(connection);
            loop {
                let item = tokio::select! {
                    _ = cancel.cancelled() => Err(std::io::Error::other("Agent disconnected")),
                    item = stream.next() => Ok(item),
                }?;
                match item {
                    Some(bytes) => yield bytes.map_err(std::io::Error::other)?,
                    None => {
                        if !scope.cancel.is_cancelled() && reusable {
                            scope.recycle(pool_key, connection.take().unwrap());
                        }
                        break;
                    }
                }
            }
        });
        Body::from_stream(body_stream)
    };
    let mut response = Response::new(body);
    *response.status_mut() = status;
    *response.headers_mut() = headers;
    response
}

fn fallback_target(path_query: &str, referer: &str, own: &url::Url) -> Option<String> {
    let path = path_query.split('?').next()?;
    if path.starts_with("/_fwd/") || matches!(path, "/ws/agent" | "/ws/agent-data") { return None; }
    let referer = url::Url::parse(referer).ok()?;
    if referer.origin() != own.origin() { return None; }
    let mut parts = referer.path().strip_prefix("/_fwd/")?.splitn(3, '/');
    let agent = parts.next().filter(|s| !s.is_empty())?;
    let port = parts.next()?.parse::<u16>().ok().filter(|p| *p != 0)?;
    parts.next()?;
    Some(format!("/_fwd/{agent}/{port}{path_query}"))
}

pub async fn referer_fallback(request: Request, next: Next) -> Response {
    let secure = request_is_https(&request);
    if let Some(target) = origin(request.headers(), secure).and_then(|own| {
        fallback_target(request.uri().path_and_query()?.as_str(), request.headers().get(header::REFERER)?.to_str().ok()?, &own)
    }) { return Redirect::temporary(&target).into_response(); }
    next.run(request).await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn long_first_byte_deadline_and_https_detection() {
        assert!(FIRST_BYTE_TIMEOUT >= std::time::Duration::from_secs(300));
        for (uri, forwarded, expected) in [("http://hub/", "http", false), ("https://hub/", "http", true), ("http://hub/", "https", true)] {
            let request = Request::builder().uri(uri).header("x-forwarded-proto", forwarded).body(Body::empty()).unwrap();
            assert_eq!(request_is_https(&request), expected);
        }
    }
    #[test]
    fn fallback_is_same_origin_and_excludes_control_and_forward_routes() {
        let own = url::Url::parse("https://hub.test").unwrap();
        assert_eq!(fallback_target("/asset.js?v=1", "https://hub.test/_fwd/agent/9001/app", &own).as_deref(), Some("/_fwd/agent/9001/asset.js?v=1"));
        for referer in ["https://evil.test/_fwd/agent/9001/", "https://hub.test/", "https://hub.test/_fwd/agent/0/", "https://hub.test/_fwd/agent/9001", "", "not a URL"] {
            assert!(fallback_target("/asset.js", referer, &own).is_none());
        }
        for path in ["/ws/agent", "/ws/agent-data", "/_fwd/agent/9002/"] {
            assert!(fallback_target(path, "https://hub.test/_fwd/agent/9001/", &own).is_none());
        }
    }
    #[test]
    fn origin_checks_reject_cross_site_mutations_and_null_origin() {
        let own = url::Url::parse("https://hub.test").unwrap();
        let mut headers = HeaderMap::new();
        assert!(safe_origin(&headers, &own, true));
        headers.insert("sec-fetch-site", HeaderValue::from_static("cross-site"));
        assert!(!safe_origin(&headers, &own, true));
        headers.insert("sec-fetch-site", HeaderValue::from_static("same-origin"));
        headers.insert(header::ORIGIN, HeaderValue::from_static("null"));
        assert!(!safe_origin(&headers, &own, true));
        headers.insert(header::ORIGIN, HeaderValue::from_static("https://hub.test"));
        assert!(safe_origin(&headers, &own, true));
    }
}
