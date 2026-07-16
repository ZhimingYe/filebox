use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde::de::{Error as DeError, SeqAccess, Visitor};
use crate::resources::{Capabilities, CollectionConfig, FileStat, FsEntry, RootConfig, SysStats};
use crate::search::{SearchMode, SearchResult};

// ── Agent → Hub ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AgentMessage {
    Auth {
        token: String,
    },
    Register {
        agent_id: Option<String>,
        name: String,
        resource_revision: u64,
        roots: Vec<RootConfig>,
        capabilities: Capabilities,
        /// Virtual collections persisted on this agent. Omitted by legacy agents.
        #[serde(default)]
        collections_revision: u64,
        #[serde(default)]
        collections: Vec<CollectionConfig>,
    },
    Pong,
    Heartbeat,
    ResourcesApplied {
        req_id: String,
        agent_id: String,
        resource_revision: u64,
    },
    ResourcesRejected {
        req_id: String,
        agent_id: String,
        current_resource_revision: u64,
        error: String,
        message: String,
    },
    ResourcesUpdated {
        agent_id: String,
        resource_revision: u64,
        roots: Vec<RootConfig>,
    },
    CollectionsApplied {
        req_id: String,
        agent_id: String,
        collections_revision: u64,
    },
    CollectionsRejected {
        req_id: String,
        agent_id: String,
        current_collections_revision: u64,
        error: String,
        message: String,
    },
    CollectionsUpdated {
        agent_id: String,
        collections_revision: u64,
        collections: Vec<CollectionConfig>,
    },
    FsListResponse {
        req_id: String,
        items: Vec<FsEntry>,
        next_cursor: Option<String>,
        error: Option<String>,
    },
    FsStatResponse {
        req_id: String,
        stat: Option<FileStat>,
        error: Option<String>,
    },
    FileChunk {
        req_id: String,
        offset: u64,
        #[serde(with = "base64_bytes")]
        data: Vec<u8>,
        done: bool,
        error: Option<String>,
    },
    Progress {
        req_id: String,
        phase: String,
        processed: u64,
        total: Option<u64>,
        message: Option<String>,
    },
    SysStatsResponse {
        req_id: String,
        stats: Option<SysStats>,
        error: Option<String>,
    },
    WorkspaceSearchResponse {
        req_id: String,
        result: Option<SearchResult>,
        error: Option<String>,
    },
}

mod base64_bytes {
    use super::*;
    use base64::Engine;
    use std::fmt;

    pub fn serialize<S>(bytes: &[u8], serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
        serializer.serialize_str(&encoded)
    }

    pub fn deserialize<'de, D>(deserializer: D) -> Result<Vec<u8>, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_any(BytesVisitor)
    }

    struct BytesVisitor;

    impl<'de> Visitor<'de> for BytesVisitor {
        type Value = Vec<u8>;

        fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            formatter.write_str("base64 string or legacy JSON byte array")
        }

        fn visit_str<E>(self, value: &str) -> Result<Self::Value, E>
        where
            E: DeError,
        {
            base64::engine::general_purpose::STANDARD
                .decode(value)
                .map_err(E::custom)
        }

        fn visit_seq<A>(self, mut seq: A) -> Result<Self::Value, A::Error>
        where
            A: SeqAccess<'de>,
        {
            let mut bytes = Vec::with_capacity(seq.size_hint().unwrap_or(0));
            while let Some(byte) = seq.next_element::<u8>()? {
                bytes.push(byte);
            }
            Ok(bytes)
        }
    }
}

