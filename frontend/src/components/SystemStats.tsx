import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { FixedSizeList as VList } from 'react-window';
import { getSysStats, friendlyMessage } from '../api/client';
import type { ProcessInfo, SysStats, UserAgg } from '../api/client';
import { c, radius, shadow, font } from '../theme';
import { useIsMobile } from '../state/useIsMobile';

interface Props {
  agentId: string;
}

const REFRESH_INTERVAL = 30_000;

/// Process-row height. Collapsed rows are a fixed height (FixedSizeList); the
/// command is truncated to one line. To read the full command, click a row and a
/// detail panel opens above the table — no per-row expand/variable-height hacks.
const PROC_ROW_HEIGHT_DESKTOP = 36;
const PROC_ROW_HEIGHT_MOBILE = 48;

type Tab = 'overview' | 'users' | 'processes' | 'host';

type ProcSortKey = 'mem_bytes' | 'cpu_usage' | 'accumulated_cpu_ms' | 'run_time_secs' | 'user' | 'name';
type UserSortKey = 'cpu_usage' | 'cpu_share' | 'mem_bytes' | 'mem_share' | 'accumulated_cpu_ms' | 'process_count' | 'user';

export function SystemStats({ agentId }: Props) {
  const [stats, setStats] = useState<SysStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>('overview');
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchStats = useCallback(async () => {
    try {
      const data = await getSysStats(agentId);
      if (data.error) {
        setError(friendlyMessage({ error: data.error }));
      } else {
        setStats(data);
        setError(null);
        setLastUpdated(Date.now());
      }
    } catch (e: any) {
      setError(friendlyMessage(e));
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  useEffect(() => {
    setLoading(true);
    setStats(null);
    setError(null);
    fetchStats();

    timerRef.current = setInterval(fetchStats, REFRESH_INTERVAL);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [fetchStats]);

  if (loading && !stats) {
    return (
      <div style={styles.container}>
        <p style={styles.loading}>Loading system stats...</p>
      </div>
    );
  }

  if (error && !stats) {
    return (
      <div style={styles.container}>
        <p style={styles.error}>{error}</p>
        <button onClick={fetchStats} style={styles.retryBtn}>Retry</button>
      </div>
    );
  }

  if (!stats) return null;

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <h2 style={styles.title}>System Monitor</h2>
        <div style={styles.headerRight}>
          {lastUpdated && (
            <span style={styles.updatedAgo}>{formatAgo(Date.now() - lastUpdated)}</span>
          )}
          <button onClick={fetchStats} style={styles.refreshBtn}>
            <RefreshIcon /> Refresh
          </button>
        </div>
      </div>

      {error && <div style={styles.errorBanner}>{error}</div>}

      <div style={styles.tabs}>
        <TabButton active={tab === 'overview'} onClick={() => setTab('overview')} label="Overview" />
        <TabButton active={tab === 'users'} onClick={() => setTab('users')} label={`Users (${stats.user_totals.user_count})`} />
        <TabButton active={tab === 'processes'} onClick={() => setTab('processes')} label={`Processes (${formatCount(stats.total_processes)})`} />
        <TabButton active={tab === 'host'} onClick={() => setTab('host')} label="Host" />
      </div>

      {tab === 'overview' && <OverviewTab stats={stats} />}
      {tab === 'users' && <UsersTab stats={stats} />}
      {tab === 'processes' && <ProcessesTab stats={stats} />}
      {tab === 'host' && <HostTab stats={stats} />}
    </div>
  );
}

// ── Overview ──────────────────────────────────────────────────────────────

function OverviewTab({ stats }: { stats: SysStats }) {
  const memPercent = stats.mem_total_bytes > 0
    ? (stats.mem_used_bytes / stats.mem_total_bytes) * 100
    : 0;
  const swapPercent = stats.swap_total_bytes > 0
    ? (stats.swap_used_bytes / stats.swap_total_bytes) * 100
    : 0;

  return (
    <>
      <div style={styles.summaryRow}>
        <SummaryChip label="Users" value={String(stats.user_totals.user_count)} />
        <SummaryChip label="Processes" value={formatCount(stats.total_processes)} />
        <SummaryChip label="Uptime" value={formatDuration(stats.uptime_secs)} />
        <SummaryChip label="CPU" value={`${stats.cpu_usage_percent.toFixed(0)}%`} />
        <SummaryChip label="Mem" value={formatBytes(stats.mem_used_bytes)} />
      </div>

      <div style={styles.card}>
        <div style={styles.cardTitle}>CPU</div>
        <div style={styles.gaugeRow}>
          <div style={styles.barOuter}>
            <div style={{
              ...styles.barInner,
              width: `${Math.min(stats.cpu_usage_percent, 100)}%`,
              background: barColor(stats.cpu_usage_percent),
            }} />
          </div>
          <span style={styles.gaugeValue}>{stats.cpu_usage_percent.toFixed(1)}%</span>
        </div>
      </div>

      <div style={styles.card}>
        <div style={styles.cardTitle}>Memory</div>
        <div style={styles.gaugeRow}>
          <div style={styles.barOuter}>
            <div style={{
              ...styles.barInner,
              width: `${Math.min(memPercent, 100)}%`,
              background: barColor(memPercent),
            }} />
          </div>
          <span style={styles.gaugeValue}>{memPercent.toFixed(1)}%</span>
        </div>
        <div style={styles.statDetail}>
          {formatBytes(stats.mem_used_bytes)} / {formatBytes(stats.mem_total_bytes)}
        </div>
      </div>

      {stats.swap_total_bytes > 0 && (
        <div style={styles.card}>
          <div style={styles.cardTitle}>Swap</div>
          <div style={styles.gaugeRow}>
            <div style={styles.barOuter}>
              <div style={{
                ...styles.barInner,
                width: `${Math.min(swapPercent, 100)}%`,
                  background: barColor(swapPercent),
              }} />
            </div>
            <span style={styles.gaugeValue}>{swapPercent.toFixed(1)}%</span>
          </div>
          <div style={styles.statDetail}>
            {formatBytes(stats.swap_used_bytes)} / {formatBytes(stats.swap_total_bytes)}
          </div>
        </div>
      )}

      <div style={styles.card}>
        <div style={styles.cardTitle}>Load Average</div>
        <div style={styles.loadRow}>
          <div style={styles.loadItem}>
            <span style={styles.loadLabel}>1 min</span>
            <span style={styles.loadValue}>{stats.load_avg[0].toFixed(2)}</span>
          </div>
          <div style={styles.loadItem}>
            <span style={styles.loadLabel}>5 min</span>
            <span style={styles.loadValue}>{stats.load_avg[1].toFixed(2)}</span>
          </div>
          <div style={styles.loadItem}>
            <span style={styles.loadLabel}>15 min</span>
            <span style={styles.loadValue}>{stats.load_avg[2].toFixed(2)}</span>
          </div>
        </div>
      </div>
    </>
  );
}

// ── Users (per-user overview: "who's using the node") ─────────────────────
// This is the multi-tenant lens. Unlike the host-level Overview or the
// process-level Processes tab, Users answers "which user owns what share of the
// node". It is an overview with share bars + a sort table — no process drill-
// down (that lives in Processes). The three tabs are distinct: Overview=host,
// Users=per-user, Processes=per-process.

function UsersTab({ stats }: { stats: SysStats }) {
  const [sortKey, setSortKey] = useState<UserSortKey>('cpu_usage');

  // Per-user share of total CPU consumed across ALL users (percent, 0..100).
  // We deliberately use user_totals.total_cpu_usage — the sum of every user's
  // cpu_usage — as the denominator, NOT cpu_usage_percent. cpu_usage_percent is
  // the node's normalized load (already divided by core count, always 0..100),
  // while each user's cpu_usage is a raw per-core sum that legitimately exceeds
  // 100 on a busy multi-core box. Dividing one by the other yields physically
  // impossible values like "533% of node". Normalizing against the sum of all
  // users keeps every share in [0,100] and the shares summing to 100%.
  const cpuShare = useMemo(() => {
    const m: Record<number, number> = {};
    const denom = stats.user_totals.total_cpu_usage || 1;
    for (const u of stats.top_users) m[u.uid] = (u.cpu_usage / denom) * 100;
    return m;
  }, [stats.top_users, stats.user_totals.total_cpu_usage]);

  const memShare = useMemo(() => {
    const m: Record<number, number> = {};
    const denom = stats.mem_total_bytes || 1;
    for (const u of stats.top_users) m[u.uid] = (u.mem_bytes / denom) * 100;
    return m;
  }, [stats.top_users, stats.mem_total_bytes]);

  const users = useMemo(() => {
    const arr = [...stats.top_users];
    arr.sort((a, b) => cmpUsers(a, b, sortKey, cpuShare, memShare));
    return arr;
  }, [stats.top_users, sortKey, cpuShare, memShare]);

  // Bars are sorted by share desc so the biggest hog is on top, independent of
  // the table's sort key (the bars are a visual overview, the table is detail).
  const byCpu = [...users].sort((a, b) => (cpuShare[b.uid] ?? 0) - (cpuShare[a.uid] ?? 0));
  const byMem = [...users].sort((a, b) => b.mem_bytes - a.mem_bytes);

  return (
    <>
      <div style={styles.summaryRow}>
        <SummaryChip label="Distinct users" value={String(stats.user_totals.user_count)} />
        <SummaryChip label="Total CPU" value={`${stats.cpu_usage_percent.toFixed(0)}%`} />
        <SummaryChip label="Total mem" value={formatBytes(stats.user_totals.total_mem_bytes)} />
        <SummaryChip label="Total procs" value={formatCount(stats.user_totals.total_processes)} />
      </div>

      {/* CPU share by user — biggest on top.
          Bar WIDTH = the user's share of total CPU across all users (pct,
          0..100). Bar COLOR = the user's absolute CPU load (u.cpu_usage), NOT
          the share: a user can hold 100% of the share on a nearly idle node
          (their cpu_usage is tiny), and coloring that red would be a false
          alarm. Width and color are intentionally decoupled. */}
      <div style={styles.card}>
        <div style={styles.cardTitle}>CPU share by user</div>
        {byCpu.map((u) => {
          const pct = cpuShare[u.uid] ?? 0;
          return (
            <div key={u.uid} style={styles.gaugeRow}>
              <span style={styles.gaugeLabel}>{u.user}</span>
              <div style={styles.barOuter}>
                <div style={{
                  ...styles.barInner,
                  width: `${Math.min(pct, 100)}%`,
                  background: barColor(u.cpu_usage),
                }} />
              </div>
              <span style={styles.gaugeValue}>{pct.toFixed(1)}%</span>
            </div>
          );
        })}
        {byCpu.length === 0 && <div style={styles.statDetail}>No user data.</div>}
      </div>

      {/* Memory share by user — biggest on top. */}
      <div style={styles.card}>
        <div style={styles.cardTitle}>Memory share by user</div>
        {byMem.map((u) => {
          const pct = memShare[u.uid] ?? 0;
          return (
            <div key={u.uid} style={styles.gaugeRow}>
              <span style={styles.gaugeLabel}>{u.user}</span>
              <div style={styles.barOuter}>
                <div style={{
                  ...styles.barInner,
                  width: `${Math.min(pct, 100)}%`,
                  background: barColor(pct),
                }} />
              </div>
              <span style={styles.gaugeValue}>{formatBytes(u.mem_bytes)} · {pct.toFixed(0)}% of RAM</span>
            </div>
          );
        })}
        {byMem.length === 0 && <div style={styles.statDetail}>No user data.</div>}
      </div>

      {/* Detail table — sortable, no expand. Process detail lives in Processes. */}
      <div style={styles.card}>
        <div style={styles.tableScroll}>
          <table style={styles.table}>
            <thead>
              <tr>
                <ThSortable<UserSortKey> label="User" k="user" sortKey={sortKey} onSort={setSortKey} align="left" />
                <ThSortable<UserSortKey> label="CPU (cores)" k="cpu_usage" sortKey={sortKey} onSort={setSortKey} />
                <ThSortable<UserSortKey> label="CPU share" k="cpu_share" sortKey={sortKey} onSort={setSortKey} />
                <ThSortable<UserSortKey> label="Memory" k="mem_bytes" sortKey={sortKey} onSort={setSortKey} />
                <ThSortable<UserSortKey> label="Mem share" k="mem_share" sortKey={sortKey} onSort={setSortKey} />
                <ThSortable<UserSortKey> label="CPU·time" k="accumulated_cpu_ms" sortKey={sortKey} onSort={setSortKey} />
                <ThSortable<UserSortKey> label="Procs" k="process_count" sortKey={sortKey} onSort={setSortKey} />
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.uid} style={styles.tr}>
                  <td style={{ ...styles.td, textAlign: 'left' }}>{u.user}</td>
                  <td style={styles.td}>{u.cpu_usage.toFixed(1)}</td>
                  <td style={styles.td}>{(cpuShare[u.uid] ?? 0).toFixed(1)}%</td>
                  <td style={styles.td}>{formatBytes(u.mem_bytes)}</td>
                  <td style={styles.td}>{(memShare[u.uid] ?? 0).toFixed(1)}%</td>
                  <td style={styles.td}>{formatCpuMs(u.accumulated_cpu_ms)}</td>
                  <td style={styles.td}>{formatCount(u.process_count)}</td>
                </tr>
              ))}
              {users.length === 0 && (
                <tr><td style={styles.emptyRow} colSpan={7}>No user data</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

// ── Processes ─────────────────────────────────────────────────────────────

const PROC_LIMIT_KEY = 'filebox.procLimit';
const PROC_LIMIT_DEFAULT = 50;
const PROC_LIMIT_CHOICES = [50, 100, 200, 500];

function loadProcLimit(): number {
  const v = Number(localStorage.getItem(PROC_LIMIT_KEY));
  return PROC_LIMIT_CHOICES.includes(v) ? v : PROC_LIMIT_DEFAULT;
}

function ProcessesTab({ stats }: { stats: SysStats }) {
  const isMobile = useIsMobile();
  const rowHeight = isMobile ? PROC_ROW_HEIGHT_MOBILE : PROC_ROW_HEIGHT_DESKTOP;

  const [sortKey, setSortKey] = useState<ProcSortKey>('mem_bytes');
  const [selectedPid, setSelectedPid] = useState<number | null>(null);
  const [uidFilter, setUidFilter] = useState<number | null>(null);
  const [hideKthreads, setHideKthreads] = useState(true);
  const [displayLimit, setDisplayLimit] = useState<number>(loadProcLimit);
  const containerRef = useRef<HTMLDivElement>(null);
  const [listHeight, setListHeight] = useState(400);
  const [listWidth, setListWidth] = useState(800);

  // Measure the list container so the virtualized list fills available height
  // AND width. The grid is always the card width; the command column is flex:1,
  // so the table fits without horizontal scroll and has no wasted space.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const obs = new ResizeObserver(([entry]) => {
      setListHeight(entry.contentRect.height);
      setListWidth(entry.contentRect.width);
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  // Single source of truth: the global top-N snapshot. "Filter by user" just
  // narrows this same list by uid.
  const sortedProcs = useMemo(() => {
    let arr = stats.top_processes;
    if (uidFilter != null) arr = arr.filter((p) => p.uid === uidFilter);
    if (hideKthreads) arr = arr.filter((p) => !isKernelThread(p));
    const sorted = [...arr];
    sorted.sort((a, b) => cmpProcs(a, b, sortKey));
    return sorted;
  }, [stats.top_processes, uidFilter, hideKthreads, sortKey]);

  const procs = useMemo(
    () => sortedProcs.slice(0, displayLimit),
    [sortedProcs, displayLimit],
  );

  const changeLimit = (n: number) => {
    setDisplayLimit(n);
    try { localStorage.setItem(PROC_LIMIT_KEY, String(n)); } catch { /* ignore quota */ }
  };

  // The selected process (for the detail panel). Looked up from the full
  // sortedProcs so the panel survives filter changes as long as the row exists.
  const selected = selectedPid != null
    ? sortedProcs.find((p) => p.pid === selectedPid) ?? null
    : null;

  // If the selected process drops out of the snapshot (terminated, or filtered
  // away), clear the stale selection so a later same-pid reappearance doesn't
  // re-trigger the highlight, and the toggle logic keys off live state.
  useEffect(() => {
    if (selectedPid != null && !sortedProcs.some((p) => p.pid === selectedPid)) {
      setSelectedPid(null);
    }
  }, [sortedProcs, selectedPid]);

  // Virtualized row (equal-height, FixedSizeList). Clicking a row selects it
  // and opens the detail panel above the table with the full command + metrics.
  // react-window passes an absolutely-positioned style that MUST be spread first.
  const showUser = uidFilter == null;
  // Keyboard-accessible sort handler: Enter/Space trigger the same sort as click.
  const sortOnKey = (k: ProcSortKey) => ({
    role: 'button' as const,
    tabIndex: 0,
    title: `Sort by ${k}`,
    onClick: () => setSortKey(k),
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSortKey(k); }
    },
  });
  const ProcRow = ({ index, style }: { index: number; style: React.CSSProperties }) => {
    const p = procs[index];
    const isSel = selectedPid === p.pid;
    const toggle = () => setSelectedPid(isSel ? null : p.pid);
    return (
      <div
        style={{ ...style, ...styles.procRow, ...(isSel ? styles.procRowSel : {}), cursor: 'pointer' }}
        role="button"
        tabIndex={0}
        title={`${p.name} — click for full command`}
        onClick={toggle}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } }}
      >
        <span style={{ ...styles.procCell, ...styles.procColPid }}>{p.pid}</span>
        {showUser && (
          <span style={{ ...styles.procCell, ...styles.procColUser }}>{p.user}</span>
        )}
        <span style={{ ...styles.procCell, ...styles.procColName, fontWeight: 500 }}>
          {p.name}
          {p.nproc != null && <span style={styles.nprocBadge}>{p.nproc}p</span>}
        </span>
        <span style={styles.procStateWrap}><StateBadge state={p.state} /></span>
        <span style={{ ...styles.procCell, ...styles.procColMem }}>{formatBytes(p.mem_bytes)}</span>
        <span style={{ ...styles.procCell, ...styles.procColCpu }}>{p.cpu_usage.toFixed(1)}</span>
        <span style={{ ...styles.procCell, ...styles.procColCputime }}>{formatCpuMs(p.accumulated_cpu_ms)}</span>
        <span style={{ ...styles.procCell, ...styles.procColRun }}>{formatDuration(p.run_time_secs)}</span>
      </div>
    );
  };

  return (
    <>
      <div style={styles.procToolbar}>
        <div style={styles.procToolbarLeft}>
          <label style={styles.toolbarField}>
            <span style={styles.toolbarLabel}>User</span>
            <select
              style={styles.select}
              value={uidFilter ?? ''}
              onChange={(e) => setUidFilter(e.target.value ? Number(e.target.value) : null)}
            >
              <option value="">All users</option>
              {stats.top_users.map((u) => (
                <option key={u.uid} value={u.uid}>{u.user}</option>
              ))}
            </select>
          </label>
          <label style={styles.toolbarField}>
            <span style={styles.toolbarLabel}>Show</span>
            <select
              style={styles.select}
              value={displayLimit}
              onChange={(e) => changeLimit(Number(e.target.value))}
            >
              {PROC_LIMIT_CHOICES.map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
          </label>
          <label style={styles.toolbarCheck}>
            <input
              type="checkbox"
              checked={hideKthreads}
              onChange={(e) => setHideKthreads(e.target.checked)}
            />
            <span>Hide kernel threads</span>
          </label>
        </div>
        <span style={styles.procCount}>
          Showing {formatCount(procs.length)} / {formatCount(sortedProcs.length)} matched · {formatCount(stats.total_processes)} total
        </span>
      </div>

      {selected && <ProcDetail proc={selected} onClose={() => setSelectedPid(null)} />}

      <div style={styles.card}>
        <div style={styles.tableScroll}>
          {/* Column headers — a flex row the width of the card. The command
              column is flex:1 so it absorbs whatever width is left after the
              fixed columns; no horizontal scroll, no wasted space. */}
          <div style={{ ...styles.procHeaderRow, width: listWidth }}>
            <span style={styles.procColPid}>PID</span>
            {showUser && (
              <span
                style={{ ...styles.procColUser, cursor: 'pointer', userSelect: 'none' }}
                {...sortOnKey('user')}
              >User{sortKey === 'user' ? ' ▾' : ''}</span>
            )}
            <span
              style={{ ...styles.procColName, cursor: 'pointer', userSelect: 'none' }}
              {...sortOnKey('name')}
            >Name{sortKey === 'name' ? ' ▾' : ''}</span>
            <span style={styles.procColState}>St</span>
            <span
              style={{ ...styles.procColMem, cursor: 'pointer', userSelect: 'none' }}
              {...sortOnKey('mem_bytes')}
            >Memory{sortKey === 'mem_bytes' ? ' ▾' : ''}</span>
            <span
              style={{ ...styles.procColCpu, cursor: 'pointer', userSelect: 'none' }}
              {...sortOnKey('cpu_usage')}
            >CPU%{sortKey === 'cpu_usage' ? ' ▾' : ''}</span>
            <span
              style={{ ...styles.procColCputime, cursor: 'pointer', userSelect: 'none' }}
              {...sortOnKey('accumulated_cpu_ms')}
            >CPU·time{sortKey === 'accumulated_cpu_ms' ? ' ▾' : ''}</span>
            <span
              style={{ ...styles.procColRun, cursor: 'pointer', userSelect: 'none' }}
              {...sortOnKey('run_time_secs')}
            >Run{sortKey === 'run_time_secs' ? ' ▾' : ''}</span>
          </div>

          {/* Virtualized body — only the visible ~10-15 rows are in the DOM. */}
          <div ref={containerRef} style={styles.procListContainer}>
            {procs.length === 0 ? (
              <div style={styles.emptyRow}>No processes</div>
            ) : (
              <VList
                height={listHeight}
                itemCount={procs.length}
                itemSize={rowHeight}
                width={listWidth}
                style={{ overflowX: 'hidden' }}
              >
                {ProcRow}
              </VList>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

// ── Process detail panel (full command view) ──────────────────────────────
// Opens above the table when a row is clicked. Shows the full untruncated
// command (wrapping) plus a compact metric strip. Keeps variable-height content
// OUT of the virtualized list — the list stays uniform-height, this panel owns
// the long content.
function ProcDetail({ proc, onClose }: { proc: ProcessInfo; onClose: () => void }) {
  const chips: [string, string][] = [
    ['PID', String(proc.pid)],
    ['User', proc.user],
    ['Memory', formatBytes(proc.mem_bytes)],
    ['CPU%', proc.cpu_usage.toFixed(1)],
    ['CPU·time', formatCpuMs(proc.accumulated_cpu_ms)],
    ['Run', formatDuration(proc.run_time_secs)],
    ['State', `${proc.state} · ${stateLabel(proc.state)}`],
    ...(proc.parent_pid != null ? [['PPID', String(proc.parent_pid)] as [string, string]] : []),
    ...(proc.nproc != null ? [['Nproc', `${proc.nproc}`] as [string, string]] : []),
  ];
  return (
    <div style={styles.procDetail}>
      <div style={styles.procDetailHead}>
        <span style={styles.procDetailName}>{proc.name}</span>
        {proc.nproc != null && <span style={styles.nprocBadge}>{proc.nproc}p</span>}
        <button type="button" onClick={onClose} style={styles.procDetailClose} title="Close">×</button>
      </div>
      <div style={styles.procDetailChips}>
        {chips.map(([k, v]) => (
          <span key={k} style={styles.procDetailChip}>
            <span style={styles.procDetailChipK}>{k}</span>
            <span style={styles.procDetailChipV}>{v}</span>
          </span>
        ))}
      </div>
      <pre style={styles.procDetailCmd}>{proc.command || proc.name}</pre>
    </div>
  );
}

// ── Host ──────────────────────────────────────────────────────────────────

function HostTab({ stats }: { stats: SysStats }) {
  const rows: [string, string][] = [
    ['Uptime', formatDuration(stats.uptime_secs)],
    ['Boot time', formatBoot(stats.boot_time)],
    ['CPU usage', `${stats.cpu_usage_percent.toFixed(1)}%`],
    ['Load (1/5/15m)', `${stats.load_avg[0].toFixed(2)} / ${stats.load_avg[1].toFixed(2)} / ${stats.load_avg[2].toFixed(2)}`],
    ['Memory used', `${formatBytes(stats.mem_used_bytes)} / ${formatBytes(stats.mem_total_bytes)}`],
    ['Swap used', stats.swap_total_bytes > 0
      ? `${formatBytes(stats.swap_used_bytes)} / ${formatBytes(stats.swap_total_bytes)}`
      : 'none'],
    ['Total processes', formatCount(stats.total_processes)],
    ['Distinct users', String(stats.user_totals.user_count)],
  ];
  return (
    <div style={styles.card}>
      <div style={styles.cardTitle}>Host Info</div>
      {rows.map(([k, v]) => (
        <div key={k} style={styles.kvRow}>
          <span style={styles.kvKey}>{k}</span>
          <span style={styles.kvVal}>{v}</span>
        </div>
      ))}
    </div>
  );
}

// ── Shared bits ───────────────────────────────────────────────────────────

function TabButton({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      style={{ ...styles.tabBtn, ...(active ? styles.tabBtnActive : {}) }}
    >
      {label}
    </button>
  );
}

function SummaryChip({ label, value }: { label: string; value: string }) {
  return (
    <div style={styles.chip}>
      <span style={styles.chipLabel}>{label}</span>
      <span style={styles.chipValue}>{value}</span>
    </div>
  );
}

function StateBadge({ state }: { state: string }) {
  const color = stateColor(state);
  return (
    <span
      style={{ ...styles.stateBadge, color, background: `${color}18` }}
      title={stateLabel(state)}
    >
      {state}
    </span>
  );
}

function ThSortable<K extends string>({
  label, k, sortKey, onSort, align = 'right',
}: {
  label: string;
  k: K;
  sortKey: K;
  onSort: (k: K) => void;
  align?: 'left' | 'right';
}) {
  const active = sortKey === k;
  return (
    <th
      style={{ ...styles.th, textAlign: align, cursor: 'pointer', userSelect: 'none' }}
      onClick={() => onSort(k)}
    >
      {label}{active ? ' ▾' : ''}
    </th>
  );
}

function RefreshIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" style={{ marginRight: 4, verticalAlign: '-1px' }}>
      <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2v3h-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ── formatting & helpers ──────────────────────────────────────────────────

function barColor(pct: number): string {
  return pct > 80 ? c.danger : pct > 60 ? c.warning : c.success;
}

function stateColor(state: string): string {
  switch (state) {
    case 'R': return c.success;
    case 'S': return c.textMuted;
    case 'D': return c.warning;
    case 'Z': return c.danger;
    case 'I': return c.textFaint;
    default: return c.textMuted;
  }
}

function stateLabel(state: string): string {
  switch (state) {
    case 'R': return 'Running';
    case 'S': return 'Sleeping';
    case 'D': return 'Uninterruptible disk sleep';
    case 'Z': return 'Zombie';
    case 'I': return 'Idle';
    case 'T': return 'Stopped';
    case 'X': return 'Dead';
    default: return state;
  }
}

// Multi-key comparison with a stable, non-recursive tiebreak. `cpuShare` and
// `memShare` are the user's share of the total across all users (percent,
// 0..100), passed in because they're derived from the user totals. Falling back to the same
// key on a tie would recurse forever — common on HPC nodes running identical
// jobs — so the tiebreak always lands on a different dimension and finally on
// uid (unique), never recursing.
function cmpUsers(
  a: UserAgg, b: UserAgg, key: UserSortKey,
  cpuShare: Record<number, number>, memShare: Record<number, number>,
): number {
  const primary = (() => {
    switch (key) {
      case 'cpu_usage': return b.cpu_usage - a.cpu_usage;
      case 'cpu_share': return (cpuShare[b.uid] ?? 0) - (cpuShare[a.uid] ?? 0);
      case 'mem_bytes': return b.mem_bytes > a.mem_bytes ? 1 : b.mem_bytes < a.mem_bytes ? -1 : 0;
      case 'mem_share': return (memShare[b.uid] ?? 0) - (memShare[a.uid] ?? 0);
      case 'accumulated_cpu_ms': return b.accumulated_cpu_ms > a.accumulated_cpu_ms ? 1 : b.accumulated_cpu_ms < a.accumulated_cpu_ms ? -1 : 0;
      case 'process_count': return b.process_count - a.process_count;
      case 'user': return a.user.localeCompare(b.user);
    }
  })();
  if (primary !== 0) return primary;
  // Stable tiebreak: distinct secondary key, then uid (unique) — never recurses.
  if (key !== 'cpu_usage') return b.cpu_usage - a.cpu_usage;
  return b.uid - a.uid;
}

function cmpProcs(a: ProcessInfo, b: ProcessInfo, key: ProcSortKey): number {
  const primary = (() => {
    switch (key) {
      case 'mem_bytes': return b.mem_bytes > a.mem_bytes ? 1 : b.mem_bytes < a.mem_bytes ? -1 : 0;
      case 'cpu_usage': return b.cpu_usage - a.cpu_usage;
      case 'accumulated_cpu_ms': return b.accumulated_cpu_ms > a.accumulated_cpu_ms ? 1 : b.accumulated_cpu_ms < a.accumulated_cpu_ms ? -1 : 0;
      case 'run_time_secs': return b.run_time_secs > a.run_time_secs ? 1 : b.run_time_secs < a.run_time_secs ? -1 : 0;
      case 'user': return a.user.localeCompare(b.user) || a.name.localeCompare(b.name);
      case 'name': return a.name.localeCompare(b.name);
    }
  })();
  if (primary !== 0) return primary;
  // Stable tiebreak: pid is unique, so this always terminates.
  return a.pid - b.pid;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes < 1024 * 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  return `${(bytes / (1024 * 1024 * 1024 * 1024)).toFixed(2)} TB`;
}

function formatCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function formatDuration(secs: number): string {
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ${secs % 60}s`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
  return `${Math.floor(secs / 86400)}d ${Math.floor((secs % 86400) / 3600)}h`;
}

function formatCpuMs(ms: number): string {
  // CPU-ms → human core-time (the unit HPC ops cares about for accounting).
  const secs = ms / 1000;
  if (secs < 60) return `${secs.toFixed(0)}s`;
  if (secs < 3600) return `${(secs / 60).toFixed(1)}m`;
  if (secs < 86400) return `${(secs / 3600).toFixed(1)}h`;
  return `${(secs / 86400).toFixed(1)}d`;
}

function formatAgo(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  return `${Math.floor(s / 60)}m ago`;
}

function formatBoot(epoch: number): string {
  if (!epoch) return '—';
  const d = new Date(epoch * 1000);
  return d.toLocaleString();
}

/// Best-effort kernel-thread filter. On Linux, kthreads have an empty argv
/// (so command is blank) and live in PID space below the first userspace PID,
/// owned by root. We also catch the common bracketed-name convention (`[kworker]`,
/// `[kthreadd]`) so this works even if a future sysinfo change fills cmd.
function isKernelThread(p: ProcessInfo): boolean {
  if (p.uid === 0 && p.command === '' && p.name.startsWith('[') && p.name.endsWith(']')) {
    return true;
  }
  if (p.uid === 0 && p.command === '' && p.mem_bytes === 0) {
    return true;
  }
  return false;
}

// ── styles ────────────────────────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  container: { padding: 20, overflow: 'auto', height: '100%', fontFamily: font.sans },
  header: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    marginBottom: 16,
  },
  title: { margin: 0, fontSize: 16, color: c.text, fontWeight: 600 },
  headerRight: { display: 'flex', alignItems: 'center', gap: 12 },
  updatedAgo: { fontSize: 11, color: c.textMuted },
  refreshBtn: {
    display: 'inline-flex', alignItems: 'center',
    padding: '6px 14px', borderRadius: radius.md, border: `1px solid ${c.border}`,
    background: 'transparent', color: c.textSecondary, cursor: 'pointer', fontSize: 13,
    transition: 'all 0.15s',
  },
  tabs: {
    display: 'flex', gap: 4, marginBottom: 16, borderBottom: `1px solid ${c.border}`,
  },
  tabBtn: {
    padding: '8px 14px', border: 'none', background: 'transparent',
    color: c.textMuted, cursor: 'pointer', fontSize: 13, fontWeight: 500,
    borderBottom: '2px solid transparent', marginBottom: -1, transition: 'all 0.15s',
  },
  tabBtnActive: {
    color: c.text, borderBottom: `2px solid ${c.accent}`,
  },
  summaryRow: { display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 },
  procToolbar: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    gap: 12, flexWrap: 'wrap', marginBottom: 14,
  },
  procToolbarLeft: { display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' },
  toolbarField: { display: 'inline-flex', alignItems: 'center', gap: 6 },
  toolbarLabel: { fontSize: 11, textTransform: 'uppercase', color: c.textMuted, letterSpacing: 0.5 },
  toolbarCheck: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: c.textSecondary, cursor: 'pointer' },
  select: {
    padding: '4px 8px', borderRadius: radius.md, border: `1px solid ${c.border}`,
    background: c.surface, color: c.text, fontSize: 13, cursor: 'pointer',
  },
  procCount: { fontSize: 12, color: c.textMuted },
  chip: {
    display: 'inline-flex', flexDirection: 'column', gap: 2,
    padding: '8px 12px', background: c.bgSubtle, borderRadius: radius.md,
    border: `1px solid ${c.border}`,
  },
  chipLabel: { fontSize: 10, textTransform: 'uppercase', color: c.textMuted, letterSpacing: 0.5 },
  chipValue: { fontSize: 15, fontWeight: 600, color: c.text },
  card: {
    background: c.surface, border: `1px solid ${c.border}`, borderRadius: radius.lg,
    padding: '14px 18px', marginBottom: 12, boxShadow: shadow.xs,
  },
  cardTitle: {
    fontSize: 11, textTransform: 'uppercase', color: c.textMuted,
    letterSpacing: 0.5, marginBottom: 10, fontWeight: 500,
  },
  gaugeRow: { display: 'flex', alignItems: 'center', gap: 12 },
  // Label for a per-user share bar (the username). Fixed width + ellipsis so the
  // bars all start at the same x regardless of name length.
  gaugeLabel: {
    width: 110, flexShrink: 0, fontSize: 13, color: c.text,
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  barOuter: {
    flex: 1, height: 8, background: c.bgMuted, borderRadius: radius.pill, overflow: 'hidden',
  },
  barInner: {
    height: '100%', borderRadius: radius.pill, transition: 'width 0.5s ease',
  },
  gaugeValue: {
    fontSize: 13, fontWeight: 600, color: c.text, minWidth: 140, textAlign: 'right',
    whiteSpace: 'nowrap',
  },
  statDetail: { fontSize: 12, color: c.textMuted, marginTop: 6 },
  loadRow: { display: 'flex', gap: 32 },
  loadItem: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 },
  loadLabel: { fontSize: 11, color: c.textMuted },
  loadValue: { fontSize: 15, fontWeight: 600, color: c.text },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 13 },
  tableScroll: { overflowX: 'auto' },
  th: {
    textAlign: 'right', padding: '8px 8px', borderBottom: `1px solid ${c.border}`,
    color: c.textMuted, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5,
    fontWeight: 500, whiteSpace: 'nowrap',
  },
  tr: { borderBottom: `1px solid ${c.borderSubtle}`, transition: 'background 0.1s' },
  td: { textAlign: 'right', padding: '8px 8px', color: c.text },
  stateBadge: {
    display: 'inline-block', width: 16, textAlign: 'center',
    fontFamily: font.mono, fontSize: 11, fontWeight: 600, borderRadius: radius.sm,
    padding: '1px 0',
  },
  nprocBadge: {
    display: 'inline-block', marginLeft: 6,
    fontSize: 10, fontWeight: 600, color: c.accent, background: c.accentBg,
    borderRadius: radius.sm, padding: '1px 5px',
  },
  emptyRow: { padding: '16px 8px', color: c.textMuted, fontSize: 13, textAlign: 'center' },

  // ── Virtualized process grid (header + body share these widths) ───────
  // Mirrors the FileBrowser colName/entryName pairing: the header row and each
  // body row reference width-matched styles so columns align without a <table>.
  // Holds the virtualized list. The grid is always the card width (no
  // horizontal scroll), so just clip and let the list own vertical scrolling.
  procListContainer: { flex: 1, overflow: 'hidden', minHeight: 200 },
  // INVARIANT: procHeaderRow and procRow MUST share the same horizontal box
  // model (both have zero outer horizontal padding here). Name is flex:1, so
  // it absorbs whatever width is left after the fixed columns. If the header
  // had different side padding than the body rows, the header's Name column
  // would be a few px narrower/wider than the body's, and EVERY column from
  // State rightward (St, Memory, CPU%, CPU·time, Run) would shift sideways
  // relative to the body — the "St header sits over the Name column" bug.
  // Do NOT add padding here without adding the same padding to procRow.
  procHeaderRow: {
    display: 'flex', alignItems: 'center', gap: 0,
    borderBottom: `1px solid ${c.border}`, color: c.textMuted,
    fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 500,
    height: 30, whiteSpace: 'nowrap', flexShrink: 0,
  },
  // Header cells. Fixed-width metric columns + a flex Name column that absorbs
  // the leftover card width — no horizontal scroll, no wasted space.
  procColPid:    { width: 60, textAlign: 'right', flexShrink: 0, padding: '0 8px' },
  procColUser:   { width: 110, textAlign: 'left', flexShrink: 0, padding: '0 8px' },
  procColName:   { flex: 1, minWidth: 0, textAlign: 'left', flexShrink: 1, padding: '0 8px' },
  procColState:  { width: 34, textAlign: 'center', flexShrink: 0, padding: '0 4px' },
  procColMem:    { width: 80, textAlign: 'right', flexShrink: 0, padding: '0 8px' },
  procColCpu:    { width: 60, textAlign: 'right', flexShrink: 0, padding: '0 8px' },
  procColCputime:{ width: 80, textAlign: 'right', flexShrink: 0, padding: '0 8px' },
  procColRun:    { width: 70, textAlign: 'right', flexShrink: 0, padding: '0 8px' },
  // Body row: a centered single-line flex row. The Name cell is flex:1
  // (truncated+ellipsis) so it absorbs leftover width with no gaps.
  procRow: {
    display: 'flex', alignItems: 'center', gap: 0,
    borderBottom: `1px solid ${c.borderSubtle}`, fontSize: 13, color: c.text,
    whiteSpace: 'nowrap',
  },
  procCell: {
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    boxSizing: 'border-box',
  },
  // Selected row highlight (the row whose detail panel is open).
  procRowSel: { background: c.accentBg },
  // ── Process detail panel ──────────────────────────────────────────────
  // Sits above the table, holds the full command + metric chips. Variable
  // height lives here, never in the virtualized list.
  procDetail: {
    background: c.bgSubtle, border: `1px solid ${c.border}`, borderRadius: radius.lg,
    padding: '10px 14px', marginBottom: 10,
  },
  procDetailHead: {
    display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8,
  },
  procDetailName: { fontSize: 14, fontWeight: 600, color: c.text, flex: 1, minWidth: 0,
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  procDetailClose: {
    border: 'none', background: 'transparent', color: c.textMuted, cursor: 'pointer',
    fontSize: 18, lineHeight: 1, padding: '0 4px',
  },
  procDetailChips: { display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 },
  procDetailChip: {
    display: 'inline-flex', alignItems: 'center', gap: 4,
    background: c.surface, border: `1px solid ${c.border}`, borderRadius: radius.sm,
    padding: '2px 8px', fontSize: 11,
  },
  procDetailChipK: { color: c.textMuted, textTransform: 'uppercase', letterSpacing: 0.3, fontSize: 10 },
  procDetailChipV: { color: c.text, fontFamily: font.mono },
  procDetailCmd: {
    margin: 0, padding: '8px 10px', background: c.surface, border: `1px solid ${c.border}`,
    borderRadius: radius.sm, fontFamily: font.mono, fontSize: 11, color: c.text,
    whiteSpace: 'pre-wrap', wordBreak: 'break-all', lineHeight: '15px', maxHeight: 220, overflow: 'auto',
  },
  procStateWrap: { width: 34, flexShrink: 0, textAlign: 'center', padding: '0 4px', boxSizing: 'border-box' },
  kvRow: { display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: `1px solid ${c.borderSubtle}` },
  kvKey: { fontSize: 12, color: c.textMuted },
  kvVal: { fontSize: 13, color: c.text, fontFamily: font.mono },
  loading: { color: c.textMuted },
  error: { color: c.danger, marginBottom: 8 },
  errorBanner: {
    padding: '8px 12px', marginBottom: 12, background: c.dangerBg,
    border: `1px solid ${c.danger}40`, borderRadius: radius.md, color: c.danger, fontSize: 13,
  },
  retryBtn: {
    padding: '6px 16px', borderRadius: radius.md, border: `1px solid ${c.border}`,
    background: 'transparent', color: c.textSecondary, cursor: 'pointer', fontSize: 13,
    transition: 'all 0.15s',
  },
};
