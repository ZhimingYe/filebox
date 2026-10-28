use super::*;
use filebox_protocol::message::AgentMessage;

impl ConnectionSession<'_> {
    pub(super) fn handle_herdr(&mut self, message: HubMessage) -> Result<(), DisconnectReason> {
        let HubMessage::HerdrRequest {
            req_id,
            op,
            target,
            text,
            keys,
            lines,
            read_source,
            wait,
            timeout_ms,
        } = message
        else {
            unreachable!("dispatcher selected the wrong handler");
        };

        let admission = self.runtime.herdr_admission_gate.lock().unwrap_or_else(|error| error.into_inner());
        let state = self.runtime.herdr_state();
        let Some(client) = state.client.filter(|_| state.enabled) else {
            let resp = AgentMessage::HerdrResponse {
                req_id,
                error: Some(if state.enabled { "herdr_unavailable" } else { "herdr_disabled" }.to_string()),
                status: Some(filebox_protocol::herdr::HerdrServerStatus {
                    installed: false,
                    reachable: false,
                    version: None,
                    message: Some(if state.enabled {
                        "herdr is not installed on this agent".to_string()
                    } else {
                        "Herdr is disabled on this agent".to_string()
                    }),
                }),
                agents: Vec::new(),
                agent: None,
                output: None,
            };
            if !queue_agent_message(&self.control_tx, &resp) {
                return Err(DisconnectReason::ControlQueueClosed);
            }
            return Ok(());
        };

        let Ok(permit) = self.runtime.herdr_inflight.clone().try_acquire_owned() else {
            let resp = AgentMessage::HerdrResponse {
                req_id,
                error: Some("agent_busy: another Herdr command is already running".to_string()),
                status: None,
                agents: Vec::new(),
                agent: None,
                output: None,
            };
            if !queue_agent_message(&self.control_tx, &resp) {
                return Err(DisconnectReason::ControlQueueClosed);
            }
            return Ok(());
        };

        let cancel = Arc::new(AtomicBool::new(false));
        if let Ok(mut map) = self.runtime.herdr_cancels.lock() {
            map.insert(req_id.clone(), cancel.clone());
        }
        drop(admission);
        let tx = self.herdr_tx.clone();
        let cancels = self.runtime.herdr_cancels.clone();
        self.tasks.spawn(async move {
            let _permit = permit;
            let response = client
                .handle(req_id.clone(), op, target, text, keys, lines, read_source, wait, timeout_ms, cancel)
                .await;
            if let Ok(mut map) = cancels.lock() {
                map.remove(&req_id);
            }
            let _ = tx.send(response).await;
        });
        Ok(())
    }

    pub(super) fn handle_herdr_settings(&mut self, message: HubMessage) -> Result<(), DisconnectReason> {
        let HubMessage::HerdrSettingsSet { req_id, enabled } = message else {
            unreachable!("dispatcher selected the wrong handler");
        };
        if self.runtime.herdr_settings_busy.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire).is_err() {
            let state = self.runtime.herdr_state();
            return queue_settings_response(
                &self.control_tx, req_id, state.enabled, state.client.is_some(), state.locked,
                Some("herdr_settings_busy".to_string()),
            );
        }

        let previous = self.runtime.herdr_state();
        if previous.locked {
            self.runtime.herdr_settings_busy.store(false, Ordering::Release);
            return queue_settings_response(
                &self.control_tx, req_id, previous.enabled, previous.client.is_some(), true,
                Some("herdr_settings_locked".to_string()),
            );
        }
        let job = super::super::runtime::HerdrSettingsJob {
            req_id: req_id.clone(),
            enabled,
            previous: previous.clone(),
        };
        if self.runtime.herdr_settings_tx.try_send(job).is_err() {
            *self.runtime.herdr_settings.write().unwrap_or_else(|error| error.into_inner()) = previous.clone();
            self.runtime.herdr_settings_busy.store(false, Ordering::Release);
            return queue_settings_response(
                &self.control_tx, req_id, previous.enabled, previous.client.is_some(), previous.locked,
                Some("herdr_settings_busy".to_string()),
            );
        }
        Ok(())
    }
}

fn queue_settings_response(
    tx: &mpsc::Sender<Message>,
    req_id: String,
    enabled: bool,
    available: bool,
    locked: bool,
    error: Option<String>,
) -> Result<(), DisconnectReason> {
    let response = AgentMessage::HerdrSettingsResponse { req_id, enabled, available, locked, error };
    if queue_agent_message(tx, &response) {
        Ok(())
    } else {
        Err(DisconnectReason::ControlQueueClosed)
    }
}
