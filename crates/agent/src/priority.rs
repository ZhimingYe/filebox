//! Best-effort scheduler / I/O boosting so this process can still run
//! when other jobs own the CPUs. Rootless cannot take SCHED_FIFO; we
//! probe `nice` from -20 and Linux ionice RT then best-effort 0.
//!
//! `FILEBOX_AGENT_KEEP_SCHEDULER=1` skips boosting and the LibreOffice
//! child reset. Children must call [`reset_child_priority`] from `pre_exec`
//! so conversion does not inherit the boost and then outrank the WS loop.

use std::sync::atomic::{AtomicBool, Ordering};

static APPLIED: AtomicBool = AtomicBool::new(false);

const KEEP_SCHEDULER_ENV: &str = "FILEBOX_AGENT_KEEP_SCHEDULER";

#[cfg(target_os = "linux")]
const IOPRIO_CLASS_RT: i32 = 1;
#[cfg(target_os = "linux")]
const IOPRIO_CLASS_BE: i32 = 2;
#[cfg(target_os = "linux")]
const IOPRIO_WHO_PROCESS: i32 = 1;
#[cfg(target_os = "linux")]
const IOPRIO_CLASS_SHIFT: i32 = 13;
#[cfg(target_os = "linux")]
const TIMER_SLACK_NS: libc::c_ulong = 1;

/// Process-wide boost. Call once on the main thread before the Tokio
/// runtime starts so the first worker/blocking threads inherit it.
pub fn apply_at_startup() {
    if keep_scheduler() {
        tracing::info!("Scheduler boosting skipped ({KEEP_SCHEDULER_ENV} is set)");
        return;
    }
    let nice = apply_best_nice();
    let ionice = apply_best_ionice();
    let autogroup = apply_autogroup();
    let timerslack = apply_timerslack();
    APPLIED.store(true, Ordering::Release);
    tracing::info!(
        nice = nice.map(|n| n.to_string()).unwrap_or_else(|| "unchanged".into()),
        ionice = display_ionice(ionice),
        autogroup = autogroup
            .map(|n| n.to_string())
            .unwrap_or_else(|| "unchanged".into()),
        timerslack,
        "Applied rootless-best scheduler boost"
    );
}

/// Per-thread boost for Tokio worker and blocking threads. No-op until
/// [`apply_at_startup`] has opted in (`--update` never sets the flag).
pub fn apply_current_thread() {
    if !APPLIED.load(Ordering::Acquire) {
        return;
    }
    let _ = apply_best_nice();
    let _ = apply_best_ionice();
    let _ = apply_timerslack();
}

/// Async-signal-safe reset for `CommandExt::pre_exec`.
pub fn reset_child_priority() {
    #[cfg(unix)]
    unsafe {
        libc::setpriority(libc::PRIO_PROCESS, 0, 0);
    }
    #[cfg(target_os = "linux")]
    unsafe {
        let be_default = ioprio_value(IOPRIO_CLASS_BE, 4);
        libc::syscall(
            libc::SYS_ioprio_set,
            IOPRIO_WHO_PROCESS,
            0,
            be_default as libc::c_long,
        );
    }
}

/// Captured in the parent before `fork`; do not call from `pre_exec`.
pub fn keep_scheduler() -> bool {
    std::env::var(KEEP_SCHEDULER_ENV)
        .map(|value| env_flag_is_on(&value))
        .unwrap_or(false)
}

fn env_flag_is_on(value: &str) -> bool {
    let value = value.trim();
    value == "1" || value.eq_ignore_ascii_case("true") || value.eq_ignore_ascii_case("yes")
}

fn apply_best_nice() -> Option<i32> {
    #[cfg(unix)]
    {
        for nice in -20..=19 {
            let rc = unsafe { libc::setpriority(libc::PRIO_PROCESS, 0, nice) };
            if rc == 0 {
                return Some(nice);
            }
        }
        None
    }
    #[cfg(not(unix))]
    {
        None
    }
}

fn apply_best_ionice() -> Option<(i32, i32)> {
    #[cfg(target_os = "linux")]
    {
        for class in [IOPRIO_CLASS_RT, IOPRIO_CLASS_BE] {
            for prio in 0..=7 {
                if set_ioprio(class, prio) {
                    return Some((class, prio));
                }
            }
        }
        None
    }
    #[cfg(not(target_os = "linux"))]
    {
        None
    }
}

