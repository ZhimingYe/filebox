use super::*;

const UPLOAD_QUEUE_FRAMES: usize = 16;
const ACTIVE: usize = 0;
const CANCELLED: usize = 1;
const RESPONDED: usize = 2;
type UploadChunk = (u64, Vec<u8>, bool);

/// The worker and receive loop arbitrate exactly one terminal response.
/// Dropping this handle only sets a flag and closes a queue; disk cleanup is
/// owned by the worker, so Cancel/Drop cannot wait for a filesystem lock.
pub(super) struct UploadWriter {
    chunks: Option<mpsc::Sender<UploadChunk>>,
    state: Arc<AtomicUsize>,
}

impl UploadWriter {
    pub(super) fn is_active(&self) -> bool { self.state.load(Ordering::Acquire) == ACTIVE }

    fn cancel(&self) -> bool {
        self.state.compare_exchange(ACTIVE, CANCELLED, Ordering::AcqRel, Ordering::Acquire).is_ok()
    }
}

impl Drop for UploadWriter {
    fn drop(&mut self) { self.cancel(); }
}

fn upload_response(req_id: String, error: String) -> AgentMessage {
    AgentMessage::TempUploadResponse { req_id, name: None, size: None, error: Some(error) }
}

fn run_upload(
    store: &crate::temp_store::TempStore, req_id: &str, name: &str, total_size: u64,
    rx: &mut mpsc::Receiver<UploadChunk>, state: &AtomicUsize,
) -> Option<AgentMessage> {
    if state.load(Ordering::Acquire) != ACTIVE { return None; }
    if let Err(error) = store.begin(req_id, name, total_size) {
        return Some(upload_response(req_id.to_string(), error));
    }
    while let Some((offset, data, done)) = rx.blocking_recv() {
        if state.load(Ordering::Acquire) != ACTIVE { return None; }
        match store.write_chunk(req_id, offset, &data, done) {
            Ok(None) => {}
            Ok(Some((name, size))) => return Some(AgentMessage::TempUploadResponse {
                req_id: req_id.to_string(), name: Some(name), size: Some(size), error: None,
            }),
            Err(error) => return Some(upload_response(req_id.to_string(), error)),
        }
    }
    None
}

