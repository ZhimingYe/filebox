use std::{io, pin::Pin, sync::{Arc, Mutex}};
use axum::{body::{Body, Bytes}, http::{header, HeaderMap, Method, StatusCode}};
use async_compression::tokio::bufread::{BrotliDecoder, DeflateDecoder, GzipDecoder, ZlibDecoder, ZstdDecoder};
use futures_util::StreamExt;
use tokio::io::{AsyncRead, AsyncReadExt, BufReader};
use tokio_util::io::{ReaderStream, StreamReader};
use super::rewrite;

pub(super) fn document(method: &Method, headers: &HeaderMap) -> bool {
    if *method == Method::HEAD { return false; }
    if let Some(dest) = headers.get("sec-fetch-dest") { return matches!(dest.as_bytes(), b"document" | b"iframe" | b"frame"); }
    *method == Method::GET && !headers.contains_key("x-requested-with") && !headers.contains_key("hx-request")
        && headers.get(header::ACCEPT).and_then(|v| v.to_str().ok()).is_some_and(|v| v.to_ascii_lowercase().contains("text/html"))
}

pub(super) fn transform(body: Body, headers: &mut HeaderMap, method: &Method, status: StatusCode, request: &HeaderMap, (prefix, host, port): (String, String, u16)) -> Body {
    if *method == Method::HEAD || status.is_informational() || matches!(status, StatusCode::NO_CONTENT | StatusCode::NOT_MODIFIED | StatusCode::PARTIAL_CONTENT) { return body; }
    let mime = headers.get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("").split(';').next().unwrap_or("").trim().to_ascii_lowercase();
    let html = mime == "text/html" && document(method, request);
    let worker = request.get("sec-fetch-dest").is_some_and(|v| matches!(v.as_bytes(), b"worker" | b"sharedworker"))
        && matches!(mime.as_str(), "application/javascript" | "text/javascript" | "application/x-javascript" | "application/ecmascript" | "text/ecmascript");
    if !html && !worker { return body; }
    let encoding = match headers.get(header::CONTENT_ENCODING) { Some(v) => match v.to_str() { Ok(v) => v.to_ascii_lowercase(), Err(_) => return body }, None => String::new() };
    let encodings: Vec<_> = encoding.split(',').map(str::trim).filter(|s| !s.is_empty()).map(str::to_owned).collect();
    if encodings.iter().any(|v| !matches!(v.as_str(), "identity" | "gzip" | "x-gzip" | "deflate" | "br" | "zstd")) { return body; }
    rewrite::injection_headers(headers, html);
    let input = body.into_data_stream().map(|v| v.map_err(io::Error::other));
    let mut reader: Pin<Box<dyn AsyncRead + Send>> = Box::pin(StreamReader::new(input));
    let output: Pin<Box<dyn futures_util::Stream<Item = Result<Bytes, io::Error>> + Send>> = Box::pin(async_stream::try_stream! {
        for encoding in encodings.iter().rev() {
            let mut buffered = BufReader::new(reader);
            reader = match encoding.as_str() {
                "gzip" | "x-gzip" => { let mut decoder = GzipDecoder::new(buffered); decoder.multiple_members(true); Box::pin(decoder) }
                "deflate" => {
                    let mut bytes = [0; 2];
                    buffered.read_exact(&mut bytes).await?;
                    let zlib = bytes[0] & 15 == 8 && bytes[0] >> 4 <= 7 && u16::from_be_bytes(bytes) % 31 == 0;
                    let buffered = BufReader::new(std::io::Cursor::new(bytes).chain(buffered));
                    if zlib { Box::pin(ZlibDecoder::new(buffered)) } else { Box::pin(DeflateDecoder::new(buffered)) }
                }
                "br" => Box::pin(BrotliDecoder::new(buffered)),
                "zstd" => { let mut decoder = ZstdDecoder::new(buffered); decoder.multiple_members(true); Box::pin(decoder) }
                _ => Box::pin(buffered),
            };
        }
        let mut input = ReaderStream::new(reader);
        if worker {
            yield Bytes::from_static(rewrite::WORKER_SHIM.as_bytes());
            let mut start = Vec::new();
            while start.len() < 5 {
                match input.next().await { Some(bytes) => start.extend_from_slice(&bytes?), None => break }
            }
            let offset = if start.starts_with(&[0xef, 0xbb, 0xbf]) { 3 } else { 0 };
            if start.get(offset..offset + 2) == Some(b"#!") { start[offset..offset + 2].copy_from_slice(b"//"); }
            if !start.is_empty() { yield Bytes::from(start); }
            while let Some(bytes) = input.next().await { yield bytes?; }
        } else {
            let output = Arc::new(Mutex::new(Vec::new()));
            let sink = output.clone();
            let mut rewriter = rewrite::html_rewriter(prefix, host, port, move |bytes| sink.lock().unwrap().extend_from_slice(bytes));
            let mut pending = Vec::new();
            let mut injected = false;
            while let Some(bytes) = input.next().await {
                let bytes = bytes?;
                if injected { rewriter.write(&bytes).map_err(io::Error::other)?; }
                else {
                    let count = bytes.len().min(rewrite::HTML_LIMIT - pending.len());
                    pending.extend_from_slice(&bytes[..count]);
                    if let Some(position) = rewrite::insertion(&pending, pending.len() == rewrite::HTML_LIMIT) {
                        rewriter.write(&pending[..position]).map_err(io::Error::other)?;
                        rewriter.write(b"<script>").map_err(io::Error::other)?;
                        rewriter.write(rewrite::SHIM.as_bytes()).map_err(io::Error::other)?;
                        rewriter.write(b"</script>").map_err(io::Error::other)?;
                        rewriter.write(&pending[position..]).map_err(io::Error::other)?;
                        rewriter.write(&bytes[count..]).map_err(io::Error::other)?;
                        injected = true;
                        pending.clear();
                    }
                }
                let bytes = std::mem::take(&mut *output.lock().unwrap());
                if !bytes.is_empty() { yield Bytes::from(bytes); }
            }
            if !injected {
                let position = rewrite::insertion(&pending, true).unwrap_or(pending.len());
                rewriter.write(&pending[..position]).map_err(io::Error::other)?;
                rewriter.write(b"<script>").map_err(io::Error::other)?;
                rewriter.write(rewrite::SHIM.as_bytes()).map_err(io::Error::other)?;
                rewriter.write(b"</script>").map_err(io::Error::other)?;
                rewriter.write(&pending[position..]).map_err(io::Error::other)?;
            }
            rewriter.end().map_err(io::Error::other)?;
            let bytes = std::mem::take(&mut *output.lock().unwrap());
            if !bytes.is_empty() { yield Bytes::from(bytes); }
        }
    });
    Body::from_stream(output)
}

#[cfg(test)]
#[path = "body_tests.rs"]
mod tests;
