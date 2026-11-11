use super::*;

const RAW_MAX_BYTES: usize = 4 * 1024 * 1024;
const QUIET: Duration = Duration::from_millis(150);
const CAPTURE: Duration = Duration::from_millis(1500);

pub(super) async fn read(bin: &Path, target: &str, lines: u32, source: Option<AiAgentReadSource>) -> Result<String, String> {
    validate_target(target).map_err(|_| "invalid_request".to_string())?;
    let mut rpc = RpcClient::start(bin).await?;
    check_hello(&rpc.call("hello", json!({"generation": 1})).await?)?;
    let terminal = rpc.call("terminal.get", json!({"terminal": target})).await?;
    if !allowed(&terminal) || terminal["address"].as_str() != Some(target) {
        return Err("ai_agent_missing".into());
    }
    let hello = rpc.call("hello", json!({"generation": 1, "framed": true})).await?;
    if hello["framed"] != true || !hello["methods"].as_array().is_some_and(|methods| methods.iter().any(|m| m == "terminal.attach")) {
        return Err(incompatible());
    }
    let history = if source == Some(AiAgentReadSource::Visible) { 0 } else { lines as usize };
    let (rows, cols) = dimensions(&terminal, history)?;
    rpc.next_id += 1;
    let request = json!({"jsonrpc": "2.0", "id": rpc.next_id, "method": "terminal.attach",
        "params": {"terminal": target, "observe": true, "history": history, "cols": cols, "rows": rows}});
    write_frame(&mut rpc.stdin, 0, 0, request.to_string().as_bytes()).await?;
    let (channel, kind, bytes) = read_frame(&mut rpc.stdout, RPC_MAX_BYTES).await?;
    if channel != 0 || kind != 0 { return Err(incompatible()); }
    let reply: Value = serde_json::from_slice(&bytes).map_err(|_| incompatible())?;
    if reply["jsonrpc"] != "2.0" || reply["id"] != rpc.next_id { return Err(incompatible()); }
    if let Some(error) = reply.get("error") { return Err(rpc_error(error)); }
    let result = &reply["result"];
    let channel = result["channel"].as_u64().and_then(|n| u32::try_from(n).ok()).filter(|n| *n != 0).ok_or_else(incompatible)?;
    let terminal = &result["terminal"];
    if !allowed(terminal) || terminal["address"].as_str() != Some(target) { return Err("ai_agent_missing".into()); }
    let (rows, cols) = dimensions(terminal, history)?;
    let mut parser = vt100::Parser::new(rows, cols, history);
    let deadline = tokio::time::Instant::now() + CAPTURE;
    let mut total = 0;
    let mut received = false;
    let captured = async {
        while total < RAW_MAX_BYTES {
            let until = if received { deadline.min(tokio::time::Instant::now() + QUIET) } else { deadline };
            let frame = tokio::time::timeout_at(until, read_frame(&mut rpc.stdout, RAW_MAX_BYTES - total)).await;
            let (ch, kind, bytes) = match frame {
                Err(_) => break,
                Ok(Err(error)) if received && error.contains("raw byte limit") => break,
                Ok(result) => result?,
            };
            total += bytes.len();
            if ch != channel { return Err(incompatible()); }
            match kind {
                0 => {
                    parser.process(&bytes);
                    received = true;
                    match tokio::time::timeout_at(deadline, write_frame(&mut rpc.stdin, channel, 1, &(bytes.len() as u32).to_le_bytes())).await {
                        Err(_) => break,
                        Ok(result) => result?,
                    }
                }
                2 => break,
                _ => return Err(incompatible()),
            }
        }
        if !received { return Err("ai_agent_timeout".into()); }
        normalize(&mut parser, rows, cols, history, lines as usize)
    }.await;
    let _ = tokio::time::timeout(Duration::from_millis(200), write_frame(&mut rpc.stdin, channel, 2, &[])).await;
    captured
}

fn dimensions(terminal: &Value, history: usize) -> Result<(u16, u16), String> {
    let rows = terminal["rows"].as_u64().filter(|n| (1..=500).contains(n)).ok_or_else(incompatible)?;
    let cols = terminal["cols"].as_u64().filter(|n| (1..=1000).contains(n)).ok_or_else(incompatible)?;
    if (rows as usize + history) * cols as usize > 500_000 { return Err(incompatible()); }
    Ok((rows as u16, cols as u16))
}

async fn write_frame(stdin: &mut ChildStdin, channel: u32, kind: u8, bytes: &[u8]) -> Result<(), String> {
    let mut header = [0; 9];
    header[..4].copy_from_slice(&channel.to_le_bytes());
    header[4] = kind;
    header[5..].copy_from_slice(&(bytes.len() as u32).to_le_bytes());
    stdin.write_all(&header).await.map_err(unavailable)?;
    stdin.write_all(bytes).await.map_err(unavailable)
}