impl ConnectionSession<'_> {
    pub(super) fn handle_uploads(&mut self, message: HubMessage) -> Result<(), DisconnectReason> {
        let fs_workers = &self.runtime.fs_workers;
        let temp_store = self.runtime.temp_store.as_ref();
        let fs_tx = &self.fs_tx;
        let control_tx = &self.control_tx;
        let fs_admission = &self.fs_admission;
        let fs_cancellations = &self.fs_cancellations;
        let tasks = &mut self.tasks;
        match message {
            HubMessage::TempUploadBegin { req_id, name, total_size } => {
                let Some(store) = temp_store.cloned() else {
                    return self.upload_error(req_id, "temp_unavailable");
                };
                if self.temp_writers.contains_key(&req_id) {
                    // A duplicate routing id must not leave two disk writers.
                    if let Some(writer) = self.temp_writers.remove(&req_id) {
                        if writer.cancel() { return self.upload_error(req_id, "temp_internal_error"); }
                    }
                    return Ok(());
                }
                let Ok(permit) = self.runtime.upload_workers.clone().try_acquire_owned() else {
                    return self.upload_error(req_id, "agent_overloaded: upload workers are busy; retry upload");
                };
                let (chunks, mut rx) = mpsc::channel(UPLOAD_QUEUE_FRAMES);
                let state = Arc::new(AtomicUsize::new(ACTIVE));
                self.temp_writers.insert(req_id.clone(), UploadWriter { chunks: Some(chunks), state: state.clone() });
                let tx = self.temp_tx.clone();
                tokio::task::spawn_blocking(move || {
                    // Permit survives disconnect and remains held through disk
                    // cleanup, even if a native syscall never returns.
                    let _permit = permit;
                    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        run_upload(&store, &req_id, &name, total_size, &mut rx, &state)
                    }));
                    // Begin/Cancel/write failure/panic all release staging and
                    // quota here, never in the transport task's Drop path.
                    store.cancel(&req_id);
                    let response = match outcome {
                        Ok(response) => response,
                        Err(_) => Some(upload_response(req_id, "agent_internal_error".to_string())),
                    };
                    if let Some(response) = response {
                        if state.compare_exchange(ACTIVE, RESPONDED, Ordering::AcqRel, Ordering::Acquire).is_ok() {
                            let _ = tx.blocking_send(response);
                        }
                    } else {
                        let _ = state.compare_exchange(ACTIVE, CANCELLED, Ordering::AcqRel, Ordering::Acquire);
                    }
                });
            }
            HubMessage::TempUploadChunk { req_id, offset, data, done } => {
                let Some(writer) = self.temp_writers.get_mut(&req_id) else { return Ok(()); };
                let Some(tx) = writer.chunks.as_ref() else { return Ok(()); };
                // Both frame count and frame bytes are bounded. Never await
                // queue capacity here: slow storage must not bury Ping/Cancel.
                let oversized = data.len() > filebox_protocol::message::FILE_CHUNK_MAX_BYTES as usize;
                if oversized || tx.try_send((offset, data, done)).is_err() {
                    let claimed = writer.cancel();
                    self.temp_writers.remove(&req_id);
                    if claimed {
                        return self.upload_error(req_id, if oversized { "temp_upload_too_large" }
                            else { "temp_upload_stalled" });
                    }
                } else if done {
                    // Keep the cancellation handle until the worker finishes,
                    // including while publishing the queued final chunk.
                    writer.chunks.take();
                }
            }
            HubMessage::TempCleanupRequest { req_id } => {
                tracing::debug!("Temp cleanup request");
                let store = temp_store.cloned();
                let rid = req_id.clone();
                let panic_response = AgentMessage::TempCleanupResponse {
                    req_id: rid.clone(),
                    removed: 0,
                    freed_bytes: 0,
                    error: Some("agent_internal_error".to_string()),
                };
                let cancelled_response = AgentMessage::TempCleanupResponse {
                    req_id: req_id.clone(),
                    removed: 0,
                    freed_bytes: 0,
                    error: Some("request_cancelled".to_string()),
                };
                let accepted = try_spawn_fs_job(
                    tasks,
                    fs_admission,
                    fs_workers,
                    fs_tx,
                    req_id.clone(),
                    fs_cancellations,
                    move |cancelled| match store {
                        Some(store) => match store.cleanup(Some(&cancelled)) {
                            Ok((removed, freed_bytes)) => {
                                AgentMessage::TempCleanupResponse {
                                    req_id: rid.clone(),
                                    removed,
                                    freed_bytes,
                                    error: None,
                                }
                            }
                            Err(error) => AgentMessage::TempCleanupResponse {
                                req_id: rid.clone(),
                                removed: 0,
                                freed_bytes: 0,
                                error: Some(error),
                            },
                        },
                        None => AgentMessage::TempCleanupResponse {
                            req_id: rid.clone(),
                            removed: 0,
                            freed_bytes: 0,
                            error: Some("temp_unavailable".to_string()),
                        },
                    },
                    cancelled_response,
                    panic_response,
                );
                if !accepted {
                    let response = AgentMessage::TempCleanupResponse {
                        req_id,
                        removed: 0,
                        freed_bytes: 0,
                        error: Some(
                            "agent_overloaded: file I/O queue is full".to_string(),
                        ),
                    };
                    if !queue_agent_message(control_tx, &response) {
                        tracing::warn!("Failed to send temp cleanup overload response, reconnecting");
                        return Err(DisconnectReason::ControlQueueClosed);
                    }
                }
            }
            _ => unreachable!("dispatcher selected the wrong handler"),
        }
        Ok(())
    }

    fn upload_error(&self, req_id: String, error: &str) -> Result<(), DisconnectReason> {
        if queue_agent_message(&self.control_tx, &upload_response(req_id, error.to_string())) { Ok(()) }
        else { Err(DisconnectReason::ControlQueueClosed) }
    }
}
