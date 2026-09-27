//! Agent-owned PTYs survive transport loss. Each attachment needs a fresh local
//! TOTP code; routing ids authorize input only while that attachment is live.
use std::time::{SystemTime, UNIX_EPOCH};
pub fn unix_millis() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

#[cfg(unix)]
mod unix_impl {
    use super::unix_millis;
    use std::{collections::{HashMap, VecDeque}, io::{Read, Write}, sync::{Arc, Mutex}, time::{Duration, Instant}};
    use filebox_protocol::message::{AgentMessage, TerminalSessionInfo, TERMINAL_CHUNK_MAX_BYTES};
    use portable_pty::{Child, CommandBuilder, MasterPty, PtySize};
    use tokio::sync::mpsc;
    const MAX_SESSIONS: usize = 8;
    const HISTORY_BYTES: usize = 256 * 1024;

    struct Attachment { id: String, tx: mpsc::Sender<AgentMessage> }
    #[derive(Default)]
    struct Output {
        attachment: Option<Attachment>,
        history: VecDeque<Vec<u8>>,
        bytes: usize,
    }
    impl Output {
        fn disconnect(&mut self, reason: &str) {
            if let Some(a) = self.attachment.take() {
                let msg = AgentMessage::TerminalClosed { req_id: a.id, reason: Some(reason.into()) };
                if let Err(mpsc::error::TrySendError::Full(msg)) = a.tx.try_send(msg) {
                    // At most one notification worker per detached attachment.
                    std::thread::spawn(move || { let _ = a.tx.blocking_send(msg); });
                }
            }
        }
        fn write(&mut self, data: &[u8]) {
            // Coalesce small writes so both bytes and replay frame count are bounded.
            for chunk in data.chunks(TERMINAL_CHUNK_MAX_BYTES) {
                if self.history.back().is_some_and(|b| b.len() + chunk.len() <= TERMINAL_CHUNK_MAX_BYTES) {
                    self.history.back_mut().unwrap().extend_from_slice(chunk);
                } else { self.history.push_back(chunk.to_vec()); }
                self.bytes += chunk.len();
                while self.bytes > HISTORY_BYTES {
                    self.bytes -= self.history.pop_front().unwrap().len();
                }
                if let Some(a) = &self.attachment {
                    if a.tx.try_send(AgentMessage::TerminalOutput { req_id: a.id.clone(), data: chunk.to_vec() }).is_err() {
                        self.disconnect("Output stalled; reconnect to resume the shell");
                    }
                }
            }
        }
    }
    struct Session {
        input: std::sync::mpsc::SyncSender<Vec<u8>>,
        master: Box<dyn MasterPty + Send>,
        child: Arc<Mutex<Box<dyn Child + Send + Sync>>>,
        output: Arc<Mutex<Output>>,
        created: Instant,
        last_input: u64,
        cols: u16,
        rows: u16,
    }
    struct Pending { tx: mpsc::Sender<AgentMessage>, cancelled: bool }
    #[derive(Default)]
    struct State {
        sessions: HashMap<String, Session>,
        pending: HashMap<String, Pending>,
        last_counter: Option<u64>,
        failures: VecDeque<Instant>,
    }
    pub struct TerminalManager { state: Mutex<State>, secret: Option<String> }
    impl TerminalManager {
        pub fn new(secret: Option<String>) -> Self { Self { state: Mutex::new(State::default()), secret } }
        fn check_totp(&self, state: &mut State, code: Option<&str>) -> Result<(), &'static str> {
            let secret = self.secret.as_deref().ok_or("terminal_2fa_not_configured")?;
            let now = Instant::now();
            state.failures.retain(|at| now.duration_since(*at) < Duration::from_secs(30));
            if state.failures.len() >= 5 { return Err("terminal_2fa_rate_limited"); }
            let counter = code.and_then(|c| filebox_protocol::totp::matching_counter_at(secret, c, filebox_protocol::totp::current_counter()));
            if let Some(counter) = counter.filter(|c| state.last_counter.is_none_or(|last| *c > last)) {
                state.last_counter = Some(counter);
                Ok(())
            } else {
                state.failures.push_back(now);
                Err(if code.is_none() { "terminal_2fa_required" } else { "terminal_2fa_invalid" })
            }
        }
        fn reject(tx: &mpsc::Sender<AgentMessage>, id: String, error: &str) {
            let msg = AgentMessage::TerminalOpened { req_id: id, error: Some(error.into()) };
            // Never spawn unbounded workers for unauthenticated requests.
            // A saturated connection is already bounded by the Hub open deadline.
            if tx.try_send(msg).is_err() {
                tracing::debug!("Terminal rejection could not be queued");
            }
        }
        pub fn open(self: &Arc<Self>, id: String, cols: u16, rows: u16, code: Option<String>, tx: mpsc::Sender<AgentMessage>) {
            {
                let mut state = self.state.lock().unwrap();
                if state.sessions.len() + state.pending.len() >= MAX_SESSIONS || state.pending.contains_key(&id) || state.sessions.contains_key(&id) {
                    Self::reject(&tx, id, "agent_overloaded"); return;
                }
                if let Err(error) = self.check_totp(&mut state, code.as_deref()) { Self::reject(&tx, id, error); return; }
                state.pending.insert(id.clone(), Pending { tx: tx.clone(), cancelled: false });
            }
            let manager = self.clone();
            std::thread::spawn(move || {
                let result = Self::spawn(cols, rows);
                let mut state = manager.state.lock().unwrap();
                let pending = state.pending.remove(&id).unwrap();
                match result {
                    Err(error) => { tracing::warn!("PTY setup failed: {error}"); Self::reject(&tx, id, "terminal_unavailable"); }
                    Ok((session, mut reader)) => {
                        let output = session.output.clone();
                        let child = session.child.clone();
                        if !pending.cancelled && !tx.is_closed() {
                            let mut out = output.lock().unwrap();
                            if tx.try_send(AgentMessage::TerminalOpened { req_id: id.clone(), error: None }).is_ok() {
                                out.attachment = Some(Attachment { id: id.clone(), tx });
                            }
                        }
                        state.sessions.insert(id.clone(), session);
                        drop(state);
                        let mut buf = [0u8; TERMINAL_CHUNK_MAX_BYTES];
                        while let Ok(n) = reader.read(&mut buf) {
                            if n == 0 { break; }
                            output.lock().unwrap().write(&buf[..n]);
                        }
                        {
                            let mut state = manager.state.lock().unwrap();
                            if state.sessions.get(&id).is_some_and(|s| Arc::ptr_eq(&s.output, &output)) { state.sessions.remove(&id); }
                        }
                        output.lock().unwrap().disconnect("Shell exited");
                        if let Ok(mut child) = child.lock() {
                            for _ in 0..20 {
                                if !matches!(child.try_wait(), Ok(None)) { break; }
                                std::thread::sleep(Duration::from_millis(10));
                            }
                        };
                    }
                }
            });
        }
        fn spawn(cols: u16, rows: u16) -> Result<(Session, Box<dyn Read + Send>), String> {
            let (cols, rows) = (cols.clamp(1, 500), rows.clamp(1, 500));
            let pair = portable_pty::native_pty_system().openpty(PtySize { cols, rows, pixel_width: 0, pixel_height: 0 }).map_err(|e| e.to_string())?;
            // Obtain IO before spawning so failures cannot orphan a child.
            let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
            let mut writer = pair.master.take_writer().map_err(|e| e.to_string())?;
            let shell = std::env::var("SHELL").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "/bin/sh".into());
            let mut cmd = CommandBuilder::new(shell);
            if let Some(home) = dirs::home_dir() { cmd.cwd(home); }
            cmd.env("TERM", "xterm-256color");
            let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
            drop(pair.slave);
            let (input, rx) = std::sync::mpsc::sync_channel::<Vec<u8>>(64);
            std::thread::spawn(move || {
                while let Ok(data) = rx.recv() { if writer.write_all(&data).and_then(|_| writer.flush()).is_err() { break; } }
            });
            Ok((Session { input, master: pair.master, child: Arc::new(Mutex::new(child)), output: Arc::new(Mutex::new(Output::default())), created: Instant::now(), last_input: unix_millis(), cols, rows }, reader))
        }
        pub fn attach(&self, id: String, session_id: String, code: Option<String>, tx: mpsc::Sender<AgentMessage>) {
            let mut state = self.state.lock().unwrap();
            if let Err(error) = self.check_totp(&mut state, code.as_deref()) { Self::reject(&tx, id, error); return; }
            let Some(session) = state.sessions.get(&session_id) else { Self::reject(&tx, id, "terminal_session_missing"); return; };
            let mut out = session.output.lock().unwrap();
            if out.attachment.as_ref().is_some_and(|a| !a.tx.is_closed()) { Self::reject(&tx, id, "terminal_session_attached"); return; }
            out.attachment = Some(Attachment { id: id.clone(), tx: tx.clone() });
            let mut ok = tx.try_send(AgentMessage::TerminalOpened { req_id: id.clone(), error: None }).is_ok();
            for data in &out.history {
                if !ok { break; }
                ok = tx.try_send(AgentMessage::TerminalOutput { req_id: id.clone(), data: data.clone() }).is_ok();
            }
            if !ok { out.disconnect("Replay stalled; retry attachment"); }
        }
        pub fn detach(&self, id: &str) {
            let mut state = self.state.lock().unwrap();
            if let Some(p) = state.pending.get_mut(id) { p.cancelled = true; }
            for s in state.sessions.values() {
                let mut out = s.output.lock().unwrap();
                if out.attachment.as_ref().is_some_and(|a| a.id == id) { out.attachment = None; }
            }
        }
        pub fn detach_connection(&self, tx: &mpsc::Sender<AgentMessage>) {
            let mut state = self.state.lock().unwrap();
            for p in state.pending.values_mut() { if p.tx.same_channel(tx) { p.cancelled = true; } }
            for s in state.sessions.values() {
                let mut out = s.output.lock().unwrap();
                if out.attachment.as_ref().is_some_and(|a| a.tx.same_channel(tx)) { out.attachment = None; }
            }
        }
        pub fn input(&self, id: &str, data: &[u8]) {
            let mut state = self.state.lock().unwrap();
            for s in state.sessions.values_mut() {
                let mut out = s.output.lock().unwrap();
                if out.attachment.as_ref().is_some_and(|a| a.id == id && !a.tx.is_closed()) {
                    s.last_input = unix_millis();
                    if data.len() > 48 * 1024 || s.input.try_send(data.to_vec()).is_err() {
                        out.disconnect("Shell input stalled; some input was dropped. Reconnect to resume.");
                    }
                    break;
                }
            }
        }
        pub fn resize(&self, id: &str, cols: u16, rows: u16) {
            let mut state = self.state.lock().unwrap();
            for s in state.sessions.values_mut() {
                if s.output.lock().unwrap().attachment.as_ref().is_some_and(|a| a.id == id && !a.tx.is_closed()) {
                    s.cols = cols.clamp(1, 500); s.rows = rows.clamp(1, 500);
                    let _ = s.master.resize(PtySize { cols: s.cols, rows: s.rows, pixel_width: 0, pixel_height: 0 });
                    break;
                }
            }
        }
        pub fn list(&self) -> Vec<TerminalSessionInfo> {
            self.state.lock().unwrap().sessions.iter().map(|(id, s)| TerminalSessionInfo { req_id: id.clone(), age_secs: s.created.elapsed().as_secs(), idle_secs: unix_millis().saturating_sub(s.last_input) / 1000, cols: s.cols, rows: s.rows }).collect()
        }
        pub fn close(&self, id: &str) {
            let session = self.state.lock().unwrap().sessions.remove(id);
            if let Some(s) = session {
                s.output.lock().unwrap().disconnect("Session ended by user");
                if let Ok(mut child) = s.child.lock() { let _ = child.kill(); let _ = child.try_wait(); };
            }
        }
    }
    #[cfg(test)]
    mod tests {
        use super::*;
        const SECRET: &str = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
        fn code(offset: u64) -> String {
            let raw = filebox_protocol::totp::base32_decode(SECRET).unwrap();
            format!("{:06}", filebox_protocol::totp::totp_at(&raw, filebox_protocol::totp::current_counter() + offset))
        }
        async fn opened(rx: &mut mpsc::Receiver<AgentMessage>) -> Option<String> {
            loop {
                if let AgentMessage::TerminalOpened { error, .. } = tokio::time::timeout(Duration::from_secs(10), rx.recv()).await.unwrap().unwrap() { return error; }
            }
        }
        async fn output_contains(rx: &mut mpsc::Receiver<AgentMessage>, expected: &str) {
            let mut text = String::new();
            tokio::time::timeout(Duration::from_secs(10), async {
                loop {
                    if let Some(AgentMessage::TerminalOutput { data, .. }) = rx.recv().await {
                        text.push_str(&String::from_utf8_lossy(&data));
                        if text.contains(expected) { break; }
                    }
                }
            }).await.unwrap();
        }
        #[tokio::test]
        async fn disconnect_preserves_shell_and_fresh_attachment_controls_input() {
            let manager = Arc::new(TerminalManager::new(Some(SECRET.into())));
            let (tx, mut rx) = mpsc::channel(64);
            manager.open("shell".into(), 80, 24, Some(code(0)), tx.clone());
            assert_eq!(opened(&mut rx).await, None);
            manager.input("shell", b"FB_KEEP=survived; printf 'set-%s\n' done\n");
            output_contains(&mut rx, "set-done").await;
            manager.detach_connection(&tx);
            drop(rx);
            assert_eq!(manager.list().len(), 1);
            // A stable session id is not authorization after detachment.
            manager.input("shell", b"FB_KEEP=wrong\n");
            let (tx2, mut rx2) = mpsc::channel(64);
            manager.attach("replay".into(), "shell".into(), Some(code(0)), tx2.clone());
            assert_eq!(opened(&mut rx2).await.as_deref(), Some("terminal_2fa_invalid"));
            manager.attach("resume".into(), "shell".into(), Some(code(1)), tx2);
            assert_eq!(opened(&mut rx2).await, None);
            manager.input("resume", b"printf 'kept-%s\n' \"$FB_KEEP\"\n");
            output_contains(&mut rx2, "kept-survived").await;
            manager.close("shell");
            assert!(manager.list().is_empty());
        }
        #[tokio::test]
        async fn missing_secret_fails_closed() {
            let manager = Arc::new(TerminalManager::new(None));
            let (tx, mut rx) = mpsc::channel(64);
            manager.open("no".into(), 80, 24, None, tx);
            assert_eq!(opened(&mut rx).await.as_deref(), Some("terminal_2fa_not_configured"));
            assert!(manager.list().is_empty());
        }
        #[test]
        fn pending_opens_are_cancelled_only_for_their_connection() {
            let manager = TerminalManager::new(Some(SECRET.into()));
            let (tx, _rx) = mpsc::channel(64);
            let (other, _rx2) = mpsc::channel(64);
            {
                let mut state = manager.state.lock().unwrap();
                state.pending.insert("a".into(), Pending { tx: tx.clone(), cancelled: false });
                state.pending.insert("b".into(), Pending { tx: other, cancelled: false });
            }
            manager.detach_connection(&tx);
            {
                let state = manager.state.lock().unwrap();
                assert!(state.pending["a"].cancelled);
                assert!(!state.pending["b"].cancelled);
            }
            manager.detach("b");
            assert!(manager.state.lock().unwrap().pending["b"].cancelled);
        }
        #[test]
        fn output_congestion_detaches_and_keeps_history() {
            let (tx, _rx) = mpsc::channel(1);
            let mut output = Output::default();
            output.attachment = Some(Attachment { id: "attachment".into(), tx });
            output.write(b"first");
            output.write(b"second");
            assert!(output.attachment.is_none());
            assert_eq!(output.history.front().unwrap(), b"firstsecond");
        }
        #[test]
        fn rate_limit_and_history_are_bounded() {
            let manager = TerminalManager::new(Some(SECRET.into()));
            let mut state = manager.state.lock().unwrap();
            for _ in 0..5 { assert!(manager.check_totp(&mut state, Some("wrong")).is_err()); }
            assert_eq!(manager.check_totp(&mut state, Some(&code(0))), Err("terminal_2fa_rate_limited"));
            let mut output = Output::default();
            for _ in 0..100_000 { output.write(b"abcdefgh"); }
            assert!(output.bytes <= HISTORY_BYTES);
            assert!(output.history.len() <= HISTORY_BYTES / TERMINAL_CHUNK_MAX_BYTES + 1);
        }
    }

}
#[cfg(unix)]
pub use unix_impl::TerminalManager;

