//! Document-mode HTML preview: navigation responses served by the tokenized
//! preview route get sandbox guards injected at the byte level.
//!
//! Rationale: the preview iframe renders an HTML file whose relative links
//! (`href="other.html"`, `href="#anchor"`) must resolve through the same
//! tokenized route. A relative `<base href>` cannot express that (relative
//! bases resolve against the token route again), so the hub computes an
//! absolute origin from the request headers at session creation and injects
//! a locked `<base>`, a CSP meta and an anchor-fixup script into every
//! navigation-mode HTML response. Resource-mode responses (subresources,
//! HEAD, XHR) stay raw and strictly locked down.

use axum::http::{header, HeaderMap};

/// Documents larger than this are refused in document mode. The whole file is
/// buffered for byte-level injection, so the cap bounds per-request memory
/// (bounded further by the raw-read semaphore).
pub const PREVIEW_DOCUMENT_MAX_BYTES: u64 = 32 * 1024 * 1024;

/// True when `path` looks like an HTML file (`.html` / `.htm`, case-insensitive).
pub fn is_html_path(path: &str) -> bool {
    path.rsplit('.')
        .next()
        .map(|ext| matches!(ext.to_ascii_lowercase().as_str(), "html" | "htm"))
        .unwrap_or(false)
}

/// Absolute origin (`scheme://host`) for injected absolute URLs.
///
/// Scheme comes from `X-Forwarded-Proto` (whitelisted to http/https) so the
/// hub works behind a TLS-terminating reverse proxy; anything else falls back
/// to `http`. The host comes from the `Host` header, filtered to characters
/// that can never break out of a URL or attribute (letters, digits, `.`, `:`,
/// `-`, `[`, `]` for IPv6 literals).
pub fn absolute_origin_from_request(headers: &HeaderMap) -> String {
    let scheme = headers
        .get("x-forwarded-proto")
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|s| *s == "http" || *s == "https")
        .unwrap_or("http");
    let host = headers
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|h| {
            !h.is_empty()
                && h.len() <= 253
                && h.chars().all(|c| {
                    c.is_ascii_alphanumeric() || matches!(c, '.' | ':' | '-' | '[' | ']')
                })
        })
        .unwrap_or("localhost");
    format!("{}://{}", scheme, host)
}

/// CSP for document-mode responses: mirrors the legacy frontend-injected CSP
/// (scripts/styles/images from the token origin, `blob:` for workers/frames)
/// but deliberately omits `frame-ancestors` so the document can be embedded
/// in the preview iframe and in the blob new-window wrapper, both of which
/// have opaque origins.
pub fn preview_document_csp(base_url: &str) -> String {
    let source = if base_url.ends_with('/') {
        base_url.to_string()
    } else {
        format!("{}/", base_url)
    };
    format!(
        "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob: {}; \
         style-src 'unsafe-inline' {}; img-src data: blob: {}; font-src data: {}; \
         connect-src {}; media-src blob: {}; worker-src blob: {}; frame-src blob: {}; \
         navigate-to blob: {}; base-uri {}; form-action 'none'; object-src 'none'",
        source, source, source, source, source, source, source, source, source, source
    )
}

/// Capture-phase click interceptor for `href="#fragment"` links.
///
/// With an injected `<base>`, `href="#x"` resolves against the absolute base
/// URL and would navigate the iframe to the token route (403 for directory
/// URLs). The interceptor scrolls to the target element instead. `href="#"`
/// (scroll-to-top) is left alone.
const ANCHOR_FIXUP_SCRIPT: &str = r##"<script>
(function () {
  document.addEventListener('click', function (e) {
    if (!e.target || typeof e.target.closest !== 'function') return;
    var a = e.target.closest('a[href^="#"]');
    if (!a) return;
    var href = a.getAttribute('href') || '';
    if (href.length < 2) return;
    var el = document.getElementById(decodeURIComponent(href.slice(1)));
    if (!el) return;
    e.preventDefault();
    el.scrollIntoView();
  }, true);
})();
</script>"##;

