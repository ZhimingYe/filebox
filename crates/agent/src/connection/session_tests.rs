use super::*;

#[tokio::test]
async fn forwards_acknowledge_trusted_ports_and_reject_untrusted_updates_without_mutation() {
    use filebox_protocol::forwards::ForwardConfig;
    let temp = tempfile::tempdir().unwrap();
    let mut runtime = AgentRuntime::for_tests(temp.path());
    runtime.resource_mgr.trusted_ports = crate::trusted_ports::TrustedPorts::parse("9001").unwrap();
    let (sink, mut replies) = capture();
    let mut session = ConnectionSession::new(&mut runtime, sink, "agent".into());
    let entry = ForwardConfig { port: 9001, name: "app".into(), keep_prefix: false, trusted: false };
    session.dispatch(HubMessage::ForwardsSetDesired { req_id: "trusted".into(), desired_revision: 1, forwards: vec![entry.clone()] }).await.unwrap();
    match response(&mut replies).await {
        AgentMessage::ForwardsApplied { req_id, forwards_revision, forwards } => {
            assert_eq!(req_id, "trusted");
            assert_eq!(forwards_revision, 1);
            assert!(forwards[0].trusted);
        }
        other => panic!("unexpected reply: {other:?}"),
    }
    session.dispatch(HubMessage::ForwardsSetDesired {
        req_id: "untrusted".into(), desired_revision: 2,
        forwards: vec![entry, ForwardConfig { port: 9002, name: "denied".into(), keep_prefix: false, trusted: true }],
    }).await.unwrap();
    match response(&mut replies).await {
        AgentMessage::ForwardsRejected { req_id, error, message } => {
            assert_eq!(req_id, "untrusted");
            assert_eq!(error, "port_not_trusted");
            assert!(message.contains("9002") && message.contains("trusted_ports"));
            assert!(!message.contains("9001"));
        }
        other => panic!("unexpected reply: {other:?}"),
    }
    assert_eq!(session.runtime.resource_mgr.config.forwards_revision, 1);
    assert_eq!(session.runtime.resource_mgr.config.forwards.len(), 1);
    session.shutdown().await;
}

#[tokio::test]
async fn untrusted_tunnel_is_refused_even_with_a_persisted_forward_and_a_forged_trust_flag() {
    let temp = tempfile::tempdir().unwrap();
    let mut runtime = AgentRuntime::for_tests(temp.path());
    runtime.resource_mgr.config.forwards = vec![filebox_protocol::forwards::ForwardConfig {
        port: 9001, name: "persisted".into(), keep_prefix: false, trusted: true,
    }];
    let (sink, mut replies) = capture();
    let mut session = ConnectionSession::new(&mut runtime, sink, "agent".into());
    for port in [9001, 9002] {
        session.dispatch(HubMessage::TunnelOpen { ticket: "ticket".into(), port, compression: true }).await.unwrap();
        match response(&mut replies).await {
            AgentMessage::TunnelFailed { ticket, code } => {
                assert_eq!(ticket, "ticket");
                assert_eq!(code, "port_not_trusted");
            }
            other => panic!("unexpected reply: {other:?}"),
        }
        assert!(session.tasks.is_empty());
    }
    assert_eq!(session.runtime.resource_mgr.config.forwards.len(), 1);
    assert!(!session.runtime.resource_mgr.reported_forwards()[0].trusted);
    session.shutdown().await;
}

fn incoming(messages: Vec<HubMessage>) -> impl futures_util::Stream<Item = Result<Message, std::io::Error>> + Unpin {
    futures_util::stream::iter(messages.into_iter().map(|message| {
        Ok(Message::Text(serde_json::to_string(&message).unwrap().into()))
    }).chain(std::iter::once(Ok(Message::Close(None)))))
}

