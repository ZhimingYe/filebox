//! Proof-of-work login challenges.
//!
//! Self-hosted human/effort check for the login form: the hub issues a random
//! challenge (id + salt + difficulty), the browser finds a `nonce` such that
//! `sha256("{id}:{salt}:{nonce}")` starts with at least `difficulty` zero
//! bits, and the login POST echoes `pow_id` + `pow_nonce`. Verifying costs
//! the hub a single hash; producing the proof costs the client ~2^difficulty
//! hashes — so every password-guessing attempt burns real CPU, on top of the
//! existing per-IP login rate limit.
//!
//! Challenges are in-memory only (sessions and login rate limits are
//! in-memory too), single-use (consumed by the first verification, valid or
//! not — one solved challenge buys exactly one password attempt), expire
//! after [`CHALLENGE_TTL`], and are bounded per client IP and globally so the
//! public challenge endpoint cannot grow memory without bound. No external
//! service or network access is involved — works on air-gapped hubs.
//!
//! Honest scope: this verifies *effort*, not humanity. A determined attacker
//! with native-code hashing can still solve challenges, but each attempt now
//! costs measurable CPU and requires custom tooling; difficulty is tunable
//! via `FILEBOX_POW_DIFFICULTY` (default 20, clamped 12–24).

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use rand::Rng;
use sha2::{Digest, Sha256};

/// How long an issued challenge stays answerable.
pub const CHALLENGE_TTL: Duration = Duration::from_secs(300);
/// Max outstanding challenges a single client IP may hold. Oldest evicted.
pub const MAX_CHALLENGES_PER_IP: usize = 8;
/// Hard bound on total outstanding challenges (memory safety). Oldest evicted.
pub const MAX_TOTAL_CHALLENGES: usize = 5_000;
/// Default work factor: ~1M hashes per proof (sub-second on desktop
/// browsers, a second or two on phones).
pub const DEFAULT_DIFFICULTY: u32 = 20;
pub const MIN_DIFFICULTY: u32 = 12;
pub const MAX_DIFFICULTY: u32 = 24;
/// Nonces are decimal counters; 20 digits covers u64's entire range.
const MAX_NONCE_LEN: usize = 20;

#[derive(Debug, Clone)]
pub struct PowChallenge {
    pub id: String,
    /// Random per-challenge salt (hex) mixed into the hashed input.
    pub salt: String,
    /// Required number of leading zero bits in `sha256("{id}:{salt}:{nonce}")`.
    pub difficulty: u32,
    ip: String,
    created_at: Instant,
}

/// Outcome of verifying a submitted proof.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VerifyOutcome {
    /// Proof satisfies the challenge. The challenge is consumed either way.
    Valid,
    /// Answer did not match (challenge consumed).
    Insufficient,
    /// Unknown id (never issued or already consumed) or past its TTL.
    UnknownOrExpired,
}

pub struct PowStore {
    challenges: Mutex<HashMap<String, PowChallenge>>,
    difficulty: u32,
}

impl PowStore {
    pub fn new(difficulty: u32) -> Self {
        Self {
            challenges: Mutex::new(HashMap::new()),
            difficulty: difficulty.clamp(MIN_DIFFICULTY, MAX_DIFFICULTY),
        }
    }

    /// Issue a new challenge for `ip`, evicting expired entries and this IP's
    /// (then the store's) oldest challenges to respect the caps.
    pub fn issue(&self, ip: &str) -> PowChallenge {
        let now = Instant::now();
        let challenge = PowChallenge::generate(ip, now, self.difficulty);

        let mut map = self.challenges.lock().unwrap();
        map.retain(|_, ch| now.duration_since(ch.created_at) < CHALLENGE_TTL);

        // Per-IP cap: drop this IP's oldest challenges first.
        let mut mine: Vec<(String, Instant)> = map
            .iter()
            .filter(|(_, ch)| ch.ip == ip)
            .map(|(id, ch)| (id.clone(), ch.created_at))
            .collect();
        mine.sort_by_key(|(_, created)| *created);
        while mine.len() >= MAX_CHALLENGES_PER_IP {
            if let Some((oldest, _)) = mine.first() {
                map.remove(oldest);
                mine.remove(0);
            }
        }

        // Global cap: drop the globally oldest challenges.
        let mut all: Vec<(String, Instant)> = map
            .iter()
            .map(|(id, ch)| (id.clone(), ch.created_at))
            .collect();
        all.sort_by_key(|(_, created)| *created);
        while all.len() >= MAX_TOTAL_CHALLENGES {
            if let Some((oldest, _)) = all.first() {
                map.remove(oldest);
                all.remove(0);
            }
        }

        map.insert(challenge.id.clone(), challenge.clone());
        challenge
    }

