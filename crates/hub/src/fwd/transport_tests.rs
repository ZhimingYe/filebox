use super::*;
use crate::fwd::{admission, pool};

#[tokio::test]
async fn unauthenticated_document_preserves_original_target_but_fetches_remain_unauthorized() {
    let harness = harness().await;
    let client = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).build().unwrap();
    let path = format!("/_fwd/agent/{}/lab?token=demo&path=My%20Notebook.ipynb", harness.port);
    for dest in ["document", "iframe"] {
        let response = client.get(format!("{}{path}", harness.hub)).header("sec-fetch-dest", dest).send().await.unwrap();
        assert_eq!(response.status(), StatusCode::SEE_OTHER);
        let location = response.headers()[header::LOCATION].to_str().unwrap();
        assert!(location.starts_with("/?next=%2F_fwd%2F"));
        assert_eq!(url::form_urlencoded::parse(location.trim_start_matches("/?").as_bytes()).find(|(key, _)| key == "next").unwrap().1, path);
    }
    for dest in [None, Some("empty"), Some("manifest"), Some("script")] {
        let mut request = client.get(format!("{}{path}", harness.hub));
        if let Some(dest) = dest { request = request.header("sec-fetch-dest", dest); }
        assert_eq!(request.send().await.unwrap().status(), StatusCode::UNAUTHORIZED);
    }
    assert_eq!(client.post(format!("{}{path}", harness.hub)).header("sec-fetch-dest", "document").send().await.unwrap().status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn rewritten_manifest_works_without_cookies_but_not_for_other_paths_destinations_or_after_logout() {
    let harness = harness().await;
    let client = reqwest::Client::new();
    let base = format!("{}/_fwd/agent/{}", harness.hub, harness.port);
    let response = client.get(format!("{base}/")).header(header::COOKIE, &harness.cookie).header("sec-fetch-dest", "document").send().await.unwrap();
    assert_eq!(response.headers()[header::CACHE_CONTROL], "private, no-store");
    let html = response.text().await.unwrap();
    let href = html.split("href=\"").nth(1).unwrap().split('"').next().unwrap().replace("&amp;", "&");
    assert!(href.contains("__filebox_manifest="));
    for dest in [None, Some("manifest")] {
        let mut request = client.get(&href);
        if let Some(dest) = dest { request = request.header("sec-fetch-dest", dest); }
        let response = request.send().await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CACHE_CONTROL], "private, no-store");
        let body: serde_json::Value = response.json().await.unwrap();
        assert_eq!(body["upstream_uri"], "/manifest.json?v=1&name=Demo");
    }
    assert_eq!(client.get(&href).header("sec-fetch-dest", "script").send().await.unwrap().status(), StatusCode::UNAUTHORIZED);
    assert_eq!(client.get(href.replace("manifest.json", "events")).send().await.unwrap().status(), StatusCode::UNAUTHORIZED);
    assert_eq!(client.post(&href).send().await.unwrap().status(), StatusCode::UNAUTHORIZED);
    let endpoint = format!("{base}/__filebox_manifest_token");
    let response = client.get(&endpoint).header(header::COOKIE, &harness.cookie).query(&[("url", format!("{base}/manifest.json?dynamic=1"))]).send().await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body: serde_json::Value = response.json().await.unwrap();
    assert_eq!(client.get(body["href"].as_str().unwrap()).send().await.unwrap().status(), StatusCode::OK);
    assert_eq!(client.get(&endpoint).query(&[("url", format!("{base}/manifest.json"))]).send().await.unwrap().status(), StatusCode::UNAUTHORIZED);
    {
        let mut inner = harness.state.inner.write().await;
        let sid = inner.sessions.get_session_by_principal(&harness.principal).unwrap().session_id.clone();
        inner.sessions.remove(&sid);
    }
    assert_eq!(client.get(&href).send().await.unwrap().status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test(start_paused = true)]