fn capture() -> (impl SinkExt<Message> + Unpin + Send + 'static, mpsc::Receiver<Message>) {
    let (tx, rx) = mpsc::channel(512);
    let sink = futures_util::sink::unfold(tx, |tx, frame| async move {
        tx.send(frame).await.unwrap();
        Ok::<_, std::io::Error>(tx)
    });
    (Box::pin(sink), rx)
}

async fn response(rx: &mut mpsc::Receiver<Message>) -> AgentMessage {
    loop {
        let frame = tokio::time::timeout(Duration::from_secs(5), rx.recv()).await.unwrap().unwrap();
        if let Message::Text(text) = frame { return serde_json::from_str(&text).unwrap(); }
    }
}

struct CountingAiAgentBackend {
    kind: &'static str,
    calls: Arc<std::sync::atomic::AtomicUsize>,
}

impl crate::ai_agents::AiAgentBackend for CountingAiAgentBackend {
    fn kind(&self) -> &'static str { self.kind }
    fn version(&self) -> &str { "test" }
    fn features(&self) -> filebox_protocol::resources::AiAgentFeatures {
        filebox_protocol::resources::AiAgentFeatures::default()
    }

    fn list<'a>(
        &'a self,
        _: &'a AtomicBool,
    ) -> crate::ai_agents::BackendFuture<'a, Result<crate::ai_agents::AiAgentList, String>> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Box::pin(async {
            Ok(crate::ai_agents::AiAgentList {
                status: filebox_protocol::ai_agents::AiAgentBackendStatus {
                    installed: true,
                    reachable: true,
                    version: Some("test".into()),
                    message: None,
                },
                error: None,
                agents: Vec::new(),
            })
        })
    }

    fn read<'a>(
        &'a self,
        _: &'a str,
        _: u32,
        _: Option<filebox_protocol::ai_agents::AiAgentReadSource>,
        _: &'a AtomicBool,
    ) -> crate::ai_agents::BackendFuture<'a, Result<String, String>> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Box::pin(async { Ok(String::new()) })
    }

    fn prompt<'a>(
        &'a self,
        _: &'a str,
        _: &'a str,
        _: Option<u64>,
        _: &'a AtomicBool,
    ) -> crate::ai_agents::BackendFuture<
        'a,
        Result<Option<filebox_protocol::ai_agents::AiAgent>, String>,
    > {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Box::pin(async { Ok(None) })
    }

    fn send_keys<'a>(
        &'a self,
        _: &'a str,
        _: &'a [String],
        _: &'a AtomicBool,
    ) -> crate::ai_agents::BackendFuture<
        'a,
        Result<Option<filebox_protocol::ai_agents::AiAgent>, String>,
    > {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Box::pin(async { Ok(None) })
    }
}

#[tokio::test]
async fn collections_burst_keeps_update_before_ack_and_independent_revision() {
    let temp = tempfile::tempdir().unwrap();
    let mut runtime = AgentRuntime::for_tests(temp.path());
    let (sink, mut replies) = capture();
    let mut session = ConnectionSession::new(&mut runtime, sink, "agent".into());
    let messages = (1..=40).map(|revision| HubMessage::CollectionsSetDesired {
        req_id: format!("collections-{revision}"), desired_revision: revision, collections: vec![],
    }).collect();
    assert_eq!(session.drive(&mut incoming(messages)).await, DisconnectReason::HubClosed);
    let mut count = 0;
    while count < 80 {
        let revision = count / 2 + 1;
        match response(&mut replies).await {
            AgentMessage::CollectionsUpdated { collections_revision, .. } => {
                assert_eq!(count % 2, 0); assert_eq!(collections_revision, revision);
            }
            AgentMessage::CollectionsApplied { req_id, collections_revision, .. } => {
                assert_eq!(count % 2, 1); assert_eq!(collections_revision, revision);
                assert_eq!(req_id, format!("collections-{revision}"));
            }
            AgentMessage::Heartbeat => continue,
            other => panic!("unexpected reply: {other:?}"),
        }
        count += 1;
    }
    assert_eq!(session.runtime.resource_mgr.resource_revision(), 0);
    session.shutdown().await;
}

