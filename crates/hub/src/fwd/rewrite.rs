use axum::http::{header, HeaderMap, HeaderName, HeaderValue};
use base64::Engine;
use sha2::{Digest, Sha256};

pub(super) const SHIM: &str = include_str!("../../assets/fwd-shim.js");
pub(super) const WORKER_SHIM: &str = include_str!("../../assets/fwd-worker-shim.js");
pub(super) const HTML_LIMIT: usize = 64 * 1024;

pub(super) fn location(value: &str, prefix: &str, host: &str, port: u16) -> String {
    if value.starts_with('/') && !value.starts_with("//") {
        return if value == prefix || value.starts_with("/_fwd/") { value.into() } else { format!("{prefix}{value}") };
    }
    let absolute = if value.starts_with("//") { format!("http:{value}") } else { value.into() };
    if let Ok(url) = url::Url::parse(&absolute) {
        let authority = &url[url::Position::BeforeHost..url::Position::AfterPort];
        let loopback = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]")) && url.port_or_known_default() == Some(port);
        if matches!(url.scheme(), "http" | "https" | "ws" | "wss") && (authority.eq_ignore_ascii_case(host) || loopback) {
            let tail = &url[url::Position::BeforePath..];
            return if url.path() == prefix || url.path().starts_with("/_fwd/") { tail.into() } else { format!("{prefix}{tail}") };
        }
    }
    value.into()
}

fn cookie_name(name: &str, secure: bool) -> String {
    let name = name.strip_prefix("__Host-").map(|n| format!("__Secure-fbh-{n}")).unwrap_or_else(|| name.into());
    if secure { name } else { name.strip_prefix("__Secure-").map(|n| format!("fbs-{n}")).unwrap_or(name) }
}

pub(super) fn request_cookie(value: &str) -> String {
    value.split(';').filter_map(|part| {
        let (name, value) = part.trim().split_once('=')?;
        let name = name.strip_prefix("__Secure-fbh-").or_else(|| name.strip_prefix("fbs-fbh-")).map(|n| format!("__Host-{n}"))
            .or_else(|| name.strip_prefix("fbs-").map(|n| format!("__Secure-{n}"))).unwrap_or_else(|| name.into());
        Some(format!("{name}={value}"))
    }).collect::<Vec<_>>().join("; ")
}

pub(super) fn cookie(value: &str, prefix: &str, secure: bool) -> String {
    let mut parts = value.split(';');
    let first = parts.next().unwrap_or_default();
    let mut output = first.split_once('=').map(|(name, v)| format!("{}={v}", cookie_name(name.trim(), secure))).unwrap_or_else(|| first.into());
    let mut has_path = false;
    for part in parts {
        let part = part.trim();
        let (name, value) = part.split_once('=').unwrap_or((part, ""));
        let (name, value) = (name.trim(), value.trim());
        if name.eq_ignore_ascii_case("domain") || (!secure && name.eq_ignore_ascii_case("secure")) { continue; }
        if name.eq_ignore_ascii_case("path") {
            if !has_path {
                let path = if value == prefix || value.starts_with(&format!("{prefix}/")) { value.into() } else { format!("{prefix}/{}", value.trim_start_matches('/')) };
                output.push_str(&format!("; Path={path}"));
                has_path = true;
            }
        } else if !secure && name.eq_ignore_ascii_case("samesite") && value.eq_ignore_ascii_case("none") { output.push_str("; SameSite=Lax"); }
        else { output.push_str("; "); output.push_str(part); }
    }
    if !has_path { output.push_str(&format!("; Path={prefix}/")); }
    output
}

pub(super) fn sanitize(headers: &HeaderMap, websocket: bool) -> HeaderMap {
    let mut output = headers.clone();
    let mut names: Vec<HeaderName> = ["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"].iter().map(|n| HeaderName::from_static(n)).collect();
    for value in headers.get_all(header::CONNECTION) {
        if let Ok(value) = value.to_str() { names.extend(value.split(',').filter_map(|name| HeaderName::from_bytes(name.trim().as_bytes()).ok())); }
    }
    for name in names {
        if websocket && (name == header::CONNECTION || name == header::UPGRADE) { continue; }
        output.remove(name);
    }
    output
}

fn refresh(value: &str, prefix: &str, host: &str, port: u16) -> String {
    let Some((delay, target)) = value.split_once(';') else { return value.into(); };
    let Some((key, target)) = target.trim().split_once('=') else { return value.into(); };
    if !key.trim().eq_ignore_ascii_case("url") { return value.into(); }
    let target = target.trim();
    let quote = target.chars().next().filter(|c| matches!(c, '\'' | '"'));
    let bare = quote.and_then(|q| target.strip_prefix(q)?.strip_suffix(q)).unwrap_or(target);
    let rewritten = location(bare, prefix, host, port);
    match quote { Some(q) => format!("{delay}; url={q}{rewritten}{q}"), None => format!("{delay}; url={rewritten}") }
}

