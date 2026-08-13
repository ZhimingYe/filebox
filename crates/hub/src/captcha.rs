//! Login captcha challenges.
//!
//! Self-hosted human check for the login form: the hub issues short-lived
//! arithmetic challenges ("7 + 3 = ?"), the browser echoes the answer with
//! the login POST, and the challenge is consumed by the first answer check —
//! right or wrong — so an answer can't be replayed and a single challenge
//! can't be brute-forced.
//!
//! Challenges live in memory only (the hub is a single process; sessions and
//! login rate limits are in-memory too), expire after [`CHALLENGE_TTL`], and
//! are bounded per client IP and globally so the public challenge endpoint
//! cannot grow memory without bound. No external service or network access
//! is involved, which keeps the login flow usable on air-gapped hubs.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use rand::Rng;

/// How long an issued challenge stays answerable.
pub const CHALLENGE_TTL: Duration = Duration::from_secs(300);
/// Max outstanding challenges a single client IP may hold. Oldest evicted.
pub const MAX_CHALLENGES_PER_IP: usize = 8;
/// Hard bound on total outstanding challenges (memory safety). Oldest evicted.
pub const MAX_TOTAL_CHALLENGES: usize = 5_000;

#[derive(Debug, Clone)]
pub struct Challenge {
    pub id: String,
    /// Human-readable prompt, e.g. `7 + 3 = ?`.
    pub question: String,
    answer: u64,
    ip: String,
    created_at: Instant,
}

/// Outcome of checking a submitted answer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CheckOutcome {
    /// Answer matches. The challenge is consumed either way.
    Correct,
    /// Answer did not match (challenge consumed).
    Wrong,
    /// Unknown id (never issued or already consumed) or past its TTL.
    UnknownOrExpired,
}

pub struct CaptchaStore {
    challenges: Mutex<HashMap<String, Challenge>>,
}

impl CaptchaStore {
    pub fn new() -> Self {
        Self {
            challenges: Mutex::new(HashMap::new()),
        }
    }

