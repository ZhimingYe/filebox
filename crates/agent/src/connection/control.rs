use super::*;

impl ConnectionSession<'_> {
    pub(super) fn handle_control(&mut self, message: HubMessage) -> Result<(), DisconnectReason> {
        let stats_cache = &self.runtime.stats_cache;
        let search_cancels = &self.runtime.search_cancels;
        let terminal_manager = &self.runtime.terminal_manager;
        let office_runtime = self.runtime.office_runtime.as_ref();
        let stats_tx = &self.stats_tx;
        let control_tx = &self.control_tx;
        let fs_cancellations = &self.fs_cancellations;
        let temp_writers = &mut self.temp_writers;
        match message {
            HubMessage::Ping => {
                if !queue_agent_message(control_tx, &AgentMessage::Pong) {
                    tracing::warn!("Failed to send pong, reconnecting");
                    return Err(DisconnectReason::ControlQueueClosed);
                }
            }
            HubMessage::Cancel { req_id } => {
                tracing::debug!("Cancel request: {}", req_id);
                if let Ok(map) = fs_cancellations.lock() {
                    if let Some(cancellation) = map.get(&req_id) {
                        cancellation.cancel();
                    }
                }
                if let Ok(map) = search_cancels.lock() {
                    if let Some(flag) = map.get(&req_id) {
                        flag.store(true, Ordering::Relaxed);
                    }
                }
                if let Some(rt) = office_runtime {
                    rt.request_cancel(&req_id);
                }
                // Dropping the bounded queue sets cancellation; its worker
                // cleans staging off the receive loop, even with slow storage.
                temp_writers.remove(&req_id);
                // Terminal sessions also answer to Cancel
                // (harmless when req_id isn't a terminal).
                terminal_manager.detach(&req_id);
            }
            HubMessage::SysStatsRequest { req_id } => {
                tracing::debug!("Sys stats request");
                let Ok(permit) = self.stats_admission.clone().try_acquire_owned() else {
                    let response = AgentMessage::SysStatsResponse {
                        req_id, stats: None, error: Some("agent_overloaded: stats queue is full".to_string()),
                    };
                    return if queue_agent_message(control_tx, &response) { Ok(()) }
                        else { Err(DisconnectReason::ControlQueueClosed) };
                };
                let stats_cache = Arc::clone(stats_cache);
                let tx = stats_tx.clone();
                self.tasks.spawn(async move {
                    let _permit = permit;
                    let stats = stats_cache.get().await;
                    let response = AgentMessage::SysStatsResponse {
                        req_id,
                        stats: Some((*stats).clone()),
                        error: None,
                    };
                    let _ = tx.send(response).await;
                });
            }
            HubMessage::Error { message } => {
                tracing::warn!("Hub error: {}", message);
            }
            _ => unreachable!("dispatcher selected the wrong handler"),
        }
        Ok(())
    }
}
