use super::*;

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

#[tokio::test]
async fn terminal_management_burst_survives_a_full_output_queue() {
    let temp = tempfile::tempdir().unwrap();
    let mut runtime = AgentRuntime::for_tests(temp.path());
    let (sink, mut replies) = capture();
    let mut session = ConnectionSession::new(&mut runtime, sink, "agent".into());
    // No yield yet: PTY output occupies every slot before list requests arrive.
    for _ in 0..64 {
        session.term_tx.try_send(AgentMessage::TerminalOutput { req_id: "shell".into(), data: vec![b'x'] }).unwrap();
    }
    let mut messages: Vec<_> = (0..80).map(|i| HubMessage::TerminalListRequest { req_id: format!("list-{i}") }).collect();
    messages.push(HubMessage::Ping);
    assert_eq!(session.drive(&mut incoming(messages)).await, DisconnectReason::HubClosed);
    let mut ids = std::collections::HashSet::new();
    let mut pong = false;
    while ids.len() < 80 || !pong {
        match response(&mut replies).await {
            AgentMessage::TerminalListResponse { req_id, .. } => assert!(ids.insert(req_id)),
            AgentMessage::Pong => pong = true,
            AgentMessage::Heartbeat | AgentMessage::TerminalOutput { .. } => {}
            other => panic!("unexpected reply: {other:?}"),
        }
    }
    session.shutdown().await;
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
    let cancellation = FsCancellation::new();
    let cancellation_for_task = cancellation.clone();
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
    let parent = tokio::spawn(async move {
        let mut session = ConnectionSession::new(&mut runtime, futures_util::sink::drain(), "agent".into());
        session.fs_cancellations.lock().unwrap().insert("file".into(), cancellation_for_task);
        let queued = session.stats_admission.clone().acquire_owned().await.unwrap();
        session.tasks.spawn(async move { let _permit = queued; std::future::pending::<()>().await; });
        ready_tx.send((session.term_tx.clone(), session.fs_tx.clone(), session.stats_admission.clone())).unwrap();
        let mut read = futures_util::stream::pending::<Result<Message, std::io::Error>>();
        session.drive(&mut read).await;
    });
    let (term_tx, fs_tx, stats_admission) = ready_rx.await.unwrap();
    parent.abort();
    assert!(parent.await.unwrap_err().is_cancelled());
    assert!(cancellation.is_cancelled());
    assert!(search_flag.load(Ordering::Relaxed));
    tokio::time::timeout(Duration::from_secs(1), async {
        term_tx.closed().await; fs_tx.closed().await;
        while stats_admission.available_permits() < 8 { tokio::task::yield_now().await; }
    }).await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn session_drop_detaches_its_pty_and_preserves_shell_for_resume() {
    const SECRET: &str = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PX";
    fn code(offset: u64) -> String {
        let raw = filebox_protocol::totp::base32_decode(SECRET).unwrap();
        format!("{:06}", filebox_protocol::totp::totp_at(&raw, filebox_protocol::totp::current_counter() + offset))
    }
    let temp = tempfile::tempdir().unwrap();
    let mut runtime = AgentRuntime::for_tests(temp.path());
    runtime.terminal_manager = Arc::new(crate::terminal::TerminalManager::new(Some(SECRET.into())));
    let manager = runtime.terminal_manager.clone();
    struct CloseShell(Arc<crate::terminal::TerminalManager>);
    impl Drop for CloseShell { fn drop(&mut self) { self.0.close("shell"); } }
    let _shell_guard = CloseShell(manager.clone());
    let (sink, mut replies) = capture();
    let mut session = ConnectionSession::new(&mut runtime, sink, "agent".into());
    session.dispatch(HubMessage::TerminalOpen {
        req_id: "shell".into(), cols: 80, rows: 24, agent_totp_code: Some(code(0)),
    }).unwrap();
    loop {
        if let AgentMessage::TerminalOpened { error, .. } = response(&mut replies).await { assert!(error.is_none()); break; }
    }
    drop(session);
    assert_eq!(manager.list().len(), 1);
    let (tx, mut rx) = mpsc::channel(64);
    manager.attach("resume".into(), "shell".into(), Some(code(1)), tx);
    match tokio::time::timeout(Duration::from_secs(5), rx.recv()).await.unwrap().unwrap() {
        AgentMessage::TerminalOpened { error, req_id, .. } => { assert!(error.is_none()); assert_eq!(req_id, "resume"); }
        other => panic!("unexpected resume response: {other:?}"),
    }
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
        replacement.dispatch(HubMessage::TempUploadBegin { req_id: "new".into(), name: "new.txt".into(), total_size: 1 }).unwrap();
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
        recovered.dispatch(HubMessage::TempUploadBegin { req_id: "ok".into(), name: "ok.txt".into(), total_size: 1 }).unwrap();
        recovered.dispatch(HubMessage::TempUploadChunk { req_id: "ok".into(), offset: 0, data: vec![b'y'], done: true }).unwrap();
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
            session.dispatch(HubMessage::TempUploadBegin { req_id: id.into(), name: format!("{id}.txt"), total_size: 1 }).unwrap();
            session.dispatch(HubMessage::TempUploadChunk { req_id: id.into(), offset: 0, data: vec![b'x'], done: true }).unwrap();
        }
        session.dispatch(HubMessage::Cancel { req_id: "cancel".into() }).unwrap();
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
        session.dispatch(HubMessage::TempUploadBegin { req_id: "partial".into(), name: "partial.txt".into(), total_size: 512 }).unwrap();
        session.dispatch(HubMessage::TempUploadChunk { req_id: "partial".into(), offset: 0, data: vec![b'x'], done: false }).unwrap();
        let staging = base.join(".staging/partial");
        tokio::time::timeout(Duration::from_secs(2), async {
            while std::fs::metadata(&staging).map(|file| file.len()).unwrap_or(0) != 1 {
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
        }).await.unwrap();
        if explicit_cancel { session.dispatch(HubMessage::Cancel { req_id: "partial".into() }).unwrap(); }
        drop(session);
        tokio::time::timeout(Duration::from_secs(2), async {
            while runtime.upload_workers.available_permits() < 4 { tokio::task::yield_now().await; }
        }).await.unwrap();
        assert!(!staging.exists());
        assert!(!base.join("scratch/partial.txt").exists());
        let (sink, mut replies) = capture();
        let mut recovered = ConnectionSession::new(&mut runtime, sink, "agent".into());
        // Consumes the entire quota: an unreleased partial reservation fails.
        recovered.dispatch(HubMessage::TempUploadBegin { req_id: "full".into(), name: "full.txt".into(), total_size: 1024 }).unwrap();
        recovered.dispatch(HubMessage::TempUploadChunk { req_id: "full".into(), offset: 0, data: vec![b'y'; 1024], done: true }).unwrap();
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
        session.dispatch(HubMessage::TempUploadBegin { req_id: "upload".into(), name: "file.bin".into(), total_size: total as u64 }).unwrap();
        let full = total / cap * cap;
        for (index, chunk) in data[..full].chunks(cap).enumerate() {
            session.dispatch(HubMessage::TempUploadChunk {
                req_id: "upload".into(), offset: (index * cap) as u64, data: chunk.to_vec(), done: false,
            }).unwrap();
        }
        session.dispatch(HubMessage::TempUploadChunk {
            req_id: "upload".into(), offset: full as u64, data: data[full..].to_vec(), done: true,
        }).unwrap();
        match response(&mut replies).await {
            AgentMessage::TempUploadResponse { error, size, .. } => { assert!(error.is_none()); assert_eq!(size, Some(total as u64)); }
            other => panic!("unexpected upload reply: {other:?}"),
        }
        assert_eq!(std::fs::read(base.join("scratch/file.bin")).unwrap(), data);
    }
}
