use axum::{body::Body, http::StatusCode};
use hyper::client::conn::http1::SendRequest;
use hyper_util::rt::TokioIo;
use tokio_util::sync::CancellationToken;
use super::*;

pub(super) struct Connection {
    pub sender: SendRequest<Body>,
    pub cancel: CancellationToken,
}
impl Drop for Connection {
    fn drop(&mut self) { self.cancel.cancel(); }
}
pub(super) struct Idle { id: String, pub(super) since: Instant, connection: Connection, _timer: tokio_util::sync::DropGuard }

impl TunnelStore {
    pub(super) fn evict_idle(&self, agent: &str) {
        let mut idle = self.idle.lock().unwrap();
        if let Some(key) = idle.iter().filter(|((id, _), entries)| id == agent && !entries.is_empty())
            .min_by_key(|(_, entries)| entries[0].since).map(|(key, _)| key.clone()) {
            let entries = idle.get_mut(&key).unwrap();
            entries.remove(0);
            if entries.is_empty() { idle.remove(&key); }
        }
    }
    pub(super) fn take_idle(&self, key: &(String, u16)) -> Option<Connection> {
        let mut idle = self.idle.lock().unwrap();
        let entries = idle.get_mut(key)?;
        entries.retain(|entry| entry.since.elapsed() < Duration::from_secs(30) && !entry.connection.cancel.is_cancelled() && !entry.connection.sender.is_closed());
        let result = entries.pop().map(|entry| entry.connection);
        if entries.is_empty() { idle.remove(key); }
        result
    }

    pub(super) fn put_idle(self: &Arc<Self>, key: (String, u16), connection: Connection) {
        if connection.cancel.is_cancelled() || connection.sender.is_closed() { return; }
        let id = uuid::Uuid::new_v4().to_string();
        let timer = CancellationToken::new();
        {
            let mut idle = self.idle.lock().unwrap();
            let entries = idle.entry(key.clone()).or_default();
            if entries.len() >= 16 { return; }
            entries.push(Idle { id: id.clone(), since: Instant::now(), connection, _timer: timer.clone().drop_guard() });
        }
        let store = Arc::downgrade(self);
        tokio::spawn(async move {
            tokio::select! { _ = timer.cancelled() => return, _ = tokio::time::sleep(Duration::from_secs(30)) => {} }
            if let Some(store) = store.upgrade() {
                let mut idle = store.idle.lock().unwrap();
                if let Some(entries) = idle.get_mut(&key) {
                    entries.retain(|entry| entry.id != id);
                    if entries.is_empty() { idle.remove(&key); }
                }
            }
        });
    }
}

pub(super) async fn connect(state: &AppState, agent: &str, port: u16, pooled: bool) -> Result<Connection, StatusCode> {
    if pooled {
        while let Some(mut connection) = state.tunnels.take_idle(&(agent.into(), port)) {
            if connection.sender.ready().await.is_ok() && !connection.cancel.is_cancelled() { return Ok(connection); }
        }
    }
    let opened = super::open(state, agent, port).await?;
    let cancel = opened.cancel;
    let (sender, driver) = match hyper::client::conn::http1::handshake::<_, Body>(TokioIo::new(opened.stream)).await {
        Ok(result) => result, Err(_) => { cancel.cancel(); return Err(StatusCode::BAD_GATEWAY); }
    };
    let driver_cancel = cancel.clone();
    tokio::spawn(async move {
        let result = tokio::select! { _ = driver_cancel.cancelled() => return, result = driver.with_upgrades() => result };
        if result.is_err() { driver_cancel.cancel(); }
    });
    Ok(Connection { sender, cancel })
}

#[cfg(test)]
#[path = "pool_tests.rs"]
mod tests;
