use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind, Users};
use tokio::sync::Mutex;

use filebox_protocol::resources::{ProcessInfo, SysStats, UserAgg, UserTotals};

/// How many processes / users to keep after aggregation.
///
/// `TOP_PROCESSES` is the per-request ceiling carried in the payload. The
/// browser picks how many to actually show (default 50, up to 500), so we
/// always send the full cap to let a viewer who wants more ("看多多") do so
/// instantly without a second round-trip. select_top_n_by is O(N) in the
/// process count regardless of k, so raising k costs nothing on the sweep;
/// the cost is only payload size. 500 × ~1KB capped command ≈ 500KB worst
/// case, comfortably under the hub's 1MB body limit.
const TOP_PROCESSES: usize = 500;
const TOP_USERS: usize = 15;

/// Hard cap on the serialized command line, purely a size guard. A hostile or
/// pathological cmdline could otherwise balloon the payload; real launchers
/// stay well under this. Truncation only — no content filtering, filebox is
/// read-only and a logged-in user already has filesystem read access.
const COMMAND_MAX_CHARS: usize = 1024;

/// Background-cached system stats collector.
///
/// Designed for hosts with many processes (HPC: tens of thousands of PIDs,
/// terabyte memory) where each `/proc` sweep takes real time.
///
/// **Cost model** (audited against sysinfo 0.35): a single `System` instance
/// is reused so per-process CPU usage is the delta between sweeps. The
/// `ProcessRefreshKind` deliberately excludes the expensive collectors that
/// caused freezes on 1TB boxes in earlier revisions:
///   - `without_tasks()` — no recursion into `/proc/<pid>/task/*` (this was
///     the freeze root cause: O(procs × threads) syscalls);
///   - no `disk_usage` (per-PID `/proc/<pid>/io`);
///   - no `exe` (per-PID `readlink`);
///   - never `environ` (per-PID `/proc/<pid>/environ`, and a secret surface
///     we don't need — cmdline already answers "what is running").
/// `user` and `cmd` use `UpdateKind::OnlyIfNotSet` so they're read once per
/// PID lifetime and then cached by sysinfo — near-free at steady state.
///
/// Behavior mirrors the previous cache:
/// - First request triggers a synchronous refresh (off the async loop via
///   `spawn_blocking`) and caches the result.
/// - Subsequent requests inside `ttl` return the cached snapshot instantly.
/// - After `ttl`, the next request returns the stale snapshot immediately and
///   schedules a background refresh; concurrent requests collapse into one
///   refresh via an atomic CAS flag.
/// - No periodic timer — if nobody asks, no work happens.
///
/// Readers receive `Arc<SysStats>` (cheap pointer clone) rather than a deep
/// clone of the snapshot, so reading never blocks on the producer.
pub struct StatsCache {
    inner: Mutex<Inner>,
    refreshing: AtomicBool,
    ttl: Duration,
}

struct Inner {
    sys: System,
    users: Users,
    cached: Option<Arc<SysStats>>,
    last_refresh: Option<Instant>,
    /// When the user table (uid→name) was last rebuilt. Re-reading it on every
    /// sweep would reparse /etc/passwd (or the platform equivalent) far more
    /// often than user accounts ever change, so we throttle it independently.
    last_users_refresh: Option<Instant>,
}

/// Minimum gap between full user-table rebuilds. Account changes are rare;
/// uid→name resolution for long-lived PIDs stays valid from the cached table.
const USERS_REFRESH_INTERVAL: Duration = Duration::from_secs(300);

impl StatsCache {
    pub fn new(ttl: Duration) -> Arc<Self> {
        Arc::new(Self {
            inner: Mutex::new(Inner {
                sys: System::new(),
                users: Users::new(),
                cached: None,
                last_refresh: None,
                last_users_refresh: None,
            }),
            refreshing: AtomicBool::new(false),
            ttl,
        })
    }

