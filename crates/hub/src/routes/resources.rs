use axum::extract::{Extension, Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use filebox_protocol::resources::{validate_pinned_path, DesiredResources, RootConfig};
use crate::agent_registry::AgentStatus;
use crate::agent_requests::PendingResponseCleanup;
use crate::state::{AppState, AuthenticatedSession, PendingResponse, MAX_PENDING_RESPONSES};
use super::hub_overloaded_response;

// ── Agents ───────────────────────────────────────────────────────────────────

pub(super) async fn agents_list_handler(State(state): State<AppState>) -> Json<serde_json::Value> {
    let inner = state.inner.read().await;
    let agents = inner.agents.list_all();
    Json(serde_json::to_value(&agents).unwrap_or_default())
}

pub(super) async fn agent_detail_handler(
    State(state): State<AppState>,
    Path(agent_id): Path<String>,
) -> Response {
    let inner = state.inner.read().await;
    match inner.agents.get(&agent_id) {
        Some(agent) => {
            Json(serde_json::to_value(&agent.to_info()).unwrap_or_default()).into_response()
        }
        None => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({
                "error": "not_found",
                "message": format!("Agent {} not found", agent_id),
                "retryable": false,
            })),
        )
            .into_response(),
    }
}

pub(super) async fn agent_resources_handler(
    State(state): State<AppState>,
    Path(agent_id): Path<String>,
) -> Response {
    let inner = state.inner.read().await;
    match inner.agents.get(&agent_id) {
        Some(agent) => {
            Json(serde_json::to_value(&agent.to_resource_revision()).unwrap_or_default())
                .into_response()
        }
        None => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({
                "error": "not_found",
                "message": format!("Agent {} not found", agent_id),
                "retryable": false,
            })),
        )
            .into_response(),
    }
}

pub(super) async fn agent_resources_put_handler(
    State(state): State<AppState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path(agent_id): Path<String>,
    Json(value): Json<serde_json::Value>,
) -> Response {
    let _resource_update_guard = state.lock_resource_update(&agent_id).await;
    // Parse to a Value first so we can detect whether each root EXPLICITLY
    // carried a pinned_folders key. Backward-compat: a legacy automation /
    // recovery script that omits the field must NOT wipe existing pins (the
    // struct's #[serde(default)] would otherwise turn a missing field into an
    // empty vec and clear them). Here we inherit the agent's current pins for
    // any root whose JSON object omits the key; an explicit `[]` still clears.
    let desired = match reconcile_put_pins(&state, &agent_id, value).await {
        Ok(d) => d,
        Err(resp) => return resp,
    };

    tracing::info!(
        target: "audit",
        session = %session.id,
        agent_id = %agent_id,
        roots = desired.roots.len(),
        "resources_put_requested"
    );
    apply_desired_state(state, agent_id, desired, session.principal_id).await
}

/// Reconcile a whole-state PUT body so that a root whose JSON object OMITS the
/// `pinned_folders` key inherits the agent's current pins for that root (by
/// name), while an explicit value (including `[]`) is honored as-is. This
/// preserves legacy clients that predate the field; without it, serde's default
/// would silently clear pins on every such PUT.
pub(super) async fn reconcile_put_pins(
    state: &AppState,
    agent_id: &str,
    mut value: serde_json::Value,
) -> Result<DesiredResources, Response> {
    // Snapshot existing pins by root name (for inheritance).
    let existing_pins: std::collections::HashMap<String, Vec<String>> = {
        let inner = state.inner.read().await;
        inner
            .agents
            .get(agent_id)
            .map(|a| {
                a.roots
                    .iter()
                    .map(|r| (r.name.clone(), r.pinned_folders.clone()))
                    .collect()
            })
            .unwrap_or_default()
    };

    if let Some(roots) = value.get_mut("roots").and_then(|r| r.as_array_mut()) {
        for root in roots.iter_mut() {
            let obj = match root.as_object_mut() {
                Some(o) => o,
                None => continue,
            };
            if obj.contains_key("pinned_folders") {
                continue; // explicit (incl. []) — honor it
            }
            // Missing key → inherit current pins for this root name, if any.
            if let Some(name) = obj.get("name").and_then(|n| n.as_str()) {
                if let Some(pins) = existing_pins.get(name) {
                    obj.insert(
                        "pinned_folders".to_string(),
                        serde_json::to_value(pins).unwrap_or(serde_json::Value::Array(vec![])),
                    );
                }
            }
        }
    }

    match serde_json::from_value::<DesiredResources>(value) {
        Ok(d) => Ok(d),
        Err(e) => Err((
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": "invalid_body",
                "message": format!("Invalid desired resources: {}", e),
                "retryable": false,
            })),
        )
            .into_response()),
    }
}

