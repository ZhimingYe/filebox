use super::*;
use filebox_protocol::{forwards::ForwardConfig, resources::Capabilities};
use axum::{extract::ws::WebSocketUpgrade, http::header, routing::get};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use base64::Engine;
use sha2::{Digest, Sha256};
use std::sync::atomic::{AtomicUsize, Ordering};

#[path = "../../../agent/src/tunnel.rs"]
mod agent_tunnel;

#[test]
fn tickets_are_single_use_expiring_and_generation_bound() {
    let store = TunnelStore::default();
    let (tx, _rx) = oneshot::channel();
    store.tickets.lock().unwrap().insert("secret".into(), Ticket {
        agent: "agent".into(), generation: 3, expires: Instant::now() + Duration::from_secs(10), tx,
    });
    assert!(store.take("secret", "other", 3).is_none());
    assert!(store.take("secret", "agent", 2).is_none());
    assert!(store.take("secret", "agent", 3).is_some());
    assert!(store.take("secret", "agent", 3).is_none());
    let (tx, _rx) = oneshot::channel();
    store.tickets.lock().unwrap().insert("expired".into(), Ticket {
        agent: "agent".into(), generation: 3, expires: Instant::now() - Duration::from_secs(1), tx,
    });
    assert!(store.take("expired", "agent", 3).is_none());
    let cancel = CancellationToken::new();
    store.generations.lock().unwrap().insert(("agent".into(), 3), Generation { cancel: cancel.clone(), limit: Arc::new(Semaphore::new(64)) });
    store.disconnect("agent", 2);
    assert!(!cancel.is_cancelled());
    store.disconnect("agent", 3);
    assert!(cancel.is_cancelled());
    assert!(store.tickets.lock().unwrap().is_empty());
}

struct Harness { hub: String, port: u16, cookie: String, state: AppState, principal: String, csrf: String, hits: Arc<AtomicUsize>, tasks: Vec<tokio::task::JoinHandle<()>> }
impl Drop for Harness { fn drop(&mut self) { for task in &self.tasks { task.abort(); } } }

