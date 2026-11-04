use super::*;

fn hello() -> Value {
    json!({"generation": 1, "framed": false, "version": "0.1.17", "core": {"id": "core-1"}, "methods": METHODS})
}

fn terminal() -> Value {
    json!({
        "address": "t7", "name": "worker", "state": "live", "labels": {"filebox": "ai-agent"},
        "created_ms": 123, "turn": 2, "cwd": "/work",
        "status": {"state": "idle", "app": "test-agent"}, "title": "Ready",
    })
}

#[test]
fn registers_hc_after_the_existing_herdr_backend() {
    assert_eq!(super::super::BACKEND_KINDS, &["herdr", "hc"]);
}

#[test]
fn requires_generation_one_and_the_complete_api() {
    assert_eq!(check_hello(&hello()).unwrap(), "core-1");
    for field in ["generation", "framed", "methods", "core"] {
        let mut value = hello();
        value.as_object_mut().unwrap().remove(field);
        assert!(check_hello(&value).is_err(), "{field}");
    }
    let mut value = hello();
    value["generation"] = json!(2);
    assert!(check_hello(&value).is_err());
    value = hello();
    value["methods"] = json!(["terminal.list"]);
    assert!(check_hello(&value).is_err());
}

#[test]
fn only_labelled_local_live_terminals_are_allowed() {
    assert!(allowed(&terminal()));
    for (field, value) in [
        ("labels", json!({})), ("labels", json!({"filebox": "shell"})),
        ("state", json!("finished")), ("address", json!("remote/t7")),
        ("address", json!("-t7")), ("address", json!("")),
    ] {
        let mut terminal = terminal();
        terminal[field] = value;
        assert!(!allowed(&terminal));
    }
}

#[test]
fn maps_only_reported_status_and_preserves_stable_identity() {
    let original = to_agent(&terminal(), "core-1").unwrap();
    assert_eq!(original.id, "t7");
    assert_eq!(original.scope, "core-1:123");
    assert_eq!(original.kind.as_deref(), Some("test-agent"));
    assert_eq!(original.completion_seq, Some(2));
    assert!(!original.focused);
    for (word, status) in [
        ("idle", AiAgentStatus::Idle), ("working", AiAgentStatus::Working),
        ("done", AiAgentStatus::Done), ("blocked", AiAgentStatus::Blocked),
        ("error", AiAgentStatus::Unknown), ("future", AiAgentStatus::Unknown),
    ] {
        let mut terminal = terminal();
        terminal["status"]["state"] = json!(word);
        terminal["name"] = json!("renamed");
        let agent = to_agent(&terminal, "core-1").unwrap();
        assert_eq!(agent.status, status);
        assert_eq!(agent.scope, original.scope);
    }
    let mut terminal = terminal();
    terminal["status"] = Value::Null;
    terminal["title"] = json!("Working... Done! Approval required");
    assert_eq!(to_agent(&terminal, "core-1").unwrap().status, AiAgentStatus::Unknown);
    terminal["created_ms"] = json!(789);
    assert_ne!(to_agent(&terminal, "core-1").unwrap().scope, original.scope);
    assert_ne!(to_agent(&terminal, "core-2").unwrap().scope, original.scope);
}

#[test]
fn maps_structured_errors_without_leaking_messages() {
    for (kind, expected) in [
        ("not_found", "ai_agent_missing"), ("finished", "ai_agent_missing"),
        ("blocked", "ai_agent_blocked"), ("status_mismatch", "ai_agent_not_ready"),
        ("unavailable", "ai_agent_backend_unavailable"),
        ("unsupported_generation", "ai_agent_backend_incompatible"),
        ("invalid_params", "invalid_request"), ("future", "ai_agent_failed"),
    ] {
        assert_eq!(rpc_error(&json!({"data": {"kind": kind}, "message": "private text"})), expected);
    }
    assert_eq!(rpc_error(&json!({"code": -32601})), "ai_agent_backend_incompatible");
}

#[tokio::test]
async fn bounded_operations_timeout_and_cancel() {
    let cancel = AtomicBool::new(false);
    let pending = std::future::pending::<Result<(), String>>();
    assert_eq!(bounded(Duration::from_millis(5), &cancel, pending).await.unwrap_err(), "ai_agent_timeout");
    cancel.store(true, Ordering::Relaxed);
    assert_eq!(bounded(Duration::from_secs(1), &cancel, async { panic!("must not start"); }).await,
        Err::<(), _>("cancelled".into()));
}

