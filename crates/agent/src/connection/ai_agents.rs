use super::*;
use filebox_protocol::message::AgentMessage;

pub(super) fn should_reprobe(
    prev_enabled: bool,
    new_enabled: bool,
    prev_selection: Option<&str>,
    new_selection: Option<&str>,
    selected_present: bool,
) -> bool {
    (!prev_enabled && new_enabled)
        || (new_enabled && prev_selection != new_selection && !selected_present)
}

impl ConnectionSession<'_> {
    pub(super) fn handle_ai_agent_request(
        &mut self,
        message: HubMessage,
    ) -> Result<(), DisconnectReason> {
        let HubMessage::AiAgentRequest {
            req_id,
            op,
            backend: request_backend,
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

        let Some(backend) = self.runtime.active_ai_agent_backend() else {
            let resp = AgentMessage::AiAgentResponse {
                req_id,
                error: Some("ai_agent_backend_not_detected".to_string()),
                status: Some(filebox_protocol::ai_agents::AiAgentBackendStatus {
                    installed: false,
                    reachable: false,
                    version: None,
                    message: Some(
                        "The selected AI agent backend is not detected on this Agent".to_string(),
                    ),
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

        if request_backend
            .as_deref()
            .is_some_and(|requested| requested != backend.kind())
        {
            let resp = AgentMessage::AiAgentResponse {
                req_id,
                error: Some("ai_agent_backend_changed".to_string()),
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
        let HubMessage::AiAgentSettingsSet {
            req_id,
            enabled,
            backend,
        } = message
        else {
            unreachable!("dispatcher selected the wrong handler");
        };

        let error = self
            .apply_ai_agent_settings(enabled, backend, crate::ai_agents::BACKEND_KINDS)
            .await;

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

    pub(super) async fn apply_ai_agent_settings(
        &mut self,
        enabled: bool,
        backend: Option<String>,
        backend_kinds: &[&str],
    ) -> Option<String> {
        let capability = self.runtime.ai_agents_capability();
        let prev_enabled = capability.settings.enabled;
        let prev_selection = capability.settings.backend.clone();
        let enabled_locked = self.runtime.ai_agents_environment_override.is_some();
        let backend_environment_override = self
            .runtime
            .ai_agents_backend_environment_override
            .clone();
        if (enabled_locked && enabled != capability.settings.enabled)
            || (backend_environment_override.is_some()
                && backend != capability.settings.backend)
        {
            return Some("ai_agents_environment_override".into());
        }
        if backend_environment_override.is_none()
            && backend
                .as_deref()
                .is_some_and(|kind| !backend_kinds.contains(&kind))
        {
            return Some("invalid_request".into());
        }

        let persisted_enabled = if enabled_locked {
            self.runtime.resource_mgr.ai_agents_enabled()
        } else {
            enabled
        };
        let persisted_backend = if backend_environment_override.is_some() {
            self.runtime
                .resource_mgr
                .ai_agents_backend()
                .map(str::to_string)
        } else {
            backend.clone()
        };
        if let Err(save_error) = self
            .runtime
            .resource_mgr
            .set_ai_agents_settings(persisted_enabled, persisted_backend)
        {
            return Some(format!("ai_agents_settings_save_failed: {save_error}"));
        }

        let effective_enabled = crate::ai_agents::effective_enabled(
            self.runtime.resource_mgr.ai_agents_enabled(),
            self.runtime.ai_agents_environment_override,
        );
        let selection = backend_environment_override
            .as_deref()
            .or_else(|| self.runtime.resource_mgr.ai_agents_backend());
        let selected_present = match selection {
            Some(kind) => self
                .runtime
                .ai_agent_backends
                .iter()
                .any(|backend| backend.kind() == kind),
            None => !self.runtime.ai_agent_backends.is_empty(),
        };
        if should_reprobe(
            prev_enabled,
            effective_enabled,
            prev_selection.as_deref(),
            selection,
            selected_present,
        ) {
            self.runtime.ai_agent_backends = crate::ai_agents::probe_all().await;
        }
        if !effective_enabled {
            if let Ok(mut cancels) = self.runtime.ai_agent_cancels.lock() {
                for (_, cancel) in cancels.drain() {
                    cancel.store(true, std::sync::atomic::Ordering::Relaxed);
                }
            }
        }
        None
    }
}
