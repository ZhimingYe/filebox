use super::*;

pub(super) fn dispatch(context: &AgentContext, message: AgentMessage) {
    let state = &context.state;
    let agent_id_for_msgs = &context.agent_id;
    let connection_id = context.connection_id;
    match message {
        AgentMessage::TerminalOpened { req_id, error, replay_bytes, input_ack } => {
            let failed = error.is_some();
            // Audited here, not when the open was queued:
            // only the agent's answer says whether a shell
            // was actually handed out. `None` owner means
            // the browser left first.
            if let Some((username, ip, user_agent)) =
                crate::terminal_proxy::terminal_session_owner(state, &req_id)
            {
                let event = if failed {
                    "terminal_open_failed"
                } else {
                    "terminal_opened"
                };
                tracing::info!(
                    target: "audit",
                    ip = %ip,
                    user = %username,
                    req_id = %req_id,
                    error = ?error,
                    "{}",
                    event
                );
                state.terminal_audit.try_record(event, &username, &ip, &user_agent);
            }
            let frame = match error {
                Some(code) => serde_json::json!({
                    "type": "error",
                    "error": code,
                }),
                None => serde_json::json!({ "type": "opened", "replay_bytes": replay_bytes, "input_ack": input_ack }),
            };
            // A failed open is terminal for the session:
            // the agent will not stream output after it.
            crate::terminal_proxy::forward_to_terminal_session(
                state,
                agent_id_for_msgs,
                connection_id,
                &req_id,
                frame,
                failed,
            );
        }
        AgentMessage::TerminalOutput { req_id, data } => {
            // Re-chunked defensively: the agent caps output
            // at TERMINAL_CHUNK_MAX_BYTES, but the hub must
            // not let one hostile frame pin multi-megabyte
            // values in the bounded browser queue.
            crate::terminal_proxy::forward_terminal_output(
                state,
                agent_id_for_msgs,
                connection_id,
                &req_id,
                &data,
            );
        }
        AgentMessage::TerminalInputAck { req_id, seq } => {
            crate::terminal_proxy::forward_to_terminal_session(
                state, agent_id_for_msgs, connection_id, &req_id,
                serde_json::json!({ "type": "input_ack", "seq": seq }), false,
            );
        }
        AgentMessage::TerminalClosed { req_id, reason } => {
            let frame = serde_json::json!({
                "type": "closed",
                "reason": reason,
            });
            crate::terminal_proxy::forward_to_terminal_session(
                state,
                agent_id_for_msgs,
                connection_id,
                &req_id,
                frame,
                true,
            );
        }
        _ => unreachable!("only terminal messages are dispatched here"),
    }
}