#[cfg(unix)]
mod process {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    struct Fixture {
        _dir: tempfile::TempDir,
        backend: HcBackend,
        log: PathBuf,
    }

    impl Fixture {
        fn new(steps: Vec<Value>) -> Self {
            let dir = tempfile::tempdir().unwrap();
            let script = dir.path().join("hc");
            let log = dir.path().join("requests.jsonl");
            let data = serde_json::to_string(&json!({"steps": steps, "log": log})).unwrap();
            let python = format!(r#"#!/usr/bin/env python3
import json, sys, time
data = json.loads({data:?})
if sys.argv[1:] == ['--version']:
    print('hc 0.1.17')
    sys.exit(0)
assert sys.argv[1:] == ['connect']
for step in data['steps']:
    request = json.loads(sys.stdin.readline())
    with open(data['log'], 'a') as log:
        log.write(json.dumps(request) + '\n')
    assert request['method'] == step['method'], request
    for key, value in step.get('params', {{}}).items():
        assert request['params'][key] == value, request
    if 'delay' in step:
        time.sleep(step['delay'])
    if 'raw' in step:
        print(step['raw'], flush=True)
    else:
        reply = {{'jsonrpc': '2.0', 'id': request['id']}}
        reply.update(step['reply'])
        print(json.dumps(reply), flush=True)
time.sleep(30)
"#);
            std::fs::write(&script, python).unwrap();
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
            Self { _dir: dir, backend: HcBackend { bin: script, version: "0.1.17".into() }, log }
        }

        fn requests(&self) -> Vec<Value> {
            std::fs::read_to_string(&self.log).unwrap().lines()
                .map(|line| serde_json::from_str(line).unwrap()).collect()
        }
    }

    fn step(method: &str, result: Value) -> Value {
        json!({"method": method, "reply": {"result": result}})
    }

    fn handshake() -> Value {
        let mut value = step("hello", hello());
        value["params"] = json!({"generation": 1});
        value
    }