    /// Verify a proof, consuming the challenge. One-time by design: the
    /// frontend must fetch a fresh challenge after every submit attempt.
    pub fn verify(&self, id: &str, nonce: &str) -> VerifyOutcome {
        // Reject absurd ids before even locking (defense in depth).
        if id.is_empty() || id.len() > 64 {
            return VerifyOutcome::UnknownOrExpired;
        }
        let challenge = {
            let mut map = self.challenges.lock().unwrap();
            match map.remove(id) {
                Some(ch) => ch,
                None => return VerifyOutcome::UnknownOrExpired,
            }
        };
        if challenge.created_at.elapsed() >= CHALLENGE_TTL {
            return VerifyOutcome::UnknownOrExpired;
        }
        if nonce.is_empty()
            || nonce.len() > MAX_NONCE_LEN
            || !nonce.bytes().all(|b| b.is_ascii_digit())
        {
            return VerifyOutcome::Insufficient;
        }
        // Must match the frontend solver byte-for-byte:
        // sha256("{id}:{salt}:{nonce}").
        let message = format!("{}:{}:{}", challenge.id, challenge.salt, nonce);
        let digest = Sha256::digest(message.as_bytes());
        if leading_zero_bits(digest.as_slice()) >= challenge.difficulty {
            VerifyOutcome::Valid
        } else {
            VerifyOutcome::Insufficient
        }
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.challenges.lock().unwrap().len()
    }
}

/// Difficulty from `FILEBOX_POW_DIFFICULTY`, clamped to the supported range.
pub fn difficulty_from_env() -> u32 {
    std::env::var("FILEBOX_POW_DIFFICULTY")
        .ok()
        .and_then(|v| v.parse::<u32>().ok())
        .unwrap_or(DEFAULT_DIFFICULTY)
        .clamp(MIN_DIFFICULTY, MAX_DIFFICULTY)
}

fn leading_zero_bits(bytes: &[u8]) -> u32 {
    let mut bits = 0u32;
    for &byte in bytes {
        if byte == 0 {
            bits += 8;
        } else {
            bits += byte.leading_zeros();
            break;
        }
    }
    bits
}