#[cfg(target_os = "linux")]
fn set_ioprio(class: i32, prio: i32) -> bool {
    let value = ioprio_value(class, prio);
    let rc = unsafe {
        libc::syscall(
            libc::SYS_ioprio_set,
            IOPRIO_WHO_PROCESS,
            0,
            value as libc::c_long,
        )
    };
    rc == 0
}

#[cfg(target_os = "linux")]
const fn ioprio_value(class: i32, prio: i32) -> i32 {
    (class << IOPRIO_CLASS_SHIFT) | (prio & 0x1fff)
}

fn apply_autogroup() -> Option<i32> {
    #[cfg(target_os = "linux")]
    {
        for nice in -20..=0 {
            if std::fs::write("/proc/self/autogroup", format!("{nice}\n")).is_ok() {
                return Some(nice);
            }
        }
        None
    }
    #[cfg(not(target_os = "linux"))]
    {
        None
    }
}

fn apply_timerslack() -> bool {
    #[cfg(target_os = "linux")]
    {
        let rc = unsafe { libc::prctl(libc::PR_SET_TIMERSLACK, TIMER_SLACK_NS, 0, 0, 0) };
        rc == 0
    }
    #[cfg(not(target_os = "linux"))]
    {
        false
    }
}

fn display_ionice(ionice: Option<(i32, i32)>) -> String {
    match ionice {
        #[cfg(target_os = "linux")]
        Some((class, prio)) if class == IOPRIO_CLASS_RT => format!("rt/{prio}"),
        #[cfg(target_os = "linux")]
        Some((class, prio)) if class == IOPRIO_CLASS_BE => format!("best-effort/{prio}"),
        Some((class, prio)) => format!("{class}/{prio}"),
        None => "unchanged".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    fn current_nice() -> i32 {
        unsafe { libc::getpriority(libc::PRIO_PROCESS, 0) }
    }

    #[cfg(unix)]
    fn restore_nice(nice: i32) {
        let _ = unsafe { libc::setpriority(libc::PRIO_PROCESS, 0, nice) };
    }

    #[cfg(unix)]
    static NICE_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[cfg(unix)]
    #[test]
    fn boosting_never_worsens_nice() {
        let _lock = NICE_TEST_LOCK.lock().unwrap();
        let before = current_nice();
        let applied = apply_best_nice();
        let after = current_nice();
        restore_nice(before);
        assert!(
            after <= before,
            "nice went from {before} to {after} (applied={applied:?})"
        );
        if let Some(applied) = applied {
            assert_eq!(applied, after);
        }
    }

    #[cfg(unix)]
    #[test]
    fn boosting_lands_at_or_below_zero_when_kernel_allows_zero() {
        let _lock = NICE_TEST_LOCK.lock().unwrap();
        let before = current_nice();
        let applied = apply_best_nice();
        restore_nice(before);
        if before <= 0 {
            if let Some(nice) = applied {
                assert!(nice <= 0, "rootless ceiling is nice 0; got {nice}");
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn thread_boost_is_noop_until_startup_opts_in() {
        let _lock = NICE_TEST_LOCK.lock().unwrap();
        let before = current_nice();
        apply_current_thread();
        assert_eq!(current_nice(), before);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn ioprio_value_packs_class_in_high_bits() {
        assert_eq!(ioprio_value(IOPRIO_CLASS_RT, 0), IOPRIO_CLASS_RT << IOPRIO_CLASS_SHIFT);
        assert_eq!(ioprio_value(IOPRIO_CLASS_BE, 0), IOPRIO_CLASS_BE << IOPRIO_CLASS_SHIFT);
        assert_eq!(
            ioprio_value(IOPRIO_CLASS_BE, 7),
            (IOPRIO_CLASS_BE << IOPRIO_CLASS_SHIFT) | 7
        );
    }

    #[test]
    fn keep_scheduler_flag_parses_common_truthy_values() {
        assert!(!env_flag_is_on(""));
        assert!(!env_flag_is_on("0"));
        assert!(!env_flag_is_on("false"));
        assert!(env_flag_is_on("1"));
        assert!(env_flag_is_on(" true "));
        assert!(env_flag_is_on("YES"));
    }

    #[cfg(unix)]
    #[test]
    fn child_reset_sets_nice_zero() {
        let _lock = NICE_TEST_LOCK.lock().unwrap();
        let before = current_nice();
        reset_child_priority();
        let nice = current_nice();
        restore_nice(before);
        assert!(nice >= 0, "child reset must drop a negative inherited nice; got {nice}");
    }
}