async fn harness() -> Harness {
    let local = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = local.local_addr().unwrap().port();
    let hits = Arc::new(AtomicUsize::new(0));
    let upstream_hits = hits.clone();
    let local_app = Router::new().route("/", get(|headers: HeaderMap| async move {
        assert!(headers["x-forwarded-prefix"].to_str().unwrap().starts_with("/_fwd/agent/"));
        assert!(headers[header::HOST].to_str().unwrap().starts_with("127.0.0.1:"));
        assert!(!headers.get(header::COOKIE).and_then(|v| v.to_str().ok()).unwrap_or_default().contains("filebox_session"));
        axum::response::Html("<!doctype html><head><title>Forward test</title><link rel=manifest href='/manifest.json?v=1&amp;name=Demo'></head><body>local service</body>")
    })).route("/socket", get(|ws: WebSocketUpgrade| async move { ws.on_upgrade(|mut socket| async move {
        while let Some(Ok(message)) = socket.recv().await { if socket.send(message).await.is_err() { break; } }
    }) }))
        .route("/echo", axum::routing::post(|bytes: axum::body::Bytes| async move { bytes }))
        .route("/authority", axum::routing::post(|headers: HeaderMap| async move {
            ([(header::LOCATION, "https://hub.test:8983/next")], headers[header::HOST].to_str().unwrap().to_string())
        }).get(|headers: HeaderMap, uri: axum::http::Uri| async move {
            axum::Json(serde_json::json!({"host":headers[header::HOST].to_str().unwrap(), "uri":uri.to_string()}))
        }))
        .route("/authority-html", get(|| async { axum::response::Html("<head><base href='https://hub.test:8983/app/'></head>") }))
        .route("/authority-socket", get(|headers: HeaderMap, ws: WebSocketUpgrade| async move {
            ws.on_upgrade(move |mut socket| async move {
                socket.send(axum::extract::ws::Message::Text(headers[header::HOST].to_str().unwrap().to_string().into())).await.unwrap();
            })
        }))
        .route("/large", get(|| async { axum::response::Html(format!("<head>{}", "x".repeat(8 * 1024 * 1024))) }))
        .route("/large-close", get(|| async { ([(header::CONNECTION, "close")], axum::response::Html(format!("<head>{}", "x".repeat(8 * 1024 * 1024)))) }))
        .route("/bad", get(|| async { (StatusCode::INTERNAL_SERVER_ERROR, "failed") }))
        .route("/manifest.json", get(|uri: axum::http::Uri| async move { axum::Json(serde_json::json!({"name":"fixture", "upstream_uri":uri.to_string()})) }))
        .route("/broken", get(|| async {
            let stream = async_stream::stream! {
                yield Ok::<_, std::io::Error>(axum::body::Bytes::from_static(b"partial"));
                tokio::time::sleep(Duration::from_millis(10)).await;
                yield Err(std::io::Error::other("upstream failed"));
            };
            axum::body::Body::from_stream(stream)
        }))
        .route("/_fwd/{agent}/{port}/socket", get(|ws: WebSocketUpgrade| async move { ws.on_upgrade(|mut socket| async move {
            while let Some(Ok(message)) = socket.recv().await { if socket.send(message).await.is_err() { break; } }
        }) }))
        .route("/_fwd/{agent}/{port}/app", axum::routing::any(|uri: axum::http::Uri| async move { uri.to_string() }))
        .route("/events", get(|| async {
            let stream = async_stream::stream! {
                yield Ok::<_, std::io::Error>(axum::body::Bytes::from_static(b"data: first\n\n"));
                std::future::pending::<()>().await;
            };
            ([(header::CONTENT_TYPE, "text/event-stream")], axum::body::Body::from_stream(stream))
        }))
        .layer(axum::extract::DefaultBodyLimit::disable())
        .layer(axum::middleware::from_fn(move |request: axum::extract::Request, next: axum::middleware::Next| {
            upstream_hits.fetch_add(1, Ordering::SeqCst);
            async move { next.run(request).await }
        }));
    let local_task = tokio::spawn(async move { axum::serve(local, local_app).await.unwrap(); });
    let state = AppState::new(&crate::config::HubConfig {
        listen_addr: "127.0.0.1:0".parse().unwrap(), agent_token_hash: "fake".into(), users: vec![],
        prompt_review_mode: crate::prompt_review::ReviewMode::Mandatory, prompt_review: None, llm_providers: Default::default(),
    }, false);
    let (session, _) = state.inner.write().await.sessions.create_session("admin", false);
    let cookie = format!("{}={}", crate::routes::middleware::session_cookie_name(false, &state.cookie_suffix), session.session_id);
    let (tx, mut rx) = tokio::sync::mpsc::channel(64);
    {
        let mut inner = state.inner.write().await;
        inner.agents.register("agent".into(), "mock".into(), tx, Arc::new(tokio::sync::Notify::new()), 0, vec![], 0, vec![], Capabilities { port_forward: true, ..Default::default() }, None);
        inner.agents.get_mut("agent").unwrap().forwards = vec![ForwardConfig { port, name: "local".into(), keep_prefix: false }];
    }
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let hub_state = state.clone();
    let hub_task = tokio::spawn(async move { axum::serve(listener, crate::routes::create_router(hub_state).into_make_service_with_connect_info::<std::net::SocketAddr>()).await.unwrap(); });
    let agent_task = tokio::spawn(async move {
        let mut tunnels = tokio::task::JoinSet::new();
        while let Some(message) = rx.recv().await {
            if let HubMessage::TunnelOpen { ticket, port, compression } = message {
                tunnels.spawn(agent_tunnel::run(format!("ws://{address}/ws/agent-data"), "agent".into(), ticket, port, compression));
            }
        }
    });
    Harness { hub: format!("http://{address}"), port, cookie, state, principal: session.principal_id, csrf: session.csrf_token, hits, tasks: vec![local_task, hub_task, agent_task] }
}

#[path = "transport_tests.rs"]
mod transport_tests;

