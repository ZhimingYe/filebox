use super::*;

#[path = "resources.rs"] mod resources;
#[path = "filesystem.rs"] mod filesystem;
#[path = "control.rs"] mod control;
#[path = "search.rs"] mod search;
#[path = "office.rs"] mod office;
#[path = "uploads.rs"] mod uploads;
#[path = "ai_agents.rs"] mod ai_agents;

#[derive(Debug, PartialEq, Eq)]
pub(super) enum DisconnectReason {
    ConnectFailed,
    ConnectTimeout,
    AuthSendFailed,
    AuthRejected,
    UnexpectedAuthResponse,
    AuthWaitFailed,
    RegisterFailed,
    WriterStopped,
    ControlQueueClosed,
    InboundTimeout,
    StreamEnded,
    ReadFailed,
    HubClosed,
}

/// Exactly one transport generation. Business handlers can enqueue replies
/// and start bounded work, but never access or wait on the socket writer.
pub(super) struct ConnectionSession<'a> {
    runtime: &'a mut AgentRuntime,
    assigned_agent_id: String,
    writer: ConnectionWriter,
    control_tx: mpsc::Sender<Message>,
    search_tx: mpsc::Sender<AgentMessage>,
    office_tx: mpsc::Sender<AgentMessage>,
    stats_tx: mpsc::Sender<AgentMessage>,
    fs_tx: mpsc::Sender<AgentMessage>,
    temp_tx: mpsc::Sender<AgentMessage>,
    dir_tx: mpsc::Sender<AgentMessage>,
    ai_agents_tx: mpsc::Sender<AgentMessage>,
    fs_admission: Arc<Semaphore>,
    tunnel_admission: Arc<Semaphore>,
    stats_admission: Arc<Semaphore>,
    dir_list_admission: Arc<Semaphore>,
    fs_cancellations: FsCancellationMap,
    tasks: JoinSet<()>,
    temp_writers: HashMap<String, uploads::UploadWriter>,
    cancelled: bool,
}

