use super::*;

fn store() -> SessionStore {
    SessionStore::from_config(&crate::config::HubConfig {
        listen_addr: "127.0.0.1:0".parse().unwrap(), agent_token_hash: "fake".into(), users: vec![],
        prompt_review_mode: crate::prompt_review::ReviewMode::Mandatory, prompt_review: None, llm_providers: Default::default(),
    })
}

#[test]
fn manifest_authorization_is_bound_to_session_prefix_exact_path_query_method_destination_and_time() {
    let mut store = store();
    let (session, _) = store.create_session("admin", false);
    let prefix = "/_fwd/agent/9001";
    let signer = Signer::new("https://hub.test/_fwd/agent/9001/dir/page".parse().unwrap(), prefix.into(), session.clone());
    let href = signer.href("manifest.json?v=a%2Fb&x=2#icon").unwrap();
    assert!(!href.contains(&session.session_id));
    assert!(!href.contains(&session.csrf_token));
    let url: url::Url = href.parse().unwrap();
    let uri: Uri = url[url::Position::BeforePath..url::Position::AfterQuery].parse().unwrap();
    assert_eq!(clean(&uri).0, "/_fwd/agent/9001/dir/manifest.json?v=a%2Fb&x=2");
    let headers = HeaderMap::new();
    let auth = |headers: &HeaderMap, uri: &Uri| Signer::authenticate(&store, &Method::GET, headers, uri, now());
    assert!(auth(&headers, &uri).is_some());
    let mut manifest = headers.clone();
    manifest.insert("sec-fetch-dest", "manifest".parse().unwrap());
    assert!(auth(&manifest, &uri).is_some());
    for dest in ["empty", "document", "script", "image", "serviceworker", "websocket"] {
        let mut headers = headers.clone(); headers.insert("sec-fetch-dest", dest.parse().unwrap());
        assert!(auth(&headers, &uri).is_none());
    }
    let mut upgraded = headers.clone(); upgraded.insert(header::UPGRADE, "websocket".parse().unwrap());
    assert!(auth(&upgraded, &uri).is_none());
    for method in [Method::HEAD, Method::POST, Method::PUT, Method::DELETE] { assert!(Signer::authenticate(&store, &method, &headers, &uri, now()).is_none()); }
    assert!(Signer::authenticate(&store, &Method::GET, &headers, &uri, signer.expires).is_none());
    for invalid in [uri.to_string().replace("agent/9001", "other/9001"), uri.to_string().replace("9001/dir", "9002/dir"), uri.to_string().replace("manifest.json", "private.json"), uri.to_string().replace("x=2", "x=3"), format!("{uri}&{PARAM}=duplicate"), format!("{uri}x")] {
        assert!(auth(&headers, &invalid.parse().unwrap()).is_none());
    }
    for invalid in ["https://external.test/manifest", "/_fwd/agent/9002/manifest", "/_fwd/agent/9001evil/manifest", "/_fwd/agent/9001/__filebox_manifest_token", "data:application/json,{}"] { assert!(signer.href(invalid).is_none()); }
    store.remove(&session.session_id);
    assert!(Signer::authenticate(&store, &Method::GET, &headers, &uri, now()).is_none());
}

#[test]
fn static_html_signs_manifest_links_respecting_relative_paths_and_base_without_signing_other_links() {
    let mut store = store();
    let (session, _) = store.create_session("admin", false);
    let prefix = "/_fwd/agent/9001";
    let signer = Signer::new("https://hub.test/_fwd/agent/9001/dir/page".parse().unwrap(), prefix.into(), session);
    let output = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let sink = output.clone();
    let mut rewriter = crate::fwd::rewrite::html_rewriter((prefix.into(), "hub.test".into(), 9001, Some(signer)), move |bytes| sink.lock().unwrap().extend_from_slice(bytes));
    rewriter.write(b"<base href='/app/'><link rel='alternate MANIFEST' href='manifest?x=1&amp;y=2'><link rel=manifest href='https://external.test/m'><link rel=stylesheet href='/style.css'>").unwrap();
    rewriter.end().unwrap();
    let html = String::from_utf8(output.lock().unwrap().clone()).unwrap();
    assert_eq!(html.matches(PARAM).count(), 1);
    assert!(html.contains("/_fwd/agent/9001/app/manifest?x=1&amp;y=2&amp;__filebox_manifest="));
    assert!(html.contains("href='https://external.test/m'"));
    assert!(html.contains("href='/style.css'"));
}
