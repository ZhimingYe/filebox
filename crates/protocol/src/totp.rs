//! TOTP core for Agent-local enrollment, verification and anti-replay.
//!
//! HMAC-SHA1, 30s time step, 6 digits (the RFC 4226 truncated value mod
//! 10^6). Secrets are 160-bit random values, base32-encoded (RFC 4648, no
//! padding) for display/storage.

use std::time::{SystemTime, UNIX_EPOCH};

use hmac::{Hmac, Mac};
use rand::Rng;

/// RFC 6238 time step.
pub const TOTP_STEP_SECS: u64 = 30;
/// Codes are 6 digits (the RFC 4226 truncated value mod 10^6).
const TOTP_MODULO: u32 = 1_000_000;
/// Shortest operator-supplied secret we accept (RFC 4226 §4 recommends 128
/// bits; wizard-generated secrets are 160). A one-character base32 key would
/// otherwise be advertised as "2FA enabled" while being trivially guessable.
pub const MIN_SECRET_BYTES: usize = 16;

/// Fresh 160-bit TOTP secret (raw bytes; base32-encode for display/storage).
pub fn generate_secret() -> [u8; 20] {
    let mut rng = rand::rng();
    let mut bytes = [0u8; 20];
    rng.fill(&mut bytes);
    bytes
}

pub fn base32_encode(secret: &[u8]) -> String {
    base32::encode(base32::Alphabet::Rfc4648 { padding: false }, secret)
}

pub fn base32_decode(secret_b32: &str) -> Option<Vec<u8>> {
    base32::decode(base32::Alphabet::Rfc4648 { padding: false }, secret_b32)
}

/// 6-digit TOTP value for `counter` (RFC 6238 with HMAC-SHA1: 8-byte
/// big-endian counter, RFC 4226 dynamic truncation, mod 10^6).
pub fn totp_at(secret: &[u8], counter: u64) -> u32 {
    let mut mac = <Hmac<sha1::Sha1> as Mac>::new_from_slice(secret)
        .expect("HMAC-SHA1 accepts keys of any length");
    mac.update(&counter.to_be_bytes());
    let hash = mac.finalize().into_bytes();
    let offset = (hash[19] & 0x0f) as usize;
    let binary = ((hash[offset] as u32 & 0x7f) << 24)
        | ((hash[offset + 1] as u32) << 16)
        | ((hash[offset + 2] as u32) << 8)
        | (hash[offset + 3] as u32);
    binary % TOTP_MODULO
}

/// The current wall-clock 30s step.
pub fn current_counter() -> u64 {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    now / TOTP_STEP_SECS
}

/// Which counter `code` matches at reference `counter`, scanning the current
/// step ±1 (client clock skew / typing latency). Codes must be exactly 6
/// ASCII digits; leading zeros are fine because both sides compare as parsed
/// integers (timing side channels are not a concern behind rate limiters).
///
/// Returning the matched counter (rather than a bool) lets the AGENT enforce
/// anti-replay: a code is only accepted if its counter is strictly newer
/// than the last accepted one.
///
/// The NEWEST permitted step is tried first. Two adjacent steps collide (produce the
/// same 6 digits) about once in 10^6 pairs, and reporting the older counter
/// for such a collision would leave the agent's anti-replay watermark one
/// step behind, letting the same code be spent twice.
pub fn matching_counter_at(secret_b32: &str, code: &str, counter: u64) -> Option<u64> {
    if code.len() != 6 || !code.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let code_value = code.parse::<u32>().ok()?;
    let secret = base32_decode(secret_b32)?;
    candidate_counters(counter).find(|&candidate| totp_at(&secret, candidate) == code_value)
}

/// Counters to try, newest first within the ±1 skew window. `checked_sub` drops the previous
/// step at counter 0 instead of wrapping.
fn candidate_counters(counter: u64) -> impl Iterator<Item = u64> {
    [counter.checked_add(1), Some(counter), counter.checked_sub(1)]
        .into_iter()
        .flatten()
}

/// True when `secret_b32` is decodable base32 AND long enough to be worth
/// trusting. Use this for secrets that come from an operator (agent.toml /
/// env var) rather than ones this process generated.
pub fn secret_is_acceptable(secret_b32: &str) -> bool {
    base32_decode(secret_b32).is_some_and(|bytes| bytes.len() >= MIN_SECRET_BYTES)
}

/// Verify a user-submitted code at an explicit counter (±1 step window).
pub fn verify_at(secret_b32: &str, code: &str, counter: u64) -> bool {
    matching_counter_at(secret_b32, code, counter).is_some()
}

/// Verify against the current wall-clock 30s step.
pub fn verify(secret_b32: &str, code: &str) -> bool {
    verify_at(secret_b32, code, current_counter())
}

pub fn otpauth_uri(username: &str, secret_b32: &str) -> String {
    format!(
        "otpauth://totp/filebox:{}?secret={}&issuer=filebox",
        percent_encode_label(username),
        secret_b32
    )
}