    /// Returns a cached snapshot if fresh, the stale snapshot if available
    /// (with a background refresh kicked off), or blocks on a synchronous
    /// refresh for the very first call.
    pub async fn get(self: &Arc<Self>) -> Arc<SysStats> {
        // Fast path: fresh cache.
        {
            let inner = self.inner.lock().await;
            if let Some(s) = &inner.cached {
                if self.is_fresh(inner.last_refresh) {
                    return s.clone();
                }
                // Stale — hand back stale copy and schedule background refresh.
                let stale = s.clone();
                drop(inner);
                self.schedule_refresh();
                return stale;
            }
        }

        // Cold cache — refresh synchronously on the blocking pool so the
        // async WS loop keeps running.
        let clone = self.clone();
        match tokio::task::spawn_blocking(move || clone.refresh_sync()).await {
            Ok(stats) => stats,
            Err(join_err) => {
                tracing::error!("stats refresh task panicked: {}", join_err);
                Arc::new(stub_stats())
            }
        }
    }

    fn is_fresh(&self, last: Option<Instant>) -> bool {
        match last {
            Some(t) => t.elapsed() < self.ttl,
            None => false,
        }
    }

    fn schedule_refresh(self: &Arc<Self>) {
        // CAS: only one background refresh runs at a time.
        if self.refreshing.swap(true, Ordering::SeqCst) {
            return;
        }
        let this = self.clone();
        tokio::task::spawn_blocking(move || {
            this.refresh_in_background();
        });
    }

    fn refresh_in_background(&self) {
        let mut guard = self.inner.blocking_lock();
        // Re-check staleness: another refresh may have just completed while
        // we were waiting on the lock.
        if self.is_fresh(guard.last_refresh) {
            self.refreshing.store(false, Ordering::SeqCst);
            return;
        }
        refresh_inner(&mut guard);
        self.refreshing.store(false, Ordering::SeqCst);
    }

    fn refresh_sync(&self) -> Arc<SysStats> {
        let mut guard = self.inner.blocking_lock();
        if let Some(s) = &guard.cached {
            if self.is_fresh(guard.last_refresh) {
                return s.clone();
            }
        }
        refresh_inner(&mut guard);
        guard.cached.clone().unwrap_or_else(|| Arc::new(stub_stats()))
    }
}

