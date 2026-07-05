import { c, radius, shadow, font } from '../theme';
import type { AgentInfo, HealthResponse } from '../api/client';
import { friendlyMessage } from '../api/client';

interface Props {
  open: boolean;
  health: HealthResponse | null;
  agents: AgentInfo[];
  healthError?: string | null;
  isLikelyDev: boolean;
  onClose: () => void;
}

export function AboutDialog({ open, health, agents, healthError, isLikelyDev, onClose }: Props) {
  if (!open) return null;

  return (
    <div style={styles.overlay} onClick={onClose}>
      <div style={styles.card} onClick={(e) => e.stopPropagation()}>
        <div style={styles.header}>
          <div style={styles.logo}>filebox</div>
          <button onClick={onClose} style={styles.closeBtn} aria-label="Close">×</button>
        </div>
        <div style={styles.body}>
          <div style={styles.row}>
            <span style={styles.label}>Version</span>
            <span style={styles.value}>v{health?.hub.version ?? '—'}</span>
          </div>
          <div style={styles.row}>
            <span style={styles.label}>Mode</span>
            <span style={{ ...styles.value, color: isLikelyDev ? c.warning : c.success }}>
              {isLikelyDev ? 'development (local)' : 'production'}
            </span>
          </div>
          <div style={styles.row}>
            <span style={styles.label}>Homepage</span>
            <a
              href="https://zhimingye.github.io/filebox/"
              target="_blank"
              rel="noopener noreferrer"
              style={styles.link}
            >
              zhimingye.github.io/filebox
            </a>
          </div>

          <div style={styles.divider} />
          <div style={styles.sectionTitle}>Diagnostics</div>

          {healthError && (
            <div style={styles.errorBanner}>{friendlyMessage({ message: healthError })}</div>
          )}

          {!health ? (
            <div style={styles.loading}>{healthError ? '' : 'Loading...'}</div>
          ) : (
            <>
              <div style={styles.diagCard}>
                <div style={styles.diagCardTitle}>Hub</div>
                <div style={styles.row}>
                  <span style={styles.label}>Status</span>
                  <span style={{ ...styles.value, color: c.success }}>{health.hub.status}</span>
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
                <div style={styles.diagCard}>
                  <div style={styles.diagCardTitle}>Agents</div>
                  <div style={styles.agentList}>
                    {agents.map((a) => {
                      const statusColor = a.status === 'online' ? c.success : a.status === 'slow' ? c.warning : c.textFaint;
                      const statusLabel = a.status === 'online' ? 'Online' : a.status === 'slow' ? 'Slow' : 'Offline';
                      return (
                        <div key={a.id} style={styles.agentEntry}>
                          <div style={styles.agentEntryHeader}>
                            <span style={{ ...styles.agentDot, background: statusColor }} />
                            <span style={styles.agentName}>{a.name}</span>
                            <span style={{ ...styles.agentBadge, color: statusColor, background: `${statusColor}15` }}>
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
                            <div style={styles.configError}>Config error: {a.last_config_error}</div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
        <button onClick={onClose} style={styles.doneBtn}>Done</button>
      </div>
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
  overlay: {
    position: 'fixed', inset: 0, zIndex: 2000,
    background: c.bgOverlay,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    padding: 16,
  },
  card: {
    width: '100%', maxWidth: 380,
    background: c.surface, borderRadius: radius.lg,
    border: `1px solid ${c.border}`, boxShadow: shadow.lg,
    overflow: 'hidden',
    display: 'flex', flexDirection: 'column',
  },
  header: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '16px 18px', borderBottom: `1px solid ${c.border}`,
    background: c.bgSubtle,
  },
  logo: {
    fontSize: 16, fontWeight: 700, color: c.text, fontFamily: font.sans,
    letterSpacing: '-0.01em',
  },
  closeBtn: {
    background: 'none', border: 'none', fontSize: 22, lineHeight: 1,
    color: c.textMuted, cursor: 'pointer', padding: '0 4px', borderRadius: radius.sm,
    transition: 'color 0.15s',
  },
  body: {
    padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 12,
  },
  row: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  label: {
    fontSize: 12, color: c.textMuted, fontWeight: 500,
    textTransform: 'uppercase', letterSpacing: '0.04em',
  },
  value: {
    fontSize: 13, color: c.text, fontFamily: font.mono, fontWeight: 600,
  },
  link: {
    fontSize: 13, color: c.accent, textDecoration: 'none', fontWeight: 500,
  },
  divider: { height: 1, background: c.border, margin: '4px 0' },
  sectionTitle: {
    fontSize: 11, textTransform: 'uppercase', color: c.textMuted,
    letterSpacing: 0.8, fontWeight: 600,
  },
  errorBanner: {
    background: c.dangerBg, border: `1px solid ${c.danger}20`, borderRadius: radius.md,
    padding: '10px 14px', color: c.danger, fontSize: 13,
  },
  loading: { color: c.textMuted, fontSize: 13, padding: '4px 0' },
  diagCard: {
    background: c.bgSubtle, border: `1px solid ${c.border}`, borderRadius: radius.md,
    padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8,
  },
  diagCardTitle: {
    fontSize: 11, textTransform: 'uppercase', color: c.textMuted,
    letterSpacing: 0.5, fontWeight: 500,
  },
  agentList: { display: 'flex', flexDirection: 'column' },
  agentEntry: { padding: '10px 0', borderTop: `1px solid ${c.borderSubtle}` },
  agentEntryHeader: { display: 'flex', alignItems: 'center', gap: 8 },
  agentDot: { width: 7, height: 7, borderRadius: '50%', flexShrink: 0 },
  agentName: { color: c.text, fontSize: 13, fontWeight: 500, flex: 1 },
  agentBadge: {
    fontSize: 11, fontWeight: 500, padding: '2px 8px', borderRadius: radius.pill,
  },
  agentMeta: { display: 'flex', gap: 16, fontSize: 12, color: c.textMuted, marginTop: 6 },
  pendingRow: { display: 'flex', alignItems: 'center', gap: 6, marginTop: 6 },
  pendingDot: { width: 6, height: 6, borderRadius: '50%', background: c.warning },
  pendingText: { color: c.warning, fontSize: 12 },
  configError: { color: c.danger, fontSize: 12, marginTop: 6 },
  doneBtn: {
    margin: '4px 18px 18px',
    padding: '9px 16px', borderRadius: radius.md, border: 'none',
    background: c.accent, color: '#fff', cursor: 'pointer', fontSize: 13,
    fontWeight: 600, transition: 'background 0.15s',
  },
};
