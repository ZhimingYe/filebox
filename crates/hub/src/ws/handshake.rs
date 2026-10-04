use super::*;
use registration::Registration;

const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);

/// Authentication does not hold the global registry/session lock while bcrypt
/// runs. The permit stays inside the native job even if this future is dropped.
pub(super) async fn verify_token(state: &AppState, token: String) -> bool {
    if token.is_empty() {
        return false;
    }
    let permit = match tokio::time::timeout(
        HANDSHAKE_TIMEOUT,
        state.agent_auth_semaphore.clone().acquire_owned(),
    ).await {
        Ok(Ok(permit)) => permit,
        _ => return false,
    };
    let hash = state.inner.read().await.sessions.agent_token_hash().to_string();
    tokio::time::timeout(HANDSHAKE_TIMEOUT, tokio::task::spawn_blocking(move || {
        let _permit = permit;
        bcrypt::verify(token, &hash).unwrap_or(false)
    })).await.is_ok_and(|result| result.unwrap_or(false))
}

pub(super) async fn authenticate(
    sink: &mut AgentSink,
    reader: &mut AgentReader,
    state: &AppState,
    client_ip: &str,
) -> Option<Registration> {
    let auth = tokio::time::timeout(HANDSHAKE_TIMEOUT, reader.next()).await;
    let token = match auth {
        Ok(Some(Ok(Message::Text(text)))) => match serde_json::from_str(&text) {
            Ok(AgentMessage::Auth { token }) => token,
            _ => {
                send_auth_fail(sink).await;
                return None;
            }
        },
        _ => return None,
    };
    if !verify_token(state, token).await {
        tracing::warn!(target: "audit", ip = %client_ip, "agent_auth_failed");
        send_auth_fail(sink).await;
        return None;
    }
    state.ws_rate_limiter.clear(client_ip);
    let temporary_id = Uuid::new_v4().to_string();
    if !send_hub_frame(sink, &HubMessage::AuthResult {
        success: true, agent_id: Some(temporary_id.clone()),
    }).await {
        return None;
    }
    let message = match tokio::time::timeout(HANDSHAKE_TIMEOUT, reader.next()).await {
        Ok(Some(Ok(Message::Text(text)))) => serde_json::from_str(&text).ok()?,
        _ => return None,
    };
    // Missing/malformed Register must never create a phantom "unknown" Agent
    // or emit a connected event for a socket that already ended.
    let registration = Registration::from_message(message, temporary_id)?;
    tracing::info!(target: "audit", ip = %client_ip, agent_id = %registration.agent_id,
        name = %registration.name, "agent_registered");
    Some(registration)
}
