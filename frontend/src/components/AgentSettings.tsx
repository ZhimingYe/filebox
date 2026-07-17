import { useEffect, useState } from 'react';
import type { AgentInfo } from '../api/client';
import { RootManager } from './RootManager';
import { c, radius, font, shadow } from '../theme';

interface Props {
  agent: AgentInfo;
  onRefresh: () => void;
}

function statusPresentation(status: string): {
  label: string;
  color: string;
} {
  if (status === 'online') {
    return { label: 'Online', color: c.success };
  }
  if (status === 'slow') {
    return { label: 'Slow', color: c.warning };
  }
  return { label: 'Offline', color: c.textMuted };
}

function formatLastSeen(epochSec: number, nowMs: number): string {
  if (!epochSec) return '—';
  const ageMs = nowMs - epochSec * 1000;
  if (ageMs < 0) return 'just now';
  const sec = Math.floor(ageMs / 1000);
  if (sec < 10) return 'just now';
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  return `${d}d ago`;
}

/**
 * Agent settings: connection overview + workspace roots.
 */
export function AgentSettings({ agent, onRefresh }: Props) {
  const status = statusPresentation(agent.status);
  const enabledRoots = agent.roots.filter((r) => r.enabled).length;
  // Local clock so "Last seen" stays honest while the page is open without a
  // hub refresh. 30s is enough for "just now" / "Xm ago" granularity.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  return (
    <div style={styles.page}>
      <header style={styles.pageHeader}>
        <div style={styles.pageHeaderText}>
          <p style={styles.eyebrow}>Agent</p>
          <h2 style={styles.pageTitle}>{agent.name}</h2>
        </div>
        <div style={styles.headerBadge} title={`Status: ${status.label}`}>
          <span style={{ ...styles.statusDot, background: status.color }} />
          <span style={{ color: status.color }}>{status.label}</span>
        </div>
      </header>

      <div style={styles.scroll}>
        <div style={styles.stack}>
          {/* ── Connection ─────────────────────────────────────────────── */}
          <section style={styles.card} aria-labelledby="settings-connection-title">
            <div style={styles.cardHeader}>
              <h3 id="settings-connection-title" style={styles.cardTitle}>
                Connection
              </h3>
            </div>

            {/* Status lives only in the page header badge — grid holds metrics. */}
            <dl style={styles.propGrid}>
              <div style={styles.propCell}>
                <dt style={styles.propLabel}>Round-trip</dt>
                <dd style={styles.propValueMono}>
                  {agent.rtt_ms !== null ? `${agent.rtt_ms} ms` : '—'}
                </dd>
              </div>
              <div style={styles.propCell}>
                <dt style={styles.propLabel}>Last seen</dt>
                <dd style={styles.propValue}>{formatLastSeen(agent.last_seen, nowMs)}</dd>
              </div>
              <div style={styles.propCell}>
                <dt style={styles.propLabel}>Config revision</dt>
                <dd style={styles.propValueMono}>{agent.resource_revision}</dd>
              </div>
              <div style={styles.propCell}>
                <dt style={styles.propLabel}>In-flight requests</dt>
                <dd style={styles.propValueMono}>{agent.inflight}</dd>
              </div>
              <div style={styles.propCell}>
                <dt style={styles.propLabel}>Enabled roots</dt>
                <dd style={styles.propValueMono}>
                  {enabledRoots}
                  <span style={styles.propHint}> / {agent.roots.length}</span>
                </dd>
              </div>
            </dl>

            {agent.pending_resource_update && (
              <div style={styles.bannerWarn} role="status">
                <span style={styles.bannerTitle}>Pending apply</span>
                <span style={styles.bannerBody}>
                  Waiting for the agent to apply.
                </span>
              </div>
            )}

            {agent.last_config_error && (
              <div style={styles.bannerError} role="alert">
                <span style={styles.bannerTitle}>Last config error</span>
                <span style={styles.bannerBody}>{agent.last_config_error}</span>
              </div>
            )}
          </section>

          {/* ── Workspace roots ────────────────────────────────────────── */}
          <section style={styles.card} aria-labelledby="settings-roots-title">
            <div style={styles.cardHeader}>
              <h3 id="settings-roots-title" style={styles.cardTitle}>
                Workspace roots
              </h3>
            </div>
            <div style={styles.cardBody}>
              <RootManager
                agentId={agent.id}
                roots={agent.roots}
                onUpdate={onRefresh}
              />
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    minWidth: 0,
    fontFamily: font.sans,
    background: c.bgSubtle,
  },
  pageHeader: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 16,
    padding: '20px 28px 18px',
    borderBottom: `1px solid ${c.border}`,
    background: c.bg,
    flexShrink: 0,
    minWidth: 0,
  },
  pageHeaderText: {
    minWidth: 0,
    flex: 1,
  },
  eyebrow: {
    margin: '0 0 4px',
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: '0.04em',
    textTransform: 'uppercase' as const,
    color: c.textMuted,
  },
  pageTitle: {
    margin: 0,
    color: c.text,
    fontSize: 18,
    fontWeight: 600,
    letterSpacing: '-0.02em',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  headerBadge: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 7,
    flexShrink: 0,
    padding: '6px 12px',
    borderRadius: radius.pill,
    border: `1px solid ${c.border}`,
    background: c.surface,
    fontSize: 12.5,
    fontWeight: 500,
    boxShadow: shadow.xs,
  },
  statusDot: {
    width: 7,
    height: 7,
    borderRadius: radius.pill,
    flexShrink: 0,
  },
  scroll: {
    flex: 1,
    overflow: 'auto',
    minWidth: 0,
    minHeight: 0,
  },
  stack: {
    maxWidth: 760,
    margin: '0 auto',
    padding: '20px 24px 40px',
    display: 'flex',
    flexDirection: 'column',
    gap: 16,
    width: '100%',
    boxSizing: 'border-box',
  },
  card: {
    background: c.surface,
    border: `1px solid ${c.border}`,
    borderRadius: radius.lg,
    boxShadow: shadow.xs,
    overflow: 'hidden',
    minWidth: 0,
  },
  cardHeader: {
    padding: '16px 20px 14px',
    borderBottom: `1px solid ${c.borderSubtle}`,
  },
  cardTitle: {
    margin: 0,
    fontSize: 14,
    fontWeight: 600,
    color: c.text,
    letterSpacing: '-0.01em',
  },
  cardBody: {
    padding: '16px 20px 20px',
  },
  propGrid: {
    margin: 0,
    padding: '4px 8px 12px',
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
    gap: 0,
  },
  propCell: {
    padding: '12px 12px',
    minWidth: 0,
  },
  propLabel: {
    margin: 0,
    fontSize: 11,
    fontWeight: 500,
    color: c.textMuted,
    letterSpacing: '0.02em',
    textTransform: 'uppercase' as const,
  },
  propValue: {
    margin: '6px 0 0',
    fontSize: 13.5,
    fontWeight: 500,
    color: c.text,
    display: 'flex',
    alignItems: 'center',
    minHeight: 22,
  },
  propValueMono: {
    margin: '6px 0 0',
    fontSize: 13.5,
    fontWeight: 500,
    color: c.text,
    fontFamily: font.mono,
    fontVariantNumeric: 'tabular-nums',
    minHeight: 22,
  },
  propHint: {
    color: c.textMuted,
    fontWeight: 400,
  },
  bannerWarn: {
    margin: '0 16px 16px',
    padding: '12px 14px',
    borderRadius: radius.md,
    background: c.warningBg,
    border: `1px solid ${c.warning}35`,
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  },
  bannerError: {
    margin: '0 16px 16px',
    padding: '12px 14px',
    borderRadius: radius.md,
    background: c.dangerBg,
    border: `1px solid ${c.danger}25`,
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  },
  bannerTitle: {
    fontSize: 12.5,
    fontWeight: 600,
    color: c.text,
  },
  bannerBody: {
    fontSize: 12.5,
    lineHeight: 1.45,
    color: c.textSecondary,
    overflowWrap: 'break-word',
  },
};