async fn read_frame(stdout: &mut BufReader<ChildStdout>, remaining: usize) -> Result<(u32, u8, Vec<u8>), String> {
    let mut header = [0; 9];
    stdout.read_exact(&mut header).await.map_err(unavailable)?;
    let channel = u32::from_le_bytes(header[..4].try_into().unwrap());
    let len = u32::from_le_bytes(header[5..].try_into().unwrap()) as usize;
    if len > remaining { return Err("ai_agent_failed: hc snapshot exceeds raw byte limit".into()); }
    let mut bytes = vec![0; len];
    stdout.read_exact(&mut bytes).await.map_err(unavailable)?;
    Ok((channel, header[4], bytes))
}

fn normalize(parser: &mut vt100::Parser, rows: u16, cols: u16, history: usize, lines: usize) -> Result<String, String> {
    parser.screen_mut().set_scrollback(history);
    let available = parser.screen().scrollback();
    let mut output = Vec::new();
    for offset in (1..=available).rev() {
        parser.screen_mut().set_scrollback(offset);
        output.push(row(parser.screen(), 0, cols));
    }
    parser.screen_mut().set_scrollback(0);
    for index in 0..rows { output.push(row(parser.screen(), index, cols)); }
    while output.last().is_some_and(String::is_empty) { output.pop(); }
    let text = output[output.len().saturating_sub(lines)..].join("\n");
    if text.len() > AI_AGENT_OUTPUT_MAX_BYTES { return Err("ai_agent_failed: hc snapshot exceeds output limit".into()); }
    Ok(text)
}

fn row(screen: &vt100::Screen, row: u16, cols: u16) -> String {
    let end = (0..cols).rev().find(|col| screen.cell(row, *col).is_some_and(|cell| !cell.contents().trim_end().is_empty()));
    let Some(end) = end else { return String::new(); };
    let mut text = String::new();
    let mut previous = String::new();
    for col in 0..=end {
        let cell = screen.cell(row, col).unwrap();
        if cell.is_wide_continuation() { continue; }
        let mut codes = Vec::new();
        for (enabled, code) in [(cell.bold(), "1"), (cell.dim(), "2"), (cell.italic(), "3"), (cell.underline(), "4"), (cell.inverse(), "7")] {
            if enabled { codes.push(code.to_string()); }
        }
        for (color, prefix) in [(cell.fgcolor(), 38), (cell.bgcolor(), 48)] {
            match color {
                vt100::Color::Default => {}
                vt100::Color::Idx(n) => codes.push(format!("{prefix};5;{n}")),
                vt100::Color::Rgb(r, g, b) => codes.push(format!("{prefix};2;{r};{g};{b}")),
            }
        }
        let style = codes.join(";");
        if style != previous {
            if style.is_empty() { text.push_str("\x1b[0m"); }
            else { text.push_str(&format!("\x1b[0;{style}m")); }
            previous = style;
        }
        if cell.contents().is_empty() { text.push(' '); }
        else { text.extend(cell.contents().chars().filter(|ch| !ch.is_control())); }
    }
    if !previous.is_empty() { text.push_str("\x1b[0m"); }
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_cursor_moves_colors_and_unicode_without_osc() {
        let mut parser = vt100::Parser::new(4, 20, 10);
        parser.process(b"obsolete\x1b[2J\x1b[H\x1b[31mRED\x1b[0m\x1b[2;3H\x1b[1;38;2;12;180;90mRGB\x1b]2;secret\x07");
        assert_eq!(normalize(&mut parser, 4, 20, 10, 80).unwrap(), "\x1b[0;38;5;1mRED\x1b[0m\n  \x1b[0;1;38;2;12;180;90mRGB\x1b[0m");
        assert_eq!(normalize(&mut parser, 4, 20, 10, 1).unwrap(), "  \x1b[0;1;38;2;12;180;90mRGB\x1b[0m");
    }

    #[test]
    fn preserves_history_and_trims_blank_rows() {
        let mut parser = vt100::Parser::new(2, 10, 10);
        parser.process("一\r\nsecond\r\nthird".as_bytes());
        assert_eq!(normalize(&mut parser, 2, 10, 10, 3).unwrap(), "一\nsecond\nthird");
        let mut empty = vt100::Parser::new(2, 10, 10);
        assert_eq!(normalize(&mut empty, 2, 10, 10, 3).unwrap(), "");
        assert!(dimensions(&json!({"rows": 0, "cols": 80}), 80).is_err());
        assert!(dimensions(&json!({"rows": 99999, "cols": 80}), 80).is_err());
    }

    #[test]
    fn preserves_emphasis_and_rejects_oversized_output() {
        let mut parser = vt100::Parser::new(1, 10, 0);
        parser.process(b"\x1b[2;3;4;7;48;5;200mX\x1b[1mY");
        assert_eq!(normalize(&mut parser, 1, 10, 0, 1).unwrap(), "\x1b[0;2;3;4;7;48;5;200mX\x1b[0;1;3;4;7;48;5;200mY\x1b[0m");
        let mut parser = vt100::Parser::new(300, 1000, 0);
        parser.process(&vec![b'x'; 300_000]);
        assert!(normalize(&mut parser, 300, 1000, 0, 300).unwrap_err().contains("output limit"));
    }
}
