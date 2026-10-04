use filebox_protocol::message::HubMessage;
use axum::extract::{Extension, Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use filebox_protocol::resources::{validate_collection_item_path, validate_collection_name, CollectionConfig, CollectionItem, DesiredCollections};
use crate::agent_registry::AgentStatus;
use crate::agent_requests::PendingResponseCleanup;
use crate::state::{AppState, AuthenticatedSession, PendingResponse, MAX_PENDING_RESPONSES};
use super::hub_overloaded_response;

#[derive(serde::Deserialize)]
pub(super) struct AddCollectionRequest {
    name: String,
    /// Optional initial item so create+add is a single atomic desired-state rewrite.
    #[serde(default)]
    item: Option<CollectionItem>,
}

pub(super) async fn add_collection_handler(
    State(state): State<AppState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path(agent_id): Path<String>,
    Json(req): Json<AddCollectionRequest>,
) -> Response {
    if let Err(e) = validate_collection_name(&req.name) {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": "invalid_collection_name",
                "message": e,
                "retryable": false,
            })),
        )
            .into_response();
    }

    let mut initial_items = Vec::new();
    if let Some(ref add) = req.item {
        if let Err(e) = validate_collection_item_path(&add.path) {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({
                    "error": "invalid_collection_path",
                    "message": e,
                    "retryable": false,
                })),
            )
                .into_response();
        }
        if add.root.is_empty() {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({
                    "error": "invalid_collection_path",
                    "message": "item root name cannot be empty",
                    "retryable": false,
                })),
            )
                .into_response();
        }
        initial_items.push(CollectionItem {
            root: add.root.clone(),
            path: normalize_collection_path(&add.path),
            label: add.label.clone(),
        });
    }

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

    if !agent.capabilities.collections {
        drop(inner);
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": "unsupported_feature",
                "message": "This agent version does not support collections. Update the agent and retry.",
                "retryable": true,
            })),
        )
            .into_response();
    }

    // Conflict against the effective desired set (pending rewrite wins over applied).
    let base_collections = agent
        .pending_collections_update
        .as_ref()
        .map(|p| p.collections.clone())
        .unwrap_or_else(|| agent.collections.clone());
    if base_collections.iter().any(|c| c.name == req.name) {
        drop(inner);
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": "collection_name_conflict",
                "message": format!("Collection '{}' already exists", req.name),
                "retryable": false,
            })),
        )
            .into_response();
    }

    let mut collections = base_collections;
    collections.push(CollectionConfig {
        name: req.name.clone(),
        items: initial_items,
    });
    drop(inner);

    tracing::info!(
        target: "audit",
        session = %session.id,
        agent_id = %agent_id,
        collection = %req.name,
        "collection_create_requested"
    );

    apply_collections_state(
        state,
        agent_id,
        DesiredCollections { collections },
        session.principal_id,
    )
    .await
}

#[derive(serde::Deserialize)]
pub(super) struct PatchCollectionRequest {
    rename: Option<String>,
    item_add: Option<CollectionItem>,
    item_remove: Option<CollectionItemRef>,
    items: Option<Vec<CollectionItem>>,
}

#[derive(serde::Deserialize)]
pub(super) struct CollectionItemRef {
    root: String,
    path: String,
}

pub(super) fn normalize_collection_path(p: &str) -> String {
    let mut s = p.to_string();
    if !s.starts_with('/') {
        s = format!("/{s}");
    }
    if s.len() > 1 && s.ends_with('/') {
        s = s.trim_end_matches('/').to_string();
    }
    s
}

pub(super) async fn patch_collection_handler(
    State(state): State<AppState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path((agent_id, collection_name)): Path<(String, String)>,
    Json(req): Json<PatchCollectionRequest>,
) -> Response {
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

    if !agent.capabilities.collections {
        drop(inner);
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": "unsupported_feature",
                "message": "This agent version does not support collections. Update the agent and retry.",
                "retryable": true,
            })),
        )
            .into_response();
    }

    let base_collections = agent
        .pending_collections_update
        .as_ref()
        .map(|p| p.collections.clone())
        .unwrap_or_else(|| agent.collections.clone());
    let mut collections = base_collections;
    let coll_idx = match collections.iter().position(|c| c.name == collection_name) {
        Some(i) => i,
        None => {
            return (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({
                    "error": "not_found",
                    "message": format!("Collection '{}' not found", collection_name),
                    "retryable": false,
                })),
            ).into_response();
        }
    };

    if let Some(ref new_name) = req.rename {
        if let Err(e) = validate_collection_name(new_name) {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({
                    "error": "invalid_collection_name",
                    "message": e,
                    "retryable": false,
                })),
            )
                .into_response();
        }
        if new_name != &collection_name && collections.iter().any(|c| c.name == *new_name) {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({
                    "error": "collection_name_conflict",
                    "message": format!("Collection '{}' already exists", new_name),
                    "retryable": false,
                })),
            )
                .into_response();
        }
        collections[coll_idx].name = new_name.clone();
    }

    let coll = &mut collections[coll_idx];

    if req.item_add.is_some() || req.item_remove.is_some() {
        if let Some(ref add) = req.item_add {
            if let Err(e) = validate_collection_item_path(&add.path) {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({
                        "error": "invalid_collection_path",
                        "message": e,
                        "retryable": false,
                    })),
                )
                    .into_response();
            }
            let norm_path = normalize_collection_path(&add.path);
            if !coll.items.iter().any(|i| i.root == add.root && normalize_collection_path(&i.path) == norm_path) {
                coll.items.push(CollectionItem {
                    root: add.root.clone(),
                    path: norm_path,
                    label: add.label.clone(),
                });
            }
        }
        if let Some(ref remove) = req.item_remove {
            if let Err(e) = validate_collection_item_path(&remove.path) {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({
                        "error": "invalid_collection_path",
                        "message": e,
                        "retryable": false,
                    })),
                )
                    .into_response();
            }
            let norm_path = normalize_collection_path(&remove.path);
            coll.items.retain(|i| !(i.root == remove.root && normalize_collection_path(&i.path) == norm_path));
        }
    } else if let Some(ref items) = req.items {
        for item in items {
            if let Err(e) = validate_collection_item_path(&item.path) {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({
                        "error": "invalid_collection_path",
                        "message": e,
                        "retryable": false,
                    })),
                )
                    .into_response();
            }
        }
        coll.items = items
            .iter()
            .map(|item| CollectionItem {
                root: item.root.clone(),
                path: normalize_collection_path(&item.path),
                label: item.label.clone(),
            })
            .collect();
    }

    drop(inner);

    tracing::info!(
        target: "audit",
        session = %session.id,
        agent_id = %agent_id,
        collection = %collection_name,
        "collection_patch_requested"
    );

    apply_collections_state(
        state,
        agent_id,
        DesiredCollections { collections },
        session.principal_id,
    )
    .await
}

