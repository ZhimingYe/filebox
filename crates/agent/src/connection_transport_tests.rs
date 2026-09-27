use super::*;
use tokio_tungstenite::{tungstenite::protocol::Role, WebSocketStream};

fn chunk(index: u64) -> AgentMessage {
    AgentMessage::FileChunk {
        req_id: format!("file-{index}"), offset: index * 4096,
        data: vec![index as u8; 4096], done: true, error: None,
        file_size: Some(4096), modified: None,
    }
}

#[tokio::test]
async fn stalled_file_writer_keeps_receive_open_and_does_not_bury_directory_replies() {
    // A tiny full-duplex buffer creates real async write backpressure without
    // changing the host network. Repeated pauses model retransmission stalls.
    let (client, server) = tokio::io::duplex(128);
    let client = WebSocketStream::from_raw_socket(client, Role::Client, None).await;
    let mut server = WebSocketStream::from_raw_socket(server, Role::Server, None).await;
    let (write, mut read) = client.split();
    let (control_tx, control_rx) = mpsc::channel(CONTROL_QUEUE_CAPACITY);
    let (dir_tx, dir_rx) = mpsc::channel(4);
    let (file_tx, file_rx) = mpsc::channel(32);
    let (term_tx, term_rx) = mpsc::channel(64);
    for i in 0..20 { file_tx.send(chunk(i)).await.unwrap(); }
    let mut writer = ConnectionWriter(tokio::spawn(run_connection_writer(
        write, control_rx, vec![dir_rx, file_rx, term_rx],
    )));
    tokio::time::timeout(Duration::from_secs(1), async {
        while file_tx.capacity() == 12 { tokio::task::yield_now().await; }
    }).await.unwrap();
    assert!(!writer.0.is_finished());

    // The first file frame cannot finish until the server drains it. A Cancel
    // in the opposite direction must still reach the agent immediately.
    let cancel = serde_json::to_string(&HubMessage::Cancel { req_id: "file-19".into() }).unwrap();
    server.send(Message::Text(cancel.clone().into())).await.unwrap();
    let incoming = tokio::time::timeout(Duration::from_secs(1), read.next()).await.unwrap().unwrap().unwrap();
    assert_eq!(incoming.to_text().unwrap(), cancel);
    assert!(queue_agent_message(&control_tx, &AgentMessage::Pong));
    dir_tx.send(AgentMessage::FsListResponse {
        req_id: "directory".into(), items: vec![], next_cursor: None, error: None,
    }).await.unwrap();

    term_tx.send(AgentMessage::TerminalOutput {
        req_id: "terminal".into(), data: b"shell output".to_vec(),
    }).await.unwrap();
    let mut terminal_at = None;
    let mut files = 0;
    let mut directory_at = None;
    let mut pong_at = None;
    tokio::time::timeout(Duration::from_secs(5), async {
        for _ in 0..23 {
            // Several separate stalls; resumed bytes must remain intact.
            if files % 4 == 0 { tokio::time::sleep(Duration::from_millis(20)).await; }
            let frame = server.next().await.unwrap().unwrap();
            match serde_json::from_str::<AgentMessage>(frame.to_text().unwrap()).unwrap() {
                AgentMessage::FileChunk { data, offset, .. } => {
                    assert_eq!(offset, files * 4096);
                    assert_eq!(data, vec![files as u8; 4096]);
                    files += 1;
                }
                AgentMessage::FsListResponse { .. } => directory_at = Some(files),
                AgentMessage::Pong => pong_at = Some(files),
                AgentMessage::TerminalOutput { req_id, data } => {
                    assert_eq!(req_id, "terminal");
                    assert_eq!(data, b"shell output");
                    terminal_at = Some(files);
                }
                other => panic!("unexpected response: {other:?}"),
            }
        }
    }).await.unwrap();
    assert_eq!(files, 20);
    assert!(terminal_at.unwrap() < 5, "terminal output buried behind file backlog");
    assert!(directory_at.unwrap() < 5, "directory reply buried behind file backlog");
    assert!(pong_at.unwrap() < 5, "heartbeat buried behind file backlog");
    assert!(queue_frame(&control_tx, Message::Close(None)));
    assert!(matches!(server.next().await.unwrap().unwrap(), Message::Close(_)));
    tokio::time::timeout(Duration::from_secs(1), &mut writer.0).await.unwrap().unwrap();
}