/// Byte-level guard injection for a navigation-mode HTML document.
///
/// Operates on raw bytes — never `from_utf8_lossy` — so non-UTF-8 pages
/// (GBK, Shift-JIS) pass through untouched apart from the ASCII guard tags.
/// Always injects `<meta charset="utf-8">` to match the `text/html;
/// charset=utf-8` Content-Type the hub serves, strips any pre-existing
/// `<base>` (the injected one must win), and inserts the guards after
/// `<head>`, after `<html>` (wrapped in a synthetic `<head>`), or at the
/// document start for structure-less fragments.
pub fn inject_preview_guards(html: &[u8], base_url: &str) -> Vec<u8> {
    let without_base = strip_base_tags(html);
    let guards = guard_block(base_url);

    if let Some(pos) = find_tag_end(&without_base, b"head") {
        return insert_bytes(&without_base, pos, &guards);
    }
    if let Some(pos) = find_tag_end(&without_base, b"html") {
        let mut wrapped = Vec::with_capacity(guards.len() + 7);
        wrapped.extend_from_slice(b"\n<head>");
        wrapped.extend_from_slice(&guards);
        wrapped.extend_from_slice(b"</head>");
        return insert_bytes(&without_base, pos, &wrapped);
    }
    let mut prefixed = Vec::with_capacity(guards.len() + without_base.len());
    prefixed.extend_from_slice(&guards);
    prefixed.extend_from_slice(&without_base);
    prefixed
}

/// Relative base URL of a preview session, e.g. `/api/preview/{token}/` or
/// `/api/preview/{token}/{encoded base path}/`. Always ends with `/` so a
/// document at any depth resolves relative links against its directory.
pub fn preview_base_url(token: &str, base_path: &str) -> String {
    if base_path.is_empty() {
        format!("/api/preview/{}/", token)
    } else {
        format!("/api/preview/{}/{}/", token, percent_encode_path(base_path))
    }
}

/// URL of the session's own HTML document (`<base URL><encoded filename>`).
/// Relative, like `base_url`; clients absolutize against `window.location`.
pub fn preview_document_url(token: &str, base_path: &str, file_path: &str) -> String {
    let filename = file_path.rsplit('/').next().unwrap_or("");
    format!(
        "{}{}",
        preview_base_url(token, base_path),
        percent_encode_path_component(filename)
    )
}

fn guard_block(base_url: &str) -> Vec<u8> {
    // base_url comes from `preview_base_url` (hex token + percent-encoded
    // path) on top of a whitelist-filtered origin, so it cannot contain
    // `&`, `"` or `<` — attribute values need no escaping here.
    let csp = preview_document_csp(base_url);
    let mut block = Vec::with_capacity(96 + csp.len() + base_url.len());
    block.extend_from_slice(b"<meta charset=\"utf-8\">\n");
    block.extend_from_slice(b"<meta http-equiv=\"Content-Security-Policy\" content=\"");
    block.extend_from_slice(csp.as_bytes());
    block.extend_from_slice(b"\">\n");
    block.extend_from_slice(b"<base href=\"");
    block.extend_from_slice(base_url.as_bytes());
    block.extend_from_slice(b"\" target=\"_self\">\n");
    block.extend_from_slice(ANCHOR_FIXUP_SCRIPT.as_bytes());
    block
}

/// Remove `<base ...>` tags (ASCII case-insensitive, quoted attribute values
/// respected). Returns a copy; the tag is skipped entirely.
fn strip_base_tags(html: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(html.len());
    let mut i = 0;
    while i < html.len() {
        if is_tag_start(html, i, b"base") {
            i = skip_tag(html, i + 4);
        } else {
            out.push(html[i]);
            i += 1;
        }
    }
    out
}

/// Index just past the closing `>` of the first `<name ...>` tag, or None.
/// `name` is matched ASCII case-insensitively at a word boundary.
fn find_tag_end(html: &[u8], name: &[u8]) -> Option<usize> {
    let mut i = 0;
    while i < html.len() {
        if is_tag_start(html, i, name) {
            return Some(skip_tag(html, i + name.len()));
        }
        i += 1;
    }
    None
}

