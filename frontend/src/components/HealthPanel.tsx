import type { AgentInfo, HealthResponse } from '../api/client';
import { friendlyMessage } from '../api/client';
import { c, radius, shadow, font } from '../theme';

interface Props {
  health: HealthResponse | null;
  agents: AgentInfo[];
  error?: string | null;
}

export function HealthPanel({ health, agents, error }: Props) {
  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <h2 style={styles.title}>Health</h2>
      </div>

      {error && <div style={styles.errorBanner}>{friendlyMessage({ message: error })}</div>}

      {!health ? (
        <div style={styles.loading}>{error ? '' : 'Loading...'}</div>
      ) : (
        <>
          <div style={styles.card}>
            <div style={styles.cardTitle}>Hub</div>
            <div style={styles.row}>
              <span style={styles.label}>Status</span>
              <span style={styles.ok}>{health.hub.status}</span>
            </div>
            <div style={styles.row}>
              <span style={styles.label}>Version</span>
              <span style={styles.value}>{health.hub.version}</span>
            </div>
            <div style={styles.row}>
              <span style={styles.label}>Uptime</span>
              <span style={styles.value}>{formatUptime(health.hub.uptime_sec)}</span>
            </div>
          </div>

          {agents.length > 0 && (
            <div style={styles.card}>
              <div style={styles.cardTitle}>Agents</div>
              {agents.map((a) => {
                const statusColor = a.status === 'online' ? c.success : a.status === 'slow' ? c.warning : c.textFaint;
                const statusLabel = a.status === 'online' ? 'Online' : a.status === 'slow' ? 'Slow' : 'Offline';
                return (
                  <div key={a.id} style={styles.agentRow}>
                    <div style={styles.agentHeader}>
                      <span style={{ ...styles.dot, background: statusColor }} />
                      <span style={styles.agentName}>{a.name}</span>
                      <span style={{ ...styles.statusBadge, color: statusColor, background: `${statusColor}15` }}>
                        {statusLabel}
                      </span>
                    </div>
                    <div style={styles.agentMeta}>
                      <span>RTT: {a.rtt_ms ?? '-'}ms</span>
                      <span>Inflight: {a.inflight}</span>
                      <span>Rev: {a.resource_revision}</span>
                    </div>
                    {a.pending_resource_update && (
                      <div style={styles.pendingRow}>
                        <span style={styles.pendingDot} />
                        <span style={styles.pendingText}>Pending config update</span>
                      </div>
                    )}
                    {a.last_config_error && (
                      <div style={styles.configError}>
                        Config error: {a.last_config_error}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function formatUptime(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${h}h ${m}m`;
}

const styles: Record<string, React.CSSProperties> = {
  container: { padding: 20, overflow: 'auto', height: '100%', fontFamily: font.sans },
  header: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    marginBottom: 20,
  },
  title: { margin: 0, fontSize: 16, color: c.text, fontWeight: 600 },
  loading: { color: c.textMuted, fontSize: 13, padding: 12 },
  errorBanner: {
    background: c.dangerBg, border: `1px solid ${c.danger}20`, borderRadius: radius.md,
    padding: '10px 14px', color: c.danger, fontSize: 13, marginBottom: 12,
  },
  card: {
    background: c.surface, border: `1px solid ${c.border}`, borderRadius: radius.lg,
    padding: '14px 18px', marginBottom: 12, boxShadow: shadow.xs,
  },
  cardTitle: {
    fontSize: 11, textTransform: 'uppercase', color: c.textMuted,
    letterSpacing: 0.5, marginBottom: 10, fontWeight: 500,
  },
  row: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 },
  label: { color: c.textMuted, fontSize: 13, minWidth: 60 },
  value: { color: c.text, fontSize: 13 },
  ok: { color: c.success, fontSize: 13, fontWeight: 500 },
  agentRow: { padding: '10px 0', borderTop: `1px solid ${c.borderSubtle}` },
  agentHeader: { display: 'flex', alignItems: 'center', gap: 8 },
  dot: { width: 7, height: 7, borderRadius: '50%', flexShrink: 0 },
  agentName: { color: c.text, fontSize: 13, fontWeight: 500, flex: 1 },
  statusBadge: {
    fontSize: 11, fontWeight: 500, padding: '2px 8px', borderRadius: radius.pill,
  },
  agentMeta: { display: 'flex', gap: 16, fontSize: 12, color: c.textMuted, marginTop: 6 },
  pendingRow: { display: 'flex', alignItems: 'center', gap: 6, marginTop: 6 },
  pendingDot: { width: 6, height: 6, borderRadius: '50%', background: c.warning },
  pendingText: { color: c.warning, fontSize: 12 },
  configError: { color: c.danger, fontSize: 12, marginTop: 6 },
};
