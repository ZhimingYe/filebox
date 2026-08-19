//! Browser → Hub → Agent temp-folder uploads and one-click cleanup.
//!
//! The hub is a pure relay with its own limits: it validates the file name,
//! requires an exact `Content-Length`, caps the body at
//! [`TEMP_UPLOAD_MAX_BODY_BYTES`], bounds concurrent uploads with a semaphore,
//! streams the body to the agent in [`FILE_CHUNK_MAX_BYTES`] chunks over the
//! existing WS channel, and cancels the agent-side session when the HTTP
//! client goes away. The agent remains the authority on what gets written
//! where — the hub never touches a filesystem.

use std::time::Duration;

use axum::body::Body;
use axum::extract::{Extension, Path, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use futures_util::StreamExt;
use serde::Deserialize;
use tokio::sync::mpsc;
use uuid::Uuid;

use filebox_protocol::message::{HubMessage, FILE_CHUNK_MAX_BYTES};
use filebox_protocol::temp::validate_upload_name;

use crate::state::{AppState, AuthenticatedSession, PendingResponse, MAX_PENDING_RESPONSES};

/// Hub-side hard cap on an upload request body. The agent may advertise a
/// smaller per-file cap; the effective limit is the minimum of the two.
pub const TEMP_UPLOAD_MAX_BODY_BYTES: usize = 64 * 1024 * 1024;

/// Wall-clock budget for the agent to acknowledge a full upload. Generous for
/// slow links (the body itself already streamed).
const TEMP_UPLOAD_TIMEOUT: Duration = Duration::from_secs(120);
/// Wall-clock budget for the request BODY to arrive/stream. A stalled client
/// must not hold a permit, a pending slot, and an agent staging session
/// forever. Above the frontend XHR timeout (130s) is irrelevant — the client
/// aborts first and the abort path cancels the agent session.
const TEMP_UPLOAD_BODY_TIMEOUT: Duration = Duration::from_secs(150);
/// Wall-clock budget for a cleanup round-trip.
const TEMP_CLEANUP_TIMEOUT: Duration = Duration::from_secs(60);
/// How long to wait for an upload permit under load before failing.
const TEMP_PERMIT_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Deserialize)]
pub struct TempUploadParams {
    pub name: String,
}

/// Sends Cancel to the agent and clears pending when the HTTP waiter goes
/// away (client abort / timeout) so the agent does not keep a staging file.
struct CancelOnDrop {
    state: AppState,
    agent_id: String,
    req_id: String,
    armed: bool,
}

impl CancelOnDrop {
    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let state = self.state.clone();
        let agent_id = self.agent_id.clone();
        let req_id = self.req_id.clone();
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn(async move {
                let inner = state.inner.read().await;
                let _ = inner.agents.send_to_agent(
                    &agent_id,
                    HubMessage::Cancel {
                        req_id: req_id.clone(),
                    },
                );
                drop(inner);
                let pending = state.inner.read().await.pending_responses.clone();
                let mut map = pending.write().await;
                map.remove(&req_id);
            });
        }
    }
}