#[tokio::test]
async fn mock_agent_http_reaches_real_tcp_server_and_injects_html() {
    let harness = harness().await;
    let response = reqwest::Client::new().get(format!("{}/_fwd/agent/{}/", harness.hub, harness.port))
        .header(header::COOKIE, &harness.cookie).header(header::ACCEPT, "text/html").send().await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert!(response.headers().get("x-frame-options").is_none());
    assert!(response.headers().get(header::CONTENT_SECURITY_POLICY).is_none());
    assert_eq!(response.headers()[header::REFERRER_POLICY], "same-origin");
    let body = response.text().await.unwrap();
    assert!(body.contains("<head><script>(() =>"));
    assert!(body.contains("local service"));
    let client = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).build().unwrap();
    let base = format!("{}/_fwd/agent/{}", harness.hub, harness.port);
    assert_eq!(client.get(format!("{base}/")).send().await.unwrap().status(), StatusCode::UNAUTHORIZED);
    assert_eq!(client.get(format!("{base}/")).header(header::ACCEPT, "text/html").send().await.unwrap().status(), StatusCode::SEE_OTHER);
    let slash = client.get(&base).header(header::COOKIE, &harness.cookie).send().await.unwrap();
    assert_eq!(slash.status(), StatusCode::PERMANENT_REDIRECT);
    assert_eq!(slash.headers()[header::LOCATION], format!("/_fwd/agent/{}/", harness.port));
    assert_eq!(client.get(format!("{}/_fwd/agent/1/", harness.hub)).header(header::COOKIE, &harness.cookie).send().await.unwrap().status(), StatusCode::NOT_FOUND);
    assert_eq!(client.post(format!("{base}/echo")).header(header::COOKIE, &harness.cookie).header("sec-fetch-site", "cross-site").send().await.unwrap().status(), StatusCode::FORBIDDEN);
    assert_eq!(client.get(format!("{base}/")).header(header::COOKIE, &harness.cookie).header("sec-fetch-dest", "serviceworker").send().await.unwrap().status(), StatusCode::FORBIDDEN);
    let payload = vec![b'x'; 2 * 1024 * 1024];
    let response = client.post(format!("{base}/echo")).header(header::COOKIE, &harness.cookie).header("sec-fetch-site", "same-origin").body(payload.clone()).send().await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.bytes().await.unwrap().as_ref(), payload);
    let response = client.get(format!("{base}/large")).header(header::COOKIE, &harness.cookie).header(header::ACCEPT, "text/html").send().await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = response.text().await.unwrap();
    assert_eq!(body.len(), 8 * 1024 * 1024 + 6 + super::rewrite::SHIM.len() + 17);
    assert!(body.contains("__fileboxForwardShim"));
}

#[tokio::test]
async fn cold_document_bounces_before_upstream_then_recovers_host_and_preserves_query() {
    let harness = harness().await;
    let path = format!("/_fwd/agent/{}/authority?token=private%3Cvalue%3E&x=a%2Fb", harness.port);
    let client = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).build().unwrap();
    let url = format!("{}{path}", harness.hub);
    let response = client.get(&url).header(header::HOST, "hub.test").header("sec-fetch-dest", "document").send().await.unwrap();
    assert_eq!(response.status(), StatusCode::SEE_OTHER);
    let location = response.headers()[header::LOCATION].to_str().unwrap();
    assert_eq!(url::form_urlencoded::parse(location.trim_start_matches("/?").as_bytes()).next().unwrap().1, path);
    for dest in [Some("document"), Some("iframe"), None] {
        let mut request = client.get(&url).header(header::HOST, "hub.test").header(header::COOKIE, &harness.cookie)
            .header("x-forwarded-proto", "https").header(header::ACCEPT, "text/html");
        if let Some(dest) = dest { request = request.header("sec-fetch-dest", dest); }
        let response = request.send().await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        assert_eq!(response.headers()[header::REFERRER_POLICY], "same-origin");
        let csp = response.headers()[header::CONTENT_SECURITY_POLICY].to_str().unwrap().to_string();
        let html = response.text().await.unwrap();
        let script = html.split("<script>").nth(1).unwrap().split("</script>").next().unwrap();
        assert_eq!(script, "location.replace(location.href)");
        let hash = base64::engine::general_purpose::STANDARD.encode(Sha256::digest(script.as_bytes()));
        assert_eq!(csp, format!("default-src 'none'; script-src 'sha256-{hash}'; base-uri 'none'; frame-ancestors 'self'"));
        assert!(html.contains("<noscript><a href=\"\">Continue</a></noscript>"));
        assert!(!html.contains("token") && !html.contains("private") && !html.contains("hub.test"));
        assert_eq!(harness.hits.load(Ordering::SeqCst), 0);
    }
    let response = client.get(&url).header(header::HOST, "hub.test").header(header::COOKIE, &harness.cookie)
        .header("sec-fetch-dest", "document").header("x-forwarded-proto", "https")
        .header(header::REFERER, format!("https://hub.test:8983{path}")).send().await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body: serde_json::Value = response.json().await.unwrap();
    assert_eq!(body["host"], "hub.test:8983");
    assert_eq!(body["uri"], "/authority?token=private%3Cvalue%3E&x=a%2Fb");
    assert_eq!(harness.hits.load(Ordering::SeqCst), 1);
    for (method, host, dest) in [(reqwest::Method::GET, "hub.test:8983", "document"), (reqwest::Method::GET, "hub.test", "empty"), (reqwest::Method::HEAD, "hub.test", "document"), (reqwest::Method::POST, "hub.test", "document")] {
        let before = harness.hits.load(Ordering::SeqCst);
        let response = client.request(method, &url).header(header::HOST, host).header(header::COOKIE, &harness.cookie)
            .header("sec-fetch-dest", dest).header("x-forwarded-proto", "https").send().await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_ne!(response.headers().get(header::CACHE_CONTROL).and_then(|value| value.to_str().ok()), Some("no-store"));
        let _ = response.bytes().await.unwrap();
        assert_eq!(harness.hits.load(Ordering::SeqCst), before + 1);
    }
}