    /// Issue a new challenge for `ip`, evicting expired entries and this IP's
    /// (then the store's) oldest challenges to respect the caps.
    pub fn issue(&self, ip: &str) -> Challenge {
        let now = Instant::now();
        let challenge = Challenge::generate(ip, now);

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

    /// Check an answer, consuming the challenge. One-time by design: the
    /// frontend must request a fresh challenge after every submit attempt.
    pub fn check(&self, id: &str, answer: &str) -> CheckOutcome {
        // Reject absurd ids before even locking (defense in depth).
        if id.is_empty() || id.len() > 64 {
            return CheckOutcome::UnknownOrExpired;
        }
        let challenge = {
            let mut map = self.challenges.lock().unwrap();
            match map.remove(id) {
                Some(ch) => ch,
                None => return CheckOutcome::UnknownOrExpired,
            }
        };
        if challenge.created_at.elapsed() >= CHALLENGE_TTL {
            return CheckOutcome::UnknownOrExpired;
        }
        match answer.trim().parse::<u64>() {
            Ok(parsed) if parsed == challenge.answer => CheckOutcome::Correct,
            _ => CheckOutcome::Wrong,
        }
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.challenges.lock().unwrap().len()
    }
}

impl Challenge {
    fn generate(ip: &str, now: Instant) -> Challenge {
        let mut rng = rand::rng();
        // Small, positive-only arithmetic. Addition/subtraction stay within
        // single digits (answers ≤ 18); multiplication uses 2–9 (answers ≤ 81)
        // so the answer is always a short non-negative integer.
        let (a, b, answer, symbol): (u64, u64, u64, char) = match rng.random_range(0..3) {
            0 => {
                let a = rng.random_range(1..=9);
                let b = rng.random_range(1..=9);
                (a, b, a + b, '+')
            }
            1 => {
                let a = rng.random_range(2..=9);
                // b < a keeps the answer positive (never 0, never negative).
                let b = rng.random_range(1..a);
                (a, b, a - b, '-')
            }
            _ => {
                let a = rng.random_range(2..=9);
                let b = rng.random_range(2..=9);
                (a, b, a * b, '×')
            }
        };
        let mut bytes = [0u8; 16];
        rng.fill(&mut bytes);
        let id = hex::encode(bytes);
        let question = format!("{a} {symbol} {b} = ?");
        Challenge {
            id,
            question,
            answer,
            ip: ip.to_string(),
            created_at: now,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Parse a generated question string back into its numeric answer. Doubles
    /// as a format test: any change to the question format must keep it
    /// machine-solvable (the e2e scripts and this test rely on that).
    fn solve(question: &str) -> u64 {
        let mut parts = question.split_whitespace();
        let a: u64 = parts.next().unwrap().parse().unwrap();
        let op = parts.next().unwrap();
        let b: u64 = parts.next().unwrap().parse().unwrap();
        assert_eq!(parts.next(), Some("="));
        assert_eq!(parts.next(), Some("?"));
        assert_eq!(parts.next(), None);
        match op {
            "+" => a + b,
            "-" => a - b,
            "×" => a * b,
            other => panic!("unexpected operator {other:?} in {question:?}"),
        }
    }

    fn expired_challenge(id: &str) -> Challenge {
        Challenge {
            id: id.to_string(),
            question: "1 + 1 = ?".to_string(),
            answer: 2,
            ip: "10.0.0.1".to_string(),
            created_at: Instant::now() - CHALLENGE_TTL - Duration::from_secs(1),
        }
    }

    #[test]
    fn generated_questions_are_solvable_and_answers_verified() {
        let store = CaptchaStore::new();
        for _ in 0..200 {
            let ch = store.issue("10.0.0.1");
            assert_eq!(store.check(&ch.id, &solve(&ch.question).to_string()), CheckOutcome::Correct);
        }
    }

    #[test]
    fn answers_are_never_negative_or_zero() {
        let store = CaptchaStore::new();
        for _ in 0..200 {
            let ch = store.issue("10.0.0.1");
            let answer = solve(&ch.question);
            assert!(answer >= 1, "question {} has non-positive answer", ch.question);
            assert!(answer <= 81, "question {} has absurd answer", ch.question);
        }
    }

    #[test]
    fn wrong_answer_is_rejected_and_consumes_challenge() {
        let store = CaptchaStore::new();
        let ch = store.issue("10.0.0.1");
        let right = solve(&ch.question);
        let wrong = if right == 81 { 1 } else { right + 1 };
        assert_eq!(store.check(&ch.id, &wrong.to_string()), CheckOutcome::Wrong);
        // Consumed — the right answer must not work afterwards.
        assert_eq!(store.check(&ch.id, &right.to_string()), CheckOutcome::UnknownOrExpired);
    }

    #[test]
    fn non_numeric_and_empty_answers_are_wrong() {
        let store = CaptchaStore::new();
        let ch = store.issue("10.0.0.1");
        assert_eq!(store.check(&ch.id, "abc"), CheckOutcome::Wrong);
        let ch2 = store.issue("10.0.0.1");
        assert_eq!(store.check(&ch2.id, ""), CheckOutcome::Wrong);
    }

    #[test]
    fn answer_with_surrounding_whitespace_is_accepted() {
        let store = CaptchaStore::new();
        let ch = store.issue("10.0.0.1");
        let right = solve(&ch.question);
        assert_eq!(
            store.check(&ch.id, &format!("  {right}  ")),
            CheckOutcome::Correct
        );
    }

    #[test]
    fn challenge_is_single_use_even_when_correct() {
        let store = CaptchaStore::new();
        let ch = store.issue("10.0.0.1");
        let right = solve(&ch.question).to_string();
        assert_eq!(store.check(&ch.id, &right), CheckOutcome::Correct);
        assert_eq!(store.check(&ch.id, &right), CheckOutcome::UnknownOrExpired);
    }

    #[test]
    fn unknown_and_oversized_ids_are_rejected() {
        let store = CaptchaStore::new();
        assert_eq!(store.check("no-such-id", "1"), CheckOutcome::UnknownOrExpired);
        assert_eq!(store.check("", "1"), CheckOutcome::UnknownOrExpired);
        let huge = "a".repeat(65);
        assert_eq!(store.check(&huge, "1"), CheckOutcome::UnknownOrExpired);
    }

    #[test]
    fn expired_challenge_is_rejected() {
        let store = CaptchaStore::new();
        {
            let mut map = store.challenges.lock().unwrap();
            map.insert("expired".to_string(), expired_challenge("expired"));
        }
        assert_eq!(store.check("expired", "2"), CheckOutcome::UnknownOrExpired);
        // And it is gone from the store afterwards.
        assert_eq!(store.len(), 0);
    }

    #[test]
    fn expired_entries_are_swept_on_issue() {
        let store = CaptchaStore::new();
        {
            let mut map = store.challenges.lock().unwrap();
            map.insert("expired".to_string(), expired_challenge("expired"));
        }
        let fresh = store.issue("10.0.0.1");
        assert_eq!(store.len(), 1);
        assert_eq!(store.check(&fresh.id, &solve(&fresh.question).to_string()), CheckOutcome::Correct);
    }

    #[test]
    fn per_ip_cap_evicts_oldest_for_that_ip_only() {
        let store = CaptchaStore::new();
        let first = store.issue("10.0.0.1");
        for _ in 0..(MAX_CHALLENGES_PER_IP + 5) {
            store.issue("10.0.0.2");
        }
        // The other IP's churn must never evict 10.0.0.1's challenge.
        assert_eq!(store.check(&first.id, &solve(&first.question).to_string()), CheckOutcome::Correct);
        assert!(store.len() <= MAX_CHALLENGES_PER_IP + 1);

        let store = CaptchaStore::new();
        let mut issued = Vec::new();
        for _ in 0..(MAX_CHALLENGES_PER_IP + 5) {
            issued.push(store.issue("10.0.0.3"));
        }
        // Oldest was evicted; newest is still answerable.
        assert_eq!(
            store.check(issued.first().unwrap().id.as_str(), "0"),
            CheckOutcome::UnknownOrExpired
        );
        let newest = issued.last().unwrap().clone();
        assert_eq!(
            store.check(&newest.id, &solve(&newest.question).to_string()),
            CheckOutcome::Correct
        );
    }

    #[test]
    fn global_cap_bounds_total_challenges() {
        let store = CaptchaStore::new();
        let mut ip = 0;
        for _ in 0..(MAX_TOTAL_CHALLENGES + 100) {
            ip = (ip + 1) % 10_000;
            store.issue(&format!("10.0.{}.{}", ip / 255, ip % 255));
        }
        assert!(store.len() <= MAX_TOTAL_CHALLENGES);
    }
}
