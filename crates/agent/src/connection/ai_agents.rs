use super::*;
use filebox_protocol::message::AgentMessage;

impl ConnectionSession<'_> {
    pub(super) fn handle_ai_agent_request(
        &mut self,
        message: HubMessage,
    ) -> Result<(), DisconnectReason> {
        let HubMessage::AiAgentRequest {
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

        let capability = self.runtime.ai_agents_capability();
        if !crate::ai_agents::effective_enabled(
            capability.settings.enabled,
            capability.settings.environment_override,
        ) {
            let resp = AgentMessage::AiAgentResponse {
                req_id,
                error: Some("ai_agents_disabled".to_string()),
                status: None,
                agents: Vec::new(),
                agent: None,
                output: None,
            };
            if !queue_agent_message(&self.control_tx, &resp) {
                return Err(DisconnectReason::ControlQueueClosed);
            }
            return Ok(());
        }

        let Some(backend) = self.runtime.ai_agent_backend.clone() else {
            let resp = AgentMessage::AiAgentResponse {
                req_id,
                error: Some("ai_agent_backend_unavailable".to_string()),
                status: Some(filebox_protocol::ai_agents::AiAgentBackendStatus {
                    installed: false,
                    reachable: false,
                    version: None,
                    message: Some("No supported AI agent backend is installed".to_string()),
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

        let Ok(permit) = self.runtime.ai_agent_inflight.clone().try_acquire_owned() else {
            let resp = AgentMessage::AiAgentResponse {
                req_id,
                error: Some("agent_busy: another AI agent command is already running".to_string()),
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
        if let Ok(mut map) = self.runtime.ai_agent_cancels.lock() {
            map.insert(req_id.clone(), cancel.clone());
        }
        let tx = self.ai_agents_tx.clone();
        let cancels = self.runtime.ai_agent_cancels.clone();
        self.tasks.spawn(async move {
            let _permit = permit;
            let response = crate::ai_agents::handle_request(
                backend.as_ref(),
                req_id.clone(),
                op,
                target,
                text,
                keys,
                lines,
                read_source,
                wait,
                timeout_ms,
                cancel,
            )
                .await;
            if let Ok(mut map) = cancels.lock() {
                map.remove(&req_id);
            }
            let _ = tx.send(response).await;
        });
        Ok(())
    }

    pub(super) async fn handle_ai_agent_settings(
        &mut self,
        message: HubMessage,
    ) -> Result<(), DisconnectReason> {
        let HubMessage::AiAgentSettingsSet { req_id, enabled } = message else {
            unreachable!("dispatcher selected the wrong handler");
        };

        let mut error = None;
        let environment_override = self.runtime.ai_agents_environment_override;
        if environment_override.is_some() {
            error = Some("ai_agents_environment_override".to_string());
        } else {
            if enabled && self.runtime.ai_agent_backend.is_none() {
                self.runtime.ai_agent_backend = crate::ai_agents::probe().await;
            }
            match self.runtime.resource_mgr.set_ai_agents_enabled(enabled) {
                Ok(()) => {
                    if !enabled {
                        if let Ok(mut cancels) = self.runtime.ai_agent_cancels.lock() {
                            for (_, cancel) in cancels.drain() {
                                cancel.store(true, std::sync::atomic::Ordering::Relaxed);
                            }
                        }
                    }
                }
                Err(save_error) => {
                    error = Some(format!("ai_agents_settings_save_failed: {save_error}"));
                }
            }
        }

        let ai_agents = self.runtime.ai_agents_capability();
        let response = AgentMessage::AiAgentSettingsApplied {
            req_id,
            ai_agents,
            error,
        };
        if !queue_agent_message(&self.control_tx, &response) {
            return Err(DisconnectReason::ControlQueueClosed);
        }
        Ok(())
    }
}