#[tokio::test]
async fn cross_port_navigation_bounces_without_upstream_and_cross_port_mutations_are_forbidden() {
    let harness = harness().await;
    let path = format!("/_fwd/agent/{}/authority?token=unchanged", harness.port);
    let url = format!("{}{path}", harness.hub);
    let client = reqwest::Client::new();
    for (site, name, source) in [
        (Some("same-site"), header::REFERER, "https://hub.test:9000/"),
        (Some("same-site"), header::REFERER, "https://hub.test:9000/_fwd/other/9001/"),
        (Some("same-origin"), header::REFERER, "https://hub.test:9000/"),
        (None, header::REFERER, "https://hub.test:9000/"),
        (Some("same-site"), header::ORIGIN, "https://hub.test:9000"),
    ] {
        let mut request = client.get(&url).header(header::HOST, "hub.test").header(header::COOKIE, &harness.cookie)
            .header("sec-fetch-dest", "document").header("x-forwarded-proto", "https").header(name, source);
        if let Some(site) = site { request = request.header("sec-fetch-site", site); }
        let response = request.send().await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        assert!(response.text().await.unwrap().contains("location.replace(location.href)"));
        assert_eq!(harness.hits.load(Ordering::SeqCst), 0);
    }
    let response = client.post(&url).header(header::HOST, "hub.test").header(header::COOKIE, &harness.cookie)
        .header(header::ORIGIN, "https://hub.test:9000").header("sec-fetch-site", "same-site")
        .header("x-forwarded-proto", "https").send().await.unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    let mut request = format!("{}/_fwd/agent/{}/authority-socket", harness.hub.replace("http:", "ws:"), harness.port).into_client_request().unwrap();
    for (name, value) in [("host", "hub.test"), ("origin", "https://hub.test:9000"), ("cookie", harness.cookie.as_str()), ("sec-fetch-site", "same-site"), ("x-forwarded-proto", "https")] {
        request.headers_mut().insert(axum::http::HeaderName::from_bytes(name.as_bytes()).unwrap(), value.parse().unwrap());
    }
    match tokio_tungstenite::connect_async(request).await.unwrap_err() {
        tokio_tungstenite::tungstenite::Error::Http(response) => assert_eq!(response.status(), StatusCode::FORBIDDEN),
        error => panic!("expected HTTP 403, got {error}"),
    }
    assert_eq!(harness.hits.load(Ordering::SeqCst), 0);
    let response = client.get(&url).header(header::HOST, "hub.test").header(header::COOKIE, &harness.cookie)
        .header("sec-fetch-dest", "document").header("x-forwarded-proto", "https").header("sec-fetch-site", "same-origin")
        .header(header::REFERER, format!("https://hub.test:8983{path}")).send().await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body: serde_json::Value = response.json().await.unwrap();
    assert_eq!(body["host"], "hub.test:8983");
    assert_eq!(body["uri"], "/authority?token=unchanged");
    assert_eq!(harness.hits.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn port_stripping_proxy_preserves_authority_for_posts_websockets_rewriting_and_fallback() {
    let harness = harness().await;
    let base = format!("{}/_fwd/agent/{}", harness.hub, harness.port);
    let client = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).build().unwrap();
    for (host, origin, expected) in [
        ("hub.test", "https://hub.test:8983", StatusCode::OK),
        ("hub.test:8983", "https://hub.test:8983", StatusCode::OK),
        ("hub.test", "https://evil.test:8983", StatusCode::FORBIDDEN),
        ("hub.test", "http://hub.test:8983", StatusCode::FORBIDDEN),
        ("hub.test:8443", "https://hub.test:8983", StatusCode::FORBIDDEN),
    ] {
        let response = client.post(format!("{base}/authority")).header(header::COOKIE, &harness.cookie)
            .header(header::HOST, host).header(header::ORIGIN, origin).header("x-forwarded-proto", "https").send().await.unwrap();
        assert_eq!(response.status(), expected, "{host} {origin}");
        if expected == StatusCode::OK {
            assert_eq!(response.headers()[header::LOCATION], format!("/_fwd/agent/{}/next", harness.port));
            assert_eq!(response.text().await.unwrap(), "hub.test:8983");
        }
    }
    let response = client.get(format!("{base}/authority-html")).header(header::COOKIE, &harness.cookie)
        .header(header::HOST, "hub.test").header(header::ORIGIN, "https://hub.test:8983").header("x-forwarded-proto", "https").header("sec-fetch-dest", "document").send().await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert!(response.text().await.unwrap().contains(&format!("/_fwd/agent/{}/app/", harness.port)));
    for referer in ["https://hub.test:8983", "https://evil.test:8983", "http://hub.test:8983"] {
        let response = client.get(format!("{}/asset.js", harness.hub)).header(header::HOST, "hub.test")
            .header(header::REFERER, format!("{referer}/_fwd/agent/{}/app", harness.port)).header("x-forwarded-proto", "https").send().await.unwrap();
        if referer == "https://hub.test:8983" {
            assert_eq!(response.status(), StatusCode::TEMPORARY_REDIRECT);
            assert_eq!(response.headers()[header::LOCATION], format!("/_fwd/agent/{}/asset.js", harness.port));
        } else { assert_ne!(response.status(), StatusCode::TEMPORARY_REDIRECT); }
    }
    let mut request = format!("{}/authority-socket", base.replace("http:", "ws:")).into_client_request().unwrap();
    for (name, value) in [(header::HOST, "hub.test"), (header::ORIGIN, "https://hub.test:8983"), (header::COOKIE, harness.cookie.as_str()), (header::HeaderName::from_static("x-forwarded-proto"), "https")] {
        request.headers_mut().insert(name, value.parse().unwrap());
    }
    let (mut socket, response) = tokio_tungstenite::connect_async(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::SWITCHING_PROTOCOLS);
    assert_eq!(tokio::time::timeout(Duration::from_secs(5), socket.next()).await.unwrap().unwrap().unwrap().into_text().unwrap(), "hub.test:8983");
}

#[tokio::test]
async fn websocket_upgrade_crosses_data_tunnel() {
    let harness = harness().await;
    let mut request = format!("{}/_fwd/agent/{}/socket", harness.hub.replace("http:", "ws:"), harness.port).into_client_request().unwrap();
    request.headers_mut().insert(header::COOKIE, harness.cookie.parse().unwrap());
    request.headers_mut().insert(header::ORIGIN, harness.hub.parse().unwrap());
    request.headers_mut().insert("sec-fetch-site", "same-origin".parse().unwrap());
    let (mut socket, response) = tokio_tungstenite::connect_async(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::SWITCHING_PROTOCOLS);
    socket.send(tokio_tungstenite::tungstenite::Message::Text("echo me".into())).await.unwrap();
    let message = tokio::time::timeout(Duration::from_secs(5), socket.next()).await.unwrap().unwrap().unwrap();
    assert_eq!(message.into_text().unwrap(), "echo me");
}

#[tokio::test]
async fn sse_flushes_through_full_router_without_compression_or_eof() {
    let harness = harness().await;
    let mut response = reqwest::Client::new().get(format!("{}/_fwd/agent/{}/events", harness.hub, harness.port))
        .header(header::COOKIE, &harness.cookie).header(header::ACCEPT_ENCODING, "gzip, br, zstd").send().await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert!(response.headers().get(header::CONTENT_ENCODING).is_none());
    assert!(response.headers().get(header::CONTENT_LENGTH).is_none());
    let first = tokio::time::timeout(Duration::from_secs(2), response.chunk()).await.unwrap().unwrap().unwrap();
    assert_eq!(first, "data: first\n\n");
}
