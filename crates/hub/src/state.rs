use std::sync::Arc;
use tokio::sync::RwLock;

use crate::config::Config;

#[derive(Clone)]
pub struct AppState {
    pub inner: Arc<RwLock<StateInner>>,
}

pub struct StateInner {
    pub session_key: String,
}

impl AppState {
    pub fn new(config: &Config) -> Self {
        Self {
            inner: Arc::new(RwLock::new(StateInner {
                session_key: config.session_key.clone(),
            })),
        }
    }
}
