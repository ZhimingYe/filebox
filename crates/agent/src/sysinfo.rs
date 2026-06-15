use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use sysinfo::{ProcessesToUpdate, System};
use tokio::sync::Mutex;

use filebox_protocol::resources::{ProcessInfo, SysStats};

/// Background-cached system stats collector.
///
/// Designed for hosts with many processes (HPC: tens of thousands of PIDs,
/// terabyte memory) where each `refresh_processes()` sweep takes seconds.
///
/// Behavior:
/// - First request triggers a synchronous refresh (still off the async loop
///   via spawn_blocking) and caches the result.
/// - Subsequent requests inside `ttl` return cached stats instantly.
/// - After `ttl`, the next request returns the stale cache immediately and
///   schedules a background refresh; concurrent requests collapse into one
///   refresh via an atomic flag.
/// - No periodic timer — if nobody asks, no work happens.
///
/// The `System` instance is reused across refreshes so per-process CPU usage
/// is computed as the delta between successive refreshes (no extra sleep).
pub struct StatsCache {
    inner: Mutex<Inner>,
    refreshing: AtomicBool,
    ttl: Duration,
}

struct Inner {
    sys: System,
    cached: Option<SysStats>,
    last_refresh: Option<Instant>,
}

impl StatsCache {
    pub fn new(ttl: Duration) -> Arc<Self> {
        Arc::new(Self {
            inner: Mutex::new(Inner {
                sys: System::new(),
                cached: None,
                last_refresh: None,
            }),
            refreshing: AtomicBool::new(false),
            ttl,
        })
    }

    /// Returns stats from cache if fresh, stale cache if available (with a
    /// background refresh kicked off), or blocks on a synchronous refresh
    /// for the very first call.
    pub async fn get(self: &Arc<Self>) -> SysStats {
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
                stub_stats()
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

    fn refresh_sync(&self) -> SysStats {
        let mut guard = self.inner.blocking_lock();
        if let Some(s) = &guard.cached {
            if self.is_fresh(guard.last_refresh) {
                return s.clone();
            }
        }
        refresh_inner(&mut guard);
        guard.cached.clone().unwrap_or_else(stub_stats)
    }
}

fn refresh_inner(inner: &mut Inner) {
    // Refresh memory + CPU + processes in one sweep. Because `sys` persists
    // across calls, per-process CPU usage is the delta since the previous
    // refresh — no extra sleep needed.
    inner.sys.refresh_memory();
    inner.sys.refresh_cpu_all();
    inner.sys.refresh_processes(ProcessesToUpdate::All, true);

    let cpu_usage = inner.sys.global_cpu_usage();
    let mem_used = inner.sys.used_memory();
    let mem_total = inner.sys.total_memory();
    let swap_used = inner.sys.used_swap();
    let swap_total = inner.sys.total_swap();

    let mut processes: Vec<ProcessInfo> = inner
        .sys
        .processes()
        .iter()
        .map(|(pid, proc)| ProcessInfo {
            pid: pid.as_u32(),
            name: proc.name().to_string_lossy().to_string(),
            mem_bytes: proc.memory(),
            cpu_usage: proc.cpu_usage(),
        })
        .collect();

    processes.sort_by(|a, b| b.mem_bytes.cmp(&a.mem_bytes));
    processes.truncate(10);

    let load_avg = System::load_average();
    let load = [load_avg.one, load_avg.five, load_avg.fifteen];

    inner.cached = Some(SysStats {
        cpu_usage_percent: cpu_usage,
        mem_used_bytes: mem_used,
        mem_total_bytes: mem_total,
        swap_used_bytes: swap_used,
        swap_total_bytes: swap_total,
        top_processes: processes,
        load_avg: load,
    });
    inner.last_refresh = Some(Instant::now());
}

fn stub_stats() -> SysStats {
    SysStats {
        cpu_usage_percent: 0.0,
        mem_used_bytes: 0,
        mem_total_bytes: 0,
        swap_used_bytes: 0,
        swap_total_bytes: 0,
        top_processes: vec![],
        load_avg: [0.0, 0.0, 0.0],
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
    async fn get_caps_top_processes_at_ten() {
        let cache = StatsCache::new(Duration::from_secs(60));
        let stats = cache.get().await;
        assert!(
            stats.top_processes.len() <= 10,
            "top_processes must be capped at 10 entries"
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
}
