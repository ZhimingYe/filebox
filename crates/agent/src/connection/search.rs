use super::*;

impl ConnectionSession<'_> {
    pub(super) fn handle_search(&mut self, message: HubMessage) -> Result<(), DisconnectReason> {
        let resource_mgr = &self.runtime.resource_mgr;
        let search_inflight = &self.runtime.search_inflight;
        let search_cancels = &self.runtime.search_cancels;
        let temp_store = self.runtime.temp_store.as_ref();
        let search_tx = &self.search_tx;
        let control_tx = &self.control_tx;
        match message {
            HubMessage::WorkspaceSearchRequest {
                req_id,
                mode,
                root,
                path,
                query,
                extensions,
                max_results,
                context,
                ignore,
                max_depth,
            } => {
                tracing::debug!(
                    "Workspace search: mode={:?} root={} path={} query_len={}",
                    mode,
                    root,
                    path,
                    query.len()
                );
                // Atomic slot take — avoid TOCTOU where two
                // concurrent requests both pass a load() check.
                let prev = search_inflight.fetch_add(1, Ordering::AcqRel);
                if prev >= MAX_SEARCH_INFLIGHT {
                    search_inflight.fetch_sub(1, Ordering::AcqRel);
                    let busy = AgentMessage::WorkspaceSearchResponse {
                        req_id,
                        result: None,
                        error: Some(
                            "agent_busy: another search is already running"
                                .to_string(),
                        ),
                    };
                    if !queue_agent_message(control_tx, &busy) {
                        tracing::warn!("Failed to send search busy response, reconnecting");
                        return Err(DisconnectReason::ControlQueueClosed);
                    }
                    return Ok(());
                }

                let cancel = Arc::new(AtomicBool::new(false));
                if let Ok(mut map) = search_cancels.lock() {
                    map.insert(req_id.clone(), cancel.clone());
                }

                let roots_vec = roots_with_temp(resource_mgr, temp_store);
                let tx = search_tx.clone();
                let progress_tx = search_tx.clone();
                let inflight = search_inflight.clone();
                let cancels = search_cancels.clone();
                let rid = req_id.clone();
                let rid_for_progress = req_id.clone();
                let on_progress: Arc<dyn Fn(u64, u64) + Send + Sync> =
                    Arc::new(move |scanned, hits| {
                        let msg = AgentMessage::Progress {
                            req_id: rid_for_progress.clone(),
                            phase: "search".to_string(),
                            processed: scanned,
                            total: None,
                            message: Some(format!(
                                "Scanned {scanned} files · {hits} hits"
                            )),
                        };
                        // Non-blocking: drop progress if the
                        // outbound queue is full so search
                        // never stalls waiting on the WS loop.
                        let _ = progress_tx.try_send(msg);
                    });
                let params = crate::search::SearchParams {
                    mode,
                    root,
                    path,
                    query,
                    extensions,
                    max_results,
                    context,
                    ignore,
                    max_depth,
                    cancel: Some(cancel),
                    on_progress: Some(on_progress),
                };
                // Fire-and-forget worker — WS loop stays free
                // for heartbeats, FS ops, and Cancel.
                tokio::task::spawn_blocking(move || {
                    let _ = tx.try_send(AgentMessage::Progress {
                        req_id: rid.clone(),
                        phase: "search".to_string(),
                        processed: 0,
                        total: None,
                        message: Some("Starting search…".to_string()),
                    });
                    let outcome = std::panic::catch_unwind(
                        std::panic::AssertUnwindSafe(|| {
                            crate::search::run_search(&roots_vec, params)
                        }),
                    );
                    let response = match outcome {
                        Ok(Ok(result)) => AgentMessage::WorkspaceSearchResponse {
                            req_id: rid.clone(),
                            result: Some(result),
                            error: None,
                        },
                        Ok(Err(e)) => AgentMessage::WorkspaceSearchResponse {
                            req_id: rid.clone(),
                            result: None,
                            error: Some(e),
                        },
                        Err(_) => {
                            tracing::error!(
                                "Workspace search worker panicked for {}",
                                rid
                            );
                            AgentMessage::WorkspaceSearchResponse {
                                req_id: rid.clone(),
                                result: None,
                                error: Some("agent_internal_error".to_string()),
                            }
                        }
                    };
                    if let Ok(mut map) = cancels.lock() {
                        map.remove(&rid);
                    }
                    inflight.fetch_sub(1, Ordering::AcqRel);
                    // After WS teardown drops search_rx this
                    // returns immediately; while the loop is
                    // alive it must deliver the terminal msg.
                    let _ = tx.blocking_send(response);
                });
            }
            _ => unreachable!("dispatcher selected the wrong handler"),
        }
        Ok(())
    }
}