/// Look up a live, temp-capable agent. Returns `(connection_id,
/// max_file_bytes, max_total_bytes)` or an error response.
async fn resolve_temp_agent(
    state: &AppState,
    agent_id: &str,
) -> Result<(u64, u64, u64), Response> {
    let inner = state.inner.read().await;
    let Some(agent) = inner.agents.get(agent_id) else {
        return Err(error_response(
            StatusCode::NOT_FOUND,
            "backend_offline",
            &format!("Agent {} not found or offline", agent_id),
            true,
        ));
    };
    if agent.status == crate::agent_registry::AgentStatus::Offline {
        return Err(error_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "backend_offline",
            &format!("Agent {} is offline", agent_id),
            true,
        ));
    }
    if !agent.capabilities.temp_upload {
        return Err(error_response(
            StatusCode::NOT_IMPLEMENTED,
            "unsupported_feature",
            "This agent does not support the temp upload folder — upgrade the agent",
            false,
        ));
    }
    let Some(temp) = &agent.temp_root else {
        return Err(error_response(
            StatusCode::NOT_IMPLEMENTED,
            "unsupported_feature",
            "This agent did not advertise a temp upload folder",
            false,
        ));
    };
    // A user root with the same name shadows the temp folder: reads of that
    // name resolve to the user root, so an accepted upload would be
    // unbrowseable. The UI hides the Transfer view in this state
    // (`temp_root_name` is null) — the endpoint must refuse too.
    if agent.roots.iter().any(|r| r.name == temp.name) {
        return Err(error_response(
            StatusCode::NOT_IMPLEMENTED,
            "unsupported_feature",
            "A configured root shadows the temp upload folder name",
            false,
        ));
    }
    let max_file_bytes = temp.max_file_bytes.min(TEMP_UPLOAD_MAX_BODY_BYTES as u64);
    Ok((agent.connection_id, max_file_bytes, temp.max_total_bytes))
}

