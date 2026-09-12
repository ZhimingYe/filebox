//! Remote terminal sessions: each session spawns the user's shell on a PTY
//! and streams raw output back over the agent WebSocket. The real
//! implementation is unix-only (portable-pty); other platforms get a no-op
//! stub so the WS dispatch in connection.rs compiles uniformly, while the
//! advertised capability stays `cfg!(unix)`.
//!
//! Invariants (unix):
//! - Session slots are bounded (MAX_TERMINAL_SESSIONS) and taken atomically
//!   to avoid a TOCTOU race, mirroring the workspace-search admission in
//!   connection.rs.
//! - `TerminalClosed` is delivered exactly once per session, guarded by a
//!   per-session `closed` AtomicBool shared between the reader thread (EOF)
//!   and `close()`.
//! - The slot is released exactly once per admission via the `SlotGuard`
//!   stored in the session (office_convert.rs's OfficeJobLease pattern): the
//!   session map hands out the session exactly once, and its drop releases
//!   the guard.
//! - `open()` never blocks the WS loop: all PTY setup runs on a spawned
//!   std::thread, which also makes `blocking_send` legal (it panics inside
//!   a Tokio runtime context).
//! - Agent-side secondary 2FA: when a TOTP secret is configured, every open
//!   must carry a fresh code verified LOCALLY here (a compromised hub cannot
//!   mint codes). Accepted counters are remembered monotonically so a
//!   replayed code is rejected — which is why the manager is created in
//!   `run_connection_loop` and outlives individual connections: a hub must
//!   not be able to reset anti-replay by forcing reconnects.

