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
            wait,
            timeout_ms,
        } = message
        else {
            unreachable!("dispatcher selected the wrong handler");
        };

        let Some(client) = self.runtime.herdr.clone() else {
            let resp = AgentMessage::HerdrResponse {
                req_id,
                error: Some("herdr_unavailable".to_string()),
                status: Some(filebox_protocol::herdr::HerdrServerStatus {
                    installed: false,
                    reachable: false,
                    version: None,
                    message: Some("herdr is not installed on this agent".to_string()),
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
        let tx = self.herdr_tx.clone();
        let cancels = self.runtime.herdr_cancels.clone();
        self.tasks.spawn(async move {
            let _permit = permit;
            let response = client
                .handle(req_id.clone(), op, target, text, keys, lines, wait, timeout_ms, cancel)
                .await;
            if let Ok(mut map) = cancels.lock() {
                map.remove(&req_id);
            }
            let _ = tx.send(response).await;
        });
        Ok(())
    }
}