pub async fn temp_upload_handler(
    State(state): State<AppState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path(agent_id): Path<String>,
    Query(params): Query<TempUploadParams>,
    headers: HeaderMap,
    body: Body,
) -> Response {
    // Name shape is validated on both sides; the agent re-validates anyway.
    let name = match validate_upload_name(&params.name) {
        Ok(name) => name,
        Err(_) => {
            return error_response(
                StatusCode::BAD_REQUEST,
                "temp_name_invalid",
                "Upload file name must be a single, non-empty path component",
                false,
            )
        }
    };

    let (connection_id, max_file_bytes, max_total_bytes) =
        match resolve_temp_agent(&state, &agent_id).await {
            Ok(v) => v,
            Err(resp) => return resp,
        };

    // A browser fetch/XHR with a Blob body always sends Content-Length; the
    // protocol needs the total up front, so require it instead of guessing.
    let total_size = match content_length(&headers) {
        Some(len) if len <= max_file_bytes => len,
        Some(_) => {
            return error_response(
                StatusCode::PAYLOAD_TOO_LARGE,
                "temp_file_too_large",
                &format!("Uploads are limited to {} bytes", max_file_bytes),
                false,
            )
        }
        None => {
            return error_response(
                StatusCode::LENGTH_REQUIRED,
                "temp_length_required",
                "Content-Length is required for temp uploads",
                false,
            )
        }
    };

    // Fast-fail when this upload alone exceeds the advertised folder quota
    // (the agent re-checks the live total; this just spares the client from
    // relaying a body that cannot fit).
    if total_size > max_total_bytes {
        return error_response(
            StatusCode::INSUFFICIENT_STORAGE,
            "temp_quota_exceeded",
            "The temp folder is full. Clean it up and retry.",
            false,
        );
    }

    let _permit = match tokio::time::timeout(
        TEMP_PERMIT_TIMEOUT,
        state.temp_upload_semaphore.clone().acquire_owned(),
    )
    .await
    {
        Ok(Ok(permit)) => permit,
        _ => {
            return error_response(
                StatusCode::SERVICE_UNAVAILABLE,
                "hub_overloaded",
                "Too many concurrent uploads. Please retry shortly.",
                true,
            )
        }
    };

    let req_id = format!("temp_up_{}", Uuid::new_v4());
    let (resp_tx, mut resp_rx) = mpsc::channel(1);
    let send_ok = {
        let inner = state.inner.read().await;
        let mut pending = inner.pending_responses.write().await;
        if pending.len() >= MAX_PENDING_RESPONSES {
            false
        } else {
            pending.insert(
                req_id.clone(),
                PendingResponse {
                    tx: resp_tx,
                    agent_id: agent_id.clone(),
                    connection_id,
                    session_id: Some(session.principal_id.clone()),
                    desired_roots: None,
                    desired_collections: None,
                },
            );
            inner.agents.send_to_agent(
                &agent_id,
                HubMessage::TempUploadBegin {
                    req_id: req_id.clone(),
                    name: name.clone(),
                    total_size,
                },
            )
        }
    };
    if !send_ok {
        cleanup_pending(&state, &req_id).await;
        return error_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "backend_offline",
            "Failed to send request to agent",
            true,
        );
    }

    let mut guard = CancelOnDrop {
        state: state.clone(),
        agent_id: agent_id.clone(),
        req_id: req_id.clone(),
        armed: true,
    };

    // Stream the body to the agent in bounded chunks. Any failure cancels the
    // agent-side session (the guard stays armed through the failure return).
    // The whole streaming phase runs under a wall-clock budget so a stalled
    // client cannot hold the permit / pending slot / agent session forever.
    let stream_result = tokio::time::timeout(
        TEMP_UPLOAD_BODY_TIMEOUT,
        stream_upload_body(
            &state,
            &agent_id,
            &req_id,
            body,
            max_file_bytes,
            &mut resp_rx,
        ),
    )
    .await;

    let (received, buffer) = match stream_result {
        Ok(Ok(ok)) => ok,
        Ok(Err(response)) => {
            cleanup_pending(&state, &req_id).await;
            return response;
        }
        Err(_) => {
            // Body stalled past the budget: cancel the agent session.
            cleanup_pending(&state, &req_id).await;
            return error_response(
                StatusCode::REQUEST_TIMEOUT,
                "request_timeout",
                "The upload stalled before the body completed",
                true,
            );
        }
    };

    if received != total_size {
        // Client aborted early or lied about Content-Length.
        cleanup_pending(&state, &req_id).await;
        return error_response(
            StatusCode::BAD_REQUEST,
            "temp_upload_incomplete",
            "Upload body ended before the declared length",
            false,
        );
    }

    // Final chunk (may be empty for zero-byte files or exact block multiples).
    let final_offset = received - buffer.len() as u64;
    let ok = send_to_agent_await(
        &state,
        &agent_id,
        HubMessage::TempUploadChunk {
            req_id: req_id.clone(),
            offset: final_offset,
            data: buffer,
            done: true,
        },
    )
    .await;
    if !ok {
        cleanup_pending(&state, &req_id).await;
        return error_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "backend_offline",
            "Agent went away mid-upload",
            true,
        );
    }

    let resp = tokio::time::timeout(TEMP_UPLOAD_TIMEOUT, resp_rx.recv()).await;
    cleanup_pending(&state, &req_id).await;

    match resp {
        Ok(Some(value)) => {
            guard.disarm();
            let raw_error = value.get("error").and_then(|v| v.as_str());
            if raw_error == Some("cancelled") {
                return error_response(
                    StatusCode::BAD_REQUEST,
                    "cancelled",
                    "Upload cancelled",
                    false,
                );
            }
            if let Some(error) = raw_error {
                return temp_error_response(error);
            }
            state
                .emit_sse(
                    "temp_updated",
                    serde_json::json!({ "agent_id": agent_id }),
                )
                .await;
            Json(serde_json::json!({
                "ok": true,
                "name": value["name"],
                "size": value["size"],
            }))
            .into_response()
        }
        _ => {
            // Guard stays armed: Drop sends Cancel to abort the staging file.
            error_response(
                StatusCode::GATEWAY_TIMEOUT,
                "request_timeout",
                "Agent did not respond in time",
                true,
            )
        }
    }
}

