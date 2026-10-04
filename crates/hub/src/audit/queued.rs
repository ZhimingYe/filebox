//! Bounded audit persistence for the shared Agent receive loop.
use std::sync::{Arc, OnceLock};
use std::sync::atomic::{AtomicBool, Ordering};

use tokio::sync::mpsc;

use super::{LoginAuditLog, truncate_chars, EVENT_MAX, USERNAME_MAX, IP_MAX, USER_AGENT_MAX};

const QUEUE_CAPACITY: usize = 256;

struct Record {
    at_ms: u64,
    event: String,
    username: String,
    ip: String,
    user_agent: String,
}

pub(crate) struct QueuedAuditLog {
    log: Arc<LoginAuditLog>,
    sender: OnceLock<mpsc::Sender<Record>>,
    overloaded: AtomicBool,
    capacity: usize,
}

impl QueuedAuditLog {
    pub(crate) fn new(log: Arc<LoginAuditLog>) -> Self {
        Self::with_capacity(log, QUEUE_CAPACITY)
    }

    fn with_capacity(log: Arc<LoginAuditLog>, capacity: usize) -> Self {
        Self { log, sender: OnceLock::new(), overloaded: AtomicBool::new(false), capacity }
    }

    /// A single worker serializes disk work. Slow storage retains at most one
    /// blocking job plus the bounded queue; overflow warns without stalling WS.
    pub(crate) fn try_record(&self, event: &str, username: &str, ip: &str, user_agent: &str) -> bool {
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            tracing::warn!(target: "audit", "No runtime for queued audit persistence");
            return false;
        };
        let sender = self.sender.get_or_init(|| {
            let (sender, mut receiver) = mpsc::channel::<Record>(self.capacity);
            let log = self.log.clone();
            runtime.spawn(async move {
                while let Some(record) = receiver.recv().await {
                    let log = log.clone();
                    if let Err(error) = tokio::task::spawn_blocking(move || {
                        log.record_at(record.at_ms, &record.event, &record.username, &record.ip, &record.user_agent);
                    }).await {
                        tracing::warn!(target: "audit", %error, "Queued audit persistence failed");
                    }
                }
            });
            sender
        });
        let record = Record {
            at_ms: std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64).unwrap_or(0),
            event: truncate_chars(event, EVENT_MAX),
            username: truncate_chars(username, USERNAME_MAX),
            ip: truncate_chars(ip, IP_MAX),
            user_agent: truncate_chars(user_agent, USER_AGENT_MAX),
        };
        if sender.try_send(record).is_ok() {
            self.overloaded.store(false, Ordering::Relaxed);
            true
        } else {
            if !self.overloaded.swap(true, Ordering::Relaxed) {
                tracing::warn!(target: "audit", "Terminal audit queue unavailable; record omitted from persistent history");
            }
            false
        }
    }
}

#[cfg(test)]
pub(crate) struct StoragePause {
    release: Option<std::sync::mpsc::Sender<()>>,
    thread: Option<std::thread::JoinHandle<()>>,
}

#[cfg(test)]
impl Drop for StoragePause {
    fn drop(&mut self) {
        if let Some(release) = self.release.take() { let _ = release.send(()); }
        if let Some(thread) = self.thread.take() { thread.join().unwrap(); }
    }
}

#[cfg(test)]
impl LoginAuditLog {
    /// Model stalled persistence without blocking a Tokio worker or leaving a
    /// native test thread behind if an assertion fails.
    pub(crate) async fn pause_storage_for_test(self: &Arc<Self>) -> StoragePause {
        let (entered, ready) = tokio::sync::oneshot::channel();
        let (release, wait) = std::sync::mpsc::channel();
        let log = self.clone();
        let thread = std::thread::spawn(move || {
            let _storage = log.inner.lock().unwrap();
            let _ = entered.send(());
            let _ = wait.recv();
        });
        let pause = StoragePause { release: Some(release), thread: Some(thread) };
        ready.await.unwrap();
        pause
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[tokio::test]
    async fn slow_storage_bounds_queue_and_preserves_order_and_attribution() {
        let log = Arc::new(LoginAuditLog::load(None));
        let queue = QueuedAuditLog::with_capacity(log.clone(), 1);
        let pause = log.pause_storage_for_test().await;
        assert!(queue.try_record("terminal_opened", "alice", "192.0.2.1", "first"));
        tokio::time::timeout(Duration::from_secs(1), async {
            while queue.sender.get().unwrap().capacity() == 0 {
                tokio::task::yield_now().await;
            }
        }).await.unwrap();
        assert!(queue.try_record("terminal_open_failed", "bob", "192.0.2.2", "u".repeat(500).as_str()));
        assert!(!queue.try_record("terminal_opened", "overflow", "", ""));
        let before_release = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64;
        drop(pause);
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                let log = log.clone();
                let (entries, _) = tokio::task::spawn_blocking(move || log.recent(10, None)).await.unwrap();
                if entries.len() == 2 {
                    assert_eq!(entries[0].event, "terminal_open_failed");
                    assert_eq!(entries[0].username, "bob");
                    assert_eq!(entries[0].ip, "192.0.2.2");
                    assert_eq!(entries[0].user_agent.chars().count(), USER_AGENT_MAX + 1);
                    assert!(entries[0].at_ms <= before_release);
                    assert_eq!(entries[1].user_agent, "first");
                    return;
                }
                tokio::task::yield_now().await;
            }
        }).await.unwrap();
    }
}