    #[tokio::test]
    async fn probes_cli_without_connecting_or_starting_core() {
        let fixture = Fixture::new(Vec::new());
        assert_eq!(probe_version(&fixture.backend.bin).await.unwrap(), "0.1.17");
        assert!(!fixture.log.exists());
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn retries_an_executable_temporarily_open_for_writing() {
        let fixture = Fixture::new(Vec::new());
        let writer = std::fs::OpenOptions::new().write(true).open(&fixture.backend.bin).unwrap();
        let (_, result) = tokio::join!(async {
            tokio::time::sleep(Duration::from_millis(50)).await;
            drop(writer);
        }, probe_version(&fixture.backend.bin));
        assert_eq!(result.unwrap(), "0.1.17");
    }

    #[tokio::test]
    async fn list_filters_again_even_if_server_ignores_labels() {
        let mut unlabelled = terminal();
        unlabelled["labels"] = json!({});
        let mut remote = terminal();
        remote["address"] = json!("machine/t7");
        let fixture = Fixture::new(vec![handshake(), step("terminal.list", json!({
            "terminals": [terminal(), unlabelled, remote],
        }))]);
        let result = fixture.backend.list(&AtomicBool::new(false)).await.unwrap();
        assert!(result.status.reachable);
        assert_eq!(result.agents.len(), 1);
        assert_eq!(fixture.requests()[1]["params"], json!({"labels": {"filebox": "ai-agent"}}));
    }

    #[tokio::test]
    async fn rechecks_opt_in_before_every_read_prompt_and_key() {
        let mut revoked = terminal();
        revoked["labels"] = json!({});
        for op in ["read", "prompt", "keys"] {
            let fixture = Fixture::new(vec![handshake(), step("terminal.get", revoked.clone())]);
            let cancel = AtomicBool::new(false);
            let result = match op {
                "read" => fixture.backend.read("t7", 80, None, &cancel).await.map(|_| ()),
                "prompt" => fixture.backend.prompt("t7", "do it", None, &cancel).await.map(|_| ()),
                _ => fixture.backend.send_keys("t7", &["enter".into()], &cancel).await.map(|_| ()),
            };
            assert_eq!(result.unwrap_err(), "ai_agent_missing");
            assert_eq!(fixture.requests().len(), 2);
        }
    }

    #[tokio::test]
    async fn reads_visible_or_bottom_and_caps_total_lines() {
        for (source, history) in [(None, 2), (Some(AiAgentReadSource::Bottom), 2), (Some(AiAgentReadSource::Visible), 0)] {
            let fixture = Fixture::new(vec![handshake(), step("terminal.get", terminal()),
                step("terminal.read", json!({"text": "history\nvisible1\nvisible2\n", "complete": true, "how": "history"}))]);
            assert_eq!(fixture.backend.read("t7", 2, source, &AtomicBool::new(false)).await.unwrap(), "visible1\nvisible2");
            assert_eq!(fixture.requests()[2]["params"], json!({"terminal": "t7", "lines": history}));
        }
    }

    #[tokio::test]
    async fn caps_the_selected_tail_not_discarded_history() {
        let text = format!("{}\nrecent1\nrecent2\n", "x".repeat(AI_AGENT_OUTPUT_MAX_BYTES + 1));
        let fixture = Fixture::new(vec![handshake(), step("terminal.get", terminal()),
            step("terminal.read", json!({"text": text}))]);
        assert_eq!(fixture.backend.read("t7", 2, None, &AtomicBool::new(false)).await.unwrap(), "recent1\nrecent2");
    }

    #[tokio::test]
    async fn rejects_oversized_read_output_and_noncanonical_targets() {
        let fixture = Fixture::new(vec![handshake(), step("terminal.get", terminal()),
            step("terminal.read", json!({"text": "x".repeat(AI_AGENT_OUTPUT_MAX_BYTES + 1)}))]);
        assert!(fixture.backend.read("t7", 80, None, &AtomicBool::new(false)).await.unwrap_err().starts_with("ai_agent_failed"));
        for (field, value) in [("address", json!("t8")), ("state", json!("finished"))] {
            let mut stale = terminal();
            stale[field] = value;
            let fixture = Fixture::new(vec![handshake(), step("terminal.get", stale)]);
            assert_eq!(fixture.backend.read("t7", 80, None, &AtomicBool::new(false)).await.unwrap_err(), "ai_agent_missing");
            assert_eq!(fixture.requests().len(), 2);
        }
    }

    #[tokio::test]
    async fn sends_literal_text_with_second_based_wait_and_never_forces_input() {
        for wait in [None, Some(6500)] {
            let fixture = Fixture::new(vec![handshake(), step("terminal.get", terminal()),
                step("terminal.send", json!({"status": "idle", "turn": 2, "started": true}))]);
            assert!(fixture.backend.prompt("t7", "\"\n中文 --flag $(exit)", wait, &AtomicBool::new(false)).await.unwrap().is_none());
            assert_eq!(fixture.requests()[2]["params"], json!({
                "terminal": "t7", "text": "\"\n中文 --flag $(exit)", "force": false,
                "wait": wait.is_some(), "timeout": wait.map(|ms| ms as f64 / 1000.0),
            }));
        }
    }

    #[tokio::test]
    async fn forwards_logical_keys_without_shell_or_cli_interpretation() {
        let fixture = Fixture::new(vec![handshake(), step("terminal.get", terminal()), step("terminal.keys", json!({"turn": 2}))]);
        fixture.backend.send_keys("t7", &["ctrl+c".into(), "alt+enter".into()], &AtomicBool::new(false)).await.unwrap();
        assert_eq!(fixture.requests()[2]["params"], json!({"terminal": "t7", "keys": ["ctrl+c", "alt+enter"]}));
    }

    #[tokio::test]
    async fn malformed_oversized_or_wrong_id_replies_are_rejected() {
        for raw in ["not json".to_string(), json!({"jsonrpc": "2.0", "id": 999, "result": hello()}).to_string(),
            json!({"jsonrpc": "2.0", "id": 1, "result": hello(), "error": {}}).to_string(), "x".repeat(RPC_MAX_BYTES + 1)] {
            let fixture = Fixture::new(vec![json!({"method": "hello", "raw": raw})]);
            let result = fixture.backend.list(&AtomicBool::new(false)).await.unwrap();
            assert_eq!(result.error.as_deref(), Some("ai_agent_backend_incompatible"));
            assert!(!result.status.reachable);
        }
    }

    #[tokio::test]
    async fn stops_connect_child_when_cancelled_or_timed_out() {
        let fixture = Fixture::new(vec![json!({"method": "hello", "delay": 30, "reply": {"result": hello()}})]);
        let cancel = AtomicBool::new(false);
        let work = fixture.backend.read("t7", 80, None, &cancel);
        let trigger = async {
            tokio::time::sleep(Duration::from_millis(100)).await;
            cancel.store(true, Ordering::Relaxed);
        };
        let (result, ()) = tokio::join!(work, trigger);
        assert_eq!(result.unwrap_err(), "cancelled");
        let result = bounded(Duration::from_millis(100), &AtomicBool::new(false), async {
            let mut rpc = RpcClient::start(&fixture.backend.bin).await?;
            rpc.call("hello", json!({"generation": 1})).await
        }).await;
        assert_eq!(result.unwrap_err(), "ai_agent_timeout");
    }

    #[tokio::test]
    #[ignore = "set FILEBOX_TEST_HC to an official hc executable; runs in isolated XDG directories"]
    async fn real_core_labelled_terminal_lifecycle() {
        let binary = std::env::var("FILEBOX_TEST_HC").expect("FILEBOX_TEST_HC executable required");
        let dir = tempfile::tempdir().unwrap();
        let wrapper = dir.path().join("hc");
        let env = json!({
            "XDG_DATA_HOME": dir.path().join("data"), "XDG_CONFIG_HOME": dir.path().join("config"),
            "XDG_RUNTIME_DIR": dir.path().join("run"), "XDG_STATE_HOME": dir.path().join("state"),
            "HC_SESSION": "filebox-test",
            "HC_SOCKET": dir.path().join("core.sock"),
        });
        let script = format!("#!/usr/bin/env python3\nimport os,sys,json\nos.environ.update(json.loads({:?}))\nos.execv({binary:?}, [{binary:?}] + sys.argv[1:])\n", env.to_string());
        std::fs::write(&wrapper, script).unwrap();
        std::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o755)).unwrap();
        struct Cleanup(PathBuf);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = std::process::Command::new(&self.0).args(["server", "stop"])
                    .stdout(Stdio::null()).stderr(Stdio::null()).status();
            }
        }
        let _cleanup = Cleanup(wrapper.clone());
        let backend = HcBackend { version: probe_version(&wrapper).await.unwrap(), bin: wrapper.clone() };
        let cancel = AtomicBool::new(false);
        let mut setup = RpcClient::start(&wrapper).await.unwrap();
        check_hello(&setup.call("hello", json!({"generation": 1})).await.unwrap()).unwrap();
        let program = r#"import sys,time