fn refresh_inner(inner: &mut Inner) {
    // ── Host-level refresh (cheap) ──
    // refresh_cpu_usage() reads /proc/stat only; refresh_cpu_all() would also
    // hit /sys for per-core frequency, which we don't show.
    inner.sys.refresh_memory();
    inner.sys.refresh_cpu_usage();

    // ── Process sweep (the expensive part) ──
    // Kind is tuned to gather rich detail without the freeze sources:
    //   without_tasks       — never recurse into /proc/<pid>/task/*
    //   with_user(OnlyIf..) — read /proc/<pid>/status once per PID lifetime
    //   with_cmd(OnlyIf..)  — read /proc/<pid>/cmdline once per PID lifetime
    // The `multithread` feature (Cargo.toml) parallelizes the /proc scan with
    // rayon, turning a serial multi-second sweep on 10k+ PIDs into ~subsecond.
    let kind = ProcessRefreshKind::nothing()
        .with_cpu()
        .with_memory()
        .with_user(UpdateKind::OnlyIfNotSet)
        .with_cmd(UpdateKind::OnlyIfNotSet)
        .without_tasks();
    inner.sys.refresh_processes_specifics(ProcessesToUpdate::All, true, kind);

    // Rebuild the uid→name table at most every USERS_REFRESH_INTERVAL. User
    // accounts change rarely, and re-reading /etc/passwd on every sweep is
    // wasted work; the cached table keeps resolving long-lived PIDs fine.
    let users_stale = inner
        .last_users_refresh
        .map(|t| t.elapsed() >= USERS_REFRESH_INTERVAL)
        .unwrap_or(true);
    if users_stale {
        inner.users.refresh();
        inner.last_users_refresh = Some(Instant::now());
    }

    let cpu_usage = inner.sys.global_cpu_usage();
    let mem_used = inner.sys.used_memory();
    let mem_total = inner.sys.total_memory();
    let swap_used = inner.sys.used_swap();
    let swap_total = inner.sys.total_swap();

    let load_avg = System::load_average();
    let load = [load_avg.one, load_avg.five, load_avg.fifteen];

    let uptime_secs = System::uptime();
    let boot_time = System::boot_time();

    // ── One pass: per-process detail + per-user aggregation ──
    // Accumulating users inside the same iteration that builds the process
    // list costs zero extra syscalls — it's pure in-memory HashMap writes. We
    // also collect global totals here so we never walk the process map a
    // second time (matters at 10k+ PIDs).
    let total_processes = inner.sys.processes().len() as u32;
    let mut all: Vec<ProcessInfo> = Vec::with_capacity(inner.sys.processes().len());
    // uid → running aggregate. We keep the heaviest PIDs per user as a small
    // sorted sidecar (TOP_PIDS_PER_USER) so drill-down doesn't need a second
    // pass over the full process map.
    let mut user_map: HashMap<u32, UserAggBuilder> = HashMap::new();
    let mut total_cpu_usage: f32 = 0.0;

    for (pid, proc) in inner.sys.processes() {
        let pid_u32 = pid.as_u32();
        let uid_ref = proc.user_id();
        let uid = uid_ref.map(|u| **u).unwrap_or(0u32);
        let user_name = resolve_user(&inner.users, uid_ref);

        let command = build_command(proc.cmd());
        let nproc = parse_nproc(&command);

        let info = ProcessInfo {
            pid: pid_u32,
            name: proc.name().to_string_lossy().into_owned(),
            user: user_name.clone(),
            uid,
            state: process_state_label(proc.status()),
            mem_bytes: proc.memory(),
            cpu_usage: proc.cpu_usage(),
            accumulated_cpu_ms: proc.accumulated_cpu_time(),
            start_time: proc.start_time() as i64,
            run_time_secs: proc.run_time(),
            parent_pid: proc.parent().map(|p| p.as_u32()),
            command,
            nproc,
        };

        total_cpu_usage += info.cpu_usage;

        let agg = user_map.entry(uid).or_insert_with(|| UserAggBuilder {
            user: user_name.clone(),
            uid,
            cpu_usage: 0.0,
            mem_bytes: 0,
            accumulated_cpu_ms: 0,
            process_count: 0,
        });
        agg.cpu_usage += info.cpu_usage;
        agg.mem_bytes += info.mem_bytes;
        agg.accumulated_cpu_ms += info.accumulated_cpu_ms;
        agg.process_count += 1;

        all.push(info);
    }

    // ── Top-N selection: O(N) quickselect, not O(N log N) sort ──
    // On 10k+ PIDs the difference is meaningful inside a blocking task.
    select_top_n_by(&mut all, TOP_PROCESSES, |a, b| b.mem_bytes.cmp(&a.mem_bytes));
    all.truncate(TOP_PROCESSES);

    // user_count = distinct owners = size of the aggregation map, captured
    // before we drain it below.
    let user_count = user_map.len() as u32;

    let mut users: Vec<UserAgg> = user_map
        .into_values()
        .map(|b| UserAgg {
            user: b.user,
            uid: b.uid,
            cpu_usage: b.cpu_usage,
            mem_bytes: b.mem_bytes,
            accumulated_cpu_ms: b.accumulated_cpu_ms,
            process_count: b.process_count,
        })
        .collect();
    select_top_n_by(&mut users, TOP_USERS, |a, b| {
        b.cpu_usage.partial_cmp(&a.cpu_usage).unwrap_or(std::cmp::Ordering::Equal)
    });
    users.truncate(TOP_USERS);

    inner.cached = Some(Arc::new(SysStats {
        cpu_usage_percent: cpu_usage,
        mem_used_bytes: mem_used,
        mem_total_bytes: mem_total,
        swap_used_bytes: swap_used,
        swap_total_bytes: swap_total,
        load_avg: load,
        uptime_secs,
        boot_time: boot_time as i64,
        top_processes: all,
        total_processes,
        top_users: users,
        user_totals: UserTotals {
            user_count,
            total_cpu_usage,
            total_mem_bytes: mem_used,
            total_processes,
        },
    }));
    inner.last_refresh = Some(Instant::now());
}

