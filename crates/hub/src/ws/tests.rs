use super::*;
use filebox_protocol::resources::RootConfig;

fn root(name: &str, path: &str, pins: &[&str]) -> RootConfig {
    RootConfig {
        name: name.to_string(),
        path: path.to_string(),
        enabled: true,
        pinned_folders: pins.iter().map(|p| (*p).to_string()).collect(),
    }
}

#[test]
fn max_ws_message_size_allows_worst_case_agent_file_chunk() {
    // Current agents send ≤ FILE_CHUNK_MAX_BYTES; also verify a legacy
    // 4MiB chunk from a rolling-upgrade peer still fits under the limit.
    for raw_len in [
        filebox_protocol::message::FILE_CHUNK_MAX_BYTES as usize,
        4 * 1024 * 1024,
    ] {
        let chunk = AgentMessage::FileChunk {
            req_id: "file_test".to_string(),
            offset: 0,
            data: vec![255; raw_len],
            done: false,
            error: None,
            file_size: None,
            modified: None,
        };

        let serialized = serde_json::to_string(&chunk).unwrap();

        assert!(
            serialized.len() < MAX_AGENT_WS_MESSAGE_SIZE,
            "serialized {}-byte FileChunk was {} bytes; WS limit is {}",
            raw_len,
            serialized.len(),
            MAX_AGENT_WS_MESSAGE_SIZE
        );
    }
}

#[test]
fn reconcile_roots_prefers_agent_paths_keeps_hub_pins() {
    // Hub still has the typed `~/docs`; agent expanded it. Hub also has
    // pins that a legacy agent may have dropped on the wire.
    let desired = vec![root("docs", "~/docs", &["/reports"])];
    let reported = vec![root("docs", "/home/alice/docs", &[])];
    let merged = reconcile_roots_after_apply(desired, &reported);
    assert_eq!(merged.len(), 1);
    assert_eq!(merged[0].path, "/home/alice/docs");
    assert_eq!(merged[0].pinned_folders, vec!["/reports".to_string()]);
}

#[test]
fn reconcile_roots_keeps_desired_path_when_name_unknown_to_agent() {
    let desired = vec![root("new", "/data/new", &[])];
    let reported = vec![root("old", "/data/old", &[])];
    let merged = reconcile_roots_after_apply(desired, &reported);
    assert_eq!(merged[0].path, "/data/new");
}

fn test_state() -> AppState {
    AppState::new(&crate::config::HubConfig {
            prompt_review_mode: crate::prompt_review::ReviewMode::Mandatory,
            prompt_review: None,
            llm_providers: Default::default(),
        listen_addr: "127.0.0.1:0".parse().unwrap(),
        agent_token_hash: "not-a-hash".into(), users: vec![],
    }, false)
}

fn register_message() -> AgentMessage {
    AgentMessage::Register {
        agent_id: Some("agent".into()), name: "test agent".into(), resource_revision: 0,
        roots: vec![root("docs", "/home/test/docs", &[])], collections_revision: 0,
        collections: vec![], capabilities: Capabilities { collections: true, pinned_folders: true, ..Capabilities::default() },
        forwards_revision: 0, forwards: vec![],
        temp_root: None,
    }
}

#[tokio::test]
async fn forwards_reconnect_replays_latest_intent_and_stale_connections_cannot_apply() {
    use filebox_protocol::forwards::ForwardConfig;
    let state = test_state();
    let (old, _old_rx) = install(&state).await;
    let desired = vec![ForwardConfig { port: 9002, name: "new".into(), keep_prefix: true, trusted: false }];
    state.inner.write().await.agents.get_mut("agent").unwrap().pending_forwards = Some(("old-request".into(), desired.clone()));
    let mut registration = register_message();
    if let AgentMessage::Register { capabilities, forwards_revision, forwards, .. } = &mut registration {
        capabilities.port_forward = true;
        *forwards_revision = 5;
        *forwards = vec![ForwardConfig { port: 9001, name: "persisted".into(), keep_prefix: false, trusted: false }];
    }
    let (tx, mut rx) = mpsc::channel(8);
    let current = registration::Registration::from_message(registration, "temporary".into()).unwrap().install(state.clone(), tx, Arc::new(Notify::new())).await;
    let HubMessage::ForwardsSetDesired { req_id, desired_revision, forwards } = rx.recv().await.unwrap() else { panic!("expected forward replay"); };
    assert_eq!(desired_revision, 6);
    assert_eq!(forwards, desired);
    let applied = serde_json::to_string(&AgentMessage::ForwardsApplied { req_id: req_id.clone(), forwards_revision: 6, forwards: desired.clone() }).unwrap();
    dispatch::dispatch(&old, &applied).await;
    assert!(state.inner.read().await.agents.get("agent").unwrap().pending_forwards.is_some());
    dispatch::dispatch(&current, &applied).await;
    {
        let mut inner = state.inner.write().await;
        let agent = inner.agents.get_mut("agent").unwrap();
        assert_eq!(agent.forwards, desired);
        assert_eq!(agent.forwards_revision, 6);
        assert!(agent.pending_forwards.is_none());
        agent.pending_forwards = Some(("reject".into(), vec![]));
    }
    let rejected = serde_json::to_string(&AgentMessage::ForwardsRejected { req_id: "reject".into(), error: "invalid_forward".into(), message: "Persistence failed".into() }).unwrap();
    dispatch::dispatch(&current, &rejected).await;
    let inner = state.inner.read().await;
    let agent = inner.agents.get("agent").unwrap();
    assert_eq!(agent.forwards, desired);
    assert!(agent.pending_forwards.is_none());
    assert_eq!(agent.last_config_error.as_deref(), Some("Persistence failed"));
}

