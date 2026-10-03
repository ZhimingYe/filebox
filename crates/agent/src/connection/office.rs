use super::*;

impl ConnectionSession<'_> {
    pub(super) fn handle_office(&mut self, message: HubMessage) -> Result<(), DisconnectReason> {
        let resource_mgr = &self.runtime.resource_mgr;
        let office_runtime = self.runtime.office_runtime.as_ref();
        let temp_store = self.runtime.temp_store.as_ref();
        let office_tx = &self.office_tx;
        let control_tx = &self.control_tx;
        match message {
            HubMessage::OfficeConvertRequest {
                req_id,
                root,
                path,
                force,
            } => {
                tracing::debug!(
                    "Office convert: root={} path={}",
                    root,
                    path
                );
                let Some(rt) = office_runtime.cloned() else {
                    let resp = AgentMessage::OfficeConvertResponse {
                        req_id,
                        cache_key: None,
                        size: None,
                        outputs: vec![],
                        error: Some("unsupported_feature".to_string()),
                    };
                    if !queue_agent_message(control_tx, &resp) {
                        tracing::warn!("Failed to send office unsupported response, reconnecting");
                        return Err(DisconnectReason::ControlQueueClosed);
                    }
                    return Ok(());
                };
                let lease = match rt.reserve_job(&req_id) {
                    Ok(lease) => lease,
                    Err(error) => {
                        let resp = AgentMessage::OfficeConvertResponse {
                            req_id,
                            cache_key: None,
                            size: None,
                            outputs: vec![],
                            error: Some(error),
                        };
                        if !queue_agent_message(control_tx, &resp) {
                            tracing::warn!("Failed to send office overload response, reconnecting");
                            return Err(DisconnectReason::ControlQueueClosed);
                        }
                        return Ok(());
                    }
                };
                let roots_vec = roots_with_temp(resource_mgr, temp_store);
                let tx = office_tx.clone();
                let progress_tx = office_tx.clone();
                let rid = req_id.clone();
                let rid_for_progress = req_id.clone();
                let on_progress: crate::office_convert::ProgressFn =
                    Arc::new(move |phase, processed, message| {
                        let msg = AgentMessage::Progress {
                            req_id: rid_for_progress.clone(),
                            phase: phase.to_string(),
                            processed,
                            // Phase index only — not a byte total.
                            total: None,
                            message,
                        };
                        let _ = progress_tx.try_send(msg);
                    });
                let worker_timeout =
                    rt.config.timeout.saturating_add(Duration::from_secs(5));
                let rt_for_timeout = rt.clone();
                let worker = tokio::task::spawn_blocking(move || {
                    let _ = tx.try_send(AgentMessage::Progress {
                        req_id: rid.clone(),
                        phase: "preparing".to_string(),
                        processed: 0,
                        total: None,
                        message: Some("Preparing preview…".to_string()),
                    });
                    let outcome =
                        crate::office_convert::run_convert_reserved_with_options(
                            rt.as_ref(),
                            &roots_vec,
                            &rid,
                            &root,
                            &path,
                            lease,
                            force,
                            Some(on_progress),
                        );
                    match outcome {
                        Ok(r) => {
                            let legacy_pdf = r
                                .outputs
                                .first()
                                .is_some_and(|output| output.format == "pdf");
                            AgentMessage::OfficeConvertResponse {
                                req_id: rid.clone(),
                                cache_key: legacy_pdf
                                    .then_some(r.cache_key),
                                size: legacy_pdf.then_some(r.size),
                                outputs: r.outputs,
                                error: None,
                            }
                        }
                        Err(e) => AgentMessage::OfficeConvertResponse {
                            req_id: rid.clone(),
                            cache_key: None,
                            size: None,
                            outputs: vec![],
                            error: Some(e),
                        },
                    }
                });
                let terminal_tx = office_tx.clone();
                let terminal_req_id = req_id.clone();
                self.tasks.spawn(async move {
                    let response =
                        match tokio::time::timeout(worker_timeout, worker).await {
                        Ok(Ok(response)) => response,
                        Ok(Err(join_error)) => {
                            tracing::error!(
                                "Office worker failed for {}: {}",
                                terminal_req_id,
                                join_error
                            );
                            AgentMessage::OfficeConvertResponse {
                                req_id: terminal_req_id,
                                cache_key: None,
                                size: None,
                                outputs: vec![],
                                error: Some("office_internal_error".to_string()),
                            }
                        }
                        Err(_) => {
                            // A kernel-stuck filesystem read cannot be force-
                            // cancelled in-process. Still finish the protocol
                            // request on time and set the cooperative flag; the
                            // bounded blocking pool isolates any lingering syscall.
                            rt_for_timeout.request_cancel(&terminal_req_id);
                            AgentMessage::OfficeConvertResponse {
                                req_id: terminal_req_id,
                                cache_key: None,
                                size: None,
                                outputs: vec![],
                                error: Some("office_timeout".to_string()),
                            }
                        }
                    };
                    let _ = terminal_tx.send(response).await;
                });
            }
            _ => unreachable!("dispatcher selected the wrong handler"),
        }
        Ok(())
    }
}
