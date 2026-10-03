use super::*;

impl ConnectionSession<'_> {
    pub(super) fn handle_resources(&mut self, message: HubMessage) -> Result<(), DisconnectReason> {
        let resource_mgr = &mut self.runtime.resource_mgr;
        let dir_cache = &self.runtime.dir_cache;
        let content_cache = &self.runtime.content_cache;
        let assigned_agent_id = &self.assigned_agent_id;
        let control_tx = &self.control_tx;
        match message {
            HubMessage::ResourcesSetDesired {
                req_id,
                desired_revision,
                roots,
            } => {
                tracing::info!(
                    "Received resource update: rev={}, {} roots",
                    desired_revision,
                    roots.len()
                );

                let response = match resource_mgr.apply_desired(desired_revision, roots) {
                    Ok(new_rev) => {
                        // Roots may have changed (path/name/enabled/denylist
                        // semantics via root config), so cached listings could
                        // describe the wrong tree. Drop them all — they re-warm
                        // lazily on the next request. Cheaper and safer than
                        // trying to invalidate granularly.
                        dir_cache.clear();
                        // Same for content: a root's path /
                        // enabled / denylist semantics may have
                        // changed, so cached bytes could
                        // describe the wrong tree.
                        content_cache.clear();

                        let update = AgentMessage::ResourcesUpdated {
                            agent_id: assigned_agent_id.clone(),
                            resource_revision: new_rev,
                            roots: resource_mgr.roots().to_vec(),
                        };
                        if !queue_agent_message(control_tx, &update) {
                            tracing::warn!("Failed to send ResourcesUpdated, reconnecting");
                            return Err(DisconnectReason::ControlQueueClosed);
                        }

                        AgentMessage::ResourcesApplied {
                            req_id: req_id.clone(),
                            agent_id: assigned_agent_id.clone(),
                            resource_revision: new_rev,
                        }
                    }
                    Err(err_msg) => {
                        tracing::warn!("Resource update rejected: {}", err_msg);
                        AgentMessage::ResourcesRejected {
                            req_id: req_id.clone(),
                            agent_id: assigned_agent_id.clone(),
                            current_resource_revision: resource_mgr.resource_revision(),
                            error: "invalid_resource".to_string(),
                            message: err_msg,
                        }
                    }
                };

                if !queue_agent_message(control_tx, &response) {
                    tracing::warn!("Failed to send resource response, reconnecting");
                    return Err(DisconnectReason::ControlQueueClosed);
                }
            }
            HubMessage::CollectionsSetDesired {
                req_id,
                desired_revision,
                collections,
            } => {
                tracing::info!(
                    "Received collections update: rev={}, {} collections",
                    desired_revision,
                    collections.len()
                );

                let response = match resource_mgr.apply_collections_desired(
                    desired_revision,
                    collections,
                ) {
                    Ok(new_rev) => {
                        let update = AgentMessage::CollectionsUpdated {
                            agent_id: assigned_agent_id.clone(),
                            collections_revision: new_rev,
                            collections: resource_mgr.collections().to_vec(),
                        };
                        if !queue_agent_message(control_tx, &update) {
                            tracing::warn!("Failed to send CollectionsUpdated, reconnecting");
                            return Err(DisconnectReason::ControlQueueClosed);
                        }

                        AgentMessage::CollectionsApplied {
                            req_id: req_id.clone(),
                            agent_id: assigned_agent_id.clone(),
                            collections_revision: new_rev,
                        }
                    }
                    Err(err_msg) => {
                        tracing::warn!("Collections update rejected: {}", err_msg);
                        AgentMessage::CollectionsRejected {
                            req_id: req_id.clone(),
                            agent_id: assigned_agent_id.clone(),
                            current_collections_revision: resource_mgr
                                .collections_revision(),
                            error: "invalid_collection".to_string(),
                            message: err_msg,
                        }
                    }
                };

                if !queue_agent_message(control_tx, &response) {
                    tracing::warn!("Failed to send collections response, reconnecting");
                    return Err(DisconnectReason::ControlQueueClosed);
                }
            }
            _ => unreachable!("dispatcher selected the wrong handler"),
        }
        Ok(())
    }
}
