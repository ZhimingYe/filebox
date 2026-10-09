//! Wash Jupyter `.ipynb` (nbformat) JSON into a self-contained HTML document
//! for the existing sandboxed HTML preview pipeline.
//!
//! Goals for v1:
//! - Prefer text + small images; skip oversized image outputs.
//! - Never pass through raw notebook HTML / widget / JS outputs.
//! - Escape all cell sources; sanitize markdown via ammonia.
//! - Truncate very large stream/error text with an explicit note.
//! - Keep memory bounded: callers already cap the source notebook size
//!   ([`crate::preview_doc::PREVIEW_DOCUMENT_MAX_BYTES`]).

use pulldown_cmark::{html, Options, Parser};
use serde::Deserialize;
use serde_json::Value;

/// Decoded image payload above this size is omitted from the preview.
/// Matches the product decision to skip large embedded figures (≈1.5 MiB).
pub const MAX_IMAGE_OUTPUT_BYTES: usize = 1_500_000;

/// Per stream / error / text output: longer text is truncated in the HTML.
pub const MAX_TEXT_OUTPUT_CHARS: usize = 200_000;

/// Hard cap on cells rendered (pathological notebooks).
pub const MAX_CELLS: usize = 5_000;

#[derive(Debug, Deserialize)]
struct Notebook {
    #[serde(default)]
    cells: Vec<RawCell>,
    #[serde(default)]
    metadata: Value,
    #[serde(default)]
    nbformat: Option<u32>,
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct RawCell {
    #[serde(default)]
    id: Option<String>,
    cell_type: String,
    #[serde(default)]
    source: NbString,
    #[serde(default)]
    outputs: Vec<RawOutput>,
    #[serde(default)]
    execution_count: Option<i64>,
    #[serde(default)]
    metadata: Value,
}

#[derive(Debug, Deserialize)]
struct RawOutput {
    #[serde(default)]
    output_type: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    text: NbString,
    #[serde(default)]
    data: Value,
    #[serde(default)]
    ename: Option<String>,
    #[serde(default)]
    evalue: Option<String>,
    #[serde(default)]
    traceback: Vec<String>,
}

/// nbformat `source` / `text` fields may be a string or a list of strings.
#[derive(Debug, Default, Deserialize)]
#[serde(untagged)]
enum NbString {
    String(String),
    Lines(Vec<String>),
    #[default]
    Missing,
}

impl NbString {
    fn join(&self) -> String {
        match self {
            NbString::String(s) => s.clone(),
            NbString::Lines(lines) => lines.concat(),
            NbString::Missing => String::new(),
        }
    }
}

/// Convert raw notebook bytes into a washed HTML document (UTF-8).
pub fn notebook_to_preview_html(raw: &[u8]) -> Result<String, String> {
    let nb: Notebook =
        serde_json::from_slice(raw).map_err(|e| format!("Invalid Jupyter notebook JSON: {e}"))?;
    Ok(render_notebook(&nb))
}

fn render_notebook(nb: &Notebook) -> String {
    let language = notebook_language(&nb.metadata);
    let display_name = notebook_display_name(&nb.metadata);
    let mut body = String::with_capacity(16 * 1024);
    body.push_str("<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n");
    body.push_str("<meta charset=\"utf-8\">\n");
    body.push_str("<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\n");
    body.push_str("<title>");
    body.push_str(&escape_html(
        display_name.as_deref().unwrap_or("Jupyter notebook"),
    ));
    body.push_str("</title>\n<style>\n");
    body.push_str(PREVIEW_CSS);
    body.push_str("\n</style>\n</head>\n<body>\n");
    body.push_str("<header class=\"nb-banner\">\n");
    body.push_str("<div class=\"nb-banner-title\">Jupyter notebook preview</div>\n");
    body.push_str("<div class=\"nb-banner-meta\">");
    if let Some(name) = display_name.as_deref() {
        body.push_str(&escape_html(name));
        body.push_str(" · ");
    }
    body.push_str("language: ");
    body.push_str(&escape_html(&language));
    if let Some(fmt) = nb.nbformat {
        body.push_str(&format!(" · nbformat {fmt}"));
    }
    body.push_str(" · read-only (not interactive)</div>\n</header>\n");

    let cells = if nb.cells.len() > MAX_CELLS {
        body.push_str(&format!(
            "<p class=\"nb-note\">Showing first {MAX_CELLS} of {} cells.</p>\n",
            nb.cells.len()
        ));
        &nb.cells[..MAX_CELLS]
    } else {
        nb.cells.as_slice()
    };

    for cell in cells {
        match cell.cell_type.as_str() {
            "markdown" => render_markdown_cell(&mut body, &cell.source.join()),
            "raw" => render_raw_cell(&mut body, &cell.source.join()),
            "code" => render_code_cell(&mut body, cell, &language),
            other => {
                body.push_str("<div class=\"nb-cell nb-unknown\">");
                body.push_str(&format!(
                    "<div class=\"nb-note\">Unsupported cell type: {}</div>",
                    escape_html(other)
                ));
                body.push_str("</div>\n");
            }
        }
    }

    body.push_str("</body>\n</html>\n");
    body
}

fn notebook_language(meta: &Value) -> String {
    meta.get("language_info")
        .and_then(|v| v.get("name"))
        .and_then(|v| v.as_str())
        .or_else(|| {
            meta.get("kernelspec")
                .and_then(|v| v.get("language"))
                .and_then(|v| v.as_str())
        })
        .unwrap_or("python")
        .to_string()
}

fn notebook_display_name(meta: &Value) -> Option<String> {
    meta.get("kernelspec")
        .and_then(|v| v.get("display_name"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

fn render_markdown_cell(out: &mut String, source: &str) {
    out.push_str("<div class=\"nb-cell nb-markdown\">");
    out.push_str(&sanitize_markdown(source));
    out.push_str("</div>\n");
}

fn render_raw_cell(out: &mut String, source: &str) {
    out.push_str("<div class=\"nb-cell nb-raw\"><pre>");
    out.push_str(&escape_html(source));
    out.push_str("</pre></div>\n");
}

fn render_code_cell(out: &mut String, cell: &RawCell, language: &str) {
    out.push_str("<div class=\"nb-cell nb-code\">");
    out.push_str("<div class=\"nb-prompt\">");
    match cell.execution_count {
        Some(n) => out.push_str(&format!("In&nbsp;[{n}]:")),
        None => out.push_str("In&nbsp;[&nbsp;]:"),
    }
    out.push_str("</div>");
    out.push_str("<div class=\"nb-code-body\">");
    out.push_str(&format!(
        "<pre class=\"nb-source\" data-lang=\"{}\"><code>",
        escape_attr(language)
    ));
    out.push_str(&escape_html(&cell.source.join()));
    out.push_str("</code></pre>");

    if !cell.outputs.is_empty() {
        out.push_str("<div class=\"nb-outputs\">");
        for output in &cell.outputs {
            render_output(out, output);
        }
        out.push_str("</div>");
    }
    out.push_str("</div></div>\n");
}

fn render_output(out: &mut String, output: &RawOutput) {
    match output.output_type.as_str() {
        "stream" => {
            let err = output.name.as_deref() == Some("stderr");
            let class = if err {
                "nb-output nb-stream nb-stderr"
            } else {
                "nb-output nb-stream"
            };
            out.push_str(&format!("<pre class=\"{class}\">"));
            // Streams (esp. stderr from rich tooling) often include ANSI codes.
            out.push_str(&escape_html(&truncate_text(&strip_ansi(
                &output.text.join(),
            ))));
            out.push_str("</pre>");
        }
        "error" => {
            let mut text = String::new();
            if !output.traceback.is_empty() {
                // Traceback lines already include trailing newlines (nbformat/IPython);
                // concatenate like the classic frontend, then strip ANSI.
                text.push_str(&strip_ansi(&output.traceback.concat()));
            } else {
                text.push_str(&format!(
                    "{}: {}",
                    output.ename.as_deref().unwrap_or("Error"),
                    output.evalue.as_deref().unwrap_or("")
                ));
            }
            out.push_str("<pre class=\"nb-output nb-error\">");
            out.push_str(&escape_html(&truncate_text(&text)));
            out.push_str("</pre>");
        }
        "display_data" | "execute_result" => render_mime_bundle(out, &output.data),
        other => {
            out.push_str(&format!(
                "<div class=\"nb-note\">Skipped output type: {}</div>",
                escape_html(other)
            ));
        }
    }
}

fn render_mime_bundle(out: &mut String, data: &Value) {
    let Some(obj) = data.as_object() else {
        out.push_str("<div class=\"nb-note\">Empty rich output</div>");
        return;
    };

    // Safe MIME preference adapted from nbconvert HTMLExporter display_data_priority:
    // skip widgets / JS / text/html (sandbox policy); among remaining types prefer
    // raster/SVG images, then markdown, then plain. When an image is omitted
    // (oversize / invalid), fall through to the next candidate instead of stopping.
    const ORDER: &[&str] = &[
        "image/png",
        "image/jpeg",
        "image/svg+xml",
        "text/markdown",
        "text/plain",
    ];

    let mut deferred_notes: Vec<String> = Vec::new();

    for mime in ORDER {
        let Some(payload) = obj.get(*mime) else {
            continue;
        };
        let value = nb_json_string(payload);
        match *mime {
            "image/png" | "image/jpeg" => {
                let cleaned = value.split_whitespace().collect::<String>();
                match decoded_base64_len(&cleaned) {
                    Some(len) if len > MAX_IMAGE_OUTPUT_BYTES => {
                        deferred_notes.push(format!(
                            "<div class=\"nb-note\">Image omitted ({mime}, ~{} bytes; limit {} bytes)</div>",
                            len, MAX_IMAGE_OUTPUT_BYTES
                        ));
                        continue;
                    }
                    Some(_) => {
                        for note in &deferred_notes {
                            out.push_str(note);
                        }
                        out.push_str(&format!(
                            "<img class=\"nb-image\" alt=\"\" src=\"data:{mime};base64,{}\">",
                            escape_attr(&cleaned)
                        ));
                        return;
                    }
                    None => {
                        deferred_notes.push(
                            "<div class=\"nb-note\">Invalid image payload omitted</div>"
                                .to_string(),
                        );
                        continue;
                    }
                }
            }
            "image/svg+xml" => {
                // Encode as an <img data URL> so scripts inside SVG never execute.
                let bytes = value.as_bytes();
                if bytes.len() > MAX_IMAGE_OUTPUT_BYTES {
                    deferred_notes.push(format!(
                        "<div class=\"nb-note\">SVG omitted (~{} bytes; limit {} bytes)</div>",
                        bytes.len(),
                        MAX_IMAGE_OUTPUT_BYTES
                    ));
                    continue;
                }
                for note in &deferred_notes {
                    out.push_str(note);
                }
                let encoded = urlencoding_encode(&value);
                out.push_str(&format!(
                    "<img class=\"nb-image\" alt=\"\" src=\"data:image/svg+xml;charset=utf-8,{encoded}\">"
                ));
                return;
            }
            "text/markdown" => {
                for note in &deferred_notes {
                    out.push_str(note);
                }
                out.push_str("<div class=\"nb-output nb-md-output\">");
                out.push_str(&sanitize_markdown(&value));
                out.push_str("</div>");
                return;
            }
            "text/plain" => {
                for note in &deferred_notes {
                    out.push_str(note);
                }
                out.push_str("<pre class=\"nb-output nb-text\">");
                out.push_str(&escape_html(&truncate_text(&value)));
                out.push_str("</pre>");
                return;
            }
            _ => {}
        }
    }

    // Omitted/invalid images with no remaining safe MIME still surface their notes.
    if !deferred_notes.is_empty() {
        for note in &deferred_notes {
            out.push_str(note);
        }
        return;
    }

    let kinds: Vec<&str> = obj.keys().map(|s| s.as_str()).collect();
    out.push_str(&format!(
        "<div class=\"nb-note\">Interactive / HTML output not shown ({}) </div>",
        escape_html(&kinds.join(", "))
    ));
}

fn nb_json_string(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Array(items) => items
            .iter()
            .filter_map(|i| i.as_str())
            .collect::<Vec<_>>()
            .concat(),
        _ => String::new(),
    }
}

fn sanitize_markdown(md: &str) -> String {
    let mut options = Options::empty();
    options.insert(Options::ENABLE_TABLES);
    options.insert(Options::ENABLE_STRIKETHROUGH);
    options.insert(Options::ENABLE_TASKLISTS);
    let parser = Parser::new_ext(md, options);
    // Drop raw HTML events before pushing — ammonia is the second line of defense.
    let filtered = parser.filter(|ev| {
        !matches!(
            ev,
            pulldown_cmark::Event::Html(_) | pulldown_cmark::Event::InlineHtml(_)
        )
    });
    let mut html_buf = String::new();
    html::push_html(&mut html_buf, filtered);
    ammonia::Builder::default()
        .link_rel(Some("noopener noreferrer"))
        .clean(&html_buf)
        .to_string()
}

fn truncate_text(s: &str) -> String {
    if s.chars().count() <= MAX_TEXT_OUTPUT_CHARS {
        return s.to_string();
    }
    let truncated: String = s.chars().take(MAX_TEXT_OUTPUT_CHARS).collect();
    format!("{truncated}\n… output truncated")
}

fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            if chars.peek() == Some(&'[') {
                chars.next();
                while let Some(n) = chars.next() {
                    if ('a'..='z').contains(&n) || ('A'..='Z').contains(&n) {
                        break;
                    }
                }
            }
            continue;
        }
        out.push(c);
    }
    out
}