/// Percent-encode everything outside RFC 3986 unreserved. An authenticator
/// label may be free-form, and an unescaped `?`/`&`/space/`#` would
/// corrupt the otpauth label or inject query parameters — which would break
/// (or silently redirect) the QR scan during authenticator binding.
fn percent_encode_label(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// RFC 6238 Appendix B SHA-1 test secret (ASCII "12345678901234567890").
    const RFC_SECRET: &[u8] = b"12345678901234567890";

    fn counter_at(time_secs: u64) -> u64 {
        time_secs / TOTP_STEP_SECS
    }

    #[test]
    fn rfc6238_sha1_vectors_mod_1e6() {
        // The RFC's 8-digit values mod 10^6 give our 6-digit variant:
        // 94287082 → 287082, 07081804 → 81804, 89005924 → 5924.
        assert_eq!(totp_at(RFC_SECRET, counter_at(59)), 287082);
        assert_eq!(totp_at(RFC_SECRET, counter_at(1111111109)), 81804);
        assert_eq!(totp_at(RFC_SECRET, counter_at(1234567890)), 5924);
    }

    #[test]
    fn matching_counter_reports_the_matched_step() {
        let b32 = base32_encode(RFC_SECRET);
        let counter = counter_at(59);
        assert_eq!(matching_counter_at(&b32, "287082", counter), Some(counter));
        let prev = format!("{:06}", totp_at(RFC_SECRET, counter - 1));
        assert_eq!(
            matching_counter_at(&b32, &prev, counter),
            Some(counter - 1)
        );
        let next = format!("{:06}", totp_at(RFC_SECRET, counter + 1));
        assert_eq!(
            matching_counter_at(&b32, &next, counter),
            Some(counter + 1)
        );
    }

    #[test]
    fn verify_at_accepts_current_and_adjacent_steps() {
        let b32 = base32_encode(RFC_SECRET);
        let counter = counter_at(59);
        assert!(verify_at(&b32, "287082", counter));
        let prev = format!("{:06}", totp_at(RFC_SECRET, counter - 1));
        let next = format!("{:06}", totp_at(RFC_SECRET, counter + 1));
        assert!(verify_at(&b32, &prev, counter));
        assert!(verify_at(&b32, &next, counter));
        // A code two steps away must not verify.
        let far = format!("{:06}", totp_at(RFC_SECRET, counter + 2));
        assert!(far != "287082" && !verify_at(&b32, &far, counter));
    }

    #[test]
    fn verify_at_rejects_garbage_and_wrong_length() {
        let b32 = base32_encode(RFC_SECRET);
        let counter = counter_at(59);
        assert!(!verify_at(&b32, "28708", counter)); // 5 digits
        assert!(!verify_at(&b32, "2870820", counter)); // 7 digits
        assert!(!verify_at(&b32, "abcdef", counter)); // non-digits
        assert!(!verify_at(&b32, "", counter));
        assert!(!verify_at("not-base32!!!", "287082", counter));
    }

    #[test]
    fn base32_round_trips() {
        let secret = generate_secret();
        let b32 = base32_encode(&secret);
        assert_eq!(base32_decode(&b32).unwrap(), secret);
    }

    /// RFC 6238 gives 8-digit values; our 6-digit variant keeps the leading
    /// zeros, and the wire format is a STRING. Both must verify as written.
    #[test]
    fn leading_zero_codes_verify_as_strings() {
        let b32 = base32_encode(RFC_SECRET);
        let counter = counter_at(1111111109);
        assert!(verify_at(&b32, "081804", counter));
        assert_eq!(matching_counter_at(&b32, "081804", counter), Some(counter));
        let counter = counter_at(1234567890);
        assert!(verify_at(&b32, "005924", counter));
        assert_eq!(matching_counter_at(&b32, "005924", counter), Some(counter));
    }

    /// The newest step must win ties, so the agent's anti-replay watermark
    /// always advances to the newest counter the code could belong to.
    /// (A real collision is ~1e-6 per step, so the preference order is what
    /// gets tested; `matching_counter_at` takes the first candidate that
    /// matches.)
    #[test]
    fn candidate_counters_prefer_the_newest_step() {
        assert_eq!(candidate_counters(5).collect::<Vec<_>>(), vec![6, 5, 4]);
        // Counter 0 has no previous step — and must not wrap to u64::MAX.
        assert_eq!(candidate_counters(0).collect::<Vec<_>>(), vec![1, 0]);
    }

    #[test]
    fn weak_operator_secrets_are_rejected() {
        // "A" decodes to zero bytes — an empty HMAC key would still have been
        // advertised as "2FA enabled".
        assert!(!secret_is_acceptable("A"));
        assert!(!secret_is_acceptable("GEZDGNBVGY3TQOJQ")); // 10 bytes
        assert!(!secret_is_acceptable("not-base32!!"));
        assert!(secret_is_acceptable("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ")); // 20
    }

    #[test]
    fn otpauth_label_escapes_hostile_usernames() {
        let uri = otpauth_uri("john doe", "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
        assert!(uri.contains("filebox:john%20doe?"), "{uri}");
        let uri = otpauth_uri("a?secret=evil&x=1", "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
        assert!(uri.contains("filebox:a%3Fsecret%3Devil%26x%3D1?"), "{uri}");
        assert_eq!(
            uri.matches("secret=").count(),
            1,
            "username must not inject a second secret parameter: {uri}"
        );
    }
}