async fn install(state: &AppState) -> (AgentContext, mpsc::Receiver<HubMessage>) {
    let (sender, receiver) = mpsc::channel(8);
    let context = registration::Registration::from_message(register_message(), "temporary".into())
        .unwrap().install(state.clone(), sender, Arc::new(Notify::new())).await;
    (context, receiver)
}

#[tokio::test]
async fn forwards_api_relays_agent_trust_rejections_without_learning_or_prevalidating_policy() {
    use axum::{body::{Body, to_bytes}, http::{header, Method, Request}};
    use tower::ServiceExt;
    for method in [Method::POST, Method::PATCH] {
        let state = test_state();
        let (context, mut rx) = install(&state).await;
        let original = vec![filebox_protocol::forwards::ForwardConfig { port: 9001, name: "saved".into(), keep_prefix: false, trusted: false }];
        {
            let mut inner = state.inner.write().await;
            let agent = inner.agents.get_mut("agent").unwrap();
            agent.capabilities.port_forward = true;
            agent.forwards_revision = 3;
            agent.forwards_desired_revision = 3;
            agent.forwards = original.clone();
        }
        let mut events = state.inner.read().await.sse_tx.subscribe();
        let (session, _) = state.inner.write().await.sessions.create_session("admin", false);
        let cookie = format!("{}={}", crate::routes::middleware::session_cookie_name(false, &state.cookie_suffix), session.session_id);
        let port = if method == Method::POST { 9002 } else { 9001 };
        let request = Request::builder().method(method).uri("/api/agents/agent/forwards")
            .header(header::COOKIE, &cookie).header("x-csrf-token", &session.csrf_token).header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(serde_json::json!({"port": port, "name": "requested", "keep_prefix": true}).to_string())).unwrap();
        let app = crate::routes::create_router(state.clone());
        let pending = tokio::spawn(app.clone().oneshot(request));
        let HubMessage::ForwardsSetDesired { req_id, desired_revision, forwards } = tokio::time::timeout(Duration::from_secs(5), rx.recv()).await.unwrap().unwrap() else { panic!("expected forwarded update"); };
        assert_eq!(desired_revision, 4);
        assert!(forwards.iter().any(|forward| forward.port == port));
        let message = format!("Port {port} is not trusted by this agent; add it to the agent's trusted_ports.");
        dispatch::dispatch(&context, &serde_json::to_string(&AgentMessage::ForwardsRejected {
            req_id, error: "port_not_trusted".into(), message: message.clone(),
        }).unwrap()).await;
        let response = pending.await.unwrap().unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body: serde_json::Value = serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap()).unwrap();
        assert_eq!(body["ok"], false);
        assert_eq!(body["state"], "rejected");
        assert_eq!(body["message"], message);
        assert_eq!(events.recv().await.unwrap().data["error"], "port_not_trusted");
        let info = serde_json::to_value(state.inner.read().await.agents.get("agent").unwrap().to_info()).unwrap();
        assert_eq!(info["forwards"], serde_json::to_value(&original).unwrap());
        assert_eq!(info["forwards_revision"], 3);
        assert!(info.get("trusted_ports").is_none());
        assert!(info["capabilities"].get("trusted_ports").is_none());
        let response = app.oneshot(Request::builder().uri("/api/agents/agent/forwards").header(header::COOKIE, &cookie).header("x-csrf-token", &session.csrf_token).body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body: serde_json::Value = serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap()).unwrap();
        assert_eq!(body["forwards"], serde_json::to_value(original).unwrap());
        assert!(body.get("trusted_ports").is_none());
    }
}

