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
        listen_addr: "127.0.0.1:0".parse().unwrap(),
        agent_token_hash: "not-a-hash".into(), users: vec![],
    }, false)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stalled_terminal_audit_does_not_block_open_output_heartbeat_or_registry() {
    let mut state = test_state();
    state.audit = Arc::new(crate::audit::LoginAuditLog::load(None));
    state.terminal_audit = Arc::new(crate::audit::QueuedAuditLog::new(state.audit.clone()));
    let (context, _outbound) = install(&state).await;
    let (tx, mut browser) = mpsc::channel(8);
    state.terminal_sessions.lock().unwrap().insert("terminal".into(), crate::terminal_proxy::TerminalSessionEntry {
        agent_id: "agent".into(), connection_id: context.connection_id, principal_id: "principal".into(),
        revoked: Arc::new(Notify::new()), username: "alice".into(), ip: "192.0.2.1".into(),
        user_agent: "test-browser".into(), tx,
    });
    let pause = state.audit.pause_storage_for_test().await;
    let opened_context = context.clone();
    let opened = tokio::spawn(async move {
        let text = serde_json::to_string(&AgentMessage::TerminalOpened {
            req_id: "terminal".into(), error: None, replay_bytes: Some(0), input_ack: true,
        }).unwrap();
        dispatch::dispatch(&opened_context, &text).await;
    });
    tokio::time::timeout(Duration::from_secs(1), opened).await
        .expect("terminal open must not wait for audit storage").unwrap();
    assert_eq!(browser.recv().await.unwrap()["type"], "opened");
    drop(tokio::time::timeout(Duration::from_secs(1), state.inner.write()).await
        .expect("audit work must not retain the registry lock"));
    tokio::time::timeout(Duration::from_secs(1), dispatch::dispatch(&context, r#"{"type":"heartbeat"}"#)).await.unwrap();
    assert!(state.inner.read().await.agents.get("agent").unwrap().last_pong.is_some());
    let text = serde_json::to_string(&AgentMessage::TerminalOutput {
        req_id: "terminal".into(), data: b"still live".to_vec(),
    }).unwrap();
    tokio::time::timeout(Duration::from_secs(1), dispatch::dispatch(&context, &text)).await.unwrap();
    assert_eq!(browser.recv().await.unwrap()["type"], "output");
    drop(pause);
    tokio::time::timeout(Duration::from_secs(1), async {
        loop {
            let log = state.audit.clone();
            let (entries, _) = tokio::task::spawn_blocking(move || log.recent(10, None)).await.unwrap();
            if let Some(entry) = entries.first() {
                assert_eq!(entry.event, "terminal_opened");
                assert_eq!(entry.username, "alice");
                assert_eq!(entry.ip, "192.0.2.1");
                return;
            }
            tokio::task::yield_now().await;
        }
    }).await.unwrap();
}

fn register_message() -> AgentMessage {
    AgentMessage::Register {
        agent_id: Some("agent".into()), name: "test agent".into(), resource_revision: 0,
        roots: vec![root("docs", "/home/test/docs", &[])], collections_revision: 0,
        collections: vec![], capabilities: Capabilities { collections: true, pinned_folders: true, ..Capabilities::default() },
        temp_root: None,
    }
}

async fn install(state: &AppState) -> (AgentContext, mpsc::Receiver<HubMessage>) {
    let (sender, receiver) = mpsc::channel(8);
    let context = registration::Registration::from_message(register_message(), "temporary".into())
        .unwrap().install(state.clone(), sender, Arc::new(Notify::new())).await;
    (context, receiver)
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
