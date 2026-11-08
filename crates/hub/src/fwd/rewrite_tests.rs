use super::*;

const PREFIX: &str = "/_fwd/agent/9001";

#[test]
fn locations_cover_root_absolute_loopback_ipv6_protocol_relative_and_external() {
    for value in ["/app?q=1#frag", "http://localhost:9001/app?q=1#frag", "http://127.0.0.1:9001/app?q=1#frag", "https://hub.test/app?q=1#frag", "http://[::1]:9001/app?q=1#frag", "//localhost:9001/app?q=1#frag", "//hub.test/app?q=1#frag", "ws://localhost:9001/app?q=1#frag", "wss://[::1]:9001/app?q=1#frag"] {
        assert_eq!(location(value, PREFIX, "hub.test", 9001), format!("{PREFIX}/app?q=1#frag"), "{value}");
    }
    for value in ["next", "https://other.test/app", "//other.test/app", "http://localhost:9002/app", "http://localhost.evil:9001/", "javascript:alert(1)", "data:text/html,x", "", PREFIX, "/_fwd/agent/9001/app", "/_fwd/other/9002/app"] {
        assert_eq!(location(value, PREFIX, "hub.test", 9001), value);
    }
    assert_eq!(location("http://localhost/a", "/_fwd/a/80", "hub", 80), "/_fwd/a/80/a");
}

#[test]
fn refresh_handles_quotes_case_queries_external_and_invalid_values() {
    for (input, expected) in [("0; URL=/app?a=1", "0; url=/_fwd/agent/9001/app?a=1"), ("3; url='//localhost:9001/app'", "3; url='/_fwd/agent/9001/app'"), ("1; url=\"http://[::1]:9001/\"", "1; url=\"/_fwd/agent/9001/\"")] {
        assert_eq!(refresh(input, PREFIX, "hub", 9001), expected);
    }
    for input in ["", "10", "1; broken", "0; x=/app", "0; url=next", "0; url=https://other.test/"] { assert_eq!(refresh(input, PREFIX, "hub", 9001), input); }
}

#[test]
fn cookies_scope_paths_drop_domains_preserve_expiry_and_do_not_double_prefix() {
    assert_eq!(cookie("id=a=b; Path=/app; Domain=localhost; HttpOnly; Expires=Wed, 21 Oct 2030 07:28:00 GMT", PREFIX, true), "id=a=b; Path=/_fwd/agent/9001/app; HttpOnly; Expires=Wed, 21 Oct 2030 07:28:00 GMT");
    assert_eq!(cookie("id=; path=/; DOMAIN=hub.test; Max-Age=0", PREFIX, true), "id=; Path=/_fwd/agent/9001/; Max-Age=0");
    assert_eq!(cookie("id=1; Path=/_fwd/agent/9001/app; Path=/", PREFIX, true), "id=1; Path=/_fwd/agent/9001/app");
    assert_eq!(cookie("id=1; Secure", PREFIX, true), "id=1; Secure; Path=/_fwd/agent/9001/");
    assert_eq!(cookie("", PREFIX, false), "; Path=/_fwd/agent/9001/");
}

#[test]
fn cookie_aliases_round_trip_host_secure_and_plain_http_attributes() {
    assert_eq!(cookie("__Host-id=secret; Secure; Path=/; SameSite=None", PREFIX, true), "__Secure-fbh-id=secret; Secure; Path=/_fwd/agent/9001/; SameSite=None");
    assert_eq!(cookie("__Host-id=secret; Secure; Path=/; SameSite=None", PREFIX, false), "fbs-fbh-id=secret; Path=/_fwd/agent/9001/; SameSite=Lax");
    assert_eq!(cookie("__Secure-id=secret; secure; samesite=NONE", PREFIX, false), "fbs-id=secret; SameSite=Lax; Path=/_fwd/agent/9001/");
    assert_eq!(cookie("__Secure-id=secret; Secure; SameSite=Strict", PREFIX, true), "__Secure-id=secret; Secure; SameSite=Strict; Path=/_fwd/agent/9001/");
    assert_eq!(request_cookie("__Secure-fbh-id=a=b; fbs-fbh-other=2; fbs-secure=3; normal=4; invalid"), "__Host-id=a=b; __Host-other=2; __Secure-secure=3; normal=4");
    assert_eq!(request_cookie(""), "");
}

