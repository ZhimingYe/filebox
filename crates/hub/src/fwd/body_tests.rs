use super::*;
use http_body_util::BodyExt;
use async_compression::tokio::bufread::{BrotliEncoder, DeflateEncoder, GzipEncoder, ZlibEncoder, ZstdEncoder};

const PREFIX: &str = "/_fwd/agent/9001";

fn headers() -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(header::CONTENT_TYPE, "text/html; charset=utf-8".parse().unwrap());
    headers.insert(header::CONTENT_LENGTH, "10".parse().unwrap());
    headers
}

fn request(dest: &str) -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert("sec-fetch-dest", dest.parse().unwrap());
    headers
}

async fn render(body: Body, headers: &mut HeaderMap, method: Method, status: StatusCode, request: HeaderMap) -> Result<Vec<u8>, axum::Error> {
    transform(body, headers, &method, status, &request, (PREFIX.into(), "hub.test".into(), 9001, None)).collect().await.map(|v| v.to_bytes().to_vec())
}

#[tokio::test]
async fn compressed_html_decodes_all_encodings_stacks_and_raw_deflate_across_byte_boundaries() {
    let html = b"<!doctype html><html><head><link rel=manifest href='/manifest.json'></head><body>hello</body></html>";
    for encoding in ["gzip", "deflate", "raw-deflate", "br", "zstd", "gzip, br", "identity", "GZip"] {
        let cursor = std::io::Cursor::new(html.to_vec());
        let mut encoder: Pin<Box<dyn AsyncRead + Send>> = match encoding {
            "gzip" | "GZip" => Box::pin(GzipEncoder::new(cursor)),
            "deflate" => Box::pin(ZlibEncoder::new(cursor)),
            "raw-deflate" => Box::pin(DeflateEncoder::new(cursor)),
            "br" => Box::pin(BrotliEncoder::new(cursor)),
            "zstd" => Box::pin(ZstdEncoder::new(cursor)),
            "gzip, br" => Box::pin(BrotliEncoder::new(BufReader::new(GzipEncoder::new(cursor)))),
            _ => Box::pin(cursor),
        };
        let mut bytes = Vec::new();
        encoder.read_to_end(&mut bytes).await.unwrap();
        let chunks: Vec<_> = bytes.into_iter().map(|b| Ok::<_, io::Error>(Bytes::from(vec![b]))).collect();
        let mut headers = headers();
        headers.insert(header::CONTENT_ENCODING, (if encoding == "raw-deflate" { "deflate" } else { encoding }).parse().unwrap());
        let output = render(Body::from_stream(futures_util::stream::iter(chunks)), &mut headers, Method::GET, StatusCode::OK, request("document")).await.unwrap();
        let text = String::from_utf8(output).unwrap();
        assert!(text.starts_with("<!doctype html><html><script>"), "{encoding}");
        assert!(text.contains("crossorigin=\"use-credentials\""));
        assert!(text.ends_with("</html>"));
        assert!(!headers.contains_key(header::CONTENT_LENGTH));
        assert!(!headers.contains_key(header::CONTENT_ENCODING));
    }
}

#[tokio::test]
async fn unknown_encodings_pass_through_unchanged_and_bad_compressed_or_upstream_data_errors() {
    for encoding in ["unknown", "gzip, unknown"] {
        let mut headers = headers();
        headers.insert(header::CONTENT_ENCODING, encoding.parse().unwrap());
        assert_eq!(render(Body::from("opaque"), &mut headers, Method::GET, StatusCode::OK, request("document")).await.unwrap(), b"opaque");
        assert_eq!(headers[header::CONTENT_ENCODING], encoding);
        assert!(headers.contains_key(header::CONTENT_LENGTH));
    }
    for encoding in ["gzip", "deflate", "br", "zstd"] {
        let mut headers = headers();
        headers.insert(header::CONTENT_ENCODING, encoding.parse().unwrap());
        assert!(render(Body::from("not compressed"), &mut headers, Method::GET, StatusCode::OK, request("document")).await.is_err(), "{encoding}");
    }
    let body = Body::from_stream(futures_util::stream::iter([Err::<Bytes, _>(io::Error::other("upstream failed"))]));
    assert!(render(body, &mut headers(), Method::GET, StatusCode::OK, request("document")).await.is_err());
}