/// Mutable accumulator used while walking the process map. Finalized into the
/// serializable `UserAgg` after the sweep.
struct UserAggBuilder {
    user: String,
    uid: u32,
    cpu_usage: f32,
    mem_bytes: u64,
    accumulated_cpu_ms: u64,
    process_count: u32,
}

/// Build the display command line from argv. Joined, length-capped only.
///
/// The cap is byte-oriented and includes the trailing ellipsis when we
/// truncate, so the returned string never exceeds `COMMAND_MAX_CHARS` bytes.
/// We stop early (per-arg) so a hostile multi-MB argv is never materialized.
fn build_command(args: &[std::ffi::OsString]) -> String {
    if args.is_empty() {
        return String::new();
    }
    const ELLIPSIS: &str = "…";
    let mut joined = String::new();
    for (i, a) in args.iter().enumerate() {
        if i > 0 {
            joined.push(' ');
        }
        // Reserve room for the ellipsis so the final string stays in budget.
        if joined.len() + ELLIPSIS.len() >= COMMAND_MAX_CHARS {
            joined.push_str(ELLIPSIS);
            return joined;
        }
        let s = a.to_string_lossy();
        let remaining = COMMAND_MAX_CHARS - ELLIPSIS.len() - joined.len();
        if s.len() <= remaining {
            joined.push_str(&s);
        } else {
            // char-boundary-safe truncation of this final arg.
            let cut = char_boundary(&s, remaining);
            joined.push_str(&s[..cut]);
            joined.push_str(ELLIPSIS);
            return joined;
        }
    }
    joined
}

