use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentInfo {
    pub id: Uuid,
    pub name: String,
    pub status: AgentStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentStatus {
    Online,
    Offline,
    Slow,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_status_serializes_as_snake_case() {
        assert_eq!(
            serde_json::to_string(&AgentStatus::Online).unwrap(),
            "\"online\""
        );
        assert_eq!(
            serde_json::to_string(&AgentStatus::Offline).unwrap(),
            "\"offline\""
        );
        assert_eq!(
            serde_json::to_string(&AgentStatus::Slow).unwrap(),
            "\"slow\""
        );
    }

    #[test]
    fn agent_status_round_trips() {
        for status in [AgentStatus::Online, AgentStatus::Offline, AgentStatus::Slow] {
            let json = serde_json::to_string(&status).unwrap();
            let back: AgentStatus = serde_json::from_str(&json).unwrap();
            assert_eq!(status, back);
        }
    }

    #[test]
    fn agent_info_round_trips_with_uuid() {
        let id = Uuid::new_v4();
        let info = AgentInfo {
            id,
            name: "Lab Server 1".to_string(),
            status: AgentStatus::Online,
        };
        let json = serde_json::to_string(&info).unwrap();
        let back: AgentInfo = serde_json::from_str(&json).unwrap();
        assert_eq!(back.id, id);
        assert_eq!(back.name, "Lab Server 1");
        assert_eq!(back.status, AgentStatus::Online);
    }

    #[test]
    fn agent_status_rejects_unknown_variant() {
        let result: Result<AgentStatus, _> = serde_json::from_str("\"unknown\"");
        assert!(result.is_err());
    }

    #[test]
    fn agent_status_rejects_camel_case() {
        // serde rename_all = "snake_case" means CamelCase input must be rejected
        let result: Result<AgentStatus, _> = serde_json::from_str("\"Online\"");
        assert!(result.is_err());
    }
}
