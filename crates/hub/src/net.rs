use std::net::{IpAddr, SocketAddr};

use axum::http::HeaderMap;

pub(crate) fn client_ip(headers: &HeaderMap, peer: SocketAddr) -> String {
    client_ip_with_xff_trust(headers, peer, trust_xff_enabled())
}

fn trust_xff_enabled() -> bool {
    std::env::var("FILEBOX_TRUST_XFF")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false)
}

fn client_ip_with_xff_trust(headers: &HeaderMap, peer: SocketAddr, trust_xff: bool) -> String {
    if trust_xff {
        if let Some(ip) = headers
            .get("x-forwarded-for")
            .and_then(|v| v.to_str().ok())
            .and_then(last_valid_xff_ip)
        {
            return ip.to_string();
        }
    }
    peer.ip().to_string()
}

fn last_valid_xff_ip(value: &str) -> Option<IpAddr> {
    value
        .split(',')
        .next_back()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .and_then(|s| s.parse::<IpAddr>().ok())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    fn peer() -> SocketAddr {
        "10.0.0.10:12345".parse().unwrap()
    }

    #[test]
    fn defaults_to_peer_ip_when_xff_is_not_trusted() {
        let mut headers = HeaderMap::new();
        headers.insert("x-forwarded-for", HeaderValue::from_static("1.2.3.4"));

        assert_eq!(client_ip_with_xff_trust(&headers, peer(), false), "10.0.0.10");
    }

    #[test]
    fn trusted_xff_uses_rightmost_valid_hop() {
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-forwarded-for",
            HeaderValue::from_static("1.2.3.4, 203.0.113.9"),
        );

        assert_eq!(client_ip_with_xff_trust(&headers, peer(), true), "203.0.113.9");
    }

    #[test]
    fn trusted_xff_falls_back_to_peer_for_invalid_value() {
        let mut headers = HeaderMap::new();
        headers.insert("x-forwarded-for", HeaderValue::from_static("not-an-ip"));

        assert_eq!(client_ip_with_xff_trust(&headers, peer(), true), "10.0.0.10");
    }
}