/// Find the largest byte index <= `max` that lands on a UTF-8 char boundary.
fn char_boundary(s: &str, max: usize) -> usize {
    if max >= s.len() {
        return s.len();
    }
    let mut i = max;
    while i > 0 && !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

/// Map a kernel `ProcessStatus` to the single-letter label the UI shows.
///
/// Uses classic ps(1) codes so the UI can color-code states uniformly. The
/// enum is shared across platforms (variants just don't occur on some), so
/// every arm is always reachable at compile time.
fn process_state_label(status: sysinfo::ProcessStatus) -> String {
    match status {
        sysinfo::ProcessStatus::Run => "R",
        sysinfo::ProcessStatus::Sleep => "S",
        sysinfo::ProcessStatus::Idle => "I",
        sysinfo::ProcessStatus::Stop => "T",
        sysinfo::ProcessStatus::Zombie => "Z",
        sysinfo::ProcessStatus::Tracing => "T",
        sysinfo::ProcessStatus::Dead => "X",
        sysinfo::ProcessStatus::Wakekill => "W",
        sysinfo::ProcessStatus::Waking => "W",
        sysinfo::ProcessStatus::Parked => "P",
        sysinfo::ProcessStatus::LockBlocked => "L",
        sysinfo::ProcessStatus::UninterruptibleDiskSleep => "D",
        sysinfo::ProcessStatus::Unknown(_) => "?",
    }
    .to_string()
}

/// Resolve a uid to a username, falling back to the numeric id as a string.
/// Takes the raw `&Uid` straight from `Process::user_id()` so no Uid→u32→Uid
/// round-trip is needed.
fn resolve_user(users: &Users, uid: Option<&sysinfo::Uid>) -> String {
    match uid {
        Some(key) => users
            .get_user_by_id(key)
            .map(|u| u.name().to_string())
            .unwrap_or_else(|| key.to_string()),
        None => "0".to_string(),
    }
}

/// Best-effort HPC parallelism extraction from a command line. Recognizes the
/// common launchers. Pure string parsing — never executes anything.
fn parse_nproc(cmd: &str) -> Option<u32> {
    let tokens: Vec<&str> = cmd.split_whitespace().collect();
    if tokens.is_empty() {
        return None;
    }
    let head = tokens[0].rsplit('/').next().unwrap_or(tokens[0]);

    // Look for any of `flags` as either "flag N" (next token) or "flag=N"
    // (same token). Flags are matched exactly including their dashes.
    let find_val = |flags: &[&str]| -> Option<u32> {
        for (i, t) in tokens.iter().enumerate() {
            let lower = t.to_ascii_lowercase();
            for flag in flags {
                // "flag=N" form.
                if let Some(rest) = lower.strip_prefix(flag) {
                    if let Some(after) = rest.strip_prefix('=') {
                        if let Some(n) = after.parse::<u32>().ok().filter(|n| *n > 0) {
                            return Some(n);
                        }
                    }
                }
                // "flag N" form (exact token match, value is next token).
                if lower == *flag {
                    if let Some(v) = tokens.get(i + 1) {
                        if let Some(n) = v.parse::<u32>().ok().filter(|n| *n > 0) {
                            return Some(n);
                        }
                    }
                }
            }
        }
        None
    };

    match head {
        // mpirun/mpiexec: -np / --np / -n all in the wild.
        "mpirun" | "mpiexec" => find_val(&["-np", "--np", "-n"]),
        // Slurm: --ntasks or -n.
        "srun" | "sbatch" | "salloc" => find_val(&["--ntasks", "-n"]),
        // torchrun / accelerate.
        "python" | "python3" => find_val(&["--nproc_per_node"]),
        _ => None,
    }
}

/// O(N) top-k selection, semantics aligned with `slice::sort_by`.
///
/// After this returns, `slice[0..k]` holds the elements that would appear in
/// the first `k` positions if the slice were sorted by `cmp` — i.e. the most
/// "preferred" k, in unspecified internal order. Comparator convention is
/// identical to `sort_by`: `cmp(a, b)` returning `Less` means `a` sorts before
/// `b` (a is more preferred). Falls back gracefully when the slice is shorter
/// than k.
fn select_top_n_by<T, F>(slice: &mut [T], k: usize, cmp: F)
where
    F: Fn(&T, &T) -> std::cmp::Ordering,
{
    let k = k.min(slice.len());
    if k == 0 {
        return;
    }
    // Iterative quickselect: after partitioning around a pivot, everything in
    // [lo, p) is more-preferred-than-or-equal-to the pivot, [p, hi) is less.
    // Recurse into the side that contains the k-th boundary.
    let mut lo = 0usize;
    let mut hi = slice.len();
    while lo < hi {
        // Median-of-three pivot to dodge O(N²) on already-sorted input.
        let mid = lo + (hi - lo) / 2;
        if cmp(&slice[lo], &slice[mid]) == std::cmp::Ordering::Greater {
            slice.swap(lo, mid);
        }
        if cmp(&slice[mid], &slice[hi - 1]) == std::cmp::Ordering::Greater {
            slice.swap(mid, hi - 1);
        }
        if cmp(&slice[lo], &slice[mid]) == std::cmp::Ordering::Greater {
            slice.swap(lo, mid);
        }
        // Move pivot to the end, Lomuto-partition [lo, hi-1).
        slice.swap(mid, hi - 1);
        let pivot_idx = hi - 1;
        let mut store = lo;
        for i in lo..pivot_idx {
            // slice[i] more preferred than (or equal to) pivot → keep left.
            if cmp(&slice[i], &slice[pivot_idx]) != std::cmp::Ordering::Greater {
                slice.swap(i, store);
                store += 1;
            }
        }
        slice.swap(store, pivot_idx);
        // slice[lo..store] are all ≤-preference pivot, slice[store] is the
        // pivot in its sorted position, slice[store+1..hi] are > pivot.
        if store == k {
            return;
        } else if store < k {
            lo = store + 1;
        } else {
            hi = store;
        }
    }
}

fn stub_stats() -> SysStats {
    SysStats {
        cpu_usage_percent: 0.0,
        mem_used_bytes: 0,
        mem_total_bytes: 0,
        swap_used_bytes: 0,
        swap_total_bytes: 0,
        load_avg: [0.0, 0.0, 0.0],
        uptime_secs: 0,
        boot_time: 0,
        top_processes: vec![],
        total_processes: 0,
        top_users: vec![],
        user_totals: UserTotals {
            user_count: 0,
            total_cpu_usage: 0.0,
            total_mem_bytes: 0,
            total_processes: 0,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn get_returns_valid_stats() {
        let cache = StatsCache::new(Duration::from_secs(60));
        let stats = cache.get().await;
        assert!(
            stats.mem_total_bytes > 0,
            "total memory must be reported and non-zero"
        );
        assert!(
            stats.mem_used_bytes <= stats.mem_total_bytes,
            "used memory must not exceed total"
        );
        if stats.swap_total_bytes > 0 {
            assert!(
                stats.swap_used_bytes <= stats.swap_total_bytes,
                "used swap must not exceed total"
            );
        }
    }

    #[tokio::test]
    async fn get_caps_top_processes_at_limit() {
        let cache = StatsCache::new(Duration::from_secs(60));
        let stats = cache.get().await;
        assert!(
            stats.top_processes.len() <= TOP_PROCESSES,
            "top_processes must be capped at {} entries",
            TOP_PROCESSES
        );
    }

    #[tokio::test]
    async fn get_load_average_has_three_values() {
        let cache = StatsCache::new(Duration::from_secs(60));
        let stats = cache.get().await;
        assert_eq!(stats.load_avg.len(), 3);
    }

    #[tokio::test]
    async fn get_cpu_usage_is_finite() {
        let cache = StatsCache::new(Duration::from_secs(60));
        let stats = cache.get().await;
        assert!(stats.cpu_usage_percent.is_finite());
        assert!(stats.cpu_usage_percent >= 0.0);
    }

    #[tokio::test]
    async fn get_processes_have_non_empty_names() {
        let cache = StatsCache::new(Duration::from_secs(60));
        let stats = cache.get().await;
        for p in &stats.top_processes {
            assert!(!p.name.is_empty(), "process name must be non-empty");
        }
    }

    #[tokio::test]
    async fn second_call_within_ttl_returns_cached_without_new_refresh() {
        // Two gets back-to-back inside TTL: both should succeed and return
        // consistent data (top_processes identical, since cache wasn't busted).
        let cache = StatsCache::new(Duration::from_secs(60));
        let first = cache.get().await;
        let second = cache.get().await;
        assert_eq!(first.mem_total_bytes, second.mem_total_bytes);
        assert_eq!(first.top_processes.len(), second.top_processes.len());
        for (a, b) in first.top_processes.iter().zip(second.top_processes.iter()) {
            assert_eq!(a.pid, b.pid);
        }
    }

    #[tokio::test]
    async fn zero_ttl_forces_refresh_every_call_but_does_not_panic() {
        let cache = StatsCache::new(Duration::from_secs(0));
        let _ = cache.get().await;
        let _ = cache.get().await;
        // Just exercising the cold + stale paths back-to-back; if the atomic
        // flag isn't reset properly we'd deadlock or panic here.
    }

    #[tokio::test]
    async fn process_info_carries_user_and_state() {
        let cache = StatsCache::new(Duration::from_secs(60));
        let stats = cache.get().await;
        // Every surfaced process should have a non-empty user and a
        // single-letter state — they're mandatory fields now.
        for p in &stats.top_processes {
            assert!(!p.user.is_empty(), "user must be non-empty");
            assert_eq!(p.state.len(), 1, "state must be a single letter");
        }
    }

    #[tokio::test]
    async fn user_totals_populated() {
        let cache = StatsCache::new(Duration::from_secs(60));
        let stats = cache.get().await;
        // There's always at least one user (root) on a running host.
        assert!(stats.user_totals.user_count >= 1);
        assert!(stats.user_totals.total_processes >= 1);
        // top_users is bounded.
        assert!(stats.top_users.len() <= TOP_USERS);
    }

    #[test]
    fn parse_nproc_recognizes_mpirun() {
        assert_eq!(parse_nproc("mpirun -np 128 ./a.out"), Some(128));
        assert_eq!(parse_nproc("/usr/bin/mpirun -n 64 ./a.out"), Some(64));
        assert_eq!(parse_nproc("mpiexec --np=32 ./a.out"), Some(32));
    }

    #[test]
    fn parse_nproc_recognizes_srun() {
        assert_eq!(parse_nproc("srun --ntasks 16 app"), Some(16));
        assert_eq!(parse_nproc("srun --ntasks=8 app"), Some(8));
        assert_eq!(parse_nproc("srun -n 4 app"), Some(4));
    }

    #[test]
    fn parse_nproc_recognizes_torchrun() {
        assert_eq!(
            parse_nproc("python -m torch.distributed.run --nproc_per_node=8 train.py"),
            Some(8)
        );
    }

    #[test]
    fn parse_nproc_returns_none_for_plain_process() {
        assert_eq!(parse_nproc("vim notes.txt"), None);
        assert_eq!(parse_nproc(""), None);
    }

    #[test]
    fn build_command_joins_and_caps_length() {
        let args: Vec<std::ffi::OsString> = vec!["a".into(), "b".into(), "c".into()];
        assert_eq!(build_command(&args), "a b c");
    }

    #[test]
    fn build_command_truncates_huge_arg() {
        let big = "x".repeat(COMMAND_MAX_CHARS * 4);
        let args: Vec<std::ffi::OsString> = vec![big.into()];
        let out = build_command(&args);
        assert!(out.len() <= COMMAND_MAX_CHARS + 1, "len = {}", out.len());
        assert!(out.ends_with('…'));
    }

    #[test]
    fn build_command_empty_when_no_args() {
        let args: Vec<std::ffi::OsString> = vec![];
        assert_eq!(build_command(&args), "");
    }

    #[test]
    fn select_top_n_picks_greatest_k() {
        let mut v: Vec<u32> = vec![5, 1, 9, 3, 7, 2, 8, 4, 6];
        select_top_n_by(&mut v, 3, |a, b| b.cmp(a));
        // Top 3 of 1..9 should be {7,8,9}, order within is unspecified.
        let mut got = v[..3].to_vec();
        got.sort_unstable();
        assert_eq!(got, vec![7, 8, 9]);
    }

    #[test]
    fn select_top_n_handles_k_larger_than_slice() {
        let mut v: Vec<u32> = vec![3, 1, 2];
        select_top_n_by(&mut v, 10, |a, b| b.cmp(a));
        let mut got = v.to_vec();
        got.sort_unstable();
        assert_eq!(got, vec![1, 2, 3]);
    }

    #[test]
    fn select_top_n_sorted_input_no_quadratic() {
        // Sorted ascending — naive pivot would be O(N²). Just ensure
        // correctness; the median-of-three pivot guards the pathological case.
        let mut v: Vec<u32> = (1..=1000).collect();
        select_top_n_by(&mut v, 5, |a, b| b.cmp(a));
        let mut got = v[..5].to_vec();
        got.sort_unstable();
        assert_eq!(got, vec![996, 997, 998, 999, 1000]);
    }
}