#[tokio::test]
async fn aborting_parent_cancels_work_and_closes_all_response_queues() {
    let temp = tempfile::tempdir().unwrap();
    let mut runtime = AgentRuntime::for_tests(temp.path());
    let search_flag = Arc::new(AtomicBool::new(false));
    runtime.search_cancels.lock().unwrap().insert("search".into(), search_flag.clone());
    let ai_agents_flag = Arc::new(AtomicBool::new(false));
    let ai_agent_cancels = runtime.ai_agent_cancels.clone();
    ai_agent_cancels.lock().unwrap().insert("ai_agents".into(), ai_agents_flag.clone());
    let cancellation = FsCancellation::new();
    let cancellation_for_task = cancellation.clone();
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
    let parent = tokio::spawn(async move {
        let mut session = ConnectionSession::new(&mut runtime, futures_util::sink::drain(), "agent".into());
        session.fs_cancellations.lock().unwrap().insert("file".into(), cancellation_for_task);
        let queued = session.stats_admission.clone().acquire_owned().await.unwrap();
        session.tasks.spawn(async move { let _permit = queued; std::future::pending::<()>().await; });
        ready_tx.send((session.ai_agents_tx.clone(), session.fs_tx.clone(), session.stats_admission.clone())).unwrap();
        let mut read = futures_util::stream::pending::<Result<Message, std::io::Error>>();
        session.drive(&mut read).await;
    });
    let (ai_agents_tx, fs_tx, stats_admission) = ready_rx.await.unwrap();
    parent.abort();
    assert!(parent.await.unwrap_err().is_cancelled());
    assert!(cancellation.is_cancelled());
    assert!(search_flag.load(Ordering::Relaxed));
    assert!(ai_agents_flag.load(Ordering::Relaxed));
    assert!(ai_agent_cancels.lock().unwrap().is_empty());
    tokio::time::timeout(Duration::from_secs(1), async {
        ai_agents_tx.closed().await; fs_tx.closed().await;
        while stats_admission.available_permits() < 8 { tokio::task::yield_now().await; }
    }).await.unwrap();
}

// Hold the only blocking thread to reproduce a stalled disk writer without
// relying on a slow filesystem. Drop releases it even if an assertion fails.
struct BlockingGate(Option<std::sync::mpsc::Sender<()>>);
impl Drop for BlockingGate { fn drop(&mut self) { if let Some(tx) = self.0.take() { let _ = tx.send(()); } } }