// ── Hub → Agent ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum HubMessage {
    AuthResult {
        success: bool,
        agent_id: Option<String>,
    },
    Ping,
    ResourcesSetDesired {
        req_id: String,
        desired_revision: u64,
        roots: Vec<RootConfig>,
    },
    CollectionsSetDesired {
        req_id: String,
        desired_revision: u64,
        collections: Vec<CollectionConfig>,
    },
    FsListRequest {
        req_id: String,
        root: String,
        path: String,
        limit: u32,
        cursor: Option<String>,
        /// When true, the agent skips files entirely and returns only
        /// directory entries (used by the directory-tree navigator). Omitting
        /// it (None) preserves the legacy full-listing behavior. The field is
        /// additive: old agents that don't know it simply ignore the unknown
        /// serde field and return everything, and old hubs never send it.
        #[serde(default)]
        dirs_only: Option<bool>,
    },
    FsStatRequest {
        req_id: String,
        root: String,
        path: String,
    },
    FileReadRequest {
        req_id: String,
        root: String,
        path: String,
        offset: u64,
        length: Option<u64>,
    },
    Cancel {
        req_id: String,
    },
    Error {
        message: String,
    },
    SysStatsRequest {
        req_id: String,
    },
    /// In-process find (fd-like) / content (rg-like) search under one root.
    WorkspaceSearchRequest {
        req_id: String,
        mode: SearchMode,
        root: String,
        /// Subdirectory within the root to start from (default `/`).
        #[serde(default)]
        path: String,
        /// Find: case-insensitive name substring (empty = all names).
        /// Content: regex pattern (invalid regex → agent error).
        query: String,
        /// Extension filter without dots, e.g. `["rs","ts"]`. Empty = no filter.
        #[serde(default)]
        extensions: Vec<String>,
        /// Cap on returned hits (agent clamps to a hard max).
        #[serde(default)]
        max_results: Option<u32>,
        /// Content-mode ±context lines (default 10; ignored for find).
        #[serde(default)]
        context: Option<u32>,
    },
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::resources::{Capabilities, FileStat, FsEntry, FsEntryType, RootConfig};

    fn round_trip_agent(msg: &AgentMessage) -> AgentMessage {
        let json = serde_json::to_string(msg).unwrap();
        serde_json::from_str(&json).unwrap()
    }

    fn round_trip_hub(msg: &HubMessage) -> HubMessage {
        let json = serde_json::to_string(msg).unwrap();
        serde_json::from_str(&json).unwrap()
    }

    #[test]
    fn agent_auth_round_trips() {
        let msg = AgentMessage::Auth {
            token: "agent_token_xyz".to_string(),
        };
        let back = round_trip_agent(&msg);
        match back {
            AgentMessage::Auth { token } => assert_eq!(token, "agent_token_xyz"),
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn agent_register_round_trips_with_all_fields() {
        let msg = AgentMessage::Register {
            agent_id: Some("stable-uuid".to_string()),
            name: "Lab Server 1".to_string(),
            resource_revision: 42,
            roots: vec![RootConfig {
                name: "logs".to_string(),
                path: "/var/logs".to_string(),
                enabled: true,
                pinned_folders: vec![],
            }],
            capabilities: Capabilities::default(),
            collections_revision: 0,
            collections: vec![],
        };
        let back = round_trip_agent(&msg);
        match back {
            AgentMessage::Register {
                agent_id,
                name,
                resource_revision,
                roots,
                capabilities,
                ..
            } => {
                assert_eq!(agent_id.as_deref(), Some("stable-uuid"));
                assert_eq!(name, "Lab Server 1");
                assert_eq!(resource_revision, 42);
                assert_eq!(roots.len(), 1);
                assert!(capabilities.fs_list);
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn agent_register_accepts_none_agent_id() {
        let msg = AgentMessage::Register {
            agent_id: None,
            name: "fresh".to_string(),
            resource_revision: 0,
            roots: vec![],
            capabilities: Capabilities::default(),
            collections_revision: 0,
            collections: vec![],
        };
        let back = round_trip_agent(&msg);
        match back {
            AgentMessage::Register { agent_id, .. } => assert!(agent_id.is_none()),
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn agent_file_chunk_round_trips_with_data() {
        let msg = AgentMessage::FileChunk {
            req_id: "req_1".to_string(),
            offset: 4096,
            data: vec![0xde, 0xad, 0xbe, 0xef],
            done: false,
            error: None,
        };
        let back = round_trip_agent(&msg);
        match back {
            AgentMessage::FileChunk {
                req_id,
                offset,
                data,
                done,
                error,
            } => {
                assert_eq!(req_id, "req_1");
                assert_eq!(offset, 4096);
                assert_eq!(data, vec![0xde, 0xad, 0xbe, 0xef]);
                assert!(!done);
                assert!(error.is_none());
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn agent_file_chunk_serializes_data_as_base64_string() {
        let msg = AgentMessage::FileChunk {
            req_id: "req_1".to_string(),
            offset: 0,
            data: vec![0xde, 0xad, 0xbe, 0xef],
            done: true,
            error: None,
        };

        let json = serde_json::to_value(&msg).unwrap();

        assert_eq!(json["data"], "3q2+7w==");
    }

    #[test]
    fn agent_file_chunk_accepts_legacy_json_byte_array() {
        let json = r#"{
            "type":"file_chunk",
            "req_id":"legacy",
            "offset":0,
            "data":[222,173,190,239],
            "done":true,
            "error":null
        }"#;

        let msg: AgentMessage = serde_json::from_str(json).unwrap();

        match msg {
            AgentMessage::FileChunk { data, .. } => {
                assert_eq!(data, vec![0xde, 0xad, 0xbe, 0xef]);
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn agent_resources_rejected_round_trips() {
        let msg = AgentMessage::ResourcesRejected {
            req_id: "req_99".to_string(),
            agent_id: "agent-1".to_string(),
            current_resource_revision: 5,
            error: "invalid_resource".to_string(),
            message: "Root '/etc' is not a directory".to_string(),
        };
        let back = round_trip_agent(&msg);
        match back {
            AgentMessage::ResourcesRejected {
                req_id,
                agent_id,
                current_resource_revision,
                error,
                message,
            } => {
                assert_eq!(req_id, "req_99");
                assert_eq!(agent_id, "agent-1");
                assert_eq!(current_resource_revision, 5);
                assert_eq!(error, "invalid_resource");
                assert!(message.contains("not a directory"));
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn agent_fs_list_response_with_error_field() {
        let msg = AgentMessage::FsListResponse {
            req_id: "req_err".to_string(),
            items: vec![],
            next_cursor: None,
            error: Some("Permission denied".to_string()),
        };
        let back = round_trip_agent(&msg);
        match back {
            AgentMessage::FsListResponse { error, .. } => {
                assert_eq!(error.as_deref(), Some("Permission denied"));
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn agent_sys_stats_response_round_trips() {
        let stats = crate::resources::SysStats {
            cpu_usage_percent: 10.0,
            mem_used_bytes: 100,
            mem_total_bytes: 200,
            swap_used_bytes: 0,
            swap_total_bytes: 0,
            load_avg: [0.0, 0.0, 0.0],
            uptime_secs: 0,
            boot_time: 0,
            top_processes: vec![],
            total_processes: 0,
            top_users: vec![],
            user_totals: crate::resources::UserTotals {
                user_count: 0,
                total_cpu_usage: 0.0,
                total_mem_bytes: 0,
                total_processes: 0,
            },
        };
        let msg = AgentMessage::SysStatsResponse {
            req_id: "r".to_string(),
            stats: Some(stats),
            error: None,
        };
        let back = round_trip_agent(&msg);
        match back {
            AgentMessage::SysStatsResponse { stats, .. } => {
                assert!(stats.is_some());
                assert_eq!(stats.unwrap().cpu_usage_percent, 10.0);
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn workspace_search_request_response_round_trips() {
        let req = HubMessage::WorkspaceSearchRequest {
            req_id: "s1".into(),
            mode: crate::search::SearchMode::Content,
            root: "data".into(),
            path: "/src".into(),
            query: "TODO".into(),
            extensions: vec!["rs".into()],
            max_results: Some(50),
            context: Some(10),
        };
        let back = round_trip_hub(&req);
        match back {
            HubMessage::WorkspaceSearchRequest {
                mode,
                query,
                extensions,
                context,
                ..
            } => {
                assert_eq!(mode, crate::search::SearchMode::Content);
                assert_eq!(query, "TODO");
                assert_eq!(extensions, vec!["rs"]);
                assert_eq!(context, Some(10));
            }
            _ => panic!("wrong variant"),
        }

        let resp = AgentMessage::WorkspaceSearchResponse {
            req_id: "s1".into(),
            result: Some(crate::search::SearchResult {
                hits: vec![crate::search::SearchHit {
                    root: "data".into(),
                    path: "/src/main.rs".into(),
                    line: Some(12),
                    context: vec![crate::search::SearchContextLine {
                        line: 12,
                        text: "TODO".into(),
                        is_match: true,
                    }],
                }],
                truncated: false,
                scanned: 3,
            }),
            error: None,
        };
        let back = round_trip_agent(&resp);
        match back {
            AgentMessage::WorkspaceSearchResponse { result, .. } => {
                let r = result.expect("result");
                assert_eq!(r.hits.len(), 1);
                assert_eq!(r.hits[0].line, Some(12));
                assert_eq!(r.scanned, 3);
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn hub_auth_result_success_round_trips() {
        let msg = HubMessage::AuthResult {
            success: true,
            agent_id: Some("assigned-id".to_string()),
        };
        let back = round_trip_hub(&msg);
        match back {
            HubMessage::AuthResult { success, agent_id } => {
                assert!(success);
                assert_eq!(agent_id.as_deref(), Some("assigned-id"));
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn hub_auth_result_failure_round_trips() {
        let msg = HubMessage::AuthResult {
            success: false,
            agent_id: None,
        };
        let back = round_trip_hub(&msg);
        match back {
            HubMessage::AuthResult { success, agent_id } => {
                assert!(!success);
                assert!(agent_id.is_none());
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn hub_resources_set_desired_round_trips() {
        let msg = HubMessage::ResourcesSetDesired {
            req_id: "res_1".to_string(),
            desired_revision: 7,
            roots: vec![
                RootConfig {
                    name: "a".to_string(),
                    path: "/a".to_string(),
                    enabled: true,
                    pinned_folders: vec![],
                },
                RootConfig {
                    name: "b".to_string(),
                    path: "/b".to_string(),
                    enabled: false,
                    pinned_folders: vec![],
                },
            ],
        };
        let back = round_trip_hub(&msg);
        match back {
            HubMessage::ResourcesSetDesired {
                req_id,
                desired_revision,
                roots,
            } => {
                assert_eq!(req_id, "res_1");
                assert_eq!(desired_revision, 7);
                assert_eq!(roots.len(), 2);
                assert!(roots[0].enabled);
                assert!(!roots[1].enabled);
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn hub_file_read_request_round_trips() {
        // With length
        let msg = HubMessage::FileReadRequest {
            req_id: "f1".to_string(),
            root: "docs".to_string(),
            path: "sub/file.txt".to_string(),
            offset: 100,
            length: Some(200),
        };
        let back = round_trip_hub(&msg);
        match back {
            HubMessage::FileReadRequest {
                req_id,
                root,
                path,
                offset,
                length,
            } => {
                assert_eq!(req_id, "f1");
                assert_eq!(root, "docs");
                assert_eq!(path, "sub/file.txt");
                assert_eq!(offset, 100);
                assert_eq!(length, Some(200));
            }
            _ => panic!("wrong variant"),
        }

        // Without length (read to end)
        let msg = HubMessage::FileReadRequest {
            req_id: "f2".to_string(),
            root: "docs".to_string(),
            path: "p".to_string(),
            offset: 0,
            length: None,
        };
        let back = round_trip_hub(&msg);
        match back {
            HubMessage::FileReadRequest { length, .. } => assert!(length.is_none()),
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn hub_fs_list_request_with_cursor_round_trips() {
        let msg = HubMessage::FsListRequest {
            req_id: "l".to_string(),
            root: "r".to_string(),
            path: "p".to_string(),
            limit: 50,
            cursor: Some("next-page-token".to_string()),
            dirs_only: None,
        };
        let back = round_trip_hub(&msg);
        match back {
            HubMessage::FsListRequest {
                req_id,
                root,
                path,
                limit,
                cursor,
                dirs_only,
            } => {
                assert_eq!(req_id, "l");
                assert_eq!(root, "r");
                assert_eq!(path, "p");
                assert_eq!(limit, 50);
                assert_eq!(cursor.as_deref(), Some("next-page-token"));
                assert!(dirs_only.is_none());
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn hub_cancel_round_trips() {
        let msg = HubMessage::Cancel {
            req_id: "cancel_me".to_string(),
        };
        let back = round_trip_hub(&msg);
        match back {
            HubMessage::Cancel { req_id } => assert_eq!(req_id, "cancel_me"),
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn agent_message_tag_is_snake_case() {
        let msg = AgentMessage::Pong;
        let json = serde_json::to_string(&msg).unwrap();
        assert_eq!(json, "{\"type\":\"pong\"}");
    }

    #[test]
    fn hub_message_tag_is_snake_case() {
        let msg = HubMessage::Ping;
        let json = serde_json::to_string(&msg).unwrap();
        assert_eq!(json, "{\"type\":\"ping\"}");
    }

    #[test]
    fn agent_progress_round_trips() {
        let msg = AgentMessage::Progress {
            req_id: "p".to_string(),
            phase: "reading".to_string(),
            processed: 1024,
            total: Some(4096),
            message: Some("halfway".to_string()),
        };
        let back = round_trip_agent(&msg);
        match back {
            AgentMessage::Progress {
                phase,
                processed,
                total,
                message,
                ..
            } => {
                assert_eq!(phase, "reading");
                assert_eq!(processed, 1024);
                assert_eq!(total, Some(4096));
                assert_eq!(message.as_deref(), Some("halfway"));
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn agent_message_unknown_type_is_rejected() {
        let result: Result<AgentMessage, _> = serde_json::from_str("{\"type\":\"bogus\"}");
        assert!(result.is_err());
    }

    #[test]
    fn hub_message_unknown_type_is_rejected() {
        let result: Result<HubMessage, _> = serde_json::from_str("{\"type\":\"bogus\"}");
        assert!(result.is_err());
    }

    #[test]
    fn fs_entry_with_denied_flag_round_trips() {
        let entry = FsEntry {
            name: ".env".to_string(),
            entry_type: FsEntryType::File,
            size: None,
            modified: None,
            denied: true,
        };
        let json = serde_json::to_string(&entry).unwrap();
        let back: FsEntry = serde_json::from_str(&json).unwrap();
        assert!(back.denied);
        assert_eq!(back.entry_type, FsEntryType::File);
    }

    #[test]
    fn file_stat_with_permissions_round_trips() {
        let stat = FileStat {
            path: "x.txt".to_string(),
            entry_type: FsEntryType::File,
            size: 10,
            modified: Some("2025-01-01T00:00:00Z".to_string()),
            permissions: Some("644".to_string()),
            denied: false,
        };
        let json = serde_json::to_string(&stat).unwrap();
        let back: FileStat = serde_json::from_str(&json).unwrap();
        assert_eq!(back.path, "x.txt");
        assert_eq!(back.size, 10);
        assert_eq!(back.permissions.as_deref(), Some("644"));
    }

    #[test]
    fn agent_resources_applied_round_trips() {
        let msg = AgentMessage::ResourcesApplied {
            req_id: "r1".to_string(),
            agent_id: "a1".to_string(),
            resource_revision: 9,
        };
        let back = round_trip_agent(&msg);
        match back {
            AgentMessage::ResourcesApplied {
                req_id,
                agent_id,
                resource_revision,
            } => {
                assert_eq!(req_id, "r1");
                assert_eq!(agent_id, "a1");
                assert_eq!(resource_revision, 9);
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn agent_resources_updated_round_trips() {
        let msg = AgentMessage::ResourcesUpdated {
            agent_id: "a2".to_string(),
            resource_revision: 3,
            roots: vec![RootConfig {
                name: "x".to_string(),
                path: "/x".to_string(),
                enabled: true,
                pinned_folders: vec![],
            }],
        };
        let back = round_trip_agent(&msg);
        match back {
            AgentMessage::ResourcesUpdated {
                agent_id,
                resource_revision,
                roots,
            } => {
                assert_eq!(agent_id, "a2");
                assert_eq!(resource_revision, 3);
                assert_eq!(roots.len(), 1);
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn hub_error_round_trips() {
        let msg = HubMessage::Error {
            message: "bad request".to_string(),
        };
        let back = round_trip_hub(&msg);
        match back {
            HubMessage::Error { message } => assert_eq!(message, "bad request"),
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn agent_heartbeat_and_pong_are_tag_only() {
        let hb = AgentMessage::Heartbeat;
        let pong = AgentMessage::Pong;
        let hb_json = serde_json::to_string(&hb).unwrap();
        let pong_json = serde_json::to_string(&pong).unwrap();
        assert_eq!(hb_json, "{\"type\":\"heartbeat\"}");
        assert_eq!(pong_json, "{\"type\":\"pong\"}");
    }
}