#[tokio::test]
async fn agent_tunnel_trust_refusal_reaches_proxy_as_403_and_refreshes_the_forward_flag() {
    use axum::{body::{Body, to_bytes}, http::{header, Request}};
    use tower::ServiceExt;
    let state = test_state();
    let (context, mut rx) = install(&state).await;
    {
        let mut inner = state.inner.write().await;
        let agent = inner.agents.get_mut("agent").unwrap();
        agent.capabilities.port_forward = true;
        agent.forwards = vec![filebox_protocol::forwards::ForwardConfig { port: 9001, name: "saved".into(), keep_prefix: false, trusted: true }];
    }
    let mut events = state.inner.read().await.sse_tx.subscribe();
    let (session, _) = state.inner.write().await.sessions.create_session("admin", false);
    let cookie = format!("{}={}", crate::routes::middleware::session_cookie_name(false, &state.cookie_suffix), session.session_id);
    let app = crate::routes::create_router(state.clone());
    let request = Request::builder().uri("/_fwd/agent/9001/").header(header::HOST, "hub.test:8983").header(header::COOKIE, &cookie).body(Body::empty()).unwrap();
    let pending = tokio::spawn(app.clone().oneshot(request));
    let HubMessage::TunnelOpen { ticket, port, .. } = tokio::time::timeout(Duration::from_secs(5), rx.recv()).await.unwrap().unwrap() else { panic!("expected tunnel open"); };
    assert_eq!(port, 9001);
    dispatch::dispatch(&context, &serde_json::to_string(&AgentMessage::TunnelFailed { ticket, code: "port_not_trusted".into() }).unwrap()).await;
    let response = pending.await.unwrap().unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    assert!(std::str::from_utf8(&body).unwrap().contains("Port not trusted by agent"));
    let event = events.recv().await.unwrap();
    assert_eq!(event.event, "forwards_updated");
    assert_eq!(event.data["port"], 9001);
    assert_eq!(event.data["trusted"], false);
    assert!(!state.inner.read().await.agents.get("agent").unwrap().to_info().forwards[0].trusted);
    let response = app.oneshot(Request::builder().uri("/_fwd/agent/9001/").header(header::HOST, "hub.test:8983").header(header::COOKIE, &cookie).body(Body::empty()).unwrap()).await.unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    assert!(rx.try_recv().is_err());
}

#[tokio::test]
async fn successful_forward_retry_clears_error_before_sse_refresh_including_empty_lists() {
    use filebox_protocol::forwards::ForwardConfig;
    let state = test_state();
    let (context, _rx) = install(&state).await;
    let mut events = state.inner.read().await.sse_tx.subscribe();
    for (revision, forwards) in [
        (1, vec![ForwardConfig { port: 9001, name: "web".into(), keep_prefix: false, trusted: false }]),
        (2, vec![]),
    ] {
        state.inner.write().await.agents.get_mut("agent").unwrap().pending_forwards = Some(("failed-edit".into(), forwards.clone()));
        dispatch::dispatch(&context, &serde_json::to_string(&AgentMessage::ForwardsRejected {
            req_id: "failed-edit".into(), error: "persistence_failed".into(), message: "Persistence failed".into(),
        }).unwrap()).await;
        assert_eq!(events.recv().await.unwrap().data["state"], "rejected");
        assert_eq!(state.inner.read().await.agents.get("agent").unwrap().to_info().last_config_error.as_deref(), Some("Persistence failed"));
        dispatch::dispatch(&context, &serde_json::to_string(&AgentMessage::ForwardsApplied {
            req_id: "stale-edit".into(), forwards_revision: 0, forwards: vec![],
        }).unwrap()).await;
        let _ = events.recv().await.unwrap();
        assert_eq!(state.inner.read().await.agents.get("agent").unwrap().last_config_error.as_deref(), Some("Persistence failed"));
        state.inner.write().await.agents.get_mut("agent").unwrap().pending_forwards = Some(("retry".into(), forwards.clone()));
        dispatch::dispatch(&context, &serde_json::to_string(&AgentMessage::ForwardsApplied {
            req_id: "retry".into(), forwards_revision: revision, forwards: forwards.clone(),
        }).unwrap()).await;
        let event = events.recv().await.unwrap();
        assert_eq!(event.event, "forwards_updated");
        assert_eq!(event.data["state"], "applied");
        assert_eq!(event.data["forwards"], serde_json::to_value(&forwards).unwrap());
        let info = state.inner.read().await.agents.get("agent").unwrap().to_info();
        assert!(info.last_config_error.is_none());
        assert!(!info.pending_forwards_update);
        assert_eq!(info.forwards_revision, revision);
        assert_eq!(info.forwards, forwards);
    }
}