async fn admission_queues_until_capacity_or_thirty_seconds_and_is_cancellable() {
    let limit = Arc::new(Semaphore::new(256));
    let all = limit.clone().acquire_many_owned(256).await.unwrap();
    let cancel = CancellationToken::new();
    let task_limit = limit.clone();
    let task_cancel = cancel.clone();
    let waiting = tokio::spawn(async move { admission(task_limit, &task_cancel).await });
    tokio::task::yield_now().await;
    assert!(!waiting.is_finished());
    drop(all);
    drop(waiting.await.unwrap().unwrap());
    assert_eq!(limit.available_permits(), 256);
    let all = limit.clone().acquire_many_owned(256).await.unwrap();
    let start = tokio::time::Instant::now();
    assert_eq!(admission(limit.clone(), &cancel).await.unwrap_err(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(start.elapsed(), Duration::from_secs(30));
    cancel.cancel();
    assert_eq!(admission(limit.clone(), &cancel).await.unwrap_err(), StatusCode::SERVICE_UNAVAILABLE);
    drop(all);
    limit.close();
    assert_eq!(admission(limit, &CancellationToken::new()).await.unwrap_err(), StatusCode::SERVICE_UNAVAILABLE);
}

async fn read(harness: &Harness, path: &str) -> Vec<u8> {
    reqwest::Client::new().get(format!("{}/_fwd/agent/{}{path}", harness.hub, harness.port))
        .header(header::COOKIE, &harness.cookie).header(header::ACCEPT, "text/html").send().await.unwrap().bytes().await.unwrap().to_vec()
}

#[tokio::test]
async fn pool_reuses_only_completed_successes_and_clean_eof_does_not_truncate_html() {
    let harness = harness().await;
    read(&harness, "/").await;
    let key = ("agent".to_string(), harness.port);
    let first = harness.state.tunnels.take_idle(&key).unwrap();
    let token = first.cancel.clone();
    harness.state.tunnels.put_idle(key.clone(), first);
    read(&harness, "/").await;
    assert!(!token.is_cancelled());
    assert_eq!(harness.state.tunnels.generations.lock().unwrap().values().next().unwrap().limit.available_permits(), 255);
    assert!(!harness.state.tunnels.idle.lock().unwrap()[&key].is_empty());
    read(&harness, "/bad").await;
    assert!(token.is_cancelled());
    assert!(harness.state.tunnels.take_idle(&key).is_none());
    for _ in 0..3 {
        let body = read(&harness, "/large-close").await;
        assert_eq!(body.len(), 8 * 1024 * 1024 + 6 + crate::fwd::rewrite::SHIM.len() + 17);
        assert!(harness.state.tunnels.take_idle(&key).is_none());
    }
    let response = reqwest::Client::new().get(format!("{}/_fwd/agent/{}/broken", harness.hub, harness.port)).header(header::COOKIE, &harness.cookie).send().await.unwrap();
    assert!(response.bytes().await.is_err());
    assert!(harness.state.tunnels.take_idle(&key).is_none());
}

#[tokio::test]
async fn pool_is_forward_scoped_bounded_expires_and_does_not_reclaim_checked_out_connections() {
    let harness = harness().await;
    let key = ("agent".to_string(), harness.port);
    let mut connections = Vec::new();
    for _ in 0..17 { connections.push(pool::connect(&harness.state, "agent", harness.port, false).await.unwrap()); }
    let rejected = connections.last().unwrap().cancel.clone();
    for connection in connections { harness.state.tunnels.put_idle(key.clone(), connection); }
    assert_eq!(harness.state.tunnels.idle.lock().unwrap()[&key].len(), 16);
    assert!(rejected.is_cancelled());
    assert!(harness.state.tunnels.take_idle(&("other".into(), harness.port)).is_none());
    assert!(harness.state.tunnels.take_idle(&("agent".into(), 1)).is_none());
    let checked_out = harness.state.tunnels.take_idle(&key).unwrap();
    let live = checked_out.cancel.clone();
    // Aging an idle entry is deterministic without advancing network heartbeat timers.
    harness.state.tunnels.idle.lock().unwrap().get_mut(&key).unwrap().iter_mut().for_each(|entry| entry.since -= Duration::from_secs(31));
    assert!(harness.state.tunnels.take_idle(&key).is_none());
    assert!(!live.is_cancelled());
    drop(checked_out);
    assert!(live.is_cancelled());
}

async fn socket(harness: &Harness) -> tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>> {
    let mut request = format!("{}/_fwd/agent/{}/socket", harness.hub.replace("http:", "ws:"), harness.port).into_client_request().unwrap();
    request.headers_mut().insert(header::COOKIE, harness.cookie.parse().unwrap());
    request.headers_mut().insert(header::ORIGIN, harness.hub.parse().unwrap());
    tokio_tungstenite::connect_async(request).await.unwrap().0
}

#[tokio::test]
async fn logout_expiry_deletion_and_disconnect_close_upgraded_connections() {
    for reason in ["logout", "expiry", "delete", "disconnect"] {
        let harness = harness().await;
        if reason == "expiry" {
            let mut inner = harness.state.inner.write().await;
            let mut session = inner.sessions.get_session_by_principal(&harness.principal).unwrap().clone();
            session.expires_at = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() + 1;
            inner.sessions.sessions_insert_for_test(session);
        }
        let mut socket = socket(&harness).await;
        socket.send(tokio_tungstenite::tungstenite::Message::Text("live".into())).await.unwrap();
        assert_eq!(socket.next().await.unwrap().unwrap().into_text().unwrap(), "live");
        assert!(harness.state.tunnels.idle.lock().unwrap().is_empty());
        let client = reqwest::Client::new();
        match reason {
            "logout" => {
                let response = client.post(format!("{}/api/session/logout", harness.hub)).header(header::COOKIE, &harness.cookie).header("x-csrf-token", &harness.csrf).send().await.unwrap();
                assert_eq!(response.status(), StatusCode::OK);
            }
            "delete" => {
                harness.state.inner.write().await.agents.get_mut("agent").unwrap().status = crate::agent_registry::AgentStatus::Offline;
                let response = client.delete(format!("{}/api/agents/agent/forwards", harness.hub)).header(header::COOKIE, &harness.cookie).header("x-csrf-token", &harness.csrf).json(&serde_json::json!({"port": harness.port})).send().await.unwrap();
                assert_eq!(response.status(), StatusCode::OK);
            }
            "disconnect" => {
                let generation = harness.state.inner.read().await.agents.get("agent").unwrap().connection_id;
                harness.state.tunnels.disconnect("agent", generation);
            }
            _ => {}
        }
        let end = tokio::time::timeout(Duration::from_secs(4), socket.next()).await.unwrap();
        assert!(matches!(end, None | Some(Err(_)) | Some(Ok(tokio_tungstenite::tungstenite::Message::Close(_)))), "{reason}: {end:?}");
    }
}

#[tokio::test]
async fn cancellation_is_principal_and_forward_scoped_and_aborts_streaming_http() {
    let harness = harness().await;
    let mut response = reqwest::Client::new().get(format!("{}/_fwd/agent/{}/events", harness.hub, harness.port)).header(header::COOKIE, &harness.cookie).send().await.unwrap();
    assert_eq!(response.chunk().await.unwrap().unwrap(), "data: first\n\n");
    harness.state.tunnels.cancel_session("other");
    harness.state.tunnels.cancel_forward("agent", harness.port + 1);
    assert!(!harness.state.tunnels.active.lock().unwrap().values().next().unwrap().cancel.is_cancelled());
    harness.state.tunnels.cancel_forward("agent", harness.port);
    assert!(tokio::time::timeout(Duration::from_secs(2), response.chunk()).await.unwrap().is_err());
}

#[tokio::test]
async fn keep_prefix_preserves_upstream_path_query_and_patch_coalesces_offline() {
    let harness = harness().await;
    harness.state.inner.write().await.agents.get_mut("agent").unwrap().forwards[0].keep_prefix = true;
    let path = format!("/_fwd/agent/{}/app?q=a%2Fb", harness.port);
    let response = reqwest::Client::new().get(format!("{}{path}", harness.hub)).header(header::COOKIE, &harness.cookie).send().await.unwrap();
    assert_eq!(response.text().await.unwrap(), path);
    let mut websocket = socket(&harness).await;
    websocket.send(tokio_tungstenite::tungstenite::Message::Text("prefix".into())).await.unwrap();
    assert_eq!(websocket.next().await.unwrap().unwrap().into_text().unwrap(), "prefix");
    harness.state.inner.write().await.agents.get_mut("agent").unwrap().status = crate::agent_registry::AgentStatus::Offline;
    let client = reqwest::Client::new();
    for keep_prefix in [false, true] {
        let response = client.patch(format!("{}/api/agents/agent/forwards", harness.hub)).header(header::COOKIE, &harness.cookie).header("x-csrf-token", &harness.csrf).json(&serde_json::json!({"port": harness.port, "keep_prefix":keep_prefix})).send().await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(harness.state.inner.read().await.agents.get("agent").unwrap().pending_forwards.as_ref().unwrap().1[0].keep_prefix, keep_prefix);
    }
    let missing = client.patch(format!("{}/api/agents/agent/forwards", harness.hub)).header(header::COOKIE, &harness.cookie).header("x-csrf-token", &harness.csrf).json(&serde_json::json!({"port":0,"keep_prefix":true})).send().await.unwrap();
    assert_eq!(missing.status(), StatusCode::NOT_FOUND);
}