/// True when `html[i..]` starts with `<name` (case-insensitive) followed by a
/// non-name character (whitespace, `/`, `>` or end of input).
fn is_tag_start(html: &[u8], i: usize, name: &[u8]) -> bool {
    if html[i] != b'<' || i + name.len() >= html.len() {
        return false;
    }
    let mut matches = true;
    for (k, expected) in name.iter().enumerate() {
        let actual = html[i + 1 + k];
        if actual.to_ascii_lowercase() != expected.to_ascii_lowercase() {
            matches = false;
            break;
        }
    }
    if !matches {
        return false;
    }
    html.get(i + 1 + name.len())
        .map(|b| !is_name_char(*b))
        .unwrap_or(true)
}

/// Index just past the closing `>` of the tag starting at `start`
/// (the position of the first byte after `<name`), honoring quoted values.
fn skip_tag(html: &[u8], start: usize) -> usize {
    let mut quote: Option<u8> = None;
    let mut j = start;
    while j < html.len() {
        let b = html[j];
        if let Some(q) = quote {
            if b == q {
                quote = None;
            }
        } else if b == b'"' || b == b'\'' {
            quote = Some(b);
        } else if b == b'>' {
            return j + 1;
        }
        j += 1;
    }
    html.len()
}

fn is_name_char(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b':' | b'.')
}

fn insert_bytes(html: &[u8], pos: usize, inserted: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(html.len() + inserted.len());
    out.extend_from_slice(&html[..pos]);
    out.extend_from_slice(inserted);
    out.extend_from_slice(&html[pos..]);
    out
}

fn percent_encode_path(path: &str) -> String {
    path.split('/')
        .map(percent_encode_path_component)
        .collect::<Vec<_>>()
        .join("/")
}