#[tokio::test(start_paused = true)]
async fn blocked_writer_times_out_and_releases_response_queues() {
    let sink = futures_util::sink::unfold((), |(), _: Message| async {
        std::future::pending::<()>().await;
        Ok::<_, std::io::Error>(())
    });
    let (control_tx, control_rx) = mpsc::channel(1);
    let (file_tx, file_rx) = mpsc::channel(1);
    file_tx.send(chunk(0)).await.unwrap();
    let writer = tokio::spawn(run_connection_writer(Box::pin(sink), control_rx, vec![file_rx]));
    tokio::task::yield_now().await;
    tokio::time::advance(WS_WRITE_TIMEOUT + Duration::from_millis(1)).await;
    writer.await.unwrap();
    assert!(file_tx.is_closed());
    assert!(control_tx.is_closed());
}

#[tokio::test]
async fn dropping_connection_aborts_writer_and_reply_slot_invariant_is_checked() {
    let (control_tx, control_rx) = mpsc::channel(1);
    assert!(queue_frame(&control_tx, Message::Pong(vec![].into())));
    assert!(!queue_frame(&control_tx, Message::Pong(vec![].into())));
    let sink = futures_util::sink::unfold((), |(), _: Message| async {
        std::future::pending::<()>().await;
        Ok::<_, std::io::Error>(())
    });
    let writer = ConnectionWriter(tokio::spawn(run_connection_writer(Box::pin(sink), control_rx, vec![])));
    drop(writer);
    tokio::time::timeout(Duration::from_secs(1), control_tx.closed()).await.unwrap();
}

async fn start_test_connection() -> (
    tempfile::TempDir,
    tokio::task::JoinHandle<()>,
    WebSocketStream<tokio::net::TcpStream>,
) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let temp = tempfile::tempdir().unwrap();
    let config = AgentConfig {
        hub_url: format!("ws://{address}"), token: "test-token".into(),
        agent_name: "test-agent".into(), data_dir: temp.path().to_path_buf(),
        temp_dir: None, temp_upload_name: None, terminal_totp_secret: None,
    };
    let mut resources = ResourceManager::new(temp.path().to_path_buf());
    let agent_id = resources.agent_id().to_string();
    let agent = tokio::spawn(async move {
        run_one_connection(
            &format!("ws://{address}/ws/agent"), &config, &mut resources, &agent_id,
            &StatsCache::new(Duration::from_secs(60)), &DirCache::new(),
            &Arc::new(ContentCache::new(4096, 4096)), None, None,
            &Arc::new(Semaphore::new(1)), &Arc::new(Semaphore::new(1)),
            &Arc::new(AtomicUsize::new(0)), &Arc::new(Mutex::new(HashMap::new())),
            &Arc::new(crate::terminal::TerminalManager::new(None)),
        ).await;
    });
    let (socket, _) = listener.accept().await.unwrap();
    let mut hub = tokio_tungstenite::accept_async(socket).await.unwrap();
    let auth = hub.next().await.unwrap().unwrap();
    assert!(matches!(serde_json::from_str::<AgentMessage>(auth.to_text().unwrap()).unwrap(), AgentMessage::Auth { .. }));
    hub.send(Message::Text(serde_json::to_string(&HubMessage::AuthResult {
        success: true, agent_id: Some("test-agent".into()),
    }).unwrap().into())).await.unwrap();
    let register = hub.next().await.unwrap().unwrap();
    assert!(matches!(serde_json::from_str::<AgentMessage>(register.to_text().unwrap()).unwrap(), AgentMessage::Register { .. }));
    (temp, agent, hub)
}