#[test]
fn upload_congestion_keeps_ping_cancel_and_reconnect_admission_working() {
    let executor = tokio::runtime::Builder::new_current_thread().enable_all().max_blocking_threads(1).build().unwrap();
    let temp = tempfile::tempdir().unwrap();
    let mut runtime = AgentRuntime::for_tests(temp.path());
    runtime.upload_workers = Arc::new(Semaphore::new(1));
    let store = Arc::new(crate::temp_store::TempStore::new(crate::temp_store::TempStoreConfig {
        base_dir: temp.path().join("uploads"), upload_folder_name: "scratch".into(),
        max_file_bytes: 1024, max_total_bytes: 1024,
    }).unwrap());
    runtime.temp_store = Some(store.clone());
    executor.block_on(async {
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let _gate = BlockingGate(Some(release_tx));
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let blocker = tokio::task::spawn_blocking(move || { started_tx.send(()).unwrap(); release_rx.recv().unwrap(); });
        started_rx.await.unwrap();
        let (sink, mut replies) = capture();
        let mut session = ConnectionSession::new(&mut runtime, sink, "agent".into());
        let cancel = FsCancellation::new();
        session.fs_cancellations.lock().unwrap().insert("file".into(), cancel.clone());
        let mut messages = vec![HubMessage::TempUploadBegin { req_id: "slow".into(), name: "slow.txt".into(), total_size: 17 }];
        for offset in 0..17 {
            messages.push(HubMessage::TempUploadChunk { req_id: "slow".into(), offset, data: vec![b'x'], done: false });
        }
        messages.push(HubMessage::Ping);
        messages.push(HubMessage::Cancel { req_id: "file".into() });
        assert_eq!(tokio::time::timeout(Duration::from_secs(1), session.drive(&mut incoming(messages))).await.unwrap(), DisconnectReason::HubClosed);
        assert!(cancel.is_cancelled());
        let mut failures = 0;
        loop {
            match response(&mut replies).await {
                AgentMessage::TempUploadResponse { error, .. } => { failures += 1; assert!(error.unwrap().starts_with("temp_upload_stalled")); }
                AgentMessage::Pong => break,
                AgentMessage::Heartbeat => {}
                other => panic!("unexpected reply: {other:?}"),
            }
        }
        assert_eq!(failures, 1);
        drop(session);
        // The queued native worker still holds its permit across reconnect.
        assert_eq!(runtime.upload_workers.available_permits(), 0);
        let (sink, mut new_replies) = capture();
        let mut replacement = ConnectionSession::new(&mut runtime, sink, "agent".into());
        replacement.dispatch(HubMessage::TempUploadBegin { req_id: "new".into(), name: "new.txt".into(), total_size: 1 }).await.unwrap();
        match response(&mut new_replies).await {
            AgentMessage::TempUploadResponse { error, .. } => assert!(error.unwrap().starts_with("agent_overloaded")),
            other => panic!("unexpected overload reply: {other:?}"),
        }
        drop(replacement);
        drop(_gate);
        blocker.await.unwrap();
        tokio::time::timeout(Duration::from_secs(1), async {
            while runtime.upload_workers.available_permits() == 0 { tokio::task::yield_now().await; }
        }).await.unwrap();
        assert!(!std::path::Path::new(&store.upload_dir_str()).join("slow.txt").exists());
        // Cancellation neither leaks quota nor poisons future uploads.
        let (sink, mut final_replies) = capture();
        let mut recovered = ConnectionSession::new(&mut runtime, sink, "agent".into());
        recovered.dispatch(HubMessage::TempUploadBegin { req_id: "ok".into(), name: "ok.txt".into(), total_size: 1 }).await.unwrap();
        recovered.dispatch(HubMessage::TempUploadChunk { req_id: "ok".into(), offset: 0, data: vec![b'y'], done: true }).await.unwrap();
        match response(&mut final_replies).await {
            AgentMessage::TempUploadResponse { error, size, .. } => { assert!(error.is_none()); assert_eq!(size, Some(1)); }
            other => panic!("unexpected upload reply: {other:?}"),
        }
        assert_eq!(std::fs::read(std::path::Path::new(&store.upload_dir_str()).join("ok.txt")).unwrap(), b"y");
        drop(recovered);
        assert!(replies.recv().await.is_none(), "cancelled worker sent a second terminal reply");
    });
}