impl PowChallenge {
    fn generate(ip: &str, now: Instant, difficulty: u32) -> PowChallenge {
        let mut rng = rand::rng();
        let mut id_bytes = [0u8; 16];
        let mut salt_bytes = [0u8; 16];
        rng.fill(&mut id_bytes);
        rng.fill(&mut salt_bytes);
        PowChallenge {
            id: hex::encode(id_bytes),
            salt: hex::encode(salt_bytes),
            difficulty,
            ip: ip.to_string(),
            created_at: now,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Mirror the browser solver: find a decimal nonce meeting the target.
    fn solve(challenge: &PowChallenge) -> String {
        let mut nonce: u64 = 0;
        loop {
            let message = format!("{}:{}:{}", challenge.id, challenge.salt, nonce);
            let digest = Sha256::digest(message.as_bytes());
            if leading_zero_bits(digest.as_slice()) >= challenge.difficulty {
                return nonce.to_string();
            }
            nonce += 1;
        }
    }

    fn expired_challenge(id: &str) -> PowChallenge {
        PowChallenge {
            id: id.to_string(),
            salt: "00".repeat(16),
            difficulty: 8,
            ip: "10.0.0.1".to_string(),
            created_at: Instant::now() - CHALLENGE_TTL - Duration::from_secs(1),
        }
    }

    #[test]
    fn solved_proof_verifies_as_valid() {
        let store = PowStore::new(8);
        for _ in 0..5 {
            let ch = store.issue("10.0.0.1");
            assert_eq!(store.verify(&ch.id, &solve(&ch)), VerifyOutcome::Valid);
        }
    }

    #[test]
    fn difficulty_is_clamped_into_supported_range() {
        assert_eq!(PowStore::new(0).difficulty, MIN_DIFFICULTY);
        assert_eq!(PowStore::new(1000).difficulty, MAX_DIFFICULTY);
        assert_eq!(difficulty_from_env(), DEFAULT_DIFFICULTY);
    }

    #[test]
    fn wrong_nonce_is_insufficient_and_consumes_challenge() {
        let store = PowStore::new(8);
        let ch = store.issue("10.0.0.1");
        let nonce = solve(&ch);
        // 999… can never be a valid proof for difficulty ≥ 1 in practice;
        // just assert it fails and that the real proof no longer works.
        let mut bogus = "99999999999999999999".to_string();
        if bogus == nonce {
            bogus = "1".to_string();
        }
        assert_eq!(store.verify(&ch.id, &bogus), VerifyOutcome::Insufficient);
        assert_eq!(store.verify(&ch.id, &nonce), VerifyOutcome::UnknownOrExpired);
    }

    #[test]
    fn garbage_nonces_are_insufficient() {
        let store = PowStore::new(8);
        let ch = store.issue("10.0.0.1");
        assert_eq!(store.verify(&ch.id, ""), VerifyOutcome::Insufficient);
        let ch2 = store.issue("10.0.0.1");
        assert_eq!(store.verify(&ch2.id, "abc"), VerifyOutcome::Insufficient);
        let ch3 = store.issue("10.0.0.1");
        let too_long = "1".repeat(MAX_NONCE_LEN + 1);
        assert_eq!(store.verify(&ch3.id, &too_long), VerifyOutcome::Insufficient);
    }

    #[test]
    fn challenge_is_single_use_even_when_valid() {
        let store = PowStore::new(8);
        let ch = store.issue("10.0.0.1");
        let nonce = solve(&ch);
        assert_eq!(store.verify(&ch.id, &nonce), VerifyOutcome::Valid);
        assert_eq!(store.verify(&ch.id, &nonce), VerifyOutcome::UnknownOrExpired);
    }

    #[test]
    fn unknown_and_oversized_ids_are_rejected() {
        let store = PowStore::new(8);
        assert_eq!(store.verify("no-such-id", "1"), VerifyOutcome::UnknownOrExpired);
        assert_eq!(store.verify("", "1"), VerifyOutcome::UnknownOrExpired);
        let huge = "a".repeat(65);
        assert_eq!(store.verify(&huge, "1"), VerifyOutcome::UnknownOrExpired);
    }

    #[test]
    fn expired_challenge_is_rejected() {
        let store = PowStore::new(8);
        {
            let mut map = store.challenges.lock().unwrap();
            map.insert("expired".to_string(), expired_challenge("expired"));
        }
        assert_eq!(store.verify("expired", "0"), VerifyOutcome::UnknownOrExpired);
        assert_eq!(store.len(), 0);
    }

    #[test]
    fn expired_entries_are_swept_on_issue() {
        let store = PowStore::new(8);
        {
            let mut map = store.challenges.lock().unwrap();
            map.insert("expired".to_string(), expired_challenge("expired"));
        }
        let fresh = store.issue("10.0.0.1");
        assert_eq!(store.len(), 1);
        assert_eq!(store.verify(&fresh.id, &solve(&fresh)), VerifyOutcome::Valid);
    }

    #[test]
    fn per_ip_cap_evicts_oldest_for_that_ip_only() {
        let store = PowStore::new(8);
        let first = store.issue("10.0.0.1");
        for _ in 0..(MAX_CHALLENGES_PER_IP + 5) {
            store.issue("10.0.0.2");
        }
        // The other IP's churn must never evict 10.0.0.1's challenge.
        assert_eq!(store.verify(&first.id, &solve(&first)), VerifyOutcome::Valid);
        assert!(store.len() <= MAX_CHALLENGES_PER_IP + 1);

        let store = PowStore::new(8);
        let mut issued = Vec::new();
        for _ in 0..(MAX_CHALLENGES_PER_IP + 5) {
            issued.push(store.issue("10.0.0.3"));
        }
        // Oldest was evicted; newest is still answerable.
        assert_eq!(
            store.verify(issued.first().unwrap().id.as_str(), "0"),
            VerifyOutcome::UnknownOrExpired
        );
        let newest = issued.last().unwrap().clone();
        assert_eq!(store.verify(&newest.id, &solve(&newest)), VerifyOutcome::Valid);
    }

    #[test]
    fn global_cap_bounds_total_challenges() {
        let store = PowStore::new(8);
        let mut ip = 0;
        for _ in 0..(MAX_TOTAL_CHALLENGES + 100) {
            ip = (ip + 1) % 10_000;
            store.issue(&format!("10.0.{}.{}", ip / 255, ip % 255));
        }
        assert!(store.len() <= MAX_TOTAL_CHALLENGES);
    }
}