pub async fn temp_cleanup_handler(
    State(state): State<AppState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path(agent_id): Path<String>,
) -> Response {
    let (connection_id, _max_file, _max_total) =
        match resolve_temp_agent(&state, &agent_id).await {
            Ok(v) => v,
            Err(resp) => return resp,
        };

    let req_id = format!("temp_clean_{}", Uuid::new_v4());
    let (resp_tx, mut resp_rx) = mpsc::channel(1);
    let send_ok = {
        let inner = state.inner.read().await;
        let mut pending = inner.pending_responses.write().await;
        if pending.len() >= MAX_PENDING_RESPONSES {
            false
        } else {
            pending.insert(
                req_id.clone(),
                PendingResponse {
                    tx: resp_tx,
                    agent_id: agent_id.clone(),
                    connection_id,
                    session_id: Some(session.principal_id.clone()),
                    desired_roots: None,
                    desired_collections: None,
                },
            );
            inner.agents.send_to_agent(
                &agent_id,
                HubMessage::TempCleanupRequest {
                    req_id: req_id.clone(),
                },
            )
        }
    };
    if !send_ok {
        cleanup_pending(&state, &req_id).await;
        return error_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "backend_offline",
            "Failed to send request to agent",
            true,
        );
    }

    let mut guard = CancelOnDrop {
        state: state.clone(),
        agent_id: agent_id.clone(),
        req_id: req_id.clone(),
        armed: true,
    };

    let resp = tokio::time::timeout(TEMP_CLEANUP_TIMEOUT, resp_rx.recv()).await;
    cleanup_pending(&state, &req_id).await;

    match resp {
        Ok(Some(value)) => {
            guard.disarm();
            let raw_error = value.get("error").and_then(|v| v.as_str());
            if raw_error == Some("cancelled") || raw_error == Some("request_cancelled") {
                return error_response(
                    StatusCode::BAD_REQUEST,
                    "cancelled",
                    "Cleanup cancelled",
                    false,
                );
            }
            if let Some(error) = raw_error {
                return temp_error_response(error);
            }
            state
                .emit_sse(
                    "temp_updated",
                    serde_json::json!({ "agent_id": agent_id }),
                )
                .await;
            Json(serde_json::json!({
                "ok": true,
                "removed": value["removed"],
                "freed_bytes": value["freed_bytes"],
            }))
            .into_response()
        }
        _ => error_response(
            StatusCode::GATEWAY_TIMEOUT,
            "request_timeout",
            "Agent did not respond in time",
            true,
        ),
    }
}

fn content_length(headers: &HeaderMap) -> Option<u64> {
    headers
        .get(header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.trim().parse::<u64>().ok())
}

/// Send a hub→agent message with backpressure instead of `try_send`: a full
/// outbound queue must backpressure the upload relay, not abort it with a
/// spurious "agent went away" while the agent is healthy.
async fn send_to_agent_await(state: &AppState, agent_id: &str, msg: HubMessage) -> bool {
    let sender = {
        let inner = state.inner.read().await;
        inner.agents.get(agent_id).map(|a| a.sender.clone())
    };
    match sender {
        Some(sender) => sender.send(msg).await.is_ok(),
        None => false,
    }
}