fn percent_encode_path_component(component: &str) -> String {
    let mut encoded = String::new();
    for byte in component.as_bytes() {
        match *byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                encoded.push(*byte as char);
            }
            _ => {
                use std::fmt::Write;
                let _ = write!(encoded, "%{:02X}", byte);
            }
        }
    }
    encoded
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    #[test]
    fn html_path_detection_is_extension_based() {
        assert!(is_html_path("report.HTML"));
        assert!(is_html_path("report.htm"));
        assert!(is_html_path("dir/报告.html"));
        assert!(!is_html_path("report.md"));
        assert!(!is_html_path("report"));
        assert!(!is_html_path("report.html.bak"));
    }

    #[test]
    fn origin_prefers_forwarded_proto_https() {
        let mut headers = HeaderMap::new();
        headers.insert("x-forwarded-proto", HeaderValue::from_static("https"));
        headers.insert(header::HOST, HeaderValue::from_static("files.example.com"));
        assert_eq!(
            absolute_origin_from_request(&headers),
            "https://files.example.com"
        );
    }

    #[test]
    fn origin_falls_back_to_http_and_rejects_host_breakout() {
        let mut headers = HeaderMap::new();
        headers.insert(header::HOST, HeaderValue::from_static("evil\"/><script>"));
        assert_eq!(absolute_origin_from_request(&headers), "http://localhost");

        let mut headers = HeaderMap::new();
        headers.insert("x-forwarded-proto", HeaderValue::from_static("ftp"));
        headers.insert(header::HOST, HeaderValue::from_static("h:3000"));
        assert_eq!(absolute_origin_from_request(&headers), "http://h:3000");

        let mut headers = HeaderMap::new();
        headers.insert("x-forwarded-proto", HeaderValue::from_static("https"));
        headers.insert(header::HOST, HeaderValue::from_static("[::1]:8443"));
        assert_eq!(
            absolute_origin_from_request(&headers),
            "https://[::1]:8443"
        );
    }

    #[test]
    fn document_csp_allows_token_origin_and_omits_frame_ancestors() {
        let csp = preview_document_csp("http://h:3000/api/preview/tok/");
        assert!(csp.contains("default-src 'none'"));
        assert!(csp.contains("script-src 'unsafe-inline' 'unsafe-eval' blob: http://h:3000/api/preview/tok/"));
        assert!(csp.contains("base-uri http://h:3000/api/preview/tok/"));
        assert!(!csp.contains("frame-ancestors"));
        assert!(csp.contains("form-action 'none'"));
    }

    #[test]
    fn injection_after_head_tag() {
        let html = b"<!doctype html>\n<html><head><title>T</title></head><body>x</body></html>";
        let out = inject_preview_guards(html, "http://h/api/preview/tok/");
        let out = String::from_utf8(out).unwrap();
        let head_end = out.find("<title>").unwrap();
        let injected = &out[..head_end];
        assert!(injected.contains("<meta charset=\"utf-8\">"));
        assert!(injected.contains("http-equiv=\"Content-Security-Policy\""));
        assert!(injected.contains("<base href=\"http://h/api/preview/tok/\" target=\"_self\">"));
        assert!(injected.contains("<script>"));
        assert!(injected.contains("scrollIntoView"));
        // <!doctype> and the original head content survive.
        assert!(out.contains("<!doctype html>"));
        assert!(out.contains("<title>T</title>"));
    }

    #[test]
    fn injection_wraps_head_when_only_html_tag_exists() {
        let html: &[u8] = b"<html lang=\"en\"><body>hi</body></html>";
        let out = String::from_utf8(inject_preview_guards(html, "http://h/p/")).unwrap();
        assert!(out.starts_with("<html lang=\"en\">\n<head><meta charset=\"utf-8\">"));
        assert!(out.contains("</head><body>hi</body></html>"));
    }

    #[test]
    fn injection_prefixes_structure_less_fragments() {
        let html = b"<p>fragment</p>";
        let out = String::from_utf8(inject_preview_guards(html, "http://h/p/")).unwrap();
        assert!(out.starts_with("<meta charset=\"utf-8\">"));
        assert!(out.ends_with("<p>fragment</p>"));
    }

    #[test]
    fn existing_base_tags_are_stripped_case_insensitively() {
        let html = b"<BASE href=\"http://evil/\"><base href='http://evil2/'><base\tdata-x=\"a>b\"><p>x</p>";
        let out = String::from_utf8(inject_preview_guards(html, "http://h/p/")).unwrap();
        assert!(!out.contains("evil"));
        // Only the injected <base> remains.
        assert_eq!(out.matches("<base href=\"http://h/p/\"").count(), 1);
    }

    #[test]
    fn injection_preserves_non_utf8_bytes() {
        // GBK bytes for 中文 — must pass through untouched.
        let gbk = [0xba, 0xba, 0xce, 0xc4];
        let mut html = b"<html><head></head><body>".to_vec();
        html.extend_from_slice(&gbk);
        html.extend_from_slice(b"</body></html>");
        let out = inject_preview_guards(&html, "http://h/p/");
        assert!(out.windows(4).any(|w| w == gbk));
    }

    #[test]
    fn percent_encoding_keeps_fragments_and_spaces_out_of_urls() {
        assert_eq!(
            preview_base_url("tok", "reports/run 1/#figures"),
            "/api/preview/tok/reports/run%201/%23figures/"
        );
        assert_eq!(preview_base_url("tok", ""), "/api/preview/tok/");
    }

    #[test]
    fn document_url_appends_encoded_filename() {
        assert_eq!(
            preview_document_url("tok", "", "index.html"),
            "/api/preview/tok/index.html"
        );
        assert_eq!(
            preview_document_url("tok", "reports/run 1", "index.html"),
            "/api/preview/tok/reports/run%201/index.html"
        );
        assert_eq!(
            preview_document_url("tok", "reports", "图表 1.html"),
            "/api/preview/tok/reports/%E5%9B%BE%E8%A1%A8%201.html"
        );
    }
}
