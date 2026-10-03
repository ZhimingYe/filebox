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
    const OUTPUT_QUEUE_WAIT: Duration = Duration::from_secs(5);

    struct Attachment { id: String, tx: mpsc::Sender<AgentMessage> }
    struct Input { id: String, data: Vec<u8>, seq: Option<u64> }
    #[derive(Default)]
    struct Output {
        attachment: Option<Attachment>,
        replaying: bool,
        replay_progress: Option<Instant>,
        history: VecDeque<Vec<u8>>,
        bytes: usize,
    }
    impl Output {
        fn disconnect(&mut self, reason: &str) {
            if let Some(a) = self.attachment.take() {
                self.replaying = false;
                let msg = AgentMessage::TerminalClosed { req_id: a.id, reason: Some(reason.into()) };
                if let Err(mpsc::error::TrySendError::Full(msg)) = a.tx.try_send(msg) {
                    // At most one notification worker per detached attachment.
                    std::thread::spawn(move || { let _ = a.tx.blocking_send(msg); });
                }
            }
        }
        fn record(&mut self, data: &[u8]) {
            // Coalesce small writes so both bytes and replay frame count are bounded.
            for chunk in data.chunks(TERMINAL_CHUNK_MAX_BYTES) {
                if self.history.back().is_some_and(|b| b.len() + chunk.len() <= TERMINAL_CHUNK_MAX_BYTES) {
                    self.history.back_mut().unwrap().extend_from_slice(chunk);
                } else { self.history.push_back(chunk.to_vec()); }
                self.bytes += chunk.len();
                while self.bytes > HISTORY_BYTES {
                    self.bytes -= self.history.pop_front().unwrap().len();
                }
            }
        }
    }
    fn deliver_output(output: &Arc<Mutex<Output>>, data: &[u8], wait: Duration) {
        let attachment = {
            let mut out = output.lock().unwrap();
            out.record(data);
            out.attachment.as_ref().map(|a| a.id.clone())
        };
        let Some(id) = attachment else { return; };
        for chunk in data.chunks(TERMINAL_CHUNK_MAX_BYTES) {
            // A replacement attachment already replayed these bytes from
            // history. Never send an old reader's pending bytes twice.
            if !deliver_frame(output, &id, wait, false, "Output stalled; reconnect to resume the shell", || {
                AgentMessage::TerminalOutput { req_id: id.clone(), data: chunk.to_vec() }
            }) { return; }
        }
    }
    fn deliver_frame(output: &Arc<Mutex<Output>>, id: &str, wait: Duration, replay: bool, stalled: &str, frame: impl Fn() -> AgentMessage) -> bool {
        let mut deadline = Instant::now() + wait;
        let mut last_replay_progress = None;
        let mut waiting_for_replay = false;
        loop {
            let mut out = output.lock().unwrap();
            let Some(a) = out.attachment.as_ref().filter(|a| a.id == id) else { return false; };
            if a.tx.is_closed() {
                out.disconnect("Connection lost; resume the shell");
                return false;
            }
            let sent = if out.replaying && !replay {
                // Replay progress is shared by all waiting live-output/ACK
                // workers. A long but progressing replay is not a stall.
                if out.replay_progress != last_replay_progress {
                    last_replay_progress = out.replay_progress;
                    deadline = Instant::now() + wait;
                }
                waiting_for_replay = true;
                Err(mpsc::error::TrySendError::Full(()))
            } else {
                if waiting_for_replay {
                    // Start a fresh queue-capacity budget after the replay
                    // barrier, even if its final frame still occupies a slot.
                    deadline = Instant::now() + wait;
                    waiting_for_replay = false;
                }
                match a.tx.try_reserve() {
                    Ok(permit) => {
                        permit.send(frame());
                        Ok(())
                    }
                    Err(error) => Err(error),
                }
            };
            match sent {
                Ok(()) => {
                    if replay { out.replay_progress = Some(Instant::now()); }
                    return true;
                }
                Err(mpsc::error::TrySendError::Closed(_)) => {
                    out.disconnect("Connection lost; resume the shell");
                    return false;
                }
                Err(mpsc::error::TrySendError::Full(_)) => {
                    if Instant::now() >= deadline {
                        out.disconnect(stalled);
                        return false;
                    }
                }
            }
            // Only dedicated PTY workers wait: heartbeat and detach stay
            // responsive. Paused reads apply bounded PTY backpressure; detach
            // releases this worker within one polling tick.
            drop(out);
            std::thread::sleep(Duration::from_millis(5));
        }
    }
    fn drain_output(mut reader: impl Read, output: &Arc<Mutex<Output>>) -> std::io::Result<()> {
        let mut buf = [0u8; TERMINAL_CHUNK_MAX_BYTES];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => return Ok(()),
                Ok(n) => deliver_output(output, &buf[..n], OUTPUT_QUEUE_WAIT),
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(error) => return Err(error),
            }
        }
    }
    fn flush_input(writer: &mut impl Write) -> std::io::Result<()> {
        loop {
            match writer.flush() {
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                result => return result,
            }
        }
    }
    fn run_input_writer(mut writer: impl Write, rx: std::sync::mpsc::Receiver<Input>, output: Arc<Mutex<Output>>) {
        while let Ok(frame) = rx.recv() {
            // Discard queued input from a detached attachment. Never hold this
            // lock during a potentially blocked PTY write.
            if !output.lock().unwrap().attachment.as_ref().is_some_and(|a| a.id == frame.id && !a.tx.is_closed()) { continue; }
            let result = writer.write_all(&frame.data).and_then(|_| flush_input(&mut writer));
            if result.is_err() {
                let mut out = output.lock().unwrap();
                if out.attachment.as_ref().is_some_and(|a| a.id == frame.id) {
                    out.disconnect("Shell input failed; some input may have been written. Resume the shell to check.");
                }
                break;
            } else if let Some(seq) = frame.seq {
                deliver_frame(&output, &frame.id, OUTPUT_QUEUE_WAIT, false,
                    "Input confirmation stalled; resume the shell to check its state.", || {
                    AgentMessage::TerminalInputAck { req_id: frame.id.clone(), seq }
                });
            }
        }
    }
    struct Session {
        input: std::sync::mpsc::SyncSender<Input>,
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
            let msg = AgentMessage::TerminalOpened { req_id: id, error: Some(error.into()), replay_bytes: None, input_ack: false };
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
                    Ok((session, reader)) => {
                        let output = session.output.clone();
                        let child = session.child.clone();
                        if !pending.cancelled && !tx.is_closed() {
                            let mut out = output.lock().unwrap();
                            if tx.try_send(AgentMessage::TerminalOpened { req_id: id.clone(), error: None, replay_bytes: Some(0), input_ack: true }).is_ok() {
                                out.attachment = Some(Attachment { id: id.clone(), tx });
                            }
                        }
                        state.sessions.insert(id.clone(), session);
                        drop(state);
                        if let Err(error) = drain_output(reader, &output) {
                            tracing::debug!("PTY reader ended for {id}: {error}");
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
            let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
            #[cfg(not(test))]
            let shell = std::env::var("SHELL").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "/bin/sh".into());
            // PTY transport tests use a known shell instead of user-specific
            // startup scripts and prompt plugins that can interleave output.
            #[cfg(test)]
            let shell = "/bin/sh";
            let mut cmd = CommandBuilder::new(shell);
            if let Some(home) = dirs::home_dir() { cmd.cwd(home); }
            cmd.env("TERM", "xterm-256color");
            let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
            drop(pair.slave);
            let output = Arc::new(Mutex::new(Output::default()));
            let writer_output = output.clone();
            let (input, rx) = std::sync::mpsc::sync_channel::<Input>(64);
            std::thread::spawn(move || run_input_writer(writer, rx, writer_output));
            Ok((Session { input, master: pair.master, child: Arc::new(Mutex::new(child)), output, created: Instant::now(), last_input: unix_millis(), cols, rows }, reader))
        }
        pub fn attach(&self, id: String, session_id: String, code: Option<String>, tx: mpsc::Sender<AgentMessage>) {
            let mut state = self.state.lock().unwrap();
            if let Err(error) = self.check_totp(&mut state, code.as_deref()) { Self::reject(&tx, id, error); return; }
            let Some(session) = state.sessions.get(&session_id) else { Self::reject(&tx, id, "terminal_session_missing"); return; };
            let output = session.output.clone();
            let mut out = output.lock().unwrap();
            if out.attachment.as_ref().is_some_and(|a| !a.tx.is_closed()) { Self::reject(&tx, id, "terminal_session_attached"); return; }
            out.attachment = Some(Attachment { id: id.clone(), tx: tx.clone() });
            // Snapshot once under the output lock. Live IO may keep recording
            // history, but it waits behind this replay until all frames queue.
            out.replaying = true;
            out.replay_progress = Some(Instant::now());
            let replay_bytes = out.bytes;
            let history: Vec<_> = out.history.iter().cloned().collect();
            drop(out);
            drop(state);
            // Replay waits on its own worker, never on the shared Agent WS
            // read loop. A full queue need not spend a code on a failed resume.
            std::thread::spawn(move || {
                let reason = "Replay stalled; retry attachment";
                if !deliver_frame(&output, &id, OUTPUT_QUEUE_WAIT, true, reason, || {
                    AgentMessage::TerminalOpened { req_id: id.clone(), error: None, replay_bytes: Some(replay_bytes), input_ack: true }
                }) { return; }
                for data in history {
                    if !deliver_frame(&output, &id, OUTPUT_QUEUE_WAIT, true, reason, || {
                        AgentMessage::TerminalOutput { req_id: id.clone(), data: data.clone() }
                    }) { return; }
                }
                let mut out = output.lock().unwrap();
                if out.attachment.as_ref().is_some_and(|a| a.id == id) { out.replaying = false; }
            });
        }
        pub fn detach(&self, id: &str) {
            let mut state = self.state.lock().unwrap();
            if let Some(p) = state.pending.get_mut(id) { p.cancelled = true; }
            for s in state.sessions.values() {
                let mut out = s.output.lock().unwrap();
                if out.attachment.as_ref().is_some_and(|a| a.id == id) { out.attachment = None; out.replaying = false; }
            }
        }
        pub fn detach_connection(&self, tx: &mpsc::Sender<AgentMessage>) {
            let mut state = self.state.lock().unwrap();
            for p in state.pending.values_mut() { if p.tx.same_channel(tx) { p.cancelled = true; } }
            for s in state.sessions.values() {
                let mut out = s.output.lock().unwrap();
                if out.attachment.as_ref().is_some_and(|a| a.tx.same_channel(tx)) { out.attachment = None; out.replaying = false; }
            }
        }
        pub fn input(&self, id: &str, data: &[u8], seq: Option<u64>) {
            let mut state = self.state.lock().unwrap();
            for s in state.sessions.values_mut() {
                let mut out = s.output.lock().unwrap();
                if out.attachment.as_ref().is_some_and(|a| a.id == id && !a.tx.is_closed()) {
                    s.last_input = unix_millis();
                    if data.len() > 48 * 1024 || s.input.try_send(Input { id: id.into(), data: data.to_vec(), seq }).is_err() {
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
        struct GatedWriter {
            bytes: Arc<Mutex<Vec<u8>>>,
            flushing: std::sync::mpsc::Sender<()>,
            release: std::sync::mpsc::Receiver<()>,
            fail: bool,
        }
        fn wait_for_history(output: &Arc<Mutex<Output>>, bytes: usize) {
            let deadline = Instant::now() + Duration::from_secs(2);
            while output.lock().unwrap().bytes < bytes {
                assert!(Instant::now() < deadline, "reader did not retain pending output");
                std::thread::sleep(Duration::from_millis(1));
            }
        }
        #[test]
        fn transient_output_congestion_preserves_attachment_and_all_bytes() {
            let (tx, mut rx) = mpsc::channel(1);
            let output = Arc::new(Mutex::new(Output { attachment: Some(Attachment { id: "route".into(), tx }), ..Output::default() }));
            deliver_output(&output, b"first", Duration::ZERO);
            let pending_output = output.clone();
            let pending = std::thread::spawn(move || deliver_output(&pending_output, b"second", Duration::from_secs(1)));
            wait_for_history(&output, 11);
            assert!(output.lock().unwrap().attachment.is_some());
            assert!(matches!(rx.try_recv(), Ok(AgentMessage::TerminalOutput { data, .. }) if data == b"first"));
            pending.join().unwrap();
            assert!(matches!(rx.try_recv(), Ok(AgentMessage::TerminalOutput { data, .. }) if data == b"second"));
            assert!(output.lock().unwrap().attachment.is_some());
            assert!(rx.try_recv().is_err());
        }
        #[test]
        fn progressing_replay_preserves_live_output_and_input_ack_order() {
            let (tx, mut rx) = mpsc::channel(1);
            let output = Arc::new(Mutex::new(Output {
                attachment: Some(Attachment { id: "resume".into(), tx }), replaying: true,
                ..Output::default()
            }));
            let consumer = std::thread::spawn(move || {
                let mut frames = Vec::new();
                while let Some(frame) = rx.blocking_recv() {
                    let history = matches!(&frame, AgentMessage::TerminalOutput { data, .. } if data == b"history");
                    frames.push(frame);
                    if history { std::thread::sleep(Duration::from_millis(80)); }
                }
                frames
            });
            let wait = Duration::from_millis(300);
            let live_output = output.clone();
            let ack_output = output.clone();
            let (started_tx, started_rx) = std::sync::mpsc::channel();
            let ack_started = started_tx.clone();
            let live = std::thread::spawn(move || {
                started_tx.send(()).unwrap();
                deliver_frame(&live_output, "resume", wait, false, "live timeout", || {
                    AgentMessage::TerminalOutput { req_id: "resume".into(), data: b"live".to_vec() }
                })
            });
            let ack = std::thread::spawn(move || {
                ack_started.send(()).unwrap();
                deliver_frame(&ack_output, "resume", wait, false, "ack timeout", || {
                    AgentMessage::TerminalInputAck { req_id: "resume".into(), seq: 19 }
                })
            });
            started_rx.recv_timeout(Duration::from_secs(1)).unwrap();
            started_rx.recv_timeout(Duration::from_secs(1)).unwrap();
            let replay_output = output.clone();
            let replay = std::thread::spawn(move || {
                for _ in 0..6 {
                    if !deliver_frame(&replay_output, "resume", wait, true, "replay timeout", || {
                        AgentMessage::TerminalOutput { req_id: "resume".into(), data: b"history".to_vec() }
                    }) { return; }
                }
                replay_output.lock().unwrap().replaying = false;
            });
            let delivered = live.join().unwrap();
            let acknowledged = ack.join().unwrap();
            replay.join().unwrap();
            let attached = output.lock().unwrap().attachment.is_some();
            output.lock().unwrap().attachment = None;
            let frames = consumer.join().unwrap();
            assert!(delivered && acknowledged && attached, "progressing replay was detached");
            assert_eq!(frames.len(), 8);
            for frame in &frames[..6] {
                assert!(matches!(frame, AgentMessage::TerminalOutput { data, .. } if data == b"history"));
            }
            assert!(frames[6..].iter().any(|frame| matches!(frame, AgentMessage::TerminalOutput { data, .. } if data == b"live")));
            assert!(frames[6..].iter().any(|frame| matches!(frame, AgentMessage::TerminalInputAck { seq: 19, .. })));
        }
        #[test]
        fn replay_without_progress_still_detaches_waiting_live_output() {
            let (tx, mut rx) = mpsc::channel(8);
            let output = Arc::new(Mutex::new(Output {
                attachment: Some(Attachment { id: "resume".into(), tx }), replaying: true,
                replay_progress: Some(Instant::now()), ..Output::default()
            }));
            assert!(!deliver_frame(&output, "resume", Duration::from_millis(20), false, "replay stopped", || {
                AgentMessage::TerminalOutput { req_id: "resume".into(), data: b"live".to_vec() }
            }));
            assert!(output.lock().unwrap().attachment.is_none());
            assert!(matches!(rx.try_recv(), Ok(AgentMessage::TerminalClosed { reason: Some(reason), .. }) if reason == "replay stopped"));
        }
        #[test]
        fn closed_connection_interrupts_replay_barrier_immediately() {
            let (tx, rx) = mpsc::channel(8);
            let output = Arc::new(Mutex::new(Output {
                attachment: Some(Attachment { id: "resume".into(), tx }), replaying: true,
                ..Output::default()
            }));
            drop(rx);
            let start = Instant::now();
            assert!(!deliver_frame(&output, "resume", Duration::from_secs(30), false, "replay stopped", || {
                AgentMessage::TerminalOutput { req_id: "resume".into(), data: b"live".to_vec() }
            }));
            assert!(start.elapsed() < Duration::from_secs(1));
            assert!(output.lock().unwrap().attachment.is_none());
        }
        #[test]
        fn detach_interrupts_output_wait_without_leaking_bytes_to_new_attachment() {
            let (tx, _rx) = mpsc::channel(1);
            let output = Arc::new(Mutex::new(Output { attachment: Some(Attachment { id: "old".into(), tx }), ..Output::default() }));
            deliver_output(&output, b"first", Duration::ZERO);
            let pending_output = output.clone();
            let pending = std::thread::spawn(move || deliver_output(&pending_output, b"second", Duration::from_secs(30)));
            wait_for_history(&output, 11);
            let (new_tx, mut new_rx) = mpsc::channel(8);
            output.lock().unwrap().attachment = Some(Attachment { id: "new".into(), tx: new_tx });
            let start = Instant::now();
            pending.join().unwrap();
            assert!(start.elapsed() < Duration::from_secs(1));
            assert!(new_rx.try_recv().is_err()); // Replay owns the retained second chunk.
            assert_eq!(output.lock().unwrap().history.front().unwrap(), b"firstsecond");
            deliver_output(&output, b"live", Duration::ZERO);
            assert!(matches!(new_rx.try_recv(), Ok(AgentMessage::TerminalOutput { req_id, data }) if req_id == "new" && data == b"live"));
        }
        #[test]
        fn interrupted_pty_reads_and_flushes_do_not_end_attachment_or_repeat_input() {
            struct InterruptedReader { interrupts: usize, bytes: std::io::Cursor<Vec<u8>> }
            impl Read for InterruptedReader {
                fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
                    if self.interrupts > 0 { self.interrupts -= 1; return Err(std::io::ErrorKind::Interrupted.into()); }
                    self.bytes.read(buf)
                }
            }
            #[derive(Default)]
            struct InterruptedWriter { bytes: Vec<u8>, flushes: usize }
            impl Write for InterruptedWriter {
                fn write(&mut self, data: &[u8]) -> std::io::Result<usize> { self.bytes.extend_from_slice(data); Ok(data.len()) }
                fn flush(&mut self) -> std::io::Result<()> {
                    self.flushes += 1;
                    if self.flushes < 3 { Err(std::io::ErrorKind::Interrupted.into()) } else { Ok(()) }
                }
            }
            let (tx, mut rx) = mpsc::channel(8);
            let output = Arc::new(Mutex::new(Output { attachment: Some(Attachment { id: "route".into(), tx }), ..Output::default() }));
            drain_output(InterruptedReader { interrupts: 2, bytes: std::io::Cursor::new(b"still alive".to_vec()) }, &output).unwrap();
            assert!(matches!(rx.try_recv(), Ok(AgentMessage::TerminalOutput { data, .. }) if data == b"still alive"));
            let (input, incoming) = std::sync::mpsc::channel();
            input.send(Input { id: "route".into(), data: b"command".to_vec(), seq: Some(7) }).unwrap();
            drop(input);
            let mut writer = InterruptedWriter::default();
            run_input_writer(&mut writer, incoming, output.clone());
            assert_eq!(writer.bytes, b"command");
            assert_eq!(writer.flushes, 3);
            assert!(matches!(rx.try_recv(), Ok(AgentMessage::TerminalInputAck { seq: 7, .. })));
            assert!(output.lock().unwrap().attachment.is_some());
        }
        #[test]
        fn input_ack_waits_through_temporary_output_queue_congestion() {
            let (tx, mut rx) = mpsc::channel(1);
            tx.try_send(AgentMessage::TerminalOutput { req_id: "route".into(), data: b"busy".to_vec() }).unwrap();
            let output = Arc::new(Mutex::new(Output { attachment: Some(Attachment { id: "route".into(), tx }), ..Output::default() }));
            let (flushing, flushed) = std::sync::mpsc::channel();
            let (release, gate) = std::sync::mpsc::channel();
            let (input, incoming) = std::sync::mpsc::channel();
            input.send(Input { id: "route".into(), data: b"command".to_vec(), seq: Some(3) }).unwrap();
            drop(input);
            let writer_output = output.clone();
            let pending = std::thread::spawn(move || run_input_writer(GatedWriter {
                bytes: Arc::new(Mutex::new(Vec::new())), flushing, release: gate, fail: false,
            }, incoming, writer_output));
            flushed.recv_timeout(Duration::from_secs(2)).unwrap();
            release.send(()).unwrap();
            // Give the writer time to encounter the full queue before freeing it.
            std::thread::sleep(Duration::from_millis(20));
            assert!(output.lock().unwrap().attachment.is_some());
            assert!(matches!(rx.try_recv(), Ok(AgentMessage::TerminalOutput { .. })));
            pending.join().unwrap();
            assert!(matches!(rx.try_recv(), Ok(AgentMessage::TerminalInputAck { seq: 3, .. })));
            assert!(output.lock().unwrap().attachment.is_some());
        }
        impl Write for GatedWriter {
            fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
                self.bytes.lock().unwrap().extend_from_slice(data);
                Ok(data.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                self.flushing.send(()).unwrap();
                self.release.recv_timeout(Duration::from_secs(5)).unwrap();
                if self.fail { Err(std::io::Error::other("test failure")) } else { Ok(()) }
            }
        }
        #[test]
        fn input_confirmation_waits_for_flush_and_discards_stale_attachment() {
            let (tx, mut messages) = mpsc::channel(8);
            let output = Arc::new(Mutex::new(Output { attachment: Some(Attachment { id: "old".into(), tx: tx.clone() }), ..Output::default() }));
            let bytes = Arc::new(Mutex::new(Vec::new()));
            let (flushing, flushed) = std::sync::mpsc::channel();
            let (release, gate) = std::sync::mpsc::channel();
            let (input, rx) = std::sync::mpsc::channel();
            let writer = GatedWriter { bytes: bytes.clone(), flushing, release: gate, fail: false };
            let writer_output = output.clone();
            let thread = std::thread::spawn(move || run_input_writer(writer, rx, writer_output));
            input.send(Input { id: "old".into(), data: b"first".to_vec(), seq: Some(1) }).unwrap();
            flushed.recv_timeout(Duration::from_secs(5)).unwrap();
            assert!(messages.try_recv().is_err()); // Write happened, flush has not.
            // An in-flight write can finish after detach; neither its old ack
            // nor the queued remainder may reach the replacement attachment.
            output.lock().unwrap().attachment = Some(Attachment { id: "new".into(), tx });
            input.send(Input { id: "old".into(), data: b"stale".to_vec(), seq: Some(2) }).unwrap();
            input.send(Input { id: "new".into(), data: b"current".to_vec(), seq: Some(1) }).unwrap();
            release.send(()).unwrap();
            flushed.recv_timeout(Duration::from_secs(5)).unwrap();
            assert!(messages.try_recv().is_err());
            release.send(()).unwrap();
            drop(input);
            thread.join().unwrap();
            assert_eq!(&*bytes.lock().unwrap(), b"firstcurrent");
            assert!(matches!(messages.try_recv(), Ok(AgentMessage::TerminalInputAck { req_id, seq: 1 }) if req_id == "new"));
            assert!(messages.try_recv().is_err());
        }
        #[test]
        fn failed_input_flush_detaches_without_acknowledging_delivery() {
            let (tx, mut messages) = mpsc::channel(8);
            let output = Arc::new(Mutex::new(Output { attachment: Some(Attachment { id: "route".into(), tx }), ..Output::default() }));
            let (flushing, flushed) = std::sync::mpsc::channel();
            let (release, gate) = std::sync::mpsc::channel();
            let (input, rx) = std::sync::mpsc::channel();
            input.send(Input { id: "route".into(), data: b"partial".to_vec(), seq: Some(1) }).unwrap();
            drop(input);
            let writer_output = output.clone();
            let thread = std::thread::spawn(move || run_input_writer(GatedWriter {
                bytes: Arc::new(Mutex::new(Vec::new())), flushing, release: gate, fail: true,
            }, rx, writer_output));
            flushed.recv_timeout(Duration::from_secs(5)).unwrap();
            release.send(()).unwrap();
            thread.join().unwrap();
            assert!(output.lock().unwrap().attachment.is_none());
            assert!(matches!(messages.try_recv(), Ok(AgentMessage::TerminalClosed { reason: Some(reason), .. }) if reason.contains("may have been written")));
            assert!(messages.try_recv().is_err());
        }
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
            manager.input("shell", b"FB_KEEP=survived; printf 'set-%s\n' done\n", None);
            output_contains(&mut rx, "set-done").await;
            manager.detach_connection(&tx);
            drop(rx);
            assert_eq!(manager.list().len(), 1);
            // A stable session id is not authorization after detachment.
            manager.input("shell", b"FB_KEEP=wrong\n", None);
            let (tx2, mut rx2) = mpsc::channel(1);
            manager.attach("replay".into(), "shell".into(), Some(code(0)), tx2.clone());
            assert_eq!(opened(&mut rx2).await.as_deref(), Some("terminal_2fa_invalid"));
            // A query retained in history must be included in the exact
            // replay boundary, even if live shell output follows immediately.
            {
                let state = manager.state.lock().unwrap();
                state.sessions["shell"].output.lock().unwrap().record(&vec![b'x'; 64 * 1024]);
                state.sessions["shell"].output.lock().unwrap().record(b"\x1b]4;0;?;1;?\x07");
            }
            manager.attach("resume".into(), "shell".into(), Some(code(1)), tx2);
            let replay_bytes = match rx2.recv().await.unwrap() {
                AgentMessage::TerminalOpened { error, replay_bytes, input_ack, .. } => {
                    assert!(error.is_none());
                    assert!(input_ack);
                    replay_bytes.unwrap()
                }
                _ => panic!("replay must start with its byte count"),
            };
            manager.input("resume", b"printf 'kept-%s\n' \"$FB_KEEP\"\n", None);
            let mut replay = Vec::new();
            while replay.len() < replay_bytes {
                match rx2.recv().await.unwrap() {
                    AgentMessage::TerminalOutput { req_id, data } => {
                        assert_eq!(req_id, "resume");
                        replay.extend_from_slice(&data);
                    }
                    _ => panic!("replay must contain only output"),
                }
            }
            assert_eq!(replay.len(), replay_bytes);
            let query = b"\x1b]4;0;?;1;?\x07";
            assert!(replay.windows(query.len()).any(|w| w == query));
            output_contains(&mut rx2, "kept-survived").await;
            manager.close("shell");
            assert!(manager.list().is_empty());
        }
        #[tokio::test]
        async fn real_pty_survives_a_slow_output_consumer_and_keeps_input_working() {
            let manager = Arc::new(TerminalManager::new(Some(SECRET.into())));
            // One frame forces real reader backpressure while the shell runs.
            let (tx, mut rx) = mpsc::channel(1);
            manager.open("burst".into(), 80, 24, Some(code(0)), tx);
            assert_eq!(opened(&mut rx).await, None);
            manager.input("burst", b"i=0; while [ \"$i\" -lt 256 ]; do printf 'FB-BURST-%s\\n' \"$i\"; i=$((i+1)); done\n", Some(1));
            tokio::time::sleep(Duration::from_millis(100)).await;
            let mut bytes = Vec::new();
            let mut ack = false;
            tokio::time::timeout(Duration::from_secs(10), async {
                loop {
                    match rx.recv().await.unwrap() {
                        AgentMessage::TerminalOutput { data, .. } => bytes.extend(data),
                        AgentMessage::TerminalInputAck { seq: 1, .. } => ack = true,
                        AgentMessage::TerminalClosed { reason, .. } => panic!("transient congestion detached shell: {reason:?}"),
                        _ => {}
                    }
                    // A PTY read may split the final line before its newline.
                    // Wait for that complete line before checking the stream.
                    if ack && String::from_utf8_lossy(&bytes).split_inclusive('\n').any(|line| {
                        line.ends_with('\n') && line.trim_end_matches(['\r', '\n']) == "FB-BURST-255"
                    }) { break; }
                }
            }).await.unwrap();
            let text = String::from_utf8_lossy(&bytes);
            // PTY line disciplines can emit CRCRLF as well as CRLF. Check
            // logical lines without weakening completeness or ordering.
            let lines: Vec<_> = text.split('\n').map(|line| line.trim_end_matches('\r'))
                .filter(|line| line.starts_with("FB-BURST-")).collect();
            assert_eq!(lines.len(), 256, "unexpected burst output: {text:?}");
            for (i, line) in lines.iter().enumerate() { assert_eq!(*line, format!("FB-BURST-{i}")); }
            assert_eq!(manager.list().len(), 1);
            manager.input("burst", b"printf 'FB-NEXT-%s\\n' ok\n", Some(2));
            output_contains(&mut rx, "FB-NEXT-ok").await;
            manager.close("burst");
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
            let output = Arc::new(Mutex::new(Output { attachment: Some(Attachment { id: "attachment".into(), tx }), ..Output::default() }));
            deliver_output(&output, b"first", Duration::ZERO);
            let start = Instant::now();
            deliver_output(&output, b"second", Duration::from_millis(20));
            assert!(start.elapsed() >= Duration::from_millis(20));
            assert!(start.elapsed() < Duration::from_secs(1));
            let out = output.lock().unwrap();
            assert!(out.attachment.is_none());
            assert_eq!(out.history.front().unwrap(), b"firstsecond");
        }
        #[test]
        fn rate_limit_and_history_are_bounded() {
            let manager = TerminalManager::new(Some(SECRET.into()));
            let mut state = manager.state.lock().unwrap();
            for _ in 0..5 { assert!(manager.check_totp(&mut state, Some("wrong")).is_err()); }
            assert_eq!(manager.check_totp(&mut state, Some(&code(0))), Err("terminal_2fa_rate_limited"));
            let mut output = Output::default();
            for _ in 0..100_000 { output.record(b"abcdefgh"); }
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
            let _ = tx.try_send(AgentMessage::TerminalOpened { req_id, error: Some("terminal_unavailable".into()), replay_bytes: None, input_ack: false });
        }
        pub fn attach(self: &Arc<Self>, id: String, _: String, code: Option<String>, tx: mpsc::Sender<AgentMessage>) { self.open(id, 80, 24, code, tx); }
        pub fn detach(&self, _: &str) {}
        pub fn detach_connection(&self, _: &mpsc::Sender<AgentMessage>) {}
        pub fn input(&self, _: &str, _: &[u8], _: Option<u64>) {}
        pub fn resize(&self, _: &str, _: u16, _: u16) {}
        pub fn list(&self) -> Vec<TerminalSessionInfo> { vec![] }
        pub fn close(&self, _: &str) {}
    }
}
#[cfg(not(unix))]
pub use stub::TerminalManager;