#[tokio::test]
async fn forwards_success_preserves_root_and_collection_errors_even_after_a_forward_error() {
    for collections in [false, true] {
        for prior_forward_error in [false, true] {
            let state = test_state();
            let (context, _rx) = install(&state).await;
            if prior_forward_error {
                state.inner.write().await.agents.get_mut("agent").unwrap().pending_forwards = Some(("forward-failure".into(), vec![]));
                dispatch::dispatch(&context, &serde_json::to_string(&AgentMessage::ForwardsRejected {
                    req_id: "forward-failure".into(), error: "persistence_failed".into(), message: "Forward persistence failed".into(),
                }).unwrap()).await;
            }
            {
                let mut inner = state.inner.write().await;
                let agent = inner.agents.get_mut("agent").unwrap();
                if collections { agent.pending_collection_request = Some("other-failure".into()); }
                else { agent.pending_resource_request = Some("other-failure".into()); }
            }
            let message = if collections {
                AgentMessage::CollectionsRejected {
                    req_id: "other-failure".into(), agent_id: "agent".into(), current_collections_revision: 0,
                    error: "invalid_collection".into(), message: "Collection unavailable".into(),
                }
            } else {
                AgentMessage::ResourcesRejected {
                    req_id: "other-failure".into(), agent_id: "agent".into(), current_resource_revision: 0,
                    error: "invalid_root".into(), message: "Root unavailable".into(),
                }
            };
            updates::dispatch(&context, message).await;
            let expected = state.inner.read().await.agents.get("agent").unwrap().last_config_error.clone();
            assert!(expected.is_some());
            let mut events = state.inner.read().await.sse_tx.subscribe();
            dispatch::dispatch(&context, &serde_json::to_string(&AgentMessage::ForwardsApplied {
                req_id: "forward-success".into(), forwards_revision: 1, forwards: vec![],
            }).unwrap()).await;
            let event = events.recv().await.unwrap();
            assert_eq!(event.event, "forwards_updated");
            let info = state.inner.read().await.agents.get("agent").unwrap().to_info();
            assert_eq!(info.forwards_revision, 1);
            assert_eq!(info.last_config_error, expected);
        }
    }
}

async fn pending(
    context: &AgentContext, req_id: &str, desired_roots: Option<Vec<RootConfig>>,
) -> mpsc::Receiver<serde_json::Value> {
    let (tx, rx) = mpsc::channel(1);
    context.state.inner.read().await.pending_responses.write().await.insert(req_id.into(), PendingResponse {
        tx, agent_id: context.agent_id.clone(), connection_id: context.connection_id,
        session_id: None, desired_roots, desired_collections: None,
    });
    rx
}

#[tokio::test]
async fn replacement_transfers_inflight_desired_state_before_connected_event() {
    let state = test_state();
    let (old, _) = install(&state).await;
    let desired = vec![root("docs", "~/docs", &["/reports"])];
    let mut reply = pending(&old, "roots-change", Some(desired.clone())).await;
    let (new, mut outbound) = install(&state).await;
    assert_ne!(old.connection_id, new.connection_id);
    assert_eq!(reply.recv().await.unwrap()["error"], "backend_offline");
    let replay_id = match outbound.recv().await {
        Some(HubMessage::ResourcesSetDesired { roots, req_id, .. }) => { assert_eq!(roots, desired); req_id }
        other => panic!("unexpected replay {other:?}"),
    };
    let inner = state.inner.read().await;
    assert_eq!(inner.agents.get("agent").unwrap().connection_id, new.connection_id);
    assert_eq!(inner.sse_history.read().await.back().unwrap().event, "agent_connected");
    drop(inner);
    updates::dispatch(&new, AgentMessage::ResourcesApplied {
        req_id: replay_id, agent_id: "agent".into(), resource_revision: 1,
    }).await;
    state.fail_pending_for_connection("agent", old.connection_id).await;
    let inner = state.inner.read().await;
    let agent = inner.agents.get("agent").unwrap();
    assert!(agent.pending_update.is_none());
    assert_eq!(agent.roots[0].pinned_folders, vec!["/reports"]);
    assert_eq!(agent.roots[0].path, "/home/test/docs");
}

