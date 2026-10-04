use super::*;

/// After a successful apply, prefer hub `desired` for the root set (names,
/// enabled, pins — the hub may retain pins a legacy agent stripped on the
/// wire) but keep **paths** from the agent-reported snapshot when the name
/// matches. That snapshot is installed by `ResourcesUpdated` just before
/// `ResourcesApplied` and includes agent-side expansions such as `~/…`.
pub(super) fn reconcile_roots_after_apply(
    desired: Vec<filebox_protocol::resources::RootConfig>,
    agent_reported: &[filebox_protocol::resources::RootConfig],
) -> Vec<filebox_protocol::resources::RootConfig> {
    desired
        .into_iter()
        .map(|mut root| {
            if let Some(reported) = agent_reported.iter().find(|r| r.name == root.name) {
                root.path = reported.path.clone();
            }
            root
        })
        .collect()
}

/// Return a copy of `roots` with every root's `pinned_folders` emptied. Used
/// when pushing `ResourcesSetDesired` to an agent that doesn't advertise the
/// `pinned_folders` capability (rolling upgrade): the old agent would silently
/// drop the field and reply `applied`, fooling the hub into thinking pins were
/// persisted when they weren't. The hub's own mirror keeps the real pins; this
/// only controls what we send over the wire to a legacy agent.
pub(super) fn strip_pinned_folders(roots: &[filebox_protocol::resources::RootConfig]) -> Vec<filebox_protocol::resources::RootConfig> {
    roots
        .iter()
        .map(|r| {
            let mut r = r.clone();
            r.pinned_folders.clear();
            r
        })
        .collect()
}

pub(super) async fn dispatch(context: &AgentContext, message: AgentMessage) {
    let mut inner = context.state.inner.write().await;
    let id = &context.agent_id;
    if !inner.agents.is_current_connection(id, context.connection_id) {
        return;
    }
    // Mutation, final response and SSE publication are ordered under the same
    // generation lock. A superseded socket cannot announce a newer Agent's state.
    match message {
        AgentMessage::ResourcesApplied { req_id, resource_revision, .. } => {
            let pending = responses::take_pending_locked(&inner, context, &req_id).await;
            let agent = inner.agents.get(id).expect("current generation checked");
            let owns_queued = agent.pending_resource_request.as_deref() == Some(req_id.as_str());
            let queued = (!owns_queued).then(|| (agent.pending_update.clone(), agent.pending_resource_request.clone()));
            let desired = pending.as_ref().and_then(|p| p.desired_roots.clone())
                .or_else(|| owns_queued.then(|| agent.pending_update.as_ref().map(|p| p.roots.clone())).flatten());
            let roots = desired.map(|d| reconcile_roots_after_apply(d, &agent.roots))
                .unwrap_or_else(|| agent.roots.clone());
            inner.agents.update_resources_for_connection(id, context.connection_id, resource_revision, roots);
            if let Some((queued, request)) = queued {
                let agent = inner.agents.get_mut(id).expect("current generation checked");
                agent.pending_update = queued;
                agent.pending_resource_request = request;
            }
            if let Some(pending) = pending {
                pending.deliver(serde_json::json!({
                    "ok": true, "state": "applied", "resource_revision": resource_revision,
                }));
            }
            AppState::emit_sse_locked(&inner, "resources_updated", serde_json::json!({
                "agent_id": id, "resource_revision": resource_revision, "state": "applied",
            })).await;
        }
        AgentMessage::CollectionsApplied { req_id, collections_revision, .. } => {
            let pending = responses::take_pending_locked(&inner, context, &req_id).await;
            let agent = inner.agents.get(id).expect("current generation checked");
            let owns_queued = agent.pending_collection_request.as_deref() == Some(req_id.as_str());
            let queued = (!owns_queued).then(|| (agent.pending_collections_update.clone(), agent.pending_collection_request.clone()));
            let collections = pending.as_ref().and_then(|p| p.desired_collections.clone())
                .or_else(|| owns_queued.then(|| agent.pending_collections_update.as_ref().map(|p| p.collections.clone())).flatten())
                .unwrap_or_else(|| agent.collections.clone());
            inner.agents.update_collections_for_connection(id, context.connection_id, collections_revision, collections);
            if let Some((queued, request)) = queued {
                let agent = inner.agents.get_mut(id).expect("current generation checked");
                agent.pending_collections_update = queued;
                agent.pending_collection_request = request;
            }
            if let Some(pending) = pending {
                pending.deliver(serde_json::json!({
                    "ok": true, "state": "applied", "collections_revision": collections_revision,
                }));
            }
            AppState::emit_sse_locked(&inner, "collections_updated", serde_json::json!({
                "agent_id": id, "collections_revision": collections_revision, "state": "applied",
            })).await;
        }
        AgentMessage::ResourcesRejected { req_id, error, message, .. } => {
            reject(&mut inner, context, &req_id, error, message, false).await;
        }
        AgentMessage::CollectionsRejected { req_id, error, message, .. } => {
            reject(&mut inner, context, &req_id, error, message, true).await;
        }
        AgentMessage::ResourcesUpdated { resource_revision, roots, .. } => {
            let agent = inner.agents.get(id).expect("current generation checked");
            let pending = agent.pending_update.clone();
            let request = agent.pending_resource_request.clone();
            inner.agents.update_resources_for_connection(id, context.connection_id, resource_revision, roots);
            let agent = inner.agents.get_mut(id).expect("current generation checked");
            agent.pending_update = pending;
            agent.pending_resource_request = request;
            AppState::emit_sse_locked(&inner, "resources_updated", serde_json::json!({
                "agent_id": id, "resource_revision": resource_revision, "state": "applied",
            })).await;
        }
        AgentMessage::CollectionsUpdated { collections_revision, collections, .. } => {
            let agent = inner.agents.get(id).expect("current generation checked");
            let pending = agent.pending_collections_update.clone();
            let request = agent.pending_collection_request.clone();
            inner.agents.update_collections_for_connection(id, context.connection_id, collections_revision, collections);
            let agent = inner.agents.get_mut(id).expect("current generation checked");
            agent.pending_collections_update = pending;
            agent.pending_collection_request = request;
            AppState::emit_sse_locked(&inner, "collections_updated", serde_json::json!({
                "agent_id": id, "collections_revision": collections_revision, "state": "applied",
            })).await;
        }
        _ => unreachable!("only resource and collection messages are dispatched here"),
    }
}

async fn reject(
    inner: &mut crate::state::AppStateInner, context: &AgentContext, req_id: &str,
    error: String, message: String, collections: bool,
) {
    let pending = responses::take_pending_locked(inner, context, req_id).await;
    let detail = if message.is_empty() { error.clone() } else { message.clone() };
    let agent = inner.agents.get_mut(&context.agent_id).expect("current generation checked");
    if collections {
        if agent.pending_collection_request.as_deref() == Some(req_id) {
            inner.agents.reject_pending_collections_update(&context.agent_id, detail.clone());
        }
    } else if agent.pending_resource_request.as_deref() == Some(req_id) {
        agent.pending_update = None;
        agent.pending_resource_request = None;
    }
    inner.agents.set_config_error(&context.agent_id, detail);
    if let Some(pending) = pending {
        pending.deliver(serde_json::json!({
            "ok": false, "state": "rejected", "error": error, "message": message,
        }));
    }
    AppState::emit_sse_locked(inner,
        if collections { "collections_updated" } else { "resources_updated" },
        serde_json::json!({ "agent_id": context.agent_id, "state": "rejected" }),
    ).await;
}
