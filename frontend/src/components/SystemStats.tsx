import { useState, useEffect, useRef, useCallback } from 'react';
import { getSysStats, friendlyMessage } from '../api/client';
import type { SysStats } from '../api/client';
import { c, radius, shadow, font } from '../theme';

interface Props {
  agentId: string;
}

const REFRESH_INTERVAL = 30_000;

export function SystemStats({ agentId }: Props) {
  const [stats, setStats] = useState<SysStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchStats = useCallback(async () => {
    try {
      const data = await getSysStats(agentId);
      if (data.error) {
        setError(friendlyMessage({ error: data.error }));
      } else {
        setStats(data);
        setError(null);
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

  const memPercent = stats.mem_total_bytes > 0
    ? (stats.mem_used_bytes / stats.mem_total_bytes) * 100
    : 0;
  const swapPercent = stats.swap_total_bytes > 0
    ? (stats.swap_used_bytes / stats.swap_total_bytes) * 100
    : 0;

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <h2 style={styles.title}>System Monitor</h2>
        <button onClick={fetchStats} style={styles.refreshBtn}>&#x21bb; Refresh</button>
      </div>

      {/* CPU */}
      <div style={styles.card}>
        <div style={styles.cardTitle}>CPU</div>
        <div style={styles.gaugeRow}>
          <div style={styles.barOuter}>
            <div style={{
              ...styles.barInner,
              width: `${Math.min(stats.cpu_usage_percent, 100)}%`,
              background: stats.cpu_usage_percent > 80 ? c.danger : stats.cpu_usage_percent > 60 ? c.warning : c.success,
            }} />
          </div>
          <span style={styles.gaugeValue}>{stats.cpu_usage_percent.toFixed(1)}%</span>
        </div>
      </div>

      {/* Memory */}
      <div style={styles.card}>
        <div style={styles.cardTitle}>Memory</div>
        <div style={styles.gaugeRow}>
          <div style={styles.barOuter}>
            <div style={{
              ...styles.barInner,
              width: `${Math.min(memPercent, 100)}%`,
              background: memPercent > 80 ? c.danger : memPercent > 60 ? c.warning : c.success,
            }} />
          </div>
          <span style={styles.gaugeValue}>{memPercent.toFixed(1)}%</span>
        </div>
        <div style={styles.statDetail}>
          {formatBytes(stats.mem_used_bytes)} / {formatBytes(stats.mem_total_bytes)}
        </div>
      </div>

      {/* Swap */}
      {stats.swap_total_bytes > 0 && (
        <div style={styles.card}>
          <div style={styles.cardTitle}>Swap</div>
          <div style={styles.gaugeRow}>
            <div style={styles.barOuter}>
              <div style={{
                ...styles.barInner,
                width: `${Math.min(swapPercent, 100)}%`,
                background: swapPercent > 80 ? c.danger : c.success,
              }} />
            </div>
            <span style={styles.gaugeValue}>{swapPercent.toFixed(1)}%</span>
          </div>
          <div style={styles.statDetail}>
            {formatBytes(stats.swap_used_bytes)} / {formatBytes(stats.swap_total_bytes)}
          </div>
        </div>
      )}

      {/* Load Average */}
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

      {/* Top Processes */}
      <div style={styles.card}>
        <div style={styles.cardTitle}>Top Processes (by memory)</div>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>PID</th>
              <th style={{ ...styles.th, textAlign: 'left' }}>Name</th>
              <th style={styles.th}>Memory</th>
              <th style={styles.th}>CPU</th>
            </tr>
          </thead>
          <tbody>
            {stats.top_processes.map((p) => (
              <tr key={p.pid} style={styles.tr}>
                <td style={styles.td}>{p.pid}</td>
                <td style={{ ...styles.td, textAlign: 'left' }}>{p.name}</td>
                <td style={styles.td}>{formatBytes(p.mem_bytes)}</td>
                <td style={styles.td}>{p.cpu_usage.toFixed(1)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

const styles: Record<string, React.CSSProperties> = {
  container: { padding: 20, overflow: 'auto', height: '100%', fontFamily: font.sans },
  header: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    marginBottom: 20,
  },
  title: { margin: 0, fontSize: 16, color: c.text, fontWeight: 600 },
  refreshBtn: {
    padding: '6px 14px', borderRadius: radius.md, border: `1px solid ${c.border}`,
    background: 'transparent', color: c.textSecondary, cursor: 'pointer', fontSize: 13,
    transition: 'all 0.15s',
  },
  card: {
    background: c.surface, border: `1px solid ${c.border}`, borderRadius: radius.lg,
    padding: '14px 18px', marginBottom: 12, boxShadow: shadow.xs,
  },
  cardTitle: {
    fontSize: 11, textTransform: 'uppercase', color: c.textMuted,
    letterSpacing: 0.5, marginBottom: 10, fontWeight: 500,
  },
  gaugeRow: { display: 'flex', alignItems: 'center', gap: 12 },
  barOuter: {
    flex: 1, height: 8, background: c.bgMuted, borderRadius: radius.pill, overflow: 'hidden',
  },
  barInner: {
    height: '100%', borderRadius: radius.pill, transition: 'width 0.5s ease',
  },
  gaugeValue: {
    fontSize: 15, fontWeight: 600, color: c.text, minWidth: 56, textAlign: 'right',
  },
  statDetail: { fontSize: 12, color: c.textMuted, marginTop: 6 },
  loadRow: { display: 'flex', gap: 32 },
  loadItem: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 },
  loadLabel: { fontSize: 11, color: c.textMuted },
  loadValue: { fontSize: 15, fontWeight: 600, color: c.text },
  table: {
    width: '100%', borderCollapse: 'collapse', fontSize: 13,
  },
  th: {
    textAlign: 'right', padding: '8px 8px', borderBottom: `1px solid ${c.border}`,
    color: c.textMuted, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5,
    fontWeight: 500,
  },
  tr: { borderBottom: `1px solid ${c.borderSubtle}` },
  td: {
    textAlign: 'right', padding: '8px 8px', color: c.text,
  },
  loading: { color: c.textMuted },
  error: { color: c.danger, marginBottom: 8 },
  retryBtn: {
    padding: '6px 16px', borderRadius: radius.md, border: `1px solid ${c.border}`,
    background: 'transparent', color: c.textSecondary, cursor: 'pointer', fontSize: 13,
    transition: 'all 0.15s',
  },
};
