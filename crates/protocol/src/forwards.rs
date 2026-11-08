use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ForwardConfig {
    pub port: u16,
    pub name: String,
    #[serde(default)]
    pub keep_prefix: bool,
    #[serde(default)]
    pub trusted: bool,
}

pub fn validate_forwards(forwards: &[ForwardConfig]) -> Result<(), String> {
    if forwards.len() > 64 {
        return Err("At most 64 forwards are allowed".into());
    }
    let mut ports = std::collections::HashSet::new();
    for forward in forwards {
        if forward.port == 0 || !ports.insert(forward.port) {
            return Err("Forward ports must be nonzero and unique".into());
        }
        if forward.name.trim().is_empty() || forward.name.len() > 256
            || forward.name.chars().any(char::is_control)
        {
            return Err("Forward names must be nonempty, at most 256 bytes, and contain no control characters".into());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn keep_prefix_defaults_false_and_round_trips_true() {
        let legacy: ForwardConfig = serde_json::from_str(r#"{"port":9001,"name":"app"}"#).unwrap();
        assert!(!legacy.keep_prefix);
        assert!(!legacy.trusted);
        let entry = ForwardConfig { keep_prefix: true, ..legacy };
        assert_eq!(serde_json::from_str::<ForwardConfig>(&serde_json::to_string(&entry).unwrap()).unwrap(), entry);
    }

    #[test]
    fn validates_empty_normal_and_invalid_lists() {
        assert!(validate_forwards(&[]).is_ok());
        let entry = ForwardConfig { port: 9001, name: "Notebook".into(), keep_prefix: false, trusted: false };
        assert!(validate_forwards(std::slice::from_ref(&entry)).is_ok());
        assert!(validate_forwards(&[entry.clone(), entry]).is_err());
        for (port, name) in [(0, "app"), (80, ""), (80, "bad\nname")] {
            assert!(validate_forwards(&[ForwardConfig { port, name: name.into(), keep_prefix: false, trusted: false }]).is_err());
        }
    }
}