#[tokio::test]
async fn injection_classifies_documents_not_html_api_requests_or_bodyless_responses() {
    let html = "<!doctype html><head>hello";
    for dest in ["document", "iframe", "frame"] {
        assert!(String::from_utf8(render(Body::from(html), &mut headers(), Method::GET, StatusCode::OK, request(dest)).await.unwrap()).unwrap().contains(rewrite::SHIM));
    }
    for dest in ["empty", "", "script", "style", "image", "worker", "sharedworker"] {
        let mut request = request(dest);
        request.insert(header::ACCEPT, "text/html".parse().unwrap());
        assert_eq!(render(Body::from(html), &mut headers(), Method::GET, StatusCode::OK, request).await.unwrap(), html.as_bytes());
    }
    let mut fallback = HeaderMap::new();
    fallback.insert(header::ACCEPT, "application/xhtml+xml, TEXT/HTML;q=0.9".parse().unwrap());
    assert!(document(&Method::GET, &fallback));
    assert!(!document(&Method::POST, &fallback));
    assert!(!document(&Method::HEAD, &request("document")));
    for name in ["x-requested-with", "hx-request"] {
        let mut request = fallback.clone();
        request.insert(name, "false".parse().unwrap());
        assert!(!document(&Method::GET, &request));
    }
    for (method, status) in [(Method::HEAD, StatusCode::OK), (Method::GET, StatusCode::NO_CONTENT), (Method::GET, StatusCode::NOT_MODIFIED), (Method::GET, StatusCode::CONTINUE), (Method::GET, StatusCode::SWITCHING_PROTOCOLS), (Method::GET, StatusCode::PARTIAL_CONTENT)] {
        let mut headers = headers();
        assert_eq!(render(Body::from(html), &mut headers, method, status, request("document")).await.unwrap(), html.as_bytes());
        assert!(headers.contains_key(header::CONTENT_LENGTH));
    }
}

#[tokio::test]
async fn html_streams_bootstrap_before_eof_and_keeps_large_documents_and_empty_html() {
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<Bytes, io::Error>>(1);
    tx.send(Ok(Bytes::from_static(b"<!doctype html><html>"))).await.unwrap();
    let body = transform(Body::from_stream(tokio_stream::wrappers::ReceiverStream::new(rx)), &mut headers(), &Method::GET, StatusCode::OK, &request("document"), (PREFIX.into(), "hub".into(), 9001, None));
    let mut stream = body.into_data_stream();
    let first = tokio::time::timeout(std::time::Duration::from_secs(1), stream.next()).await.unwrap().unwrap().unwrap();
    assert!(String::from_utf8_lossy(&first).contains(rewrite::SHIM));
    let bytes = vec![b'x'; 9 * 1024 * 1024];
    let send = tokio::spawn(async move { tx.send(Ok(Bytes::from(bytes))).await.unwrap(); });
    let mut length = 0;
    while length < 9 * 1024 * 1024 { length += stream.next().await.unwrap().unwrap().len(); }
    send.await.unwrap();
    assert_eq!(length, 9 * 1024 * 1024);
    assert!(stream.next().await.is_none());
    let empty = render(Body::empty(), &mut headers(), Method::GET, StatusCode::OK, request("document")).await.unwrap();
    assert_eq!(empty, format!("<script>{}</script>", rewrite::SHIM).as_bytes());
    let spaces = vec![b' '; rewrite::HTML_LIMIT];
    let output = render(Body::from(spaces), &mut headers(), Method::GET, StatusCode::OK, request("document")).await.unwrap();
    assert_eq!(output.len(), rewrite::HTML_LIMIT + rewrite::SHIM.len() + 17);
}

#[tokio::test]
async fn workers_classic_module_shared_and_mime_gates() {
    for dest in ["worker", "sharedworker"] {
        for javascript in ["self.postMessage('ok')", "import '/module.js'; export const x = 1;", "#!/bin/js\nself.postMessage('ok')", "", "\u{feff}#!/bin/js\nself.postMessage('ok')"] {
            let mut headers = headers();
            headers.insert(header::CONTENT_TYPE, "application/javascript; charset=utf-8".parse().unwrap());
            let output = render(Body::from(javascript), &mut headers, Method::GET, StatusCode::OK, request(dest)).await.unwrap();
            assert!(output.starts_with(rewrite::WORKER_SHIM.as_bytes()));
            assert!(!String::from_utf8_lossy(&output).contains("#!/bin/js"));
            assert!(!headers.contains_key(header::CONTENT_LENGTH));
        }
    }
    let mut headers = headers();
    headers.insert(header::CONTENT_TYPE, "text/javascript".parse().unwrap());
    assert_eq!(render(Body::from("original"), &mut headers, Method::GET, StatusCode::OK, request("script")).await.unwrap(), b"original");
}

#[tokio::test]
async fn sse_is_not_buffered_recompressed_or_injected() {
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<Bytes, io::Error>>(1);
    tx.send(Ok(Bytes::from_static(b"data: first\n\n"))).await.unwrap();
    let mut headers = headers();
    headers.insert(header::CONTENT_TYPE, "text/event-stream".parse().unwrap());
    let mut stream = transform(Body::from_stream(tokio_stream::wrappers::ReceiverStream::new(rx)), &mut headers, &Method::GET, StatusCode::OK, &request("empty"), (PREFIX.into(), "hub".into(), 9001, None)).into_data_stream();
    assert_eq!(tokio::time::timeout(std::time::Duration::from_secs(1), stream.next()).await.unwrap().unwrap().unwrap(), "data: first\n\n");
    tx.send(Ok(Bytes::from_static(b"data: second\n\n"))).await.unwrap();
    assert_eq!(stream.next().await.unwrap().unwrap(), "data: second\n\n");
}