// ── Root Management ──────────────────────────────────────────────────────────

#[derive(serde::Deserialize)]
pub(super) struct AddRootRequest {
    name: String,
    path: String,
    enabled: Option<bool>,
}

pub(super) async fn add_root_handler(
    State(state): State<AppState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path(agent_id): Path<String>,
    Json(req): Json<AddRootRequest>,
) -> Response {
    // Validate root name
    if req.name.is_empty() || req.name.len() > 128 || req.name.contains('/') || req.name.contains('\\') || req.name.contains('\0') {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": "invalid_root_name",
                "message": "Root name must be non-empty, max 128 chars, and contain no slashes",
                "retryable": false,
            })),
        ).into_response();
    }

    // Validate path is not empty
    if req.path.is_empty() || req.path.len() > 4096 {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": "invalid_root_path",
                "message": "Root path must be non-empty and max 4096 chars",
                "retryable": false,
            })),
        ).into_response();
    }

    let _resource_update_guard = state.lock_resource_update(&agent_id).await;
    let inner = state.inner.read().await;
    let agent = match inner.agents.get(&agent_id) {
        Some(a) => a,
        None => {
            return (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({"error": "not_found", "message": "Agent not found", "retryable": false})),
            ).into_response();
        }
    };

    let mut roots = agent
        .pending_update
        .as_ref()
        .map(|pending| pending.roots.clone())
        .unwrap_or_else(|| agent.roots.clone());
    if roots.iter().any(|r| r.name == req.name) {
        return (
            StatusCode::CONFLICT,
            Json(serde_json::json!({
                "error": "resource_name_conflict",
                "message": format!("Root '{}' already exists", req.name),
                "retryable": false,
            })),
        )
            .into_response();
    }

    roots.push(RootConfig {
        name: req.name,
        path: req.path,
        enabled: req.enabled.unwrap_or(true),
        pinned_folders: vec![],
    });

    drop(inner);

    tracing::info!(
        target: "audit",
        session = %session.id,
        agent_id = %agent_id,
        root = %roots.last().map(|r| r.name.as_str()).unwrap_or(""),
        "root_add_requested"
    );

    apply_desired_state(state, agent_id, DesiredResources { roots }, session.principal_id).await
}

#[derive(serde::Deserialize)]
pub(super) struct PatchRootRequest {
    pub(super) enabled: Option<bool>,
    pub(super) name: Option<String>,
    pub(super) path: Option<String>,
    /// Replace the whole pinned-folders array (relative paths within the
    /// root). `None` = leave untouched; `Some(vec)` = set to exactly that.
    pub(super) pinned_folders: Option<Vec<String>>,
    /// Single-item delta: add this path to pinned_folders if absent. Mutually
    /// atomic with `pinned_folders` and `pin_remove`. The pin/unpin UI uses
    /// these instead of sending the whole array, so rapid clicks or two tabs
    /// editing the same root can't clobber each other (last-array-wins would).
    pub(super) pin_add: Option<String>,
    /// Single-item delta: remove this path from pinned_folders if present.
    pub(super) pin_remove: Option<String>,
}