#[tokio::test]
async fn full_waiter_does_not_block_replacement_or_following_heartbeat() {
    let state = test_state();
    let (old, _) = install(&state).await;
    let mut reply = pending(&old, "full", None).await;
    let tx = state.inner.read().await.pending_responses.read().await.get("full").unwrap().tx.clone();
    tx.try_send(serde_json::json!({ "state": "cancelled" })).unwrap();
    tokio::time::timeout(Duration::from_secs(1), dispatch::dispatch(&old,
        r#"{"type":"fs_stat_response","req_id":"full","stat":null,"error":null}"#,
    )).await.expect("one waiter must not block Agent ingress");
    assert_eq!(reply.recv().await.unwrap()["state"], "cancelled");
    let _second_reply = pending(&old, "full-again", None).await;
    let tx = state.inner.read().await.pending_responses.read().await.get("full-again").unwrap().tx.clone();
    tx.try_send(serde_json::json!({ "state": "cancelled" })).unwrap();
    let (new, _) = tokio::time::timeout(Duration::from_secs(1), install(&state)).await.unwrap();
    dispatch::dispatch(&new, r#"{"type":"heartbeat"}"#).await;
    assert!(state.inner.read().await.agents.get("agent").unwrap().last_pong.is_some());
}

#[tokio::test]
async fn old_generation_cannot_mutate_state_emit_progress_or_consume_new_reply() {
    let state = test_state();
    let (old, _) = install(&state).await;
    let (new, _) = install(&state).await;
    let mut reply = pending(&new, "reused", None).await;
    let before = state.inner.read().await.sse_history.read().await.len();
    for frame in [
        r#"{"type":"progress","req_id":"reused","phase":"search","processed":99,"total":null,"message":null}"#,
        r#"{"type":"fs_stat_response","req_id":"reused","stat":null,"error":"old"}"#,
        r#"{"type":"resources_updated","agent_id":"agent","resource_revision":99,"roots":[]}"#,
    ] { dispatch::dispatch(&old, frame).await; }
    assert!(reply.try_recv().is_err());
    let inner = state.inner.read().await;
    assert_eq!(inner.agents.get("agent").unwrap().resource_revision, 0);
    assert_eq!(inner.sse_history.read().await.len(), before);
    drop(inner);
    dispatch::dispatch(&new, r#"{"type":"fs_stat_response","req_id":"reused","stat":null,"error":null}"#).await;
    assert!(reply.recv().await.unwrap()["error"].is_null());
}

#[tokio::test]
async fn file_chunk_wire_path_preserves_base64_legacy_arrays_and_extensions() {
    let state = test_state();
    let (context, _) = install(&state).await;
    for data in [serde_json::json!("YWJj"), serde_json::json!([97, 98, 99])] {
        let mut reply = pending(&context, "chunk", None).await;
        let frame = serde_json::json!({
            "type": "file_chunk", "req_id": "chunk", "offset": 0,
            "data": data, "done": true, "error": null, "retryable": true,
        });
        dispatch::dispatch(&context, &frame.to_string()).await;
        assert_eq!(reply.recv().await.unwrap(), frame);
    }
    let mut reply = pending(&context, "invalid", None).await;
    dispatch::dispatch(&context, r#"{"type":"file_chunk","req_id":"invalid","offset":0,"data":[256],"done":true}"#).await;
    assert!(reply.try_recv().is_err(), "malformed chunk must not consume its waiter");
}

#[tokio::test]
async fn replay_apply_keeps_desired_pins_until_agent_acknowledges() {
    let state = test_state();
    let (context, _) = install(&state).await;
    state.inner.write().await.agents.set_pending_update("agent",
        filebox_protocol::resources::DesiredResources { roots: vec![root("docs", "~/docs", &["/reports"])] },
    );
    state.inner.write().await.agents.get_mut("agent").unwrap().pending_resource_request = Some("pending_test".into());
    updates::dispatch(&context, AgentMessage::ResourcesUpdated {
        agent_id: "agent".into(), resource_revision: 1, roots: vec![root("docs", "/expanded/docs", &[])],
    }).await;
    assert!(state.inner.read().await.agents.get("agent").unwrap().pending_update.is_some());
    updates::dispatch(&context, AgentMessage::ResourcesApplied {
        req_id: "pending_test".into(), agent_id: "agent".into(), resource_revision: 1,
    }).await;
    let inner = state.inner.read().await;
    let agent = inner.agents.get("agent").unwrap();
    assert!(agent.pending_update.is_none());
    assert_eq!(agent.roots[0].path, "/expanded/docs");
    assert_eq!(agent.roots[0].pinned_folders, vec!["/reports"]);
}

#[tokio::test]
async fn rejection_uses_message_variant_and_preserves_last_good_state() {
    let state = test_state();
    let (context, _) = install(&state).await;
    state.inner.write().await.agents.set_pending_update("agent",
        filebox_protocol::resources::DesiredResources { roots: vec![] },
    );
    state.inner.write().await.agents.get_mut("agent").unwrap().pending_resource_request = Some("arbitrary".into());
    updates::dispatch(&context, AgentMessage::ResourcesRejected {
        req_id: "arbitrary".into(), agent_id: "agent".into(), current_resource_revision: 0,
        error: "invalid_root".into(), message: "missing folder".into(),
    }).await;
    let inner = state.inner.read().await;
    let agent = inner.agents.get("agent").unwrap();
    assert!(agent.pending_update.is_none());
    assert_eq!(agent.roots.len(), 1);
    assert_eq!(agent.last_config_error.as_deref(), Some("missing folder"));
}

#[tokio::test]
async fn auth_admission_does_not_hold_registry_lock() {
    let state = test_state();
    let permits = state.agent_auth_semaphore.clone().acquire_many_owned(4).await.unwrap();
    let verification = handshake::verify_token(&state, "token".into());
    tokio::pin!(verification);
    assert!(tokio::time::timeout(Duration::from_millis(20), verification.as_mut()).await.is_err());
    assert!(state.inner.try_write().is_ok(), "waiting for bcrypt must not block the registry");
    drop(permits);
    assert!(!tokio::time::timeout(Duration::from_secs(1), verification).await.unwrap());
}

async fn test_server() -> (AppState, String, tokio::task::JoinHandle<()>) {
    let state = AppState::new(&crate::config::HubConfig {
            prompt_review_mode: crate::prompt_review::ReviewMode::Mandatory,
            prompt_review: None,
            llm_providers: Default::default(),
        listen_addr: "127.0.0.1:0".parse().unwrap(),
        agent_token_hash: bcrypt::hash("test-token", 4).unwrap(), users: vec![],
    }, false);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}/ws/agent", listener.local_addr().unwrap());
    let router = axum::Router::new().route("/ws/agent", axum::routing::get(ws_handler)).with_state(state.clone());
    let task = tokio::spawn(async move {
        axum::serve(listener, router.into_make_service_with_connect_info::<std::net::SocketAddr>()).await.unwrap();
    });
    (state, url, task)
}

type TestSocket = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn authenticated_socket(url: &str) -> TestSocket {
    let (mut socket, _) = tokio_tungstenite::connect_async(url).await.unwrap();
    socket.send(tokio_tungstenite::tungstenite::Message::Text(
        r#"{"type":"auth","token":"test-token"}"#.into(),
    )).await.unwrap();
    let frame = tokio::time::timeout(Duration::from_secs(2), socket.next()).await.unwrap().unwrap().unwrap();
    let value: serde_json::Value = serde_json::from_str(frame.to_text().unwrap()).unwrap();
    assert_eq!(value["success"], true);
    socket
}

#[tokio::test]
async fn real_socket_requires_register_and_cleans_up_after_disconnect() {
    let (state, url, server) = test_server().await;
    let mut socket = authenticated_socket(&url).await;
    socket.send(tokio_tungstenite::tungstenite::Message::Text(r#"{"type":"heartbeat"}"#.into())).await.unwrap();
    let _ = tokio::time::timeout(Duration::from_secs(2), socket.next()).await.unwrap();
    assert!(state.inner.read().await.agents.list_all().is_empty());
    assert!(state.inner.read().await.sse_history.read().await.is_empty());
    let mut socket = authenticated_socket(&url).await;
    socket.send(tokio_tungstenite::tungstenite::Message::Text(serde_json::to_string(&register_message()).unwrap().into())).await.unwrap();
    tokio::time::timeout(Duration::from_secs(2), async {
        while state.inner.read().await.agents.get("agent").is_none() { tokio::task::yield_now().await; }
    }).await.unwrap();
    let id = state.inner.read().await.agents.get("agent").unwrap().connection_id;
    let context = AgentContext { state: state.clone(), agent_id: "agent".into(), connection_id: id };
    let mut reply = pending(&context, "pending-on-disconnect", None).await;
    socket.close(None).await.unwrap();
    assert_eq!(tokio::time::timeout(Duration::from_secs(2), reply.recv()).await.unwrap().unwrap()["error"], "backend_offline");
    let inner = state.inner.read().await;
    assert_eq!(inner.agents.get("agent").unwrap().status, crate::agent_registry::AgentStatus::Offline);
    assert_eq!(inner.sse_history.read().await.back().unwrap().event, "agent_disconnected");
    server.abort();
}

#[tokio::test]
async fn real_socket_replacement_does_not_emit_offline_for_the_new_generation() {
    let (state, url, server) = test_server().await;
    let mut old = authenticated_socket(&url).await;
    old.send(tokio_tungstenite::tungstenite::Message::Text(serde_json::to_string(&register_message()).unwrap().into())).await.unwrap();
    tokio::time::timeout(Duration::from_secs(2), async {
        while state.inner.read().await.agents.get("agent").is_none() { tokio::task::yield_now().await; }
    }).await.unwrap();
    let old_id = state.inner.read().await.agents.get("agent").unwrap().connection_id;
    let mut new = authenticated_socket(&url).await;
    new.send(tokio_tungstenite::tungstenite::Message::Text(serde_json::to_string(&register_message()).unwrap().into())).await.unwrap();
    tokio::time::timeout(Duration::from_secs(2), async {
        while state.inner.read().await.agents.get("agent").unwrap().connection_id == old_id { tokio::task::yield_now().await; }
    }).await.unwrap();
    // Reading EOF is the barrier that confirms the old driver released its transport.
    let _ = tokio::time::timeout(Duration::from_secs(2), old.next()).await.unwrap();
    let inner = state.inner.read().await;
    assert_eq!(inner.agents.get("agent").unwrap().status, crate::agent_registry::AgentStatus::Online);
    assert!(!inner.sse_history.read().await.iter().any(|e| e.event == "agent_disconnected"));
    drop(inner);
    new.close(None).await.unwrap();
    server.abort();
}

#[tokio::test]
async fn late_acknowledgement_must_not_consume_a_newer_coalesced_edit() {
    let state = test_state();
    let (context, _) = install(&state).await;
    let latest = vec![root("latest", "/latest", &[])];
    state.inner.write().await.agents.set_pending_update("agent",
        filebox_protocol::resources::DesiredResources { roots: latest.clone() },
    );
    updates::dispatch(&context, AgentMessage::ResourcesApplied {
        req_id: "older-request".into(), agent_id: "agent".into(), resource_revision: 1,
    }).await;
    let inner = state.inner.read().await;
    let agent = inner.agents.get("agent").unwrap();
    assert_eq!(agent.pending_update.as_ref().map(|d| &d.roots), Some(&latest));
    assert_eq!(agent.roots[0].name, "docs", "ack must not claim an unsent edit was applied");
}

#[tokio::test]
async fn old_collection_ack_and_rejection_keep_a_newer_queued_edit() {
    use filebox_protocol::resources::{CollectionConfig, DesiredCollections};
    let state = test_state();
    let (context, _) = install(&state).await;
    let latest = vec![CollectionConfig { name: "latest".into(), items: vec![] }];
    state.inner.write().await.agents.set_pending_collections_update("agent", DesiredCollections { collections: latest.clone() });
    updates::dispatch(&context, AgentMessage::CollectionsApplied {
        req_id: "older".into(), agent_id: "agent".into(), collections_revision: 1,
    }).await;
    updates::dispatch(&context, AgentMessage::CollectionsRejected {
        req_id: "older".into(), agent_id: "agent".into(), current_collections_revision: 1,
        error: "invalid".into(), message: "old edit failed".into(),
    }).await;
    let inner = state.inner.read().await;
    let agent = inner.agents.get("agent").unwrap();
    assert_eq!(agent.pending_collections_update.as_ref().unwrap().collections, latest);
    assert!(agent.collections.is_empty(), "an unsent edit must not become the applied mirror");
}

#[tokio::test]
async fn ai_agents_updates_mirror_current_state_and_emit_sse_without_waiter() {
    let state = test_state();
    let (context, _) = install(&state).await;
    let settings = filebox_protocol::resources::AiAgentsCapability {
        available: false,
        backend: None,
        version: None,
        backends: vec![],
        settings: filebox_protocol::resources::AiAgentSettings { enabled: true, environment_override: None, backend: None, backend_environment_override: None },
    };
    updates::dispatch(
        &context,
        AgentMessage::AiAgentSettingsApplied {
            req_id: "disconnected-caller".into(),
            ai_agents: settings.clone(),
            error: None,
        },
    )
    .await;

    let inner = state.inner.read().await;
    let agent = inner.agents.get("agent").unwrap();
    assert!(agent.capabilities.ai_agents.as_ref().unwrap().settings.enabled);
    assert!(!agent.capabilities.ai_agents.as_ref().unwrap().available);
    assert_eq!(
        agent.to_info().capabilities.ai_agents,
        Some(settings)
    );
    let history = inner.sse_history.read().await;
    let event = history.back().unwrap();
    assert_eq!(event.event, "ai_agent_settings_updated");
    assert_eq!(event.data["agent_id"], "agent");
}

#[tokio::test]
async fn stale_generation_ai_agents_cannot_update_mirror_or_emit_sse() {
    let state = test_state();
    let (old, _) = install(&state).await;
    let (current, _) = install(&state).await;
    let events_before = state.inner.read().await.sse_history.read().await.len();
    updates::dispatch(
        &old,
        AgentMessage::AiAgentSettingsApplied {
            req_id: "stale".into(),
            ai_agents: filebox_protocol::resources::AiAgentsCapability {
                available: false,
                backend: None,
                version: None,
                backends: vec![],
                settings: filebox_protocol::resources::AiAgentSettings { enabled: false, environment_override: Some(false), backend: None, backend_environment_override: None },
            },
            error: None,
        },
    )
    .await;
    {
        let inner = state.inner.read().await;
        assert!(inner.agents.get("agent").unwrap().capabilities.ai_agents.is_none());
        assert_eq!(inner.sse_history.read().await.len(), events_before);
    }

    updates::dispatch(
        &current,
        AgentMessage::AiAgentSettingsApplied {
            req_id: "current".into(),
            ai_agents: filebox_protocol::resources::AiAgentsCapability {
                available: false,
                backend: None,
                version: None,
                backends: vec![],
                settings: filebox_protocol::resources::AiAgentSettings { enabled: false, environment_override: Some(false), backend: None, backend_environment_override: None },
            },
            error: None,
        },
    )
    .await;
    let inner = state.inner.read().await;
    assert_eq!(
        inner.agents.get("agent").unwrap().capabilities.ai_agents,
        Some(filebox_protocol::resources::AiAgentsCapability {
            available: false,
            backend: None,
            version: None,
            backends: vec![],
            settings: filebox_protocol::resources::AiAgentSettings { enabled: false, environment_override: Some(false), backend: None, backend_environment_override: None },
        })
    );
    assert_eq!(
        inner.sse_history.read().await.back().unwrap().event,
        "ai_agent_settings_updated"
    );
}

#[tokio::test]
async fn ai_agents_pending_reply_is_generation_owned() {
    let state = test_state();
    let (old, _) = install(&state).await;
    let mut old_reply = pending(&old, "settings-request", None).await;
    let (current, _) = install(&state).await;
    assert_eq!(old_reply.recv().await.unwrap()["error"], "backend_offline");
    let mut current_reply = pending(&current, "settings-request", None).await;
    let settings = filebox_protocol::resources::AiAgentsCapability {
        available: false,
        backend: None,
        version: None,
        backends: vec![],
        settings: filebox_protocol::resources::AiAgentSettings {
            enabled: false,
            environment_override: Some(false),
            backend: None,
            backend_environment_override: None,
        },
    };

    updates::dispatch(
        &old,
        AgentMessage::AiAgentSettingsApplied {
            req_id: "settings-request".into(),
            ai_agents: settings.clone(),
            error: None,
        },
    )
    .await;
    assert!(
        tokio::time::timeout(Duration::from_millis(20), current_reply.recv())
            .await
            .is_err()
    );

    updates::dispatch(
        &current,
        AgentMessage::AiAgentSettingsApplied {
            req_id: "settings-request".into(),
            ai_agents: settings,
            error: None,
        },
    )
    .await;
    assert_eq!(
        current_reply.recv().await.unwrap()["ai_agents"]["settings"]["enabled"],
        false
    );
}