#[test]
fn cancel_and_drop_cover_uploads_with_the_final_chunk_already_queued() {
    let executor = tokio::runtime::Builder::new_current_thread().enable_all().max_blocking_threads(1).build().unwrap();
    let temp = tempfile::tempdir().unwrap();
    let mut runtime = AgentRuntime::for_tests(temp.path());
    runtime.temp_store = Some(Arc::new(crate::temp_store::TempStore::new(crate::temp_store::TempStoreConfig {
        base_dir: temp.path().join("uploads"), upload_folder_name: "scratch".into(),
        max_file_bytes: 1, max_total_bytes: 2,
    }).unwrap()));
    let store = runtime.temp_store.clone().unwrap();
    executor.block_on(async {
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let gate = BlockingGate(Some(release_tx));
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let blocker = tokio::task::spawn_blocking(move || { started_tx.send(()).unwrap(); release_rx.recv().unwrap(); });
        started_rx.await.unwrap();
        let mut session = ConnectionSession::new(&mut runtime, futures_util::sink::drain(), "agent".into());
        for id in ["cancel", "drop"] {
            session.dispatch(HubMessage::TempUploadBegin { req_id: id.into(), name: format!("{id}.txt"), total_size: 1 }).await.unwrap();
            session.dispatch(HubMessage::TempUploadChunk { req_id: id.into(), offset: 0, data: vec![b'x'], done: true }).await.unwrap();
        }
        session.dispatch(HubMessage::Cancel { req_id: "cancel".into() }).await.unwrap();
        drop(session);
        drop(gate);
        blocker.await.unwrap();
        tokio::time::timeout(Duration::from_secs(1), async {
            while runtime.upload_workers.available_permits() < 4 { tokio::task::yield_now().await; }
        }).await.unwrap();
        for id in ["cancel", "drop"] {
            assert!(!std::path::Path::new(&store.upload_dir_str()).join(format!("{id}.txt")).exists());
        }
    });
}

