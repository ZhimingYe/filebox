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
