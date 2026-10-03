use super::*;

impl ConnectionSession<'_> {
    pub(super) fn handle_filesystem(&mut self, message: HubMessage) -> Result<(), DisconnectReason> {
        let resource_mgr = &self.runtime.resource_mgr;
        let dir_cache = &self.runtime.dir_cache;
        let content_cache = &self.runtime.content_cache;
        let fs_workers = &self.runtime.fs_workers;
        let dir_list_workers = &self.runtime.dir_list_workers;
        let office_runtime = self.runtime.office_runtime.as_ref();
        let temp_store = self.runtime.temp_store.as_ref();
        let fs_tx = &self.fs_tx;
        let dir_tx = &self.dir_tx;
        let control_tx = &self.control_tx;
        let fs_admission = &self.fs_admission;
        let dir_list_admission = &self.dir_list_admission;
        let fs_cancellations = &self.fs_cancellations;
        let tasks = &mut self.tasks;
        match message {
            HubMessage::FsListRequest { req_id, root, path, limit, cursor, dirs_only } => {
                tracing::debug!("FS list: root={}, path={}, dirs_only={:?}", root, path, dirs_only);
                let roots_vec = roots_with_temp(resource_mgr, temp_store);
                let dirs_only_flag = dirs_only.unwrap_or(false);
                let cache_clone = dir_cache.clone();
                let rid = req_id.clone();
                let panic_response = AgentMessage::FsListResponse {
                    req_id: rid,
                    items: vec![],
                    next_cursor: None,
                    error: Some("agent_internal_error".to_string()),
                };
                let cancelled_response = AgentMessage::FsListResponse {
                    req_id: req_id.clone(),
                    items: vec![],
                    next_cursor: None,
                    error: Some("request_cancelled".to_string()),
                };
                let job_req_id = req_id.clone();
                let accepted = try_spawn_fs_job(
                    tasks,
                    dir_list_admission,
                    dir_list_workers,
                    dir_tx,
                    req_id.clone(),
                    fs_cancellations,
                    move |cancelled| match cache_clone.list_with_cancel(
                        &roots_vec, &root, &path, limit as usize,
                        cursor.as_deref(), dirs_only_flag, &cancelled,
                    ) {
                        Ok((items, next_cursor)) => AgentMessage::FsListResponse {
                            req_id: job_req_id,
                            items,
                            next_cursor,
                            error: None,
                        },
                        Err(e) => AgentMessage::FsListResponse {
                            req_id: job_req_id,
                            items: vec![],
                            next_cursor: None,
                            error: Some(e),
                        },
                    },
                    cancelled_response,
                    panic_response,
                );
                if !accepted {
                    let response = AgentMessage::FsListResponse {
                        req_id,
                        items: vec![],
                        next_cursor: None,
                        error: Some(
                            "agent_overloaded: file I/O queue is full".to_string(),
                        ),
                    };
                    if !queue_agent_message(control_tx, &response) {
                        tracing::warn!("Failed to send fs list overload response, reconnecting");
                        return Err(DisconnectReason::ControlQueueClosed);
                    }
                }
            }
            HubMessage::FsStatRequest { req_id, root, path } => {
                tracing::debug!("FS stat: root={}, path={}", root, path);
                let roots_vec = roots_with_temp(resource_mgr, temp_store);
                let runtime = office_runtime.cloned();
                let rid = req_id.clone();
                let panic_response = AgentMessage::FsStatResponse {
                    req_id: rid,
                    stat: None,
                    error: Some("agent_internal_error".to_string()),
                };
                let cancelled_response = AgentMessage::FsStatResponse {
                    req_id: req_id.clone(),
                    stat: None,
                    error: Some("request_cancelled".to_string()),
                };
                let job_req_id = req_id.clone();
                let accepted = try_spawn_fs_job(
                    tasks,
                    fs_admission,
                    fs_workers,
                    dir_tx,
                    req_id.clone(),
                    fs_cancellations,
                    move |cancelled| {
                        if cancelled.load(Ordering::Acquire) {
                            return AgentMessage::FsStatResponse {
                                req_id: job_req_id.clone(),
                                stat: None,
                                error: Some("request_cancelled".to_string()),
                            };
                        }
                        if let Some(cache) =
                            crate::office_convert::parse_cache_virtual_path(&path)
                        {
                            match runtime {
                                Some(rt) => match crate::office_convert::stat_cache(
                                    &rt.config.office_dir,
                                    &roots_vec,
                                    &root,
                                    &cache,
                                ) {
                                    Ok(size) => AgentMessage::FsStatResponse {
                                        req_id: job_req_id,
                                        stat: Some(
                                            filebox_protocol::resources::FileStat {
                                                path,
                                                entry_type:
                                                    filebox_protocol::resources::FsEntryType::File,
                                                size,
                                                modified: None,
                                                permissions: None,
                                                denied: false,
                                            },
                                        ),
                                        error: None,
                                    },
                                    Err(e) => AgentMessage::FsStatResponse {
                                        req_id: job_req_id,
                                        stat: None,
                                        error: Some(e),
                                    },
                                },
                                None => AgentMessage::FsStatResponse {
                                    req_id: job_req_id,
                                    stat: None,
                                    error: Some("office_unavailable".to_string()),
                                },
                            }
                        } else {
                            match crate::fs::stat_file(&roots_vec, &root, &path) {
                                Ok(stat) => AgentMessage::FsStatResponse {
                                    req_id: job_req_id,
                                    stat: Some(stat),
                                    error: None,
                                },
                                Err(e) => AgentMessage::FsStatResponse {
                                    req_id: job_req_id,
                                    stat: None,
                                    error: Some(e),
                                },
                            }
                        }
                    },
                    cancelled_response,
                    panic_response,
                );
                if !accepted {
                    let response = AgentMessage::FsStatResponse {
                        req_id,
                        stat: None,
                        error: Some(
                            "agent_overloaded: file I/O queue is full".to_string(),
                        ),
                    };
                    if !queue_agent_message(control_tx, &response) {
                        tracing::warn!("Failed to send fs stat overload response, reconnecting");
                        return Err(DisconnectReason::ControlQueueClosed);
                    }
                }
            }
            HubMessage::FileReadRequest { req_id, root, path, offset, length } => {
                tracing::debug!("FS read: root={}, path={}, offset={}, len={:?}", root, path, offset, length);
                let roots_vec = roots_with_temp(resource_mgr, temp_store);
                let runtime = office_runtime.cloned();
                let content_cache_ref = content_cache.clone();
                let rid = req_id.clone();
                let panic_response = AgentMessage::FileChunk {
                    req_id: rid,
                    offset: 0,
                    data: vec![],
                    done: true,
                    error: Some("agent_internal_error".to_string()),
                    file_size: None,
                    modified: None,
                };
                let cancelled_response = AgentMessage::FileChunk {
                    req_id: req_id.clone(),
                    offset,
                    data: vec![],
                    done: true,
                    error: Some("request_cancelled".to_string()),
                    file_size: None,
                    modified: None,
                };
                let job_req_id = req_id.clone();
                let accepted = try_spawn_fs_job(
                    tasks,
                    fs_admission,
                    fs_workers,
                    fs_tx,
                    req_id.clone(),
                    fs_cancellations,
                    move |cancelled| {
                        if cancelled.load(Ordering::Acquire) {
                            return AgentMessage::FileChunk {
                                req_id: job_req_id.clone(),
                                offset,
                                data: vec![],
                                done: true,
                                error: Some("request_cancelled".to_string()),
                                file_size: None,
                                modified: None,
                            };
                        }
                        let read_result = if let Some(cache) =
                            crate::office_convert::parse_cache_virtual_path(&path)
                        {
                            match runtime {
                                Some(rt) => crate::office_convert::read_cache_range(
                                    &rt.config.office_dir,
                                    &roots_vec,
                                    &root,
                                    &cache,
                                    offset,
                                    length,
                                )
                                .map(|(data, done, file_len)| {
                                    crate::fs::FileReadRange {
                                        data,
                                        done,
                                        file_size: Some(file_len),
                                        modified: None,
                                    }
                                }),
                                None => Err("office_unavailable".to_string()),
                            }
                        } else {
                            crate::fs::read_file_range_with_metadata(
                                &roots_vec,
                                &root,
                                &path,
                                offset,
                                length,
                                Some(&content_cache_ref),
                                Some(cancelled.as_ref()),
                            )
                        };
                        if cancelled.load(Ordering::Acquire) {
                            return AgentMessage::FileChunk {
                                req_id: job_req_id.clone(),
                                offset,
                                data: vec![],
                                done: true,
                                error: Some("request_cancelled".to_string()),
                                file_size: None,
                                modified: None,
                            };
                        }
                        match read_result {
                            Ok(result) => AgentMessage::FileChunk {
                                req_id: job_req_id,
                                offset,
                                data: result.data,
                                done: result.done,
                                error: None,
                                file_size: result.file_size,
                                modified: result.modified,
                            },
                            Err(e) => AgentMessage::FileChunk {
                                req_id: job_req_id,
                                offset: 0,
                                data: vec![],
                                done: true,
                                error: Some(e),
                                file_size: None,
                                modified: None,
                            },
                        }
                    },
                    cancelled_response,
                    panic_response,
                );
                if !accepted {
                    let response = AgentMessage::FileChunk {
                        req_id,
                        offset: 0,
                        data: vec![],
                        done: true,
                        error: Some(
                            "agent_overloaded: file I/O queue is full".to_string(),
                        ),
                        file_size: None,
                        modified: None,
                    };
                    if !queue_agent_message(control_tx, &response) {
                        tracing::warn!("Failed to send file read overload response, reconnecting");
                        return Err(DisconnectReason::ControlQueueClosed);
                    }
                }
            }
            _ => unreachable!("dispatcher selected the wrong handler"),
        }
        Ok(())
    }
}