def report(state):
    print('\x1b]7501;app=fixture:state='+state+'\x07', end='', flush=True)
report('idle')
print('READY', flush=True)
for line in sys.stdin:
    report('working')
    print('RECEIVED: '+line.strip(), flush=True)
    time.sleep(0.3)
    report('done')
"#;
        let run = setup.call("terminal.run", json!({
            "argv": ["python3", "-u", "-c", program], "labels": {"filebox": "ai-agent"},
            "name": "filebox-fixture", "wait": false, "no_parent": true,
        })).await.unwrap();
        let target = run["address"].as_str().unwrap();
        setup.call("terminal.run", json!({"argv": ["python3", "-c", "import time; time.sleep(60)"], "wait": false, "no_parent": true})).await.unwrap();
        let listed = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let listed = backend.list(&cancel).await.unwrap();
                if listed.agents.first().is_some_and(|agent| agent.status == AiAgentStatus::Idle) {
                    break listed;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        }).await.expect("fixture should report idle through OSC 7501");
        assert!(listed.status.reachable, "{:?}", listed.error);
        assert_eq!(listed.agents.len(), 1);
        assert_eq!(listed.agents[0].target, target);
        assert_eq!(listed.agents[0].status, AiAgentStatus::Idle);
        assert!(backend.read(target, 80, Some(AiAgentReadSource::Visible), &cancel).await.unwrap().contains("READY"));
        backend.prompt(target, "filebox literal \"prompt\"", Some(5000), &cancel).await.unwrap();
        let output = backend.read(target, 80, None, &cancel).await.unwrap();
        assert!(output.contains("RECEIVED: filebox literal \"prompt\""), "{output}");
        let after = backend.list(&cancel).await.unwrap();
        assert_eq!(after.agents[0].status, AiAgentStatus::Done);
        assert_eq!(after.agents[0].completion_seq, Some(1));
        backend.send_keys(target, &["y".into(), "enter".into()], &cancel).await.unwrap();
        setup.call("terminal.label", json!({"terminal": target, "labels": {"filebox": ""}})).await.unwrap();
        assert!(backend.list(&cancel).await.unwrap().agents.is_empty());
        assert_eq!(backend.read(target, 80, None, &cancel).await.unwrap_err(), "ai_agent_missing");
        assert_eq!(backend.prompt(target, "must not send", None, &cancel).await.unwrap_err(), "ai_agent_missing");
        assert_eq!(backend.send_keys(target, &["enter".into()], &cancel).await.unwrap_err(), "ai_agent_missing");
    }
}
