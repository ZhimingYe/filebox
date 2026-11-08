use axum::http::{header, HeaderMap, HeaderName, HeaderValue};
use base64::Engine;
use sha2::{Digest, Sha256};

pub(super) const SHIM: &str = include_str!("../../assets/fwd-shim.js");

pub(super) fn location(value: &str, prefix: &str, host: &str, port: u16) -> String {
    if value.starts_with('/') && !value.starts_with("//") {
        return format!("{prefix}{value}");
    }
    if let Ok(url) = url::Url::parse(value) {
        let authority = &url[url::Position::BeforeHost..url::Position::AfterPort];
        let loopback = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]")) && url.port_or_known_default() == Some(port);
        if matches!(url.scheme(), "http" | "https") && (authority == host || loopback) {
            return format!("{prefix}{}", &url[url::Position::BeforePath..]);
        }
    }
    value.into()
}

pub(super) fn cookie(value: &str, prefix: &str) -> String {
    let mut parts = value.split(';');
    let mut output = parts.next().unwrap_or_default().to_string();
    let mut has_path = false;
    for part in parts {
        let part = part.trim();
        let (name, value) = part.split_once('=').unwrap_or((part, ""));
        if name.eq_ignore_ascii_case("domain") { continue; }
        if name.eq_ignore_ascii_case("path") {
            if !has_path {
                output.push_str(&format!("; Path={prefix}/{}", value.trim_start_matches('/')));
                has_path = true;
            }
        } else { output.push_str("; "); output.push_str(part); }
    }
    if !has_path { output.push_str(&format!("; Path={prefix}/")); }
    output
}

pub(super) fn sanitize(headers: &HeaderMap, websocket: bool) -> HeaderMap {
    let mut output = headers.clone();
    let mut names: Vec<HeaderName> = ["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"].iter().map(|n| HeaderName::from_static(n)).collect();
    for value in headers.get_all(header::CONNECTION) {
        if let Ok(value) = value.to_str() {
            names.extend(value.split(',').filter_map(|name| HeaderName::from_bytes(name.trim().as_bytes()).ok()));
        }
    }
    for name in names {
        if websocket && (name == header::CONNECTION || name == header::UPGRADE) { continue; }
        output.remove(name);
    }
    output
}

pub(super) fn response_headers(headers: &HeaderMap, websocket: bool, prefix: &str, host: &str, port: u16) -> HeaderMap {
    let mut output = sanitize(headers, websocket);
    if let Some(value) = headers.get(header::LOCATION).and_then(|v| v.to_str().ok()) {
        if let Ok(value) = HeaderValue::from_str(&location(value, prefix, host, port)) { output.insert(header::LOCATION, value); }
    }
    output.remove(header::SET_COOKIE);
    for value in headers.get_all(header::SET_COOKIE) {
        if let Some(value) = value.to_str().ok().and_then(|v| HeaderValue::from_str(&cookie(v, prefix)).ok()) { output.append(header::SET_COOKIE, value); }
    }
    output.insert("x-filebox-forward", HeaderValue::from_static("1"));
    output.insert(header::REFERRER_POLICY, HeaderValue::from_static("same-origin"));
    output
}