#[cfg(unix)]
mod unix_impl {
    use std::collections::HashMap;
    use std::io::{Read, Write};
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};

    use filebox_protocol::message::{AgentMessage, TERMINAL_CHUNK_MAX_BYTES};
    use portable_pty::{Child, CommandBuilder, MasterPty, PtySize};
    use tokio::sync::mpsc;

    /// Interactive shells are cheap but each one holds a reader thread and a
    /// process; bound them so a misbehaving client cannot pile them up.
    pub const MAX_TERMINAL_SESSIONS: usize = 8;

    /// Clamp terminal geometry to sane bounds — a garbage size must not
    /// reach the PTY or the shell.
    const MIN_TERM_DIM: u16 = 1;
    const MAX_TERM_DIM: u16 = 500;

    /// Releases one admission slot exactly once when the owning session is
    /// dropped.
    struct SlotGuard(Arc<AtomicUsize>);

    impl Drop for SlotGuard {
        fn drop(&mut self) {
            self.0.fetch_sub(1, Ordering::AcqRel);
        }
    }

    struct TerminalSession {
        writer: Arc<Mutex<Box<dyn Write + Send>>>,
        master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
        child: Arc<Mutex<Box<dyn Child + Send + Sync>>>,
        /// Set exactly once, by whichever side observes the end first
        /// (reader EOF or an explicit close); gates the single
        /// TerminalClosed message.
        closed: Arc<AtomicBool>,
        _slot: SlotGuard,
    }

    pub struct TerminalManager {
        sessions: Mutex<HashMap<String, TerminalSession>>,
        inflight: Arc<AtomicUsize>,
        /// Base32 TOTP secret for agent-side secondary 2FA; None disables
        /// the check (the hub's code, if any, is then ignored).
        totp_secret: Option<String>,
        /// Highest TOTP counter ever accepted — anti-replay. Must survive
        /// reconnects, so the manager is shared across connections.
        last_accepted_counter: Mutex<Option<u64>>,
    }

    impl TerminalManager {
        pub fn new(totp_secret: Option<String>) -> Self {
            Self {
                sessions: Mutex::new(HashMap::new()),
                inflight: Arc::new(AtomicUsize::new(0)),
                totp_secret,
                last_accepted_counter: Mutex::new(None),
            }
        }

        pub fn open(
            self: &Arc<Self>,
            req_id: String,
            cols: u16,
            rows: u16,
            agent_totp_code: Option<String>,
            tx: mpsc::Sender<AgentMessage>,
        ) {
            // PTY setup + blocking_send must not run on the WS loop (Tokio
            // forbids blocking_send in a runtime context), so the whole
            // open sequence happens on a dedicated thread.
            let manager = Arc::clone(self);
            std::thread::spawn(move || {
                manager.open_on_thread(req_id, cols, rows, agent_totp_code, tx)
            });
        }

        fn open_on_thread(
            self: &Arc<Self>,
            req_id: String,
            cols: u16,
            rows: u16,
            agent_totp_code: Option<String>,
            tx: mpsc::Sender<AgentMessage>,
        ) {
            // Admission is an atomic slot take — a load()+store pair would
            // let concurrent opens both pass the limit check.
            let prev = self.inflight.fetch_add(1, Ordering::AcqRel);
            if prev >= MAX_TERMINAL_SESSIONS {
                self.inflight.fetch_sub(1, Ordering::AcqRel);
                let _ = tx.blocking_send(AgentMessage::TerminalOpened {
                    req_id,
                    error: Some("agent_overloaded: too many terminal sessions".to_string()),
                });
                return;
            }
            let slot = SlotGuard(Arc::clone(&self.inflight));

            // Secondary 2FA is checked after admission but BEFORE any PTY
            // allocation; the SlotGuard drop releases the slot on reject.
            if let Some(error) = self.check_totp(agent_totp_code.as_deref()) {
                let _ = tx.blocking_send(AgentMessage::TerminalOpened {
                    req_id,
                    error: Some(error),
                });
                return;
            }

            if let Err(error) = self.open_inner(&req_id, cols, rows, &tx, slot) {
                let _ = tx.blocking_send(AgentMessage::TerminalOpened {
                    req_id,
                    error: Some(format!("terminal_unavailable: {error}")),
                });
            }
        }

        /// Agent-side secondary 2FA gate. Returns the rejection error, or
        /// None when the open may proceed. With no secret configured the
        /// hub-supplied code is ignored entirely.
        fn check_totp(&self, code: Option<&str>) -> Option<String> {
            let secret = self.totp_secret.as_deref()?;
            let Some(code) = code else {
                return Some("terminal_2fa_required".to_string());
            };
            let counter = match filebox_protocol::totp::matching_counter_at(
                secret,
                code,
                filebox_protocol::totp::current_counter(),
            ) {
                Some(counter) => counter,
                None => return Some("terminal_2fa_invalid".to_string()),
            };
            // Anti-replay: accept only a counter strictly newer than the
            // last accepted one, so the same code cannot open two sessions.
            let mut last = match self.last_accepted_counter.lock() {
                Ok(last) => last,
                Err(_) => return Some("terminal_2fa_invalid".to_string()),
            };
            if last.is_some_and(|last| last >= counter) {
                return Some("terminal_2fa_invalid".to_string());
            }
            *last = Some(counter);
            None
        }

        fn open_inner(
            self: &Arc<Self>,
            req_id: &str,
            cols: u16,
            rows: u16,
            tx: &mpsc::Sender<AgentMessage>,
            slot: SlotGuard,
        ) -> Result<(), String> {
            let cols = cols.clamp(MIN_TERM_DIM, MAX_TERM_DIM);
            let rows = rows.clamp(MIN_TERM_DIM, MAX_TERM_DIM);

            let pair = portable_pty::native_pty_system()
                .openpty(PtySize {
                    rows,
                    cols,
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .map_err(|e| format!("openpty failed: {e}"))?;

            let shell = std::env::var("SHELL")
                .ok()
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "/bin/sh".to_string());
            let mut cmd = CommandBuilder::new(shell);
            if let Some(home) = dirs::home_dir() {
                cmd.cwd(home);
            }
            cmd.env("TERM", "xterm-256color");
            let child = pair
                .slave
                .spawn_command(cmd)
                .map_err(|e| format!("spawn shell failed: {e}"))?;
            // The slave side belongs to the child; keeping it open here
            // would suppress the EOF the reader relies on to detect shell
            // exit.
            drop(pair.slave);

            let mut reader = pair
                .master
                .try_clone_reader()
                .map_err(|e| format!("clone PTY reader failed: {e}"))?;
            let writer = pair
                .master
                .take_writer()
                .map_err(|e| format!("take PTY writer failed: {e}"))?;

            let closed = Arc::new(AtomicBool::new(false));
            let child = Arc::new(Mutex::new(child));
            let session = TerminalSession {
                writer: Arc::new(Mutex::new(writer)),
                master: Arc::new(Mutex::new(pair.master)),
                child: Arc::clone(&child),
                closed: Arc::clone(&closed),
                _slot: slot,
            };
            if let Ok(mut map) = self.sessions.lock() {
                map.insert(req_id.to_string(), session);
            } else {
                return Err("session map poisoned".to_string());
            }

            let manager = Arc::clone(self);
            let rid = req_id.to_string();
            let tx_reader = tx.clone();
            // Reader thread: streams PTY output, then reports terminal close
            // exactly once and releases the session.
            std::thread::spawn(move || {
                let mut buf = [0u8; TERMINAL_CHUNK_MAX_BYTES];
                let reason: Option<String> = loop {
                    match reader.read(&mut buf) {
                        Ok(0) => break Some("shell exited".to_string()),
                        Ok(n) => {
                            let msg = AgentMessage::TerminalOutput {
                                req_id: rid.clone(),
                                data: buf[..n].to_vec(),
                            };
                            if tx_reader.blocking_send(msg).is_err() {
                                // Connection is gone; teardown / close_all
                                // owns cleanup — do not try to report the
                                // close.
                                break None;
                            }
                        }
                        Err(e) => break Some(format!("pty read error: {e}")),
                    }
                };
                match reason {
                    Some(reason) => {
                        if closed
                            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                            .is_ok()
                        {
                            let _ = tx_reader.blocking_send(AgentMessage::TerminalClosed {
                                req_id: rid.clone(),
                                reason: Some(reason),
                            });
                        }
                        // Reap the shell so it does not linger as a zombie.
                        if let Ok(mut child) = child.lock() {
                            let _ = child.try_wait();
                        }
                    }
                    None => {
                        closed.store(true, Ordering::SeqCst);
                    }
                }
                // Removal is idempotent against close(): whichever side
                // removes the session drops it (and its SlotGuard) exactly
                // once.
                if let Ok(mut map) = manager.sessions.lock() {
                    map.remove(&rid);
                }
            });

            let _ = tx.blocking_send(AgentMessage::TerminalOpened {
                req_id: req_id.to_string(),
                error: None,
            });
            Ok(())
        }

        pub fn input(&self, req_id: &str, data: &[u8]) {
            let writer = match self.sessions.lock() {
                Ok(map) => map.get(req_id).map(|s| Arc::clone(&s.writer)),
                Err(_) => None,
            };
            let Some(writer) = writer else {
                tracing::debug!("Terminal input for unknown session {}", req_id);
                return;
            };
            if let Ok(mut writer) = writer.lock() {
                let result = writer.write_all(data).and_then(|_| writer.flush());
                if let Err(e) = result {
                    tracing::debug!("Terminal input write failed for {}: {}", req_id, e);
                }
            };
        }

        pub fn resize(&self, req_id: &str, cols: u16, rows: u16) {
            let master = match self.sessions.lock() {
                Ok(map) => map.get(req_id).map(|s| Arc::clone(&s.master)),
                Err(_) => None,
            };
            let Some(master) = master else { return };
            let size = PtySize {
                rows: rows.clamp(MIN_TERM_DIM, MAX_TERM_DIM),
                cols: cols.clamp(MIN_TERM_DIM, MAX_TERM_DIM),
                pixel_width: 0,
                pixel_height: 0,
            };
            if let Ok(master) = master.lock() {
                let result = master.resize(size);
                if let Err(e) = result {
                    tracing::debug!("Terminal resize failed for {}: {}", req_id, e);
                }
            };
        }

        pub fn close(&self, req_id: &str, tx: &mpsc::Sender<AgentMessage>) {
            let session = match self.sessions.lock() {
                Ok(mut map) => map.remove(req_id),
                Err(_) => None,
            };
            let Some(session) = session else { return };
            // Claim the close BEFORE killing: the kill makes the reader
            // thread fail out of read() immediately, and without the flag
            // already set it would win the race and report a spurious
            // "pty read error" instead of this explicit close.
            let first_closer = session
                .closed
                .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                .is_ok();
            // Kill so the reader thread unblocks; "already exited" is fine.
            if let Ok(mut child) = session.child.lock() {
                let _ = child.kill();
                let _ = child.try_wait();
            }
            if first_closer {
                // try_send: close() can run on the WS loop, where
                // blocking_send would panic; a full channel means the
                // connection is saturated and the hub will see the session
                // die with the connection.
                if let Err(e) = tx.try_send(AgentMessage::TerminalClosed {
                    req_id: req_id.to_string(),
                    reason: None,
                }) {
                    tracing::debug!("TerminalClosed for {} not sent: {}", req_id, e);
                }
            }
            // Dropping the session drops writer/master and releases the slot.
        }

        /// Teardown path: kill every session without sending anything (the
        /// connection is already dead, so no TerminalClosed can be
        /// delivered).
        pub fn close_all(&self) {
            let sessions: Vec<TerminalSession> = match self.sessions.lock() {
                Ok(mut map) => map.drain().map(|(_, s)| s).collect(),
                Err(_) => Vec::new(),
            };
            for session in sessions {
                session.closed.store(true, Ordering::SeqCst);
                if let Ok(mut child) = session.child.lock() {
                    let _ = child.kill();
                    let _ = child.try_wait();
                }
            }
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::time::{Duration, Instant};

        const TEST_TIMEOUT: Duration = Duration::from_secs(10);

        /// RFC 6238 Appendix B SHA-1 test secret (base32 of ASCII
        /// "12345678901234567890").
        const TOTP_TEST_SECRET: &str = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

        /// The code for the current wall-clock step. Computing it right
        /// before the open keeps step-boundary races inside the ±1 window.
        fn current_totp_code() -> String {
            let secret = filebox_protocol::totp::base32_decode(TOTP_TEST_SECRET).unwrap();
            let counter = filebox_protocol::totp::current_counter();
            format!(
                "{:06}",
                filebox_protocol::totp::totp_at(&secret, counter)
            )
        }

        /// A 6-digit code that does NOT match anywhere in the current
        /// ±1 step window.
        fn wrong_totp_code() -> String {
            let secret = filebox_protocol::totp::base32_decode(TOTP_TEST_SECRET).unwrap();
            let counter = filebox_protocol::totp::current_counter();
            let mut candidate = 0u32;
            for step in [-1i64, 0, 1] {
                let c = (counter as i64 + step).max(0) as u64;
                while candidate == filebox_protocol::totp::totp_at(&secret, c) {
                    candidate += 1;
                }
            }
            format!("{:06}", candidate)
        }

        /// Bridge tokio-mpsc → std-mpsc so tests can use recv_timeout and
        /// can never hang the suite.
        fn collector(
            mut rx: mpsc::Receiver<AgentMessage>,
        ) -> std::sync::mpsc::Receiver<AgentMessage> {
            let (std_tx, std_rx) = std::sync::mpsc::channel();
            std::thread::spawn(move || {
                while let Some(msg) = rx.blocking_recv() {
                    if std_tx.send(msg).is_err() {
                        return;
                    }
                }
            });
            std_rx
        }

        fn recv_until(
            rx: &std::sync::mpsc::Receiver<AgentMessage>,
            deadline: Instant,
            mut pred: impl FnMut(&AgentMessage) -> bool,
        ) -> AgentMessage {
            loop {
                let remaining = deadline.saturating_duration_since(Instant::now());
                assert!(remaining > Duration::ZERO, "timed out waiting for message");
                let msg = rx.recv_timeout(remaining).expect("channel closed early");
                if pred(&msg) {
                    return msg;
                }
            }
        }

        #[test]
        fn open_echo_close_round_trip() {
            let manager = Arc::new(TerminalManager::new(None));
            let (tx, rx) = mpsc::channel(64);
            let rx = collector(rx);
            let deadline = Instant::now() + TEST_TIMEOUT;

            manager.open("t1".to_string(), 80, 24, None, tx.clone());
            let opened = recv_until(&rx, deadline, |m| {
                matches!(m, AgentMessage::TerminalOpened { req_id, .. } if req_id == "t1")
            });
            match opened {
                AgentMessage::TerminalOpened { error, .. } => assert!(error.is_none()),
                _ => unreachable!(),
            }

            manager.input("t1", b"echo filebox-terminal-marker\n");
            let mut output = Vec::new();
            recv_until(&rx, deadline, |m| {
                if let AgentMessage::TerminalOutput { data, .. } = m {
                    output.extend_from_slice(data);
                }
                String::from_utf8_lossy(&output).contains("filebox-terminal-marker")
            });

            manager.input("t1", b"exit\n");
            let closed = recv_until(&rx, deadline, |m| {
                matches!(m, AgentMessage::TerminalClosed { req_id, .. } if req_id == "t1")
            });
            match closed {
                AgentMessage::TerminalClosed { reason, .. } => {
                    assert!(reason.is_some(), "EOF close should carry a reason")
                }
                _ => unreachable!(),
            }

            // The reader thread releases the slot asynchronously; give it a
            // beat.
            let deadline = Instant::now() + TEST_TIMEOUT;
            while manager.inflight.load(Ordering::Acquire) != 0 {
                assert!(Instant::now() < deadline, "slot not released after close");
                std::thread::sleep(Duration::from_millis(20));
            }
        }

        #[test]
        fn explicit_close_reports_once() {
            let manager = Arc::new(TerminalManager::new(None));
            let (tx, rx) = mpsc::channel(64);
            let rx = collector(rx);
            let deadline = Instant::now() + TEST_TIMEOUT;

            manager.open("t2".to_string(), 80, 24, None, tx.clone());
            recv_until(&rx, deadline, |m| {
                matches!(m, AgentMessage::TerminalOpened { req_id, error: None } if req_id == "t2")
            });

            manager.close("t2", &tx);
            let closed = recv_until(&rx, deadline, |m| {
                matches!(m, AgentMessage::TerminalClosed { req_id, .. } if req_id == "t2")
            });
            match closed {
                AgentMessage::TerminalClosed { reason, .. } => assert!(reason.is_none()),
                _ => unreachable!(),
            }
            // Exactly once: no second TerminalClosed may arrive from the
            // reader thread.
            loop {
                match rx.recv_timeout(Duration::from_millis(300)) {
                    Ok(AgentMessage::TerminalClosed { .. }) => panic!("duplicate TerminalClosed"),
                    Ok(_) => continue,
                    Err(_) => break,
                }
            }
            let deadline = Instant::now() + TEST_TIMEOUT;
            while manager.inflight.load(Ordering::Acquire) != 0 {
                assert!(Instant::now() < deadline, "slot not released after close");
                std::thread::sleep(Duration::from_millis(20));
            }
        }

        #[test]
        fn admission_is_bounded() {
            let manager = Arc::new(TerminalManager::new(None));
            let (tx, rx) = mpsc::channel(64);
            let rx = collector(rx);
            // Fill every slot without starting PTYs by simulating
            // admissions.
            for _ in 0..MAX_TERMINAL_SESSIONS {
                manager.inflight.fetch_add(1, Ordering::AcqRel);
            }
            manager.open("overflow".to_string(), 80, 24, None, tx);
            let msg = rx
                .recv_timeout(TEST_TIMEOUT)
                .expect("expected overload rejection");
            match msg {
                AgentMessage::TerminalOpened { req_id, error } => {
                    assert_eq!(req_id, "overflow");
                    assert!(
                        error
                            .as_deref()
                            .is_some_and(|e| e.starts_with("agent_overloaded")),
                        "unexpected error: {error:?}"
                    );
                }
                _ => panic!("wrong message"),
            }
            // The rejected open returned its slot immediately.
            assert_eq!(
                manager.inflight.load(Ordering::Acquire),
                MAX_TERMINAL_SESSIONS
            );
        }

        #[test]
        fn totp_missing_code_is_rejected() {
            let manager = Arc::new(TerminalManager::new(Some(TOTP_TEST_SECRET.to_string())));
            let (tx, rx) = mpsc::channel(64);
            let rx = collector(rx);

            manager.open("t2fa-req".to_string(), 80, 24, None, tx);
            let msg = rx
                .recv_timeout(TEST_TIMEOUT)
                .expect("expected 2fa rejection");
            match msg {
                AgentMessage::TerminalOpened { req_id, error } => {
                    assert_eq!(req_id, "t2fa-req");
                    assert_eq!(error.as_deref(), Some("terminal_2fa_required"));
                }
                _ => panic!("wrong message"),
            }
            // The rejected open returned its slot immediately.
            assert_eq!(manager.inflight.load(Ordering::Acquire), 0);
        }

        #[test]
        fn totp_valid_code_opens_and_replay_is_rejected() {
            let manager = Arc::new(TerminalManager::new(Some(TOTP_TEST_SECRET.to_string())));
            let (tx, rx) = mpsc::channel(64);
            let rx = collector(rx);
            let deadline = Instant::now() + TEST_TIMEOUT;

            let code = current_totp_code();
            manager.open("t2fa-ok".to_string(), 80, 24, Some(code.clone()), tx.clone());
            let opened = recv_until(&rx, deadline, |m| {
                matches!(m, AgentMessage::TerminalOpened { req_id, .. } if req_id == "t2fa-ok")
            });
            match opened {
                AgentMessage::TerminalOpened { error, .. } => assert!(error.is_none()),
                _ => unreachable!(),
            }
            manager.close("t2fa-ok", &tx);
            recv_until(&rx, deadline, |m| {
                matches!(m, AgentMessage::TerminalClosed { req_id, .. } if req_id == "t2fa-ok")
            });

            // Same code again: anti-replay must reject it even though the
            // code is still inside the ±1 step window.
            manager.open("t2fa-replay".to_string(), 80, 24, Some(code), tx);
            let replayed = recv_until(&rx, deadline, |m| {
                matches!(m, AgentMessage::TerminalOpened { req_id, .. } if req_id == "t2fa-replay")
            });
            match replayed {
                AgentMessage::TerminalOpened { error, .. } => {
                    assert_eq!(error.as_deref(), Some("terminal_2fa_invalid"))
                }
                _ => unreachable!(),
            }

            // The closed session and the rejected open both released slots.
            let deadline = Instant::now() + TEST_TIMEOUT;
            while manager.inflight.load(Ordering::Acquire) != 0 {
                assert!(Instant::now() < deadline, "slot not released after close");
                std::thread::sleep(Duration::from_millis(20));
            }
        }

        #[test]
        fn totp_wrong_code_is_rejected() {
            let manager = Arc::new(TerminalManager::new(Some(TOTP_TEST_SECRET.to_string())));
            let (tx, rx) = mpsc::channel(64);
            let rx = collector(rx);

            manager.open("t2fa-bad".to_string(), 80, 24, Some(wrong_totp_code()), tx.clone());
            let msg = rx
                .recv_timeout(TEST_TIMEOUT)
                .expect("expected 2fa rejection");
            match msg {
                AgentMessage::TerminalOpened { req_id, error } => {
                    assert_eq!(req_id, "t2fa-bad");
                    assert_eq!(error.as_deref(), Some("terminal_2fa_invalid"));
                }
                _ => panic!("wrong message"),
            }
            // A rejected code must NOT consume the counter — a fresh valid
            // code still opens afterwards.
            manager.open(
                "t2fa-good".to_string(),
                80,
                24,
                Some(current_totp_code()),
                tx.clone(),
            );
            let deadline = Instant::now() + TEST_TIMEOUT;
            let opened = recv_until(&rx, deadline, |m| {
                matches!(m, AgentMessage::TerminalOpened { req_id, .. } if req_id == "t2fa-good")
            });
            match opened {
                AgentMessage::TerminalOpened { error, .. } => assert!(error.is_none()),
                _ => unreachable!(),
            }
            manager.close("t2fa-good", &tx);
            let deadline = Instant::now() + TEST_TIMEOUT;
            while manager.inflight.load(Ordering::Acquire) != 0 {
                assert!(Instant::now() < deadline, "slot not released after close");
                std::thread::sleep(Duration::from_millis(20));
            }
        }
    }
}

#[cfg(unix)]
pub use unix_impl::TerminalManager;

/// Non-unix stub: the capability is advertised as false, so the hub should
/// never send terminal messages; if one arrives anyway, reject the open
/// politely and ignore the rest.
#[cfg(not(unix))]
mod stub {
    use std::sync::Arc;

    use filebox_protocol::message::AgentMessage;
    use tokio::sync::mpsc;

    pub struct TerminalManager;

    impl TerminalManager {
        pub fn new(_totp_secret: Option<String>) -> Self {
            Self
        }

        pub fn open(
            self: &Arc<Self>,
            req_id: String,
            _cols: u16,
            _rows: u16,
            _agent_totp_code: Option<String>,
            tx: mpsc::Sender<AgentMessage>,
        ) {
            let _ = tx.try_send(AgentMessage::TerminalOpened {
                req_id,
                error: Some("terminal_unavailable: unsupported platform".to_string()),
            });
        }

        pub fn input(&self, _req_id: &str, _data: &[u8]) {}

        pub fn resize(&self, _req_id: &str, _cols: u16, _rows: u16) {}

        pub fn close(&self, _req_id: &str, _tx: &mpsc::Sender<AgentMessage>) {}

        pub fn close_all(&self) {}
    }
}

#[cfg(not(unix))]
pub use stub::TerminalManager;