#[tokio::test]
async fn outgoing_heartbeats_do_not_extend_silent_hub_deadline() {
    let (_temp, agent, mut hub) = start_test_connection().await;
    // Receive one heartbeat, then leave the hub silent but its socket open.
    hub.next().await.unwrap().unwrap();
    tokio::time::pause();
    for _ in 0..5 {
        tokio::time::advance(Duration::from_secs(10)).await;
        for _ in 0..10 { tokio::task::yield_now().await; }
    }
    let finished = agent.is_finished();
    if !finished { agent.abort(); }
    assert!(finished, "outbound traffic kept a silent connection alive beyond 45s");
    agent.await.unwrap();
}


#[tokio::test]
async fn directory_request_bursts_are_backpressured_without_disconnect_or_lost_replies() {
    let (_temp, agent, mut hub) = start_test_connection().await;
    let _agent_guard = ConnectionWriter(agent);
    tokio::time::timeout(Duration::from_secs(5), async {
        for burst in 0..3 {
            for i in 0..100 {
                hub.feed(Message::Text(serde_json::to_string(&HubMessage::FsListRequest {
                    req_id: format!("burst-{burst}-{i}"), root: "missing".into(),
                    path: "/".into(), limit: 200, cursor: None, dirs_only: None,
                }).unwrap().into())).await.unwrap();
            }
            hub.flush().await.unwrap();
            // Pause draining responses between bursts, like an intermittent stall.
            tokio::time::sleep(Duration::from_millis(25)).await;
            let mut received = std::collections::HashSet::new();
            while received.len() < 100 {
                let frame = hub.next().await.unwrap().unwrap();
                assert!(!matches!(frame, Message::Close(_)), "request burst disconnected the agent");
                match serde_json::from_str::<AgentMessage>(frame.to_text().unwrap()).unwrap() {
                    AgentMessage::FsListResponse { req_id, error, .. } => {
                        assert!(req_id.starts_with(&format!("burst-{burst}-")));
                        assert!(error.is_some()); // Missing root or request-scoped overload.
                        assert!(received.insert(req_id), "duplicate response");
                    }
                    AgentMessage::Heartbeat => {}
                    other => panic!("unexpected response: {other:?}"),
                }
            }
        }
        hub.send(Message::Text(serde_json::to_string(&HubMessage::Ping).unwrap().into())).await.unwrap();
        loop {
            let frame = hub.next().await.unwrap().unwrap();
            match serde_json::from_str::<AgentMessage>(frame.to_text().unwrap()).unwrap() {
                AgentMessage::Pong => break,
                AgentMessage::Heartbeat => {}
                other => panic!("unexpected response after burst: {other:?}"),
            }
        }
    }).await.unwrap();
}

#[tokio::test]
async fn resource_burst_preserves_both_ordered_control_responses() {
    let (_temp, agent, mut hub) = start_test_connection().await;
    let _agent_guard = ConnectionWriter(agent);
    tokio::time::timeout(Duration::from_secs(5), async {
        for revision in 1..=40 {
            hub.feed(Message::Text(serde_json::to_string(&HubMessage::ResourcesSetDesired {
                req_id: format!("resources-{revision}"), desired_revision: revision, roots: vec![],
            }).unwrap().into())).await.unwrap();
        }
        hub.flush().await.unwrap();
        let mut replies = 0;
        while replies < 80 {
            let frame = hub.next().await.unwrap().unwrap();
            let response = serde_json::from_str::<AgentMessage>(frame.to_text().unwrap()).unwrap();
            let expected_revision = replies / 2 + 1;
            match response {
                AgentMessage::ResourcesUpdated { resource_revision, .. } => {
                    assert_eq!(replies % 2, 0);
                    assert_eq!(resource_revision, expected_revision);
                }
                AgentMessage::ResourcesApplied { req_id, resource_revision, .. } => {
                    assert_eq!(replies % 2, 1);
                    assert_eq!(resource_revision, expected_revision);
                    assert_eq!(req_id, format!("resources-{expected_revision}"));
                }
                AgentMessage::Heartbeat => continue,
                other => panic!("unexpected response: {other:?}"),
            }
            replies += 1;
        }
    }).await.unwrap();
}