pub(super) fn inject(html: &[u8], headers: &mut HeaderMap) -> Option<Vec<u8>> {
    let position = html.windows(5).enumerate().filter(|(_, word)| word.eq_ignore_ascii_case(b"<head")).find_map(|(position, _)| {
        let next = html.get(position + 5)?;
        if *next != b'>' && !next.is_ascii_whitespace() { return None; }
        let mut quote = None;
        for (offset, byte) in html[position + 5..].iter().enumerate() {
            match (quote, byte) {
                (Some(q), b) if q == *b => quote = None,
                (None, b'\'' | b'"') => quote = Some(*byte),
                (None, b'>') => return Some(position + 6 + offset),
                _ => {}
            }
        }
        None
    }).unwrap_or(0);
    let mut output = Vec::with_capacity(html.len() + SHIM.len() + 17);
    output.extend_from_slice(&html[..position]);
    output.extend_from_slice(b"<script>");
    output.extend_from_slice(SHIM.as_bytes());
    output.extend_from_slice(b"</script>");
    output.extend_from_slice(&html[position..]);
    let hash = format!("'sha256-{}'", base64::engine::general_purpose::STANDARD.encode(Sha256::digest(SHIM.as_bytes())));
    for name in [header::CONTENT_SECURITY_POLICY, HeaderName::from_static("content-security-policy-report-only")] {
        let values: Vec<_> = headers.get_all(&name).iter().filter_map(|v| v.to_str().ok()).map(|value| {
            value.split(',').map(|policy| {
                let has_script = policy.split(';').any(|d| d.split_whitespace().next().is_some_and(|n| n.eq_ignore_ascii_case("script-src")));
                let has_elem = policy.split(';').any(|d| d.split_whitespace().next().is_some_and(|n| n.eq_ignore_ascii_case("script-src-elem")));
                policy.split(';').map(|d| {
                    let name = d.split_whitespace().next().unwrap_or("");
                    if name.eq_ignore_ascii_case("script-src") || (has_elem && name.eq_ignore_ascii_case("script-src-elem")) || (!has_script && name.eq_ignore_ascii_case("default-src")) {
                        format!("{} {hash}", d.trim())
                    } else { d.into() }
                }).collect::<Vec<_>>().join(";")
            }).collect::<Vec<_>>().join(",")
        }).collect();
        headers.remove(&name);
        for value in values { if let Ok(value) = HeaderValue::from_str(&value) { headers.append(name.clone(), value); } }
    }
    headers.remove(header::CONTENT_LENGTH);
    headers.remove(header::ETAG);
    headers.remove("content-md5");
    headers.insert(header::CONTENT_LENGTH, HeaderValue::from_str(&output.len().to_string()).ok()?);
    Some(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rewrites_locations_and_scopes_cookies() {
        let prefix = "/_fwd/agent/9001";
        for value in ["/app?q=1#frag", "http://localhost:9001/app?q=1#frag", "http://127.0.0.1:9001/app?q=1#frag", "https://hub.test/app?q=1#frag"] {
            assert_eq!(location(value, prefix, "hub.test", 9001), format!("{prefix}/app?q=1#frag"));
        }
        for value in ["next", "https://other.test/app", "//other.test/app", "http://localhost:9002/app", ""] {
            assert_eq!(location(value, prefix, "hub.test", 9001), value);
        }
        assert_eq!(cookie("id=1; Path=/app; Domain=localhost; HttpOnly", prefix), "id=1; Path=/_fwd/agent/9001/app; HttpOnly");
        assert_eq!(cookie("id=1; Secure", prefix), "id=1; Secure; Path=/_fwd/agent/9001/");
        assert_eq!(cookie("id=1; path=/; DOMAIN=hub.test", prefix), "id=1; Path=/_fwd/agent/9001/");
    }
    #[test]
    fn injects_before_app_code_and_extends_each_csp() {
        let mut headers = HeaderMap::new();
        headers.insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static("default-src 'self'; script-src 'nonce-abc'; script-src-elem 'nonce-abc'"));
        headers.append(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static("default-src 'none'"));
        let html = b"<!doctype html><HEAD lang='en'><script>app()</script></HEAD>";
        let output = inject(html, &mut headers).unwrap();
        let output = String::from_utf8(output).unwrap();
        assert!(output.starts_with("<!doctype html><HEAD lang='en'><script>(() =>"));
        assert_eq!(headers[header::CONTENT_LENGTH], output.len().to_string());
        let hash = format!("'sha256-{}'", base64::engine::general_purpose::STANDARD.encode(Sha256::digest(SHIM.as_bytes())));
        let policies: Vec<_> = headers.get_all(header::CONTENT_SECURITY_POLICY).iter().map(|v| v.to_str().unwrap()).collect();
        assert_eq!(policies.len(), 2);
        assert_eq!(policies[0].matches(&hash).count(), 2);
        assert!(policies[1].contains(&hash));
        assert!(String::from_utf8(inject(b"", &mut HeaderMap::new()).unwrap()).unwrap().starts_with("<script>"));
        assert!(inject(&[255], &mut HeaderMap::new()).unwrap().ends_with(&[255]));
        assert!(String::from_utf8(inject(b"<head data-test='>'>app", &mut HeaderMap::new()).unwrap()).unwrap().starts_with("<head data-test='>'><script>"));
    }
}