pub(super) async fn delete_collection_handler(
    State(state): State<AppState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path((agent_id, collection_name)): Path<(String, String)>,
) -> Response {
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

    if !agent.capabilities.collections {
        drop(inner);
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": "unsupported_feature",
                "message": "This agent version does not support collections. Update the agent and retry.",
                "retryable": true,
            })),
        )
            .into_response();
    }

    let base_collections = agent
        .pending_collections_update
        .as_ref()
        .map(|p| p.collections.clone())
        .unwrap_or_else(|| agent.collections.clone());
    let base_len = base_collections.len();
    let collections: Vec<CollectionConfig> = base_collections
        .into_iter()
        .filter(|c| c.name != collection_name)
        .collect();
    if collections.len() == base_len {
        return (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({
                "error": "not_found",
                "message": format!("Collection '{}' not found", collection_name),
                "retryable": false,
            })),
        )
            .into_response();
    }

    drop(inner);

    tracing::info!(
        target: "audit",
        session = %session.id,
        agent_id = %agent_id,
        collection = %collection_name,
        "collection_delete_requested"
    );

    apply_collections_state(
        state,
        agent_id,
        DesiredCollections { collections },
        session.principal_id,
    )
    .await
}

pub(super) async fn apply_collections_state(
    state: AppState,
    agent_id: String,
    desired: DesiredCollections,
    session_id: String,
) -> Response {
    let _collection_update_guard = state.lock_resource_update(&agent_id).await;
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
        if !agent.capabilities.collections && !desired.collections.is_empty() {
            drop(inner);
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({
                    "error": "unsupported_feature",
                    "message": "This agent version does not support collections. Update the agent and retry.",
                    "retryable": true,
                })),
            )
                .into_response();
        }
        drop(inner);
        let mut inner = state.inner.write().await;
        inner.agents.set_pending_collections_update(&agent_id, desired);
        return Json(serde_json::json!({
            "ok": true,
            "state": "pending_agent_reconnect",
            "message": "Agent is offline. This change will be applied after it reconnects.",
        }))
        .into_response();
    }

    if !agent.capabilities.collections {
        drop(inner);
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": "unsupported_feature",
                "message": "This agent version does not support collections. Update the agent and retry.",
                "retryable": true,
            })),
        )
            .into_response();
    }

    let next_revision = match agent.collections_revision.checked_add(1) {
        Some(revision) => revision,
        None => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({
                    "error": "revision_overflow",
                    "message": "Collections revision overflow",
                    "retryable": false,
                })),
            )
                .into_response();
        }
    };
    let req_id = format!("col_{}", uuid::Uuid::new_v4());
    let desired_collections = desired.collections.clone();

    let msg = HubMessage::CollectionsSetDesired {
        req_id: req_id.clone(),
        desired_revision: next_revision,
        collections: desired.collections,
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
                desired_roots: None,
                desired_collections: Some(desired_collections.clone()),
            },
        );
    }

    if !inner.agents.send_to_agent(&agent_id, msg) {
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
    inner.agents.set_pending_collections_update(&agent_id, DesiredCollections { collections: desired_collections });
    inner.agents.get_mut(&agent_id).expect("Agent resolved under this lock").pending_collection_request = Some(req_id.clone());

    drop(inner);

    let cleanup = PendingResponseCleanup::new(state.clone(), req_id.clone(), None, response_owner);
    let resp = tokio::time::timeout(std::time::Duration::from_secs(30), resp_rx.recv()).await;

    cleanup.finish(false).await;

    match resp {
        Ok(Some(value)) => {
            Json(value).into_response()
        }
        _ => (
            StatusCode::GATEWAY_TIMEOUT,
            Json(serde_json::json!({
                "error": "request_timeout",
                "message": "Timed out waiting for agent to apply collection change",
                "retryable": true,
            })),
        )
            .into_response(),
    }
}