pub(super) async fn patch_root_handler(
    State(state): State<AppState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path((agent_id, root_name)): Path<(String, String)>,
    Json(req): Json<PatchRootRequest>,
) -> Response {
    // Validate new name if being renamed
    if let Some(ref name) = req.name {
        if name.is_empty() || name.len() > 128 || name.contains('/') || name.contains('\\') || name.contains('\0') {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({
                    "error": "invalid_root_name",
                    "message": "Root name must be non-empty, max 128 chars, and contain no slashes",
                    "retryable": false,
                })),
            ).into_response();
        }
    }

    let _resource_update_guard = state.lock_resource_update(&agent_id).await;
    let inner = state.inner.read().await;
    let agent = match inner.agents.get(&agent_id) {
        Some(a) => a,
        None => {
            return (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({"error": "not_found", "message": "Agent not found", "retryable": false})),
            ).into_response();
        }
    };

    // Capability gate: a legacy agent that never advertises pinned_folders
    // would silently drop pin data (serde ignores the unknown field) and reply
    // "applied", fooling the hub + UI into thinking pins persisted. Rather than
    // let that happen, reject any PATCH that touches pinned_folders against such
    // an agent with a clear, retryable error. The user upgrades the agent and
    // retries. We treat an explicit `pinned_folders: []` (unpin-all) against a
    // legacy agent as a no-op success instead of an error — the agent already
    // has no pins, so there's nothing to lose, and erroring on an unpin is a
    // confusing UX. A delta (pin_add/pin_remove) is always a hard error though,
    // since it asserts the agent can persist the result.
    let req_touches_pins = req.pin_add.is_some()
        || req.pin_remove.is_some()
        || req.pinned_folders.as_ref().map_or(false, |v| !v.is_empty());
    if req_touches_pins && !agent.capabilities.pinned_folders {
        drop(inner);
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": "unsupported_feature",
                "message": "This agent version does not support pinned folders. Update the agent and retry.",
                "retryable": true,
            })),
        )
            .into_response();
    }

    // Base the patch on the pending desired state when one exists (offline
    // coalescing). Without this, two rapid offline pin_add calls would each
    // clone agent.roots (the LAST APPLIED state, which has no pins yet), apply
    // their single delta, and the second set_pending_update would overwrite the
    // first — losing the earlier pin. Basing off the pending roots makes the
    // deltas chain: pin /a → pending={/a}; pin /b → clone pending ({/a}), add
    // /b → pending={/a,/b}. Online path: pending is None, so we fall back to
    // agent.roots as before.
    let base_roots = agent
        .pending_update
        .as_ref()
        .map(|p| p.roots.clone())
        .unwrap_or_else(|| agent.roots.clone());
    let mut roots = base_roots;
    let root = match roots.iter_mut().find(|r| r.name == root_name) {
        Some(r) => r,
        None => {
            return (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({"error": "not_found", "message": format!("Root '{}' not found", root_name), "retryable": false})),
            ).into_response();
        }
    };

    if let Some(enabled) = req.enabled {
        root.enabled = enabled;
    }
    if let Some(name) = req.name {
        root.name = name;
    }
    if let Some(path) = req.path {
        root.path = path;
    }
    // Pinned folders. Three modes, processed in priority order:
    //   1. pin_add / pin_remove — single-item atomic deltas. The pin/unpin UI
    //      uses these so rapid clicks or two tabs editing the same root can't
    //      lose updates (the alternative — client computing the whole new
    //      array from a snapshot and us replacing it — is racy).
    //   2. pinned_folders — explicit whole-array replace (incl. [] to clear).
    // The delta and replace modes are mutually exclusive by convention; if both
    // are sent, deltas win (applied to the CURRENT server array, ignoring the
    // supplied whole-array value).
    if req.pin_add.is_some() || req.pin_remove.is_some() {
        if let Some(ref add) = req.pin_add {
            if let Err(e) = validate_pinned_path(add) {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({
                        "error": "invalid_pinned_path",
                        "message": format!("Invalid pinned folder path: {}", e),
                        "retryable": false,
                    })),
                )
                    .into_response();
            }
            if !root.pinned_folders.iter().any(|p| p == add) {
                root.pinned_folders.push(add.clone());
            }
        }
        if let Some(ref remove) = req.pin_remove {
            // Validate shape for a clean 400 even on remove (defensive).
            if let Err(e) = validate_pinned_path(remove) {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({
                        "error": "invalid_pinned_path",
                        "message": format!("Invalid pinned folder path: {}", e),
                        "retryable": false,
                    })),
                )
                    .into_response();
            }
            root.pinned_folders.retain(|p| p != remove);
        }
    } else if let Some(ref pins) = req.pinned_folders {
        // Replace-whole-array. Validate shape before mutating so a bad pin
        // rejects cleanly (the agent would re-validate anyway, but failing
        // here gives a synchronous 400 instead of an async rejected-config
        // round trip). Empty vec is a valid "unpin everything" value.
        for p in pins {
            if let Err(e) = validate_pinned_path(p) {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({
                        "error": "invalid_pinned_path",
                        "message": format!("Invalid pinned folder path: {}", e),
                        "retryable": false,
                    })),
                )
                    .into_response();
            }
        }
        root.pinned_folders = pins.clone();
    }

    drop(inner);

    tracing::info!(
        target: "audit",
        session = %session.id,
        agent_id = %agent_id,
        root = %root_name,
        "root_patch_requested"
    );

    apply_desired_state(state, agent_id, DesiredResources { roots }, session.principal_id).await
}

