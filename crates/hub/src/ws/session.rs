use super::*;

/// A dropped/panicking socket task must not leave a detached writer running.
struct WriterTask(tokio::task::JoinHandle<()>);
impl Drop for WriterTask {
    fn drop(&mut self) { self.0.abort(); }
}

struct ConnectionLease {
    context: AgentContext,
    sender: mpsc::Sender<HubMessage>,
    active: bool,
}
impl ConnectionLease {
    async fn release(mut self) {
        cleanup(&self.context, &self.sender).await;
        self.active = false;
    }
}
impl Drop for ConnectionLease {
    fn drop(&mut self) {
        if self.active {
            let context = self.context.clone();
            let sender = self.sender.clone();
            if let Ok(runtime) = tokio::runtime::Handle::try_current() {
                runtime.spawn(async move { cleanup(&context, &sender).await; });
            }
        }
    }
}

pub(super) async fn run(
    context: AgentContext, mut sink: AgentSink, mut reader: AgentReader,
    sender: mpsc::Sender<HubMessage>, mut outbound: mpsc::Receiver<HubMessage>, abort: Arc<Notify>,
) {
    let lease = ConnectionLease { context: context.clone(), sender, active: true };
    let mut writer = WriterTask(tokio::spawn(async move {
        while let Some(message) = outbound.recv().await {
            if !send_hub_frame(&mut sink, &message).await {
                tracing::warn!("Agent WS write failed or stalled; closing connection");
                break;
            }
        }
    }));
    let mut last_message = tokio::time::Instant::now();
    loop {
        tokio::select! {
            biased;
            _ = abort.notified() => break,
            _ = &mut writer.0 => break,
            _ = tokio::time::sleep_until(last_message + NO_AGENT_MESSAGE_TIMEOUT) => {
                tracing::warn!(agent_id = %context.agent_id, "Agent WS receive stalled");
                break;
            }
            frame = reader.next() => {
                let Some(Ok(frame)) = frame else { break; };
                last_message = tokio::time::Instant::now();
                match frame {
                    Message::Text(text) => dispatch::dispatch(&context, &text).await,
                    Message::Ping(_) => {
                        let inner = context.state.inner.read().await;
                        if inner.agents.is_current_connection(&context.agent_id, context.connection_id) {
                            let _ = inner.agents.send_to_agent(&context.agent_id, HubMessage::Ping);
                        }
                    }
                    Message::Close(_) => break,
                    _ => {}
                }
            }
        }
    }
    drop(writer);
    lease.release().await;
}

async fn cleanup(context: &AgentContext, sender: &mpsc::Sender<HubMessage>) {
    // Mark offline before releasing waiters. New HTTP requests cannot bind to
    // a generation whose transport has stopped. Replacement sockets stay live.
    {
        let mut inner = context.state.inner.write().await;
        let current = inner.agents.is_current_connection(&context.agent_id, context.connection_id);
        inner.agents.unregister(&context.agent_id, sender);
        if current && inner.agents.get(&context.agent_id).is_some_and(|a| a.sender.same_channel(sender)) {
            AppState::emit_sse_locked(&inner, "agent_disconnected", serde_json::json!({
                "agent_id": context.agent_id,
                "name": inner.agents.get(&context.agent_id).map(|a| &a.name),
            })).await;
        }
    }
    crate::terminal_proxy::close_terminal_sessions_for_connection(
        &context.state, &context.agent_id, context.connection_id,
    );
    context.state.fail_pending_for_connection(&context.agent_id, context.connection_id).await;
}