#[tokio::test]
async fn partial_upload_cancel_and_drop_reap_staging_and_release_reserved_quota() {
    for explicit_cancel in [true, false] {
        let temp = tempfile::tempdir().unwrap();
        let mut runtime = AgentRuntime::for_tests(temp.path());
        let base = temp.path().join("uploads");
        let store = Arc::new(crate::temp_store::TempStore::new(crate::temp_store::TempStoreConfig {
            base_dir: base.clone(), upload_folder_name: "scratch".into(),
            max_file_bytes: 1024, max_total_bytes: 1024,
        }).unwrap());
        runtime.temp_store = Some(store.clone());
        let mut session = ConnectionSession::new(&mut runtime, futures_util::sink::drain(), "agent".into());
        session.dispatch(HubMessage::TempUploadBegin { req_id: "partial".into(), name: "partial.txt".into(), total_size: 512 }).await.unwrap();
        session.dispatch(HubMessage::TempUploadChunk { req_id: "partial".into(), offset: 0, data: vec![b'x'], done: false }).await.unwrap();
        let staging = base.join(".staging/partial");
        tokio::time::timeout(Duration::from_secs(2), async {
            while std::fs::metadata(&staging).map(|file| file.len()).unwrap_or(0) != 1 {
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
        }).await.unwrap();
        if explicit_cancel { session.dispatch(HubMessage::Cancel { req_id: "partial".into() }).await.unwrap(); }
        drop(session);
        tokio::time::timeout(Duration::from_secs(2), async {
            while runtime.upload_workers.available_permits() < 4 { tokio::task::yield_now().await; }
        }).await.unwrap();
        assert!(!staging.exists());
        assert!(!base.join("scratch/partial.txt").exists());
        let (sink, mut replies) = capture();
        let mut recovered = ConnectionSession::new(&mut runtime, sink, "agent".into());
        // Consumes the entire quota: an unreleased partial reservation fails.
        recovered.dispatch(HubMessage::TempUploadBegin { req_id: "full".into(), name: "full.txt".into(), total_size: 1024 }).await.unwrap();
        recovered.dispatch(HubMessage::TempUploadChunk { req_id: "full".into(), offset: 0, data: vec![b'y'; 1024], done: true }).await.unwrap();
        match response(&mut replies).await {
            AgentMessage::TempUploadResponse { error, size, .. } => { assert!(error.is_none()); assert_eq!(size, Some(1024)); }
            other => panic!("unexpected quota recovery reply: {other:?}"),
        }
    }
}

#[tokio::test]
async fn protocol_sized_upload_chunks_and_empty_final_frames_publish_exact_bytes() {
    let cap = filebox_protocol::message::FILE_CHUNK_MAX_BYTES as usize;
    for total in [0, 2 * cap, 2 * cap + 7] {
        let temp = tempfile::tempdir().unwrap();
        let mut runtime = AgentRuntime::for_tests(temp.path());
        let base = temp.path().join("uploads");
        runtime.temp_store = Some(Arc::new(crate::temp_store::TempStore::new(crate::temp_store::TempStoreConfig {
            base_dir: base.clone(), upload_folder_name: "scratch".into(),
            max_file_bytes: 4 * cap as u64, max_total_bytes: 8 * cap as u64,
        }).unwrap()));
        let (sink, mut replies) = capture();
        let mut session = ConnectionSession::new(&mut runtime, sink, "agent".into());
        let data: Vec<_> = (0..total).map(|offset| (offset % 251) as u8).collect();
        session.dispatch(HubMessage::TempUploadBegin { req_id: "upload".into(), name: "file.bin".into(), total_size: total as u64 }).await.unwrap();
        let full = total / cap * cap;
        for (index, chunk) in data[..full].chunks(cap).enumerate() {
            session.dispatch(HubMessage::TempUploadChunk {
                req_id: "upload".into(), offset: (index * cap) as u64, data: chunk.to_vec(), done: false,
            }).await.unwrap();
        }
        session.dispatch(HubMessage::TempUploadChunk {
            req_id: "upload".into(), offset: full as u64, data: data[full..].to_vec(), done: true,
        }).await.unwrap();
        match response(&mut replies).await {
            AgentMessage::TempUploadResponse { error, size, .. } => { assert!(error.is_none()); assert_eq!(size, Some(total as u64)); }
            other => panic!("unexpected upload reply: {other:?}"),
        }
        assert_eq!(std::fs::read(base.join("scratch/file.bin")).unwrap(), data);
    }
}

#[tokio::test]
async fn ai_agents_setting_update_persists_and_cancels_running_requests() {
    let temp = tempfile::tempdir().unwrap();
    let mut runtime = AgentRuntime::for_tests(temp.path());
    runtime.ai_agents_environment_override = None;
    let active = Arc::new(AtomicBool::new(false));
    runtime
        .ai_agent_cancels
        .lock()
        .unwrap()
        .insert("active".into(), active.clone());
    let ai_agent_cancels = runtime.ai_agent_cancels.clone();
    let (sink, mut replies) = capture();
    let mut session = ConnectionSession::new(&mut runtime, sink, "agent".into());
    session
        .dispatch(HubMessage::AiAgentSettingsSet {
            req_id: "settings".into(),
            enabled: false,
            backend: None,
        })
        .await
        .unwrap();

    match response(&mut replies).await {
        AgentMessage::AiAgentSettingsApplied {
            req_id,
            ai_agents,
            error,
        } => {
            assert_eq!(req_id, "settings");
            assert!(!ai_agents.settings.enabled);
            assert!(ai_agents.settings.environment_override.is_none());
            assert!(!ai_agents.available);
            assert!(error.is_none());
        }
        other => panic!("unexpected response: {other:?}"),
    }
    assert!(active.load(Ordering::Relaxed));
    assert!(ai_agent_cancels.lock().unwrap().is_empty());
    assert!(!crate::config_store::PersistedConfig::load_or_create(&temp.path().to_path_buf()).ai_agents_enabled);
}

#[tokio::test]
async fn ai_agents_settings_enforce_field_locks_and_reject_unknown_kinds() {
    let temp = tempfile::tempdir().unwrap();
    let mut runtime = AgentRuntime::for_tests(temp.path());
    runtime.ai_agents_environment_override = Some(false);
    let (sink, _) = capture();
    let mut session = ConnectionSession::new(&mut runtime, sink, "agent".into());

    assert!(session
        .apply_ai_agent_settings(false, Some("herdr".into()), crate::ai_agents::BACKEND_KINDS)
        .await
        .is_none());
    assert!(session.runtime.resource_mgr.ai_agents_enabled());
    assert_eq!(session.runtime.resource_mgr.ai_agents_backend(), Some("herdr"));

    session.runtime.ai_agents_backend_environment_override = Some("herdr".into());
    assert_eq!(
        session
            .apply_ai_agent_settings(false, None, crate::ai_agents::BACKEND_KINDS)
            .await
            .as_deref(),
        Some("ai_agents_environment_override")
    );
    assert_eq!(session.runtime.resource_mgr.ai_agents_backend(), Some("herdr"));

    session.runtime.ai_agents_backend_environment_override = None;
    session.runtime.ai_agents_environment_override = None;
    assert_eq!(
        session
            .apply_ai_agent_settings(true, Some("unknown".into()), crate::ai_agents::BACKEND_KINDS)
            .await
            .as_deref(),
        Some("invalid_request")
    );
    assert_eq!(session.runtime.resource_mgr.ai_agents_backend(), Some("herdr"));
}

#[tokio::test]
async fn unknown_backend_environment_lock_allows_enabled_toggle() {
    let temp = tempfile::tempdir().unwrap();
    let mut runtime = AgentRuntime::for_tests(temp.path());
    runtime.ai_agents_environment_override = None;
    runtime
        .resource_mgr
        .set_ai_agents_settings(true, Some("herdr".into()))
        .unwrap();
    runtime.ai_agents_backend_environment_override = Some("unknown".into());
    let (sink, _) = capture();
    let mut session = ConnectionSession::new(&mut runtime, sink, "agent".into());

    assert!(session
        .apply_ai_agent_settings(false, Some("unknown".into()), crate::ai_agents::BACKEND_KINDS)
        .await
        .is_none());
    assert!(!session.runtime.resource_mgr.ai_agents_enabled());
    assert_eq!(session.runtime.resource_mgr.ai_agents_backend(), Some("herdr"));
    let persisted =
        crate::config_store::PersistedConfig::load_or_create(&temp.path().to_path_buf());
    assert!(!persisted.ai_agents_enabled);
    assert_eq!(persisted.ai_agents_backend.as_deref(), Some("herdr"));
}

#[test]
fn ai_agent_reprobe_requires_enable_transition_or_changed_missing_selection() {
    let should_reprobe = super::ai_agents::should_reprobe;
    assert!(should_reprobe(false, true, Some("a"), Some("a"), false));
    assert!(should_reprobe(true, true, Some("a"), Some("b"), false));
    assert!(!should_reprobe(true, true, Some("a"), Some("a"), false));
    assert!(!should_reprobe(true, true, Some("a"), Some("b"), true));
    assert!(!should_reprobe(false, false, Some("a"), Some("b"), false));
}

#[tokio::test]
async fn ai_agent_requests_stay_bound_to_the_selected_backend() {
    let temp = tempfile::tempdir().unwrap();
    let mut runtime = AgentRuntime::for_tests(temp.path());
    runtime.ai_agents_environment_override = None;
    runtime.ai_agents_backend_environment_override = None;
    runtime.resource_mgr.set_ai_agents_settings(true, Some("b".into())).unwrap();
    let calls_a = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let calls_b = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    runtime.ai_agent_backends = vec![
        Arc::new(CountingAiAgentBackend { kind: "a", calls: calls_a.clone() })
            as Arc<dyn crate::ai_agents::AiAgentBackend>,
        Arc::new(CountingAiAgentBackend { kind: "b", calls: calls_b.clone() })
            as Arc<dyn crate::ai_agents::AiAgentBackend>,
    ];
    let (sink, mut replies) = capture();
    let mut session = ConnectionSession::new(&mut runtime, sink, "agent".into());

    session
        .dispatch(HubMessage::AiAgentRequest {
            req_id: "wrong-backend".into(),
            op: filebox_protocol::ai_agents::AiAgentOp::Status,
            backend: Some("a".into()),
            target: None,
            text: None,
            keys: Vec::new(),
            lines: None,
            read_source: None,
            wait: false,
            timeout_ms: None,
        })
        .await
        .unwrap();
    match response(&mut replies).await {
        AgentMessage::AiAgentResponse { error, status, agents, .. } => {
            assert_eq!(error.as_deref(), Some("ai_agent_backend_changed"));
            assert!(status.is_none());
            assert!(agents.is_empty());
        }
        other => panic!("unexpected response: {other:?}"),
    }
    assert_eq!(calls_a.load(Ordering::SeqCst), 0);
    assert_eq!(calls_b.load(Ordering::SeqCst), 0);
    assert_eq!(session.runtime.ai_agent_inflight.available_permits(), 1);

    for (req_id, backend) in [("unbound", None), ("matching", Some("b"))] {
        session
            .dispatch(HubMessage::AiAgentRequest {
                req_id: req_id.into(),
                op: filebox_protocol::ai_agents::AiAgentOp::Status,
                backend: backend.map(str::to_owned),
                target: None,
                text: None,
                keys: Vec::new(),
                lines: None,
                read_source: None,
                wait: false,
                timeout_ms: None,
            })
            .await
            .unwrap();
        match response(&mut replies).await {
            AgentMessage::AiAgentResponse { error, status, agents, .. } => {
                assert!(error.is_none());
                assert!(status.is_some_and(|status| status.reachable));
                assert!(agents.is_empty());
            }
            other => panic!("unexpected response: {other:?}"),
        }
    }
    assert_eq!(calls_a.load(Ordering::SeqCst), 0);
    assert_eq!(calls_b.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn ai_agent_request_reports_a_backend_that_is_not_detected() {
    let temp = tempfile::tempdir().unwrap();
    let mut runtime = AgentRuntime::for_tests(temp.path());
    runtime.ai_agents_environment_override = None;
    runtime.ai_agents_backend_environment_override = Some("missing".into());
    let (sink, mut replies) = capture();
    let mut session = ConnectionSession::new(&mut runtime, sink, "agent".into());
    session
        .dispatch(HubMessage::AiAgentRequest {
            req_id: "not-detected".into(),
            op: filebox_protocol::ai_agents::AiAgentOp::Status,
            backend: Some("missing".into()),
            target: None,
            text: None,
            keys: Vec::new(),
            lines: None,
            read_source: None,
            wait: false,
            timeout_ms: None,
        })
        .await
        .unwrap();
    match response(&mut replies).await {
        AgentMessage::AiAgentResponse { error, status, agents, .. } => {
            assert_eq!(error.as_deref(), Some("ai_agent_backend_not_detected"));
            assert_eq!(
                status.and_then(|status| status.message).as_deref(),
                Some("The selected AI agent backend is not detected on this Agent")
            );
            assert!(agents.is_empty());
        }
        other => panic!("unexpected response: {other:?}"),
    }
}

#[tokio::test]
async fn ai_agents_direct_request_is_rejected_when_disabled() {
    let temp = tempfile::tempdir().unwrap();
    let mut runtime = AgentRuntime::for_tests(temp.path());
    runtime.ai_agents_environment_override = None;
    runtime
        .resource_mgr
        .set_ai_agents_settings(false, None)
        .unwrap();
    let (sink, mut replies) = capture();
    let mut session = ConnectionSession::new(&mut runtime, sink, "agent".into());
    session
        .dispatch(HubMessage::AiAgentRequest {
            req_id: "direct".into(),
            op: filebox_protocol::ai_agents::AiAgentOp::Status,
            backend: None,
            target: None,
            text: None,
            keys: vec![],
            lines: None,
            read_source: None,
            wait: false,
            timeout_ms: None,
        })
        .await
        .unwrap();

    match response(&mut replies).await {
        AgentMessage::AiAgentResponse { req_id, error, .. } => {
            assert_eq!(req_id, "direct");
            assert_eq!(error.as_deref(), Some("ai_agents_disabled"));
        }
        other => panic!("unexpected response: {other:?}"),
    }
}