pub(super) async fn delete_root_handler(
    State(state): State<AppState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path((agent_id, root_name)): Path<(String, String)>,
) -> Response {
    let _resource_update_guard = state.lock_resource_update(&agent_id).await;
    let inner = state.inner.read().await;
    let agent = match inner.agents.get(&agent_id) {
        Some(a) => a,
        None => {
            return (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({"error": "not_found", "message": "Agent not found", "retryable": false})),
            ).into_response();
        }
    };

    let base_roots = agent
        .pending_update
        .as_ref()
        .map(|pending| pending.roots.clone())
        .unwrap_or_else(|| agent.roots.clone());
    let roots: Vec<RootConfig> = base_roots
        .iter()
        .filter(|r| r.name != root_name)
        .cloned()
        .collect();
    if roots.len() == base_roots.len() {
        return (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"error": "not_found", "message": format!("Root '{}' not found", root_name), "retryable": false})),
        ).into_response();
    }

    drop(inner);

    tracing::info!(
        target: "audit",
        session = %session.id,
        agent_id = %agent_id,
        root = %root_name,
        "root_delete_requested"
    );

    apply_desired_state(state, agent_id, DesiredResources { roots }, session.principal_id).await
}

// ── Helper ───────────────────────────────────────────────────────────────────

pub(super) async fn apply_desired_state(
    state: AppState,
    agent_id: String,
    desired: DesiredResources,
    session_id: String,
) -> Response {
    let mut inner = state.inner.write().await;
    let agent = match inner.agents.get(&agent_id) {
        Some(a) => a,
        None => {
            return (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({"error": "not_found", "message": "Agent not found", "retryable": false})),
            )
                .into_response();
        }
    };

    if agent.status == AgentStatus::Offline {
        // Capability gate for the offline path: a legacy agent (no
        // pinned_folders capability) would never persist pin data, so queuing a
        // pending update that carries pins is a lie — on reconnect the hub
        // strips the pins before pushing, but then the registry mirror still
        // holds them and the agent never does, so the UI shows pins that aren't
        // real. Reject up front instead. (patch_root already gates this for the
        // common pin flow; this catches PUT /resources and any future caller.)
        if !agent.capabilities.pinned_folders
            && desired.roots.iter().any(|r| !r.pinned_folders.is_empty())
        {
            drop(inner);
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({
                    "error": "unsupported_feature",
                    "message": "This agent version does not support pinned folders. Update the agent and retry.",
                    "retryable": true,
                })),
            )
                .into_response();
        }
        drop(inner);
        let mut inner = state.inner.write().await;
        inner.agents.set_pending_update(&agent_id, desired);
        return Json(serde_json::json!({
            "ok": true,
            "state": "pending_agent_reconnect",
            "message": "Agent is offline. This change will be applied after it reconnects.",
        }))
        .into_response();
    }

    let next_revision = match agent.resource_revision.checked_add(1) {
        Some(revision) => revision,
        None => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({
                    "error": "revision_overflow",
                    "message": "Resource revision overflow",
                    "retryable": false,
                })),
            )
                .into_response();
        }
    };
    let req_id = format!("res_{}", uuid::Uuid::new_v4());

    // Hub mirror of the desired set (including pins). Wired to the agent
    // after stripping pins for legacy agents; the WS Applied handler merges
    // this with agent-expanded paths so `~/…` does not stick in the registry.
    let desired_roots = desired.roots.clone();

    // Rolling-upgrade safety: if this agent doesn't advertise the
    // pinned_folders capability, strip pins from what we send over the wire so
    // a legacy agent can't reply "applied" while silently dropping pin data.
    // The hub's own mirror (desired_roots, reconciled on Applied) keeps the
    // real pins; they re-apply once the agent is upgraded.
    let agent_supports_pins = agent.capabilities.pinned_folders;
    let wire_roots = if agent_supports_pins {
        desired.roots
    } else {
        tracing::warn!(
            "Agent {} does not advertise pinned_folders capability; stripping pin data from ResourcesSetDesired",
            agent_id
        );
        desired
            .roots
            .into_iter()
            .map(|mut r| {
                r.pinned_folders.clear();
                r
            })
            .collect::<Vec<_>>()
    };

    let msg = filebox_protocol::message::HubMessage::ResourcesSetDesired {
        req_id: req_id.clone(),
        desired_revision: next_revision,
        roots: wire_roots,
    };

    let (resp_tx, mut resp_rx, response_owner) = crate::agent_requests::response_channel();
    let connection_id = agent.connection_id;
    {
        let mut pending = inner.pending_responses.write().await;
        if pending.len() >= MAX_PENDING_RESPONSES {
            drop(pending);
            drop(inner);
            return hub_overloaded_response();
        }
        pending.insert(
            req_id.clone(),
            PendingResponse {
                tx: resp_tx,
                agent_id: agent_id.clone(),
                connection_id,
                session_id: Some(session_id),
                desired_roots: Some(desired_roots.clone()),
                desired_collections: None,
            },
        );
    }

    if !inner.agents.send_to_agent(&agent_id, msg) {
        // P1 fix: the timeout-cleanup below is unreachable via this early
        // return, so we must drop the pending_responses entry here too —
        // otherwise a half-dead connection on every pin/unpin would leak an
        // entry forever (the map is unbounded).
        {
            let mut pending = inner.pending_responses.write().await;
            pending.remove(&req_id);
        }
        drop(inner);
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({
                "error": "backend_offline",
                "message": "Failed to send update to agent",
                "retryable": true,
            })),
        )
            .into_response();
    }

    // Keep the latest accepted intent until its matching acknowledgement.
    // A browser timeout or an older reply must not erase a newer edit.
    inner.agents.set_pending_update(&agent_id, DesiredResources { roots: desired_roots });
    inner.agents.get_mut(&agent_id).expect("Agent resolved under this lock").pending_resource_request = Some(req_id.clone());

    drop(inner);

    let cleanup = PendingResponseCleanup::new(state.clone(), req_id.clone(), None, response_owner);
    let resp = tokio::time::timeout(std::time::Duration::from_secs(30), resp_rx.recv()).await;

    cleanup.finish(false).await;

    match resp {
        Ok(Some(value)) => {
            // On "applied", the WS handler already updated the registry from
            // ResourcesUpdated + ResourcesApplied (agent-expanded paths,
            // reconciled pins). Re-applying `desired_roots` here would clobber
            // absolute paths back to pre-expansion forms such as `~/docs`.
            // On "rejected", store the config error (WS may also have set it).
            Json(value).into_response()
        }
        _ => (
            StatusCode::GATEWAY_TIMEOUT,
            Json(serde_json::json!({
                "error": "request_timeout",
                "message": "Agent did not respond in time",
                "retryable": true,
            })),
        )
            .into_response(),
    }
}