impl<'a> ConnectionSession<'a> {
    pub(super) fn new<W>(runtime: &'a mut AgentRuntime, write: W, assigned_agent_id: String) -> Self
    where
        W: SinkExt<Message> + Unpin + Send + 'static,
    {
        let (search_tx, search_rx) = mpsc::channel(32);
        let (office_tx, office_rx) = mpsc::channel(32);
        let (stats_tx, stats_rx) = mpsc::channel(8);
        let (fs_tx, fs_rx) = mpsc::channel(128);
        let (temp_tx, temp_rx) = mpsc::channel(16);
        let (dir_tx, dir_rx) = mpsc::channel(32);
        let (ai_agents_tx, ai_agents_rx) = mpsc::channel(8);
        let (control_tx, control_rx) = mpsc::channel(CONTROL_QUEUE_CAPACITY);
        let writer = ConnectionWriter(tokio::spawn(run_connection_writer(
            write, control_rx, vec![search_rx, office_rx, stats_rx, dir_rx, fs_rx, temp_rx, ai_agents_rx],
        )));
        Self {
            runtime, assigned_agent_id, writer, control_tx, search_tx, office_tx,
            stats_tx, fs_tx, temp_tx, dir_tx, ai_agents_tx,
            fs_admission: Arc::new(Semaphore::new(FS_MAX_INFLIGHT)),
            tunnel_admission: Arc::new(Semaphore::new(64)),
            stats_admission: Arc::new(Semaphore::new(8)),
            dir_list_admission: Arc::new(Semaphore::new(DIR_LIST_MAX_INFLIGHT)),
            fs_cancellations: Arc::new(Mutex::new(HashMap::new())),
            tasks: JoinSet::new(), temp_writers: HashMap::new(), cancelled: false,
        }
    }

    pub(super) async fn drive<R, E>(&mut self, read: &mut R) -> DisconnectReason
    where R: futures_util::Stream<Item = Result<Message, E>> + Unpin,
          E: std::fmt::Display,
    {
        let mut ping_interval = tokio::time::interval(HEARTBEAT_INTERVAL);
        let mut last_message = tokio::time::Instant::now();
        let control_tx = self.control_tx.clone();
        loop {
            // This loop alone produces control frames. Reserve room for BOTH
            // Updated + Applied before accepting any new request; the fair
            // writer only frees capacity. Liveness still runs while paused.
            let control_ready = self.control_tx.capacity() >= CONTROL_REPLY_SLOTS;
            tokio::select! {
                result = &mut self.writer.0 => {
                    if let Err(error) = result { tracing::warn!("Agent WS writer ended: {}", error); }
                    return DisconnectReason::WriterStopped;
                }
                capacity = control_tx.reserve_many(CONTROL_REPLY_SLOTS), if !control_ready => {
                    match capacity {
                        Ok(permits) => drop(permits),
                        Err(_) => return DisconnectReason::ControlQueueClosed,
                    }
                }
                Some(result) = self.tasks.join_next(), if !self.tasks.is_empty() => {
                    if let Err(error) = result { tracing::warn!("Agent worker task ended unexpectedly: {}", error); }
                }
                _ = tokio::time::sleep_until(last_message + NO_MESSAGE_TIMEOUT) => {
                    tracing::warn!("No message from hub in {}s, reconnecting", NO_MESSAGE_TIMEOUT.as_secs());
                    return DisconnectReason::InboundTimeout;
                }
                message = read.next(), if control_ready => {
                    if matches!(&message, Some(Ok(_))) { last_message = tokio::time::Instant::now(); }
                    match message {
                        None => return DisconnectReason::StreamEnded,
                        Some(Err(error)) => {
                            tracing::info!("Read error: {}", error);
                            return DisconnectReason::ReadFailed;
                        }
                        Some(Ok(Message::Text(text))) => match serde_json::from_str::<HubMessage>(&text) {
                            Ok(message) => if let Err(reason) = self.dispatch(message).await { return reason; },
                            Err(error) => tracing::debug!("Failed to parse hub message: {}", error),
                        },
                        Some(Ok(Message::Ping(data))) => {
                            if !queue_frame(&self.control_tx, Message::Pong(data)) {
                                return DisconnectReason::ControlQueueClosed;
                            }
                        }
                        Some(Ok(Message::Close(_))) => return DisconnectReason::HubClosed,
                        _ => {}
                    }
                }
                _ = ping_interval.tick(), if control_ready => {
                    self.temp_writers.retain(|_, writer| writer.is_active());
                    if !queue_agent_message(&self.control_tx, &AgentMessage::Heartbeat) {
                        return DisconnectReason::ControlQueueClosed;
                    }
                }
            }
        }
    }

    async fn dispatch(&mut self, message: HubMessage) -> Result<(), DisconnectReason> {
        self.temp_writers.retain(|_, writer| writer.is_active());
        match message {
            HubMessage::TunnelOpen { ticket, port, compression } => {
                let code = if !self.runtime.port_forward { Some("disabled") }
                    else if !self.runtime.resource_mgr.config.forwards.iter().any(|f| f.port == port) { Some("not_allowed") }
                    else { None };
                if let Some(code) = code {
                    if !queue_agent_message(&self.control_tx, &AgentMessage::TunnelFailed { ticket, code: code.into() }) {
                        return Err(DisconnectReason::ControlQueueClosed);
                    }
                } else {
                    let Ok(permit) = self.tunnel_admission.clone().try_acquire_owned() else {
                        if !queue_agent_message(&self.control_tx, &AgentMessage::TunnelFailed { ticket, code: "not_allowed".into() }) {
                            return Err(DisconnectReason::ControlQueueClosed);
                        }
                        return Ok(());
                    };
                    let url = build_ws_url(&self.runtime.hub_url).replace("/ws/agent", "/ws/agent-data");
                    let agent = self.runtime.stable_agent_id.clone();
                    let tx = self.control_tx.clone();
                    self.tasks.spawn(async move {
                        let _permit = permit;
                        if let Err(error) = crate::tunnel::run(url, agent, ticket.clone(), port, compression).await {
                            tracing::debug!(%error, "Forward tunnel ended");
                            let response = AgentMessage::TunnelFailed { ticket, code: "refused".into() };
                            let _ = tx.send(Message::Text(serde_json::to_string(&response).unwrap().into())).await;
                        }
                    });
                }
                Ok(())
            }
            HubMessage::ForwardsSetDesired { req_id, desired_revision, forwards } => {
                let response = match self.runtime.resource_mgr.apply_forwards_desired(desired_revision, forwards) {
                    Ok(forwards_revision) => AgentMessage::ForwardsApplied {
                        req_id, forwards_revision,
                        forwards: self.runtime.resource_mgr.config.forwards.clone(),
                    },
                    Err(message) => AgentMessage::ForwardsRejected { req_id, error: "invalid_forward".into(), message },
                };
                if queue_agent_message(&self.control_tx, &response) { Ok(()) }
                else { Err(DisconnectReason::ControlQueueClosed) }
            }
            HubMessage::ResourcesSetDesired { .. } | HubMessage::CollectionsSetDesired { .. } => self.handle_resources(message),
            HubMessage::FsListRequest { .. } | HubMessage::FsStatRequest { .. } | HubMessage::FileReadRequest { .. } => self.handle_filesystem(message),
            HubMessage::WorkspaceSearchRequest { .. } => self.handle_search(message),
            HubMessage::OfficeConvertRequest { .. } => self.handle_office(message),
            HubMessage::TempUploadBegin { .. } | HubMessage::TempUploadChunk { .. } | HubMessage::TempCleanupRequest { .. } => self.handle_uploads(message),
            HubMessage::AiAgentRequest { .. } => self.handle_ai_agent_request(message),
            HubMessage::AiAgentSettingsSet { .. } => self.handle_ai_agent_settings(message).await,
            HubMessage::Ping | HubMessage::Cancel { .. } | HubMessage::SysStatsRequest { .. } | HubMessage::Error { .. } => self.handle_control(message),
            _ => Ok(()),
        }
    }

    // No filesystem I/O here: upload workers own staging cleanup. This also
    // runs in Drop when the enclosing task is aborted during an await.
    fn cancel_work(&mut self) {
        if self.cancelled { return; }
        self.cancelled = true;
        if let Ok(map) = self.fs_cancellations.lock() {
            for cancellation in map.values() { cancellation.cancel(); }
        }
        if let Ok(map) = self.runtime.search_cancels.lock() {
            for flag in map.values() { flag.store(true, Ordering::Relaxed); }
        }
        if let Ok(mut map) = self.runtime.ai_agent_cancels.lock() {
            // Aborted tasks cannot reach their normal removal below handle().
            for (_, flag) in map.drain() { flag.store(true, Ordering::Relaxed); }
        }
        if let Some(runtime) = &self.runtime.office_runtime { runtime.cancel_all(); }
        self.temp_writers.clear();
        self.tasks.abort_all();
    }

    pub(super) async fn shutdown(&mut self) {
        self.cancel_work();
        if !self.writer.0.is_finished() {
            let _ = self.control_tx.try_send(Message::Close(None));
            let _ = tokio::time::timeout(CLOSE_SEND_TIMEOUT, &mut self.writer.0).await;
        }
        self.writer.0.abort();
    }
}

impl Drop for ConnectionSession<'_> {
    fn drop(&mut self) {
        self.cancel_work();
        self.writer.0.abort();
    }
}

#[cfg(test)]
#[path = "session_tests.rs"]
mod tests;