#[test]
fn response_headers_rewrite_refresh_multiple_cookies_and_connection_headers() {
    let mut headers = HeaderMap::new();
    headers.insert(header::LOCATION, "/app".parse().unwrap());
    headers.insert("refresh", "0; url=//localhost:9001/next".parse().unwrap());
    headers.append(header::SET_COOKIE, "a=1; Path=/; Secure".parse().unwrap());
    headers.append(header::SET_COOKIE, "__Host-b=2; Path=/; Secure".parse().unwrap());
    headers.insert(header::CONNECTION, "x-private, keep-alive, upgrade".parse().unwrap());
    headers.insert("x-private", "secret".parse().unwrap());
    headers.insert(header::UPGRADE, "websocket".parse().unwrap());
    let output = response_headers(&headers, false, PREFIX, "hub", 9001, false);
    assert_eq!(output[header::LOCATION], format!("{PREFIX}/app"));
    assert_eq!(output["refresh"], format!("0; url={PREFIX}/next"));
    assert_eq!(output.get_all(header::SET_COOKIE).iter().count(), 2);
    assert!(!output.contains_key("x-private"));
    assert!(!output.contains_key(header::UPGRADE));
    assert!(sanitize(&headers, true).contains_key(header::UPGRADE));
    assert_eq!(output[header::REFERRER_POLICY], "same-origin");
}

#[test]
fn csp_hash_is_added_to_every_applicable_policy_and_header() {
    let mut headers = HeaderMap::new();
    headers.insert(header::CONTENT_SECURITY_POLICY, "default-src 'self'; script-src 'nonce-abc'; script-src-elem 'none'".parse().unwrap());
    headers.append(header::CONTENT_SECURITY_POLICY, "default-src 'none', script-src 'self'".parse().unwrap());
    headers.insert("content-security-policy-report-only", "default-src 'none'".parse().unwrap());
    headers.insert(header::CONTENT_LENGTH, "12".parse().unwrap());
    headers.insert(header::CONTENT_ENCODING, "gzip".parse().unwrap());
    headers.insert(header::ETAG, "test".parse().unwrap());
    injection_headers(&mut headers, true);
    let hash = format!("'sha256-{}'", base64::engine::general_purpose::STANDARD.encode(Sha256::digest(SHIM.as_bytes())));
    let policies: Vec<_> = headers.get_all(header::CONTENT_SECURITY_POLICY).iter().map(|v| v.to_str().unwrap()).collect();
    assert_eq!(policies.len(), 2);
    assert_eq!(policies[0].matches(&hash).count(), 2);
    assert_eq!(policies[1].matches(&hash).count(), 2);
    assert!(headers["content-security-policy-report-only"].to_str().unwrap().contains(&hash));
    for name in [header::CONTENT_LENGTH, header::CONTENT_ENCODING, header::ETAG] { assert!(!headers.contains_key(name)); }
    assert_eq!(csp("img-src data:"), "img-src data:");
}

#[test]
fn incremental_html_attributes_manifest_base_csp_referrer_and_literals() {
    let output = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let sink = output.clone();
    let mut rewriter = html_rewriter((PREFIX.into(), "hub.test".into(), 9001, None), move |bytes| sink.lock().unwrap().extend_from_slice(bytes));
    let html = "<!doctype html><head><LINK REL='alternate MANIFEST' href='/m'><link rel=manifest crossorigin=anonymous><base href='http://[::1]:9001/app/?x=1&amp;y=2'><meta name=REFERRER content=no-referrer><meta http-equiv=Content-Security-Policy content=\"default-src 'self'; script-src 'none'\"><script>const x='<link rel=manifest>';</script><!-- <base href='/ignore'> --></head>";
    for byte in html.as_bytes() { rewriter.write(&[*byte]).unwrap(); }
    rewriter.end().unwrap();
    let output = String::from_utf8(output.lock().unwrap().clone()).unwrap();
    assert!(output.contains("crossorigin=\"use-credentials\""));
    assert!(output.contains("crossorigin=anonymous"));
    assert!(output.contains("href=\"/_fwd/agent/9001/app/?x=1&amp;y=2\""));
    assert!(output.contains("content=\"same-origin\""));
    assert!(output.contains("'sha256-"));
    assert!(output.contains("const x='<link rel=manifest>'"));
    assert!(output.contains("<!-- <base href='/ignore'> -->"));
}

#[test]
fn bootstrap_position_preserves_doctype_quotes_chunk_boundaries_and_empty_input() {
    for html in ["<!DOCTYPE html><html>", "<!-- comment --><!doctype html><HEAD data-x='>'>", "<!doctype html><head>"] {
        assert_eq!(insertion(html.as_bytes(), false), Some(html.len()));
        for length in 0..html.len() { assert_eq!(insertion(&html.as_bytes()[..length], false), None, "{html} at {length}"); }
    }
    assert_eq!(insertion(b"<!doctype html><script>app()</script>", false), Some(15));
    assert_eq!(insertion(b"", true), Some(0));
    assert_eq!(insertion(b"<head data-x='", false), None);
    assert_eq!(insertion(&vec![b' '; HTML_LIMIT], false), Some(HTML_LIMIT));
}
