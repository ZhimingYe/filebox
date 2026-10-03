use super::*;

impl ConnectionSession<'_> {
    pub(super) fn handle_terminal(&mut self, message: HubMessage) -> Result<(), DisconnectReason> {
        let terminal_manager = &self.runtime.terminal_manager;
        let term_tx = &self.term_tx;
        let control_tx = &self.control_tx;
        match message {
            HubMessage::TerminalOpen {
                req_id,
                cols,
                rows,
                agent_totp_code,
            } => {
                tracing::debug!(
                    "Terminal open: cols={}, rows={}",
                    cols,
                    rows
                );
                // open() spawns its own thread; the WS loop
                // never blocks on PTY setup.
                terminal_manager.open(
                    req_id,
                    cols,
                    rows,
                    agent_totp_code,
                    term_tx.clone(),
                );
            }
            HubMessage::TerminalAttach { req_id, session_id, agent_totp_code } => {
                terminal_manager.attach(req_id, session_id, agent_totp_code, term_tx.clone());
            }
            HubMessage::TerminalDetach { req_id } => terminal_manager.detach(&req_id),
            HubMessage::TerminalInput { req_id, data, seq } => {
                terminal_manager.input(&req_id, &data, seq);
            }
            HubMessage::TerminalResize { req_id, cols, rows } => {
                terminal_manager.resize(&req_id, cols, rows);
            }
            HubMessage::TerminalClose { req_id } => {
                terminal_manager.close(&req_id);
            }
            HubMessage::TerminalListRequest { req_id } => {
                let sessions = terminal_manager.list();
                // A management response must not be dropped behind PTY output.
                // Intake already reserved control capacity for this reply.
                if !queue_agent_message(control_tx, &AgentMessage::TerminalListResponse { req_id, sessions }) {
                    return Err(DisconnectReason::ControlQueueClosed);
                }
            }
            _ => unreachable!("dispatcher selected the wrong handler"),
        }
        Ok(())
    }
}
