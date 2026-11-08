use super::*;

pub(super) struct Active {
    principal: String, agent: String, port: u16,
    pub(super) cancel: CancellationToken, connection: Option<CancellationToken>,
}
impl Active {
    fn cancel(&self) {
        self.cancel.cancel();
        if let Some(connection) = &self.connection { connection.cancel(); }
    }
}
pub(super) struct Scope { store: Arc<TunnelStore>, id: String, pub cancel: CancellationToken }
impl Scope {
    pub fn attach(&self, connection: &CancellationToken) {
        if let Some(entry) = self.store.active.lock().unwrap().get_mut(&self.id) {
            entry.connection = Some(connection.clone());
            if entry.cancel.is_cancelled() { connection.cancel(); }
        } else { connection.cancel(); }
    }
    pub fn recycle(&self, key: (String, u16), connection: pool::Connection) {
        let mut active = self.store.active.lock().unwrap();
        if active.get(&self.id).is_some_and(|entry| !entry.cancel.is_cancelled()) { self.store.put_idle(key, connection); }
        active.remove(&self.id);
        self.cancel.cancel();
    }
}
impl Drop for Scope {
    fn drop(&mut self) {
        if let Some(entry) = self.store.active.lock().unwrap().remove(&self.id) { entry.cancel(); }
        self.cancel.cancel();
    }
}
impl TunnelStore {
    pub fn cancel_session(&self, principal: &str) {
        for entry in self.active.lock().unwrap().values().filter(|entry| entry.principal == principal) { entry.cancel(); }
    }
    pub fn cancel_forward(&self, agent: &str, port: u16) {
        for entry in self.active.lock().unwrap().values().filter(|entry| entry.agent == agent && entry.port == port) { entry.cancel(); }
        self.idle.lock().unwrap().remove(&(agent.into(), port));
    }
    pub(super) fn scope(self: &Arc<Self>, state: AppState, principal: String, agent: String, port: u16) -> Scope {
        let id = uuid::Uuid::new_v4().to_string();
        let cancel = CancellationToken::new();
        self.active.lock().unwrap().insert(id.clone(), Active { principal: principal.clone(), agent, port, cancel: cancel.clone(), connection: None });
        let scope = Scope { store: self.clone(), id: id.clone(), cancel: cancel.clone() };
        let store = Arc::downgrade(self);
        tokio::spawn(async move {
            loop {
                let expires = state.inner.read().await.sessions.get_session_by_principal(&principal).map(|s| s.expires_at);
                let Some(expires) = expires else {
                    if let Some(store) = store.upgrade() {
                        if let Some(entry) = store.active.lock().unwrap().get(&id) { entry.cancel(); }
                    }
                    break;
                };
                let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs();
                let delay = Duration::from_secs(expires.saturating_add(1).saturating_sub(now).max(1));
                tokio::select! { _ = cancel.cancelled() => break, _ = tokio::time::sleep(delay) => {} }
            }
        });
        scope
    }
}