/// Consume the request body and relay it to the agent in ≤
/// [`FILE_CHUNK_MAX_BYTES`] chunks. Returns `(received_bytes, tail_buffer)`
/// on clean EOF, or the error response to return. Never sends the final
/// `done` chunk — the caller does that after the length check. An agent-side
/// terminal error (e.g. a Begin quota rejection) races the body stream and
/// aborts the relay as soon as it arrives, so the client is not made to
/// upload the whole body into a rejection it could have learned upfront.
async fn stream_upload_body(
    state: &AppState,
    agent_id: &str,
    req_id: &str,
    body: Body,
    max_file_bytes: u64,
    resp_rx: &mut mpsc::Receiver<serde_json::Value>,
) -> Result<(u64, Vec<u8>), Response> {
    let mut received: u64 = 0;
    let mut buffer: Vec<u8> = Vec::with_capacity(FILE_CHUNK_MAX_BYTES as usize);
    let mut stream = body.into_data_stream();
    loop {
        let frame = tokio::select! {
            resp = resp_rx.recv() => {
                let Some(value) = resp else {
                    // The agent connection died while we were relaying.
                    return Err(error_response(
                        StatusCode::SERVICE_UNAVAILABLE,
                        "backend_offline",
                        "Agent went away mid-upload",
                        true,
                    ));
                };
                let raw_error = value.get("error").and_then(|v| v.as_str());
                if let Some(error) = raw_error {
                    // Begin (or a mid-stream chunk) was rejected — stop
                    // relaying the body and surface the agent's error now.
                    return Err(temp_error_response(error));
                }
                // The agent answered before the body completed with no
                // error — a protocol violation; abort rather than continue.
                return Err(error_response(
                    StatusCode::BAD_GATEWAY,
                    "agent_internal_error",
                    "Agent responded before the upload completed",
                    true,
                ));
            }
            frame = stream.next() => frame,
        };
        let Some(frame) = frame else { break };
        let bytes = match frame {
            Ok(bytes) => bytes,
            Err(_) => {
                return Err(error_response(
                    StatusCode::BAD_REQUEST,
                    "temp_upload_interrupted",
                    "The upload body was interrupted",
                    false,
                ))
            }
        };
        match received.checked_add(bytes.len() as u64) {
            Some(total) if total <= max_file_bytes => received = total,
            _ => {
                return Err(error_response(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "temp_file_too_large",
                    &format!("Uploads are limited to {} bytes", max_file_bytes),
                    false,
                ))
            }
        }
        buffer.extend_from_slice(&bytes);
        if (buffer.len() as u64) >= FILE_CHUNK_MAX_BYTES {
            let data = std::mem::take(&mut buffer);
            let offset = received - data.len() as u64;
            let ok = send_to_agent_await(
                state,
                agent_id,
                HubMessage::TempUploadChunk {
                    req_id: req_id.to_string(),
                    offset,
                    data,
                    done: false,
                },
            )
            .await;
            if !ok {
                return Err(error_response(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "backend_offline",
                    "Agent went away mid-upload",
                    true,
                ));
            }
        }
    }
    Ok((received, buffer))
}

/// Map agent `temp_*` error codes onto HTTP statuses.
fn temp_error_response(error: &str) -> Response {
    // Transport-level: agent disconnected/overloaded → retryable 503, never a
    // client-fault 400.
    if error == "backend_offline" || error.starts_with("agent_overloaded") {
        return error_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "backend_offline",
            "Agent is busy or unreachable. Please retry shortly.",
            true,
        );
    }
    let (status, code) = match error {
        "temp_file_too_large" => (StatusCode::PAYLOAD_TOO_LARGE, "temp_file_too_large"),
        "temp_quota_exceeded" => (StatusCode::INSUFFICIENT_STORAGE, "temp_quota_exceeded"),
        "temp_name_invalid" => (StatusCode::BAD_REQUEST, "temp_name_invalid"),
        "temp_name_conflict" => (StatusCode::CONFLICT, "temp_name_conflict"),
        "temp_unavailable" | "unsupported_feature" => {
            (StatusCode::NOT_IMPLEMENTED, "unsupported_feature")
        }
        "temp_path_violation" | "temp_internal_error" => {
            (StatusCode::INTERNAL_SERVER_ERROR, "agent_internal_error")
        }
        _ => (StatusCode::BAD_REQUEST, error),
    };
    error_response(status, code, error, code == "agent_internal_error")
}

async fn cleanup_pending(state: &AppState, req_id: &str) {
    let pending = state.inner.read().await.pending_responses.clone();
    let mut map = pending.write().await;
    map.remove(req_id);
}

fn error_response(status: StatusCode, error: &str, message: &str, retryable: bool) -> Response {
    (
        status,
        Json(serde_json::json!({
            "error": error,
            "message": message,
            "retryable": retryable,
        })),
    )
        .into_response()
}