pub(super) fn response_headers(headers: &HeaderMap, websocket: bool, prefix: &str, host: &str, port: u16, secure: bool) -> HeaderMap {
    let mut output = sanitize(headers, websocket);
    for name in [header::LOCATION, HeaderName::from_static("refresh")] {
        if let Some(value) = headers.get(&name).and_then(|v| v.to_str().ok()) {
            let value = if name == header::LOCATION { location(value, prefix, host, port) } else { refresh(value, prefix, host, port) };
            if let Ok(value) = HeaderValue::from_str(&value) { output.insert(name, value); }
        }
    }
    output.remove(header::SET_COOKIE);
    for value in headers.get_all(header::SET_COOKIE) {
        if let Some(value) = value.to_str().ok().and_then(|v| HeaderValue::from_str(&cookie(v, prefix, secure)).ok()) { output.append(header::SET_COOKIE, value); }
    }
    output.insert("x-filebox-forward", HeaderValue::from_static("1"));
    output.insert(header::REFERRER_POLICY, HeaderValue::from_static("same-origin"));
    output
}

fn csp(value: &str) -> String {
    let hash = format!("'sha256-{}'", base64::engine::general_purpose::STANDARD.encode(Sha256::digest(SHIM.as_bytes())));
    value.split(',').map(|policy| {
        let has_script = policy.split(';').any(|d| d.split_whitespace().next().is_some_and(|n| n.eq_ignore_ascii_case("script-src")));
        policy.split(';').map(|d| {
            let name = d.split_whitespace().next().unwrap_or("");
            if name.eq_ignore_ascii_case("script-src") || name.eq_ignore_ascii_case("script-src-elem") || (!has_script && name.eq_ignore_ascii_case("default-src")) {
                format!("{} {hash}", d.trim())
            } else { d.into() }
        }).collect::<Vec<_>>().join(";")
    }).collect::<Vec<_>>().join(",")
}

pub(super) fn injection_headers(headers: &mut HeaderMap, html: bool) {
    if html {
        for name in [header::CONTENT_SECURITY_POLICY, HeaderName::from_static("content-security-policy-report-only")] {
            let values: Vec<_> = headers.get_all(&name).iter().filter_map(|v| v.to_str().ok()).filter_map(|v| HeaderValue::from_str(&csp(v)).ok()).collect();
            headers.remove(&name);
            for value in values { headers.append(name.clone(), value); }
        }
    }
    for name in [header::CONTENT_LENGTH, header::CONTENT_ENCODING, header::ETAG, HeaderName::from_static("content-md5")] { headers.remove(name); }
}

pub(super) fn html_rewriter(prefix: String, host: String, port: u16, sink: impl FnMut(&[u8]) + Send + 'static) -> lol_html::send::HtmlRewriter<'static, impl FnMut(&[u8]) + Send> {
    use lol_html::{element, MemorySettings};
    let settings = lol_html::send::Settings::new_send()
        .with_memory_settings(MemorySettings::new().with_max_allowed_memory_usage(HTML_LIMIT).with_graceful_bail_out_on_memory_limit_exceeded(true))
        .append_element_content_handler(element!("link, base, meta", move |el| {
            match el.tag_name().as_str() {
                "link" => {
                    if el.get_attribute("rel").is_some_and(|v| v.split_ascii_whitespace().any(|v| v.eq_ignore_ascii_case("manifest"))) && !el.has_attribute("crossorigin") { el.set_attribute("crossorigin", "use-credentials")?; }
                }
                "base" => {
                    if let Some(value) = el.get_attribute("href") { el.set_attribute("href", &location(&value, &prefix, &host, port))?; }
                }
                "meta" => {
                    if el.get_attribute("name").is_some_and(|v| v.eq_ignore_ascii_case("referrer")) { el.set_attribute("content", "same-origin")?; }
                    if el.get_attribute("http-equiv").is_some_and(|v| v.eq_ignore_ascii_case("Content-Security-Policy")) {
                        if let Some(value) = el.get_attribute("content") { el.set_attribute("content", &csp(&value))?; }
                    }
                }
                _ => {}
            }
            Ok(())
        }));
    lol_html::send::HtmlRewriter::new(settings, sink)
}

pub(super) fn insertion(bytes: &[u8], eof: bool) -> Option<usize> {
    let mut offset = 0;
    while offset < bytes.len() {
        if bytes[offset..].starts_with(b"<!--") {
            if let Some(end) = bytes[offset + 4..].windows(3).position(|v| v == b"-->") { offset += end + 7; continue; }
            return if eof { Some(bytes.len()) } else { None };
        }
        if bytes[offset] != b'<' { offset += 1; continue; }
        let mut quote = None;
        let mut end = None;
        for (i, byte) in bytes[offset + 1..].iter().enumerate() {
            match (quote, byte) {
                (Some(q), b) if q == *b => quote = None,
                (None, b'\'' | b'"') => quote = Some(*byte),
                (None, b'>') => { end = Some(offset + i + 2); break; }
                _ => {}
            }
        }
        let Some(end) = end else { return if eof { Some(bytes.len()) } else { None }; };
        let name = bytes[offset + 1..end - 1].split(|b| b.is_ascii_whitespace() || *b == b'/').next().unwrap_or_default();
        if name.starts_with(b"!") || name.starts_with(b"?") { offset = end; continue; }
        // Script and void elements cannot contain the bootstrap script.
        return Some(if name.eq_ignore_ascii_case(b"head") || name.eq_ignore_ascii_case(b"html") { end } else { offset });
    }
    if eof || bytes.len() >= HTML_LIMIT { Some(bytes.len()) } else { None }
}

#[cfg(test)]
#[path = "rewrite_tests.rs"]
mod tests;
