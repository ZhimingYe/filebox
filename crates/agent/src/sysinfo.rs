use filebox_protocol::resources::{ProcessInfo, SysStats};
use sysinfo::System;

pub fn collect_stats() -> Result<SysStats, String> {
    let mut sys = System::new_all();
    sys.refresh_all();

    // Wait a bit for CPU measurement
    std::thread::sleep(std::time::Duration::from_millis(200));
    sys.refresh_cpu_all();

    let cpu_usage = sys.global_cpu_usage();

    let mem_used = sys.used_memory();
    let mem_total = sys.total_memory();
    let swap_used = sys.used_swap();
    let swap_total = sys.total_swap();

    // Top 10 processes by memory
    let mut processes: Vec<ProcessInfo> = sys
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

    // Load average (unix only)
    let load_avg = System::load_average();
    let load = [load_avg.one, load_avg.five, load_avg.fifteen];

    Ok(SysStats {
        cpu_usage_percent: cpu_usage,
        mem_used_bytes: mem_used,
        mem_total_bytes: mem_total,
        swap_used_bytes: swap_used,
        swap_total_bytes: swap_total,
        top_processes: processes,
        load_avg: load,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collect_stats_succeeds_on_real_system() {
        // collect_stats sleeps ~200ms internally for CPU sampling — keep this test
        // count low to avoid bloating suite runtime.
        let stats = collect_stats().expect("collect_stats must succeed");
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

    #[test]
    fn collect_stats_caps_top_processes_at_ten() {
        let stats = collect_stats().unwrap();
        assert!(
            stats.top_processes.len() <= 10,
            "top_processes must be capped at 10 entries"
        );
    }

    #[test]
    fn collect_stats_load_average_has_three_values() {
        let stats = collect_stats().unwrap();
        // 1-min, 5-min, 15-min load averages — always 3 elements.
        assert_eq!(stats.load_avg.len(), 3);
    }

    #[test]
    fn collect_stats_cpu_usage_is_finite() {
        let stats = collect_stats().unwrap();
        assert!(
            stats.cpu_usage_percent.is_finite(),
            "cpu_usage must be a finite f32"
        );
        assert!(
            stats.cpu_usage_percent >= 0.0,
            "cpu_usage must be non-negative"
        );
    }

    #[test]
    fn collect_stats_processes_have_non_empty_names() {
        let stats = collect_stats().unwrap();
        for p in &stats.top_processes {
            assert!(!p.name.is_empty(), "process name must be non-empty");
        }
    }
}
