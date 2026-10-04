use super::*;

pub(super) async fn take_pending_for_connection(
    context: &AgentContext, req_id: &str,
) -> Option<PendingResponse> {
    let inner = context.state.inner.read().await;
    if !inner.agents.is_current_connection(&context.agent_id, context.connection_id) {
        return None;
    }
    take_pending_locked(&inner, context, req_id).await
}

pub(super) async fn take_pending_locked(
    inner: &crate::state::AppStateInner, context: &AgentContext, req_id: &str,
) -> Option<PendingResponse> {
    let mut pending = inner.pending_responses.write().await;
    let matches = pending.get(req_id).is_some_and(|resp| {
        resp.agent_id == context.agent_id && resp.connection_id == context.connection_id
    });
    if matches { pending.remove(req_id) } else { None }
}