#[cfg(not(unix))]
mod stub {
    use std::sync::Arc;
    use filebox_protocol::message::{AgentMessage, TerminalSessionInfo};
    use tokio::sync::mpsc;
    pub struct TerminalManager;
    impl TerminalManager {
        pub fn new(_: Option<String>) -> Self { Self }
        pub fn open(self: &Arc<Self>, req_id: String, _: u16, _: u16, _: Option<String>, tx: mpsc::Sender<AgentMessage>) {
            let _ = tx.try_send(AgentMessage::TerminalOpened { req_id, error: Some("terminal_unavailable".into()) });
        }
        pub fn attach(self: &Arc<Self>, id: String, _: String, code: Option<String>, tx: mpsc::Sender<AgentMessage>) { self.open(id, 80, 24, code, tx); }
        pub fn detach(&self, _: &str) {}
        pub fn detach_connection(&self, _: &mpsc::Sender<AgentMessage>) {}
        pub fn input(&self, _: &str, _: &[u8]) {}
        pub fn resize(&self, _: &str, _: u16, _: u16) {}
        pub fn list(&self) -> Vec<TerminalSessionInfo> { vec![] }
        pub fn close(&self, _: &str) {}
    }
}
#[cfg(not(unix))]
pub use stub::TerminalManager;
