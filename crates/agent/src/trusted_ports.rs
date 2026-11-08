#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TrustedPorts {
    All,
    Ranges(Vec<(u16, u16)>),
}

impl Default for TrustedPorts {
    fn default() -> Self { Self::Ranges(Vec::new()) }
}

impl TrustedPorts {
    pub fn parse(value: &str) -> Result<Self, String> {
        let value = value.trim();
        if value.is_empty() { return Ok(Self::default()); }
        if value.eq_ignore_ascii_case("all") { return Ok(Self::All); }
        let port = |text: &str| -> Result<u16, String> {
            let text = text.trim();
            if text.is_empty() || !text.bytes().all(|byte| byte.is_ascii_digit()) {
                return Err("expected ports 1-65535 or inclusive ranges such as 9000-9010".into());
            }
            text.parse::<u16>().ok().filter(|port| *port != 0)
                .ok_or_else(|| "ports must be between 1 and 65535".into())
        };
        let mut ranges = Vec::new();
        for item in value.split(',') {
            let (lo, hi) = match item.split_once('-') {
                Some((lo, hi)) => (port(lo)?, port(hi)?),
                None => { let value = port(item)?; (value, value) }
            };
            if lo > hi { return Err("range start must not exceed range end".into()); }
            ranges.push((lo, hi));
        }
        Ok(Self::Ranges(ranges))
    }

    pub fn allows(&self, port: u16) -> bool {
        port != 0 && match self {
            Self::All => true,
            Self::Ranges(ranges) => ranges.iter().any(|(lo, hi)| (*lo..=*hi).contains(&port)),
        }
    }

    pub fn rejection(port: u16) -> String {
        format!("Port {port} is not trusted by this agent; add it to the agent's trusted_ports (agent.toml / FILEBOX_AGENT_TRUSTED_PORTS).")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_lists_ranges_all_and_empty_without_accepting_invalid_ports() {
        let policy = TrustedPorts::parse("3080, 8888, 9000 - 9010,1,65535").unwrap();
        for port in [1, 3080, 8888, 9000, 9005, 9010, 65535] { assert!(policy.allows(port)); }
        for port in [0, 3079, 8999, 9011] { assert!(!policy.allows(port)); }
        for value in ["all", " ALL ", "All"] {
            let policy = TrustedPorts::parse(value).unwrap();
            assert!(policy.allows(1) && policy.allows(65535));
            assert!(!policy.allows(0));
        }
        for value in ["", "  "] { assert_eq!(TrustedPorts::parse(value).unwrap(), TrustedPorts::default()); }
        assert!(!TrustedPorts::default().allows(3080));
        for value in ["0", "65536", "-1", "+80", "1.5", "80,", ",80", "80,,81", "all,80", "abc", "80-79", "1-2-3", "1-", "1 2"] {
            assert!(TrustedPorts::parse(value).is_err(), "{value}");
        }
    }
}
