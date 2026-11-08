use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ForwardConfig {
    pub port: u16,
    pub name: String,
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
    fn validates_empty_normal_and_invalid_lists() {
        assert!(validate_forwards(&[]).is_ok());
        let entry = ForwardConfig { port: 9001, name: "Notebook".into() };
        assert!(validate_forwards(std::slice::from_ref(&entry)).is_ok());
        assert!(validate_forwards(&[entry.clone(), entry]).is_err());
        for (port, name) in [(0, "app"), (80, ""), (80, "bad\nname")] {
            assert!(validate_forwards(&[ForwardConfig { port, name: name.into() }]).is_err());
        }
    }
}
