use super::*;

type AgentSocket = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;
type AgentReader = futures_util::stream::SplitStream<AgentSocket>;
type AgentSink = futures_util::stream::SplitSink<AgentSocket, Message>;

pub(super) async fn connect_and_register(
    ws_url: &str, config: &AgentConfig, runtime: &AgentRuntime,
) -> Result<(AgentSink, AgentReader, String), DisconnectReason> {
    let resource_mgr = &runtime.resource_mgr;
    let office_runtime = runtime.office_runtime.as_ref();
    let temp_store = runtime.temp_store.as_ref();
    tracing::info!("Connecting to {}", ws_url);

    // Step 1: Connect with hard timeout. Without this, a black-holed route
    // can leave us hung in DNS/TCP/TLS forever. Disable Nagle so small
    // replies do not wait for earlier data to be acknowledged.
    let ws_stream = match tokio::time::timeout(
        CONNECT_TIMEOUT,
        connect_async_with_config(ws_url, None, true),
    ).await {
        Ok(Ok((s, _))) => {
            tracing::info!("Connected to Hub");
            s
        }
        Ok(Err(e)) => {
            tracing::warn!("Connection failed: {}", e);
            return Err(DisconnectReason::ConnectFailed);
        }
        Err(_) => {
            tracing::warn!("Connection timed out after {}s", CONNECT_TIMEOUT.as_secs());
            return Err(DisconnectReason::ConnectTimeout);
        }
    };

    let (mut write, mut read) = ws_stream.split();

    // Step 2: Send Auth
    let auth = AgentMessage::Auth {
        token: config.token.clone(),
    };
    let auth_msg = Message::Text(serde_json::to_string(&auth).unwrap().into());
    if !send_with_timeout(&mut write, auth_msg).await {
        tracing::warn!("Failed to send auth");
        return Err(DisconnectReason::AuthSendFailed);
    }

    // Step 3: Wait for AuthResult
    let auth_result = tokio::time::timeout(AUTH_TIMEOUT, read.next()).await;
    let assigned_agent_id = match auth_result {
        Ok(Some(Ok(Message::Text(text)))) => match serde_json::from_str::<HubMessage>(&text) {
            Ok(HubMessage::AuthResult {
                success: true,
                agent_id: Some(id),
            }) => {
                tracing::info!("Authenticated as agent {}", id);
                id
            }
            Ok(HubMessage::AuthResult {
                success: false, ..
            }) => {
                tracing::error!("Authentication failed");
                return Err(DisconnectReason::AuthRejected);
            }
            _ => {
                tracing::warn!("Unexpected auth response: {}", text);
                return Err(DisconnectReason::UnexpectedAuthResponse);
            }
        },
        _ => {
            tracing::warn!("Timeout or error waiting for auth result");
            return Err(DisconnectReason::AuthWaitFailed);
        }
    };

    // Step 4: Send Register with persisted resource state
    let (rev, roots) = resource_mgr.current_state();
    let (collections_rev, collections) = resource_mgr.current_collections_state();
    // Advertise pinned_folders support explicitly. Capabilities::default()
    // leaves it false (the legacy-detection sentinel), so a NEW agent must opt
    // in here — this is what lets the hub tell a new agent from a pre-pin
    // agent during a rolling upgrade and avoid pushing pins to one that can't
    // store them.
    let mut capabilities = Capabilities::default();
    capabilities.pinned_folders = true;
    capabilities.collections = true;
    capabilities.workspace_search = true;
    // Temporary runtime degradation is request-scoped, not a capability
    // change. Keeping the configured capability advertised lets a later
    // user-triggered retry recover after Office is reinstalled, without
    // polling or requiring another Agent reconnect.
    capabilities.office_pdf_preview = office_runtime.is_some();
    if let Some(runtime) = office_runtime {
        capabilities.office_max_src_bytes = Some(runtime.config.max_src_bytes);
        capabilities.office_max_pdf_bytes = Some(runtime.config.max_pdf_bytes);
        capabilities.office_timeout_secs = Some(runtime.config.timeout.as_secs());
    }
    // The temp folder is a capability AND a synthetic root. The root never
    // enters the persisted desired set — the hub surfaces it to the UI from
    // the Register payload, and this agent resolves the name specially.
    capabilities.temp_upload = temp_store.is_some();
    // Remote terminal sessions spawn a shell on a PTY; unix-only
    // (portable-pty), so non-unix builds advertise false.
    capabilities.terminal = cfg!(unix);
    // Required TOTP check is enforced locally in terminal.rs; advertise it
    // so the hub knows TerminalOpen must carry agent_totp_code.
    capabilities.terminal_agent_2fa = config.terminal_totp_secret.is_some();
    // Session management and persistent attachments ride the same
    // unix-only PTY support as `terminal`.
    capabilities.terminal_manage = cfg!(unix);
    capabilities.terminal_persistent = cfg!(unix);
    let temp_root = temp_store.map(|store| store.root_info());
    let register = AgentMessage::Register {
        agent_id: Some(runtime.stable_agent_id.clone()),
        name: config.agent_name.clone(),
        resource_revision: rev,
        roots,
        capabilities,
        collections_revision: collections_rev,
        collections,
        temp_root,
    };
    let register_msg = Message::Text(serde_json::to_string(&register).unwrap().into());
    if !send_with_timeout(&mut write, register_msg).await {
        tracing::warn!("Failed to send register");
        return Err(DisconnectReason::RegisterFailed);
    }

    tracing::info!(
        "Registered as {} (rev={})",
        config.agent_name,
        resource_mgr.resource_revision()
    );

    Ok((write, read, assigned_agent_id))
}
