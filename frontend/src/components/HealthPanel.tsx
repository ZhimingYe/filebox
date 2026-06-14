import type { HealthResponse } from '../api/client';
import { friendlyMessage } from '../api/client';
import { c, radius, font } from '../theme';

interface Props {
  health: HealthResponse | null;
  error?: string | null;
}

export function HealthPanel({ health, error }: Props) {
  if (!health) {
    return (
      <div style={styles.panel}>
        {error ? (
          <div style={styles.errorBanner}>{friendlyMessage({ message: error })}</div>
        ) : (
          <div style={styles.loading}>Loading...</div>
        )}
      </div>
    );
  }

  return (
    <div style={styles.panel}>
      {error && <div style={styles.errorBanner}>{friendlyMessage({ message: error })}</div>}

      <h3 style={styles.title}>Hub</h3>
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

      {health.agents.length > 0 && (
        <>
          <h3 style={{ ...styles.title, marginTop: 20 }}>Agents</h3>
          {health.agents.map((a) => {
            const statusColor = a.status === 'online' ? c.success : a.status === 'slow' ? c.warning : c.textFaint;
            const statusLabel = a.status === 'online' ? 'Online' : a.status === 'slow' ? 'Slow' : 'Offline';
            return (
              <div key={a.id} style={styles.agentCard}>
                <div style={styles.row}>
                  <span style={{ ...styles.dot, background: statusColor }} />
                  <span style={styles.value}>{a.name}</span>
                  <span style={{ ...styles.statusLabel, color: statusColor }}>{statusLabel}</span>
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
  panel: { padding: 20, fontFamily: font.sans },
  loading: { color: c.textMuted, padding: 12 },
  errorBanner: {
    background: c.dangerBg, border: `1px solid ${c.danger}20`, borderRadius: radius.md,
    padding: '10px 14px', color: c.danger, fontSize: 13, marginBottom: 16,
  },
  title: { margin: '0 0 10px', color: c.textSecondary, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.8, fontWeight: 600 },
  row: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 },
  label: { color: c.textMuted, fontSize: 13, minWidth: 60 },
  value: { color: c.text, fontSize: 13 },
  ok: { color: c.success, fontSize: 13, fontWeight: 500 },
  dot: { width: 7, height: 7, borderRadius: '50%', flexShrink: 0 },
  statusLabel: { fontSize: 11, fontWeight: 500 },
  agentCard: { padding: '10px 0', borderTop: `1px solid ${c.border}` },
  agentMeta: { display: 'flex', gap: 16, fontSize: 12, color: c.textMuted, marginTop: 6 },
  pendingRow: { display: 'flex', alignItems: 'center', gap: 6, marginTop: 6 },
  pendingDot: { width: 6, height: 6, borderRadius: '50%', background: c.warning },
  pendingText: { color: c.warning, fontSize: 12 },
  configError: { color: c.danger, fontSize: 12, marginTop: 6 },
};