fn decoded_base64_len(b64: &str) -> Option<usize> {
    if b64.is_empty() {
        return None;
    }
    // Reject obviously non-base64 early; Engine::decode validates fully when needed.
    if !b64
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/' | b'='))
    {
        return None;
    }
    // Estimate without allocating the decoded buffer for huge payloads.
    let padding = b64.bytes().rev().take_while(|&b| b == b'=').count();
    let approx = b64.len().saturating_mul(3) / 4;
    Some(approx.saturating_sub(padding))
}

fn escape_html(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(c),
        }
    }
    out
}

fn escape_attr(s: &str) -> String {
    escape_html(s)
}

/// Minimal percent-encoding for SVG data URLs (utf-8 charset form).
fn urlencoding_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 2);
    for b in s.as_bytes() {
        match *b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

const PREVIEW_CSS: &str = r#"
:root {
  color-scheme: light dark;
  --bg: #0f1115;
  --surface: #171a21;
  --border: #2a2f3a;
  --text: #e6e8ee;
  --muted: #9aa3b2;
  --code-bg: #12151c;
  --accent: #6ea8fe;
  --danger-bg: #3a1a1a;
  --danger: #ff8e8e;
  --note-bg: #1c2430;
}
@media (prefers-color-scheme: light) {
  :root {
    --bg: #f6f7f9;
    --surface: #ffffff;
    --border: #d7dbe3;
    --text: #1b1f27;
    --muted: #5b6575;
    --code-bg: #f0f2f6;
    --accent: #245bdb;
    --danger-bg: #fdecec;
    --danger: #b42318;
    --note-bg: #eef2f8;
  }
}
html, body {
  margin: 0;
  padding: 0;
  background: var(--bg);
  color: var(--text);
  font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
.nb-banner {
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
  background: var(--surface);
  position: sticky;
  top: 0;
  z-index: 1;
}
.nb-banner-title { font-weight: 600; font-size: 13px; }
.nb-banner-meta { color: var(--muted); font-size: 12px; margin-top: 2px; }
.nb-cell { padding: 10px 16px; border-bottom: 1px solid var(--border); }
.nb-markdown { max-width: 920px; }
.nb-markdown pre, .nb-md-output pre {
  background: var(--code-bg);
  padding: 8px 10px;
  overflow-x: auto;
  border-radius: 6px;
}
.nb-markdown code, .nb-md-output code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12.5px;
}
.nb-markdown a, .nb-md-output a { color: var(--accent); }
.nb-code {
  display: grid;
  grid-template-columns: 72px minmax(0, 1fr);
  gap: 8px;
  align-items: start;
}
.nb-prompt {
  color: var(--muted);
  font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  padding-top: 10px;
  text-align: right;
}
.nb-source {
  margin: 0;
  padding: 10px 12px;
  background: var(--code-bg);
  border: 1px solid var(--border);
  border-radius: 6px;
  overflow-x: auto;
  white-space: pre-wrap;
  word-break: break-word;
  font: 12.5px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.nb-outputs { margin-top: 8px; }
.nb-output {
  margin: 0 0 6px;
  padding: 8px 10px;
  overflow-x: auto;
  white-space: pre-wrap;
  word-break: break-word;
  font: 12.5px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.nb-stderr, .nb-error { background: var(--danger-bg); color: var(--danger); }
.nb-image { max-width: 100%; height: auto; display: block; margin: 6px 0; }
.nb-note {
  color: var(--muted);
  background: var(--note-bg);
  border-radius: 6px;
  padding: 8px 10px;
  font-size: 12.5px;
  margin: 8px 16px;
}
.nb-raw pre {
  margin: 0;
  white-space: pre-wrap;
  font: 12.5px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
"#;

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_notebook() -> String {
        serde_json::json!({
            "nbformat": 4,
            "nbformat_minor": 5,
            "metadata": {
                "kernelspec": {
                    "display_name": "Python 3",
                    "language": "python",
                    "name": "python3"
                },
                "language_info": { "name": "python" }
            },
            "cells": [
                {
                    "id": "md1",
                    "cell_type": "markdown",
                    "source": ["# Hello\n", "\n", "A **bold** notebook with <script>alert(1)</script>."]
                },
                {
                    "id": "code1",
                    "cell_type": "code",
                    "execution_count": 1,
                    "source": ["print('hi')\n", "1 + 1"],
                    "outputs": [
                        {
                            "output_type": "stream",
                            "name": "stdout",
                            "text": ["hi\n"]
                        },
                        {
                            "output_type": "execute_result",
                            "data": { "text/plain": "2" },
                            "metadata": {},
                            "execution_count": 1
                        }
                    ]
                },
                {
                    "id": "err1",
                    "cell_type": "code",
                    "execution_count": 2,
                    "source": "raise ValueError('boom')",
                    "outputs": [{
                        "output_type": "error",
                        "ename": "ValueError",
                        "evalue": "boom",
                        "traceback": [
                            "\u{1b}[31mValueError\u{1b}[0m: boom"
                        ]
                    }]
                },
                {
                    "id": "img1",
                    "cell_type": "code",
                    "execution_count": 3,
                    "source": ["# tiny png"],
                    "outputs": [{
                        "output_type": "display_data",
                        // 1x1 PNG
                        "data": {
                            "image/png": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
                            "text/html": "<img src=x onerror=alert(1)>"
                        },
                        "metadata": {}
                    }]
                },
                {
                    "id": "html1",
                    "cell_type": "code",
                    "execution_count": 4,
                    "source": "HTML('<b>x</b>')",
                    "outputs": [{
                        "output_type": "display_data",
                        "data": {
                            "text/html": "<script>alert(1)</script><b>hi</b>",
                            "text/plain": "<IPython.core.display.HTML object>"
                        },
                        "metadata": {}
                    }]
                }
            ]
        })
        .to_string()
    }

    #[test]
    fn washes_markdown_code_stream_error_and_image() {
        let html = notebook_to_preview_html(fixture_notebook().as_bytes()).unwrap();
        assert!(html.contains("Jupyter notebook preview"));
        assert!(html.contains("Python 3"));
        assert!(html.contains("<h1>Hello</h1>"));
        assert!(!html.contains("<script>alert"));
        assert!(html.contains("In&nbsp;[1]:"));
        assert!(html.contains("print(&#39;hi&#39;)"));
        assert!(html.contains("nb-stream"));
        assert!(html.contains(">hi"));
        assert!(html.contains("nb-error"));
        assert!(html.contains("ValueError"));
        assert!(!html.contains("\u{1b}"));
        assert!(html.contains("data:image/png;base64,"));
        // text/plain is used because text/html is intentionally not rendered
        assert!(html.contains("IPython.core.display.HTML object"));
        assert!(!html.contains("onerror=alert"));
    }

    #[test]
    fn skips_oversized_image_outputs() {
        // ~2 MiB of 'A' base64-ish → decoded estimate over limit
        let big = "A".repeat(2_800_000);
        let nb = serde_json::json!({
            "nbformat": 4,
            "metadata": {},
            "cells": [{
                "cell_type": "code",
                "source": "",
                "outputs": [{
                    "output_type": "display_data",
                    "data": { "image/png": big },
                    "metadata": {}
                }]
            }]
        });
        let html = notebook_to_preview_html(nb.to_string().as_bytes()).unwrap();
        assert!(html.contains("Image omitted"));
        assert!(!html.contains("data:image/png;base64,AAA"));
    }

    #[test]
    fn rejects_non_json() {
        let err = notebook_to_preview_html(b"not a notebook").unwrap_err();
        assert!(err.contains("Invalid Jupyter notebook JSON"));
    }

    #[test]
    fn washes_repo_sample_fixture() {
        let raw = include_bytes!("../../../testdata/sample.ipynb");
        let html = notebook_to_preview_html(raw).unwrap();
        assert!(html.contains("Sample notebook"));
        assert!(html.contains("nb-stream"));
        assert!(html.contains("data:image/png;base64,"));
        assert!(html.contains("RuntimeError"));
    }

    #[test]
    fn is_safe_against_markdown_raw_html() {
        let nb = serde_json::json!({
            "nbformat": 4,
            "metadata": {},
            "cells": [{
                "cell_type": "markdown",
                "source": "<img src=x onerror=alert(1)>\n\n[ok](https://example.com)\n\n[bad](javascript:alert(1))"
            }]
        });
        let html = notebook_to_preview_html(nb.to_string().as_bytes()).unwrap();
        assert!(!html.contains("onerror"));
        assert!(html.contains("https://example.com"));
        // javascript: links should be stripped or neutralized by ammonia
        assert!(!html.contains("javascript:alert"));
    }

    #[test]
    fn prefers_markdown_over_plain_in_mime_bundle() {
        let nb = serde_json::json!({
            "nbformat": 4,
            "metadata": {},
            "cells": [{
                "cell_type": "code",
                "source": "",
                "outputs": [{
                    "output_type": "display_data",
                    "data": {
                        "text/plain": "plain fallback",
                        "text/markdown": "**bold md**"
                    },
                    "metadata": {}
                }]
            }]
        });
        let html = notebook_to_preview_html(nb.to_string().as_bytes()).unwrap();
        assert!(html.contains("<strong>bold md</strong>"));
        assert!(html.contains("nb-md-output"));
        assert!(!html.contains("plain fallback"));
    }

    #[test]
    fn oversized_image_falls_through_to_text_plain() {
        let big = "A".repeat(2_800_000);
        let nb = serde_json::json!({
            "nbformat": 4,
            "metadata": {},
            "cells": [{
                "cell_type": "code",
                "source": "",
                "outputs": [{
                    "output_type": "display_data",
                    "data": {
                        "image/png": big,
                        "text/plain": "figure-repr"
                    },
                    "metadata": {}
                }]
            }]
        });
        let html = notebook_to_preview_html(nb.to_string().as_bytes()).unwrap();
        assert!(html.contains("Image omitted"));
        assert!(html.contains("figure-repr"));
        assert!(!html.contains("data:image/png;base64,AAA"));
    }

    #[test]
    fn concatenates_traceback_lines_without_extra_blank_lines() {
        let nb = serde_json::json!({
            "nbformat": 4,
            "metadata": {},
            "cells": [{
                "cell_type": "code",
                "source": "raise ValueError('x')",
                "outputs": [{
                    "output_type": "error",
                    "ename": "ValueError",
                    "evalue": "x",
                    "traceback": [
                        "line1\n",
                        "line2\n",
                        "ValueError: x\n"
                    ]
                }]
            }]
        });
        let html = notebook_to_preview_html(nb.to_string().as_bytes()).unwrap();
        assert!(html.contains("line1\nline2\nValueError: x"));
        assert!(!html.contains("line1\n\nline2"));
    }

    #[test]
    fn strips_ansi_from_stream_output() {
        let nb = serde_json::json!({
            "nbformat": 4,
            "metadata": {},
            "cells": [{
                "cell_type": "code",
                "source": "",
                "outputs": [{
                    "output_type": "stream",
                    "name": "stderr",
                    "text": "\u{1b}[31mwarn\u{1b}[0m: hi\n"
                }]
            }]
        });
        let html = notebook_to_preview_html(nb.to_string().as_bytes()).unwrap();
        assert!(html.contains("warn: hi"));
        assert!(!html.contains('\u{1b}'));
    }

    #[test]
    fn handles_unicode_empty_cells_and_string_source() {
        let nb = serde_json::json!({
            "nbformat": 4,
            "metadata": { "language_info": { "name": "python" } },
            "cells": [
                { "cell_type": "markdown", "source": "" },
                {
                    "cell_type": "code",
                    "execution_count": null,
                    "source": "print('你好')",
                    "outputs": []
                },
                { "cell_type": "raw", "source": ["raw <tag>\n", "line2"] }
            ]
        });
        let html = notebook_to_preview_html(nb.to_string().as_bytes()).unwrap();
        assert!(html.contains("你好"));
        assert!(html.contains("In&nbsp;[&nbsp;]:"));
        assert!(html.contains("raw &lt;tag&gt;"));
        assert!(html.contains("nb-raw"));
    }

    #[test]
    fn encodes_svg_as_img_data_url() {
        let nb = serde_json::json!({
            "nbformat": 4,
            "metadata": {},
            "cells": [{
                "cell_type": "code",
                "source": "",
                "outputs": [{
                    "output_type": "display_data",
                    "data": {
                        "image/svg+xml": "<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script><rect width='1' height='1'/></svg>",
                        "text/plain": "<svg>"
                    },
                    "metadata": {}
                }]
            }]
        });
        let html = notebook_to_preview_html(nb.to_string().as_bytes()).unwrap();
        assert!(html.contains("data:image/svg+xml;charset=utf-8,"));
        // Script must be percent-encoded inside the data URL, not live markup.
        assert!(!html.contains("<script>alert"));
        assert!(html.contains("%3Cscript%3E"));
    }
}
