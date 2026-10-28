import { useEffect, useState } from 'react';
import type { AgentInfo } from '../api/client';
import { setHerdrEnabled } from '../api/client';
import { RootManager } from './RootManager';
import {
  readOfficePdfPreviewPref,
  writeOfficePdfPreviewPref,
} from './officePreviewSupport';
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
  const officeCapable = !!agent.capabilities?.office_pdf_preview;
  const herdrConfigurable = !!agent.capabilities?.herdr_settings;
  const herdrEnabled = herdrConfigurable ? !!agent.capabilities?.herdr_enabled : !!agent.capabilities?.herdr;
  const herdrLocked = !!agent.capabilities?.herdr_locked;
  const [savingHerdr, setSavingHerdr] = useState(false);
  const [herdrError, setHerdrError] = useState<string | null>(null);
  // Local clock so "Last seen" stays honest while the page is open without a
  // hub refresh. 30s is enough for "just now" / "Xm ago" granularity.
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [officePdfPreview, setOfficePdfPreview] = useState(() => readOfficePdfPreviewPref());
  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  function toggleOfficePdfPreview() {
    // Preference is browser-local and always editable — including when this
    // agent has no LibreOffice — so users can opt out without being nudged.
    const next = !officePdfPreview;
    writeOfficePdfPreviewPref(next);
    setOfficePdfPreview(next);
  }

  async function toggleHerdr() {
    if (savingHerdr || herdrLocked || agent.status === 'offline') return;
    setSavingHerdr(true);
    setHerdrError(null);
    try {
      await setHerdrEnabled(agent.id, !herdrEnabled);
      await onRefresh();
    } catch (error) {
      setHerdrError(error instanceof Error ? error.message : 'Could not save Herdr settings. Please retry.');
    } finally {
      setSavingHerdr(false);
    }
  }

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

          {/* ── Preview preferences ────────────────────────────────────── */}
          <section style={styles.card} aria-labelledby="settings-preview-title">
            <div style={styles.cardHeader}>
              <h3 id="settings-preview-title" style={styles.cardTitle}>
                Preview
              </h3>
            </div>
            <div style={styles.prefRow}>
              <div style={styles.prefText}>
                <div style={styles.prefLabel}>Office preview</div>
                <p style={styles.prefHint}>
                  {officeCapable
                    ? 'Optional. Word and PowerPoint open as PDF; spreadsheets open as per-sheet CSV. Leave off to download originals only.'
                    : 'Optional. This agent has no LibreOffice for conversion — download still works. The switch only affects agents that support preview.'}
                </p>
                {!officeCapable && (
                  <p style={{ ...styles.prefHint, marginTop: 6, color: c.textMuted }}>
                    Operator note: point the agent at soffice via FILEBOX_AGENT_SOFFICE if you want preview later.
                  </p>
                )}
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={officePdfPreview}
                aria-label="Office preview"
                onClick={toggleOfficePdfPreview}
                style={{
                  ...styles.switchTrack,
                  ...(officePdfPreview ? styles.switchTrackOn : null),
                  // Dim when the preference cannot apply to this agent.
                  ...(!officeCapable ? { opacity: 0.72 } : null),
                }}
              >
                <span
                  style={{
                    ...styles.switchThumb,
                    ...(officePdfPreview ? styles.switchThumbOn : null),
                  }}
                />
              </button>
            </div>
          </section>

          <section style={styles.card} aria-labelledby="settings-coding-agents-title">
            <div style={styles.cardHeader}>
              <h3 id="settings-coding-agents-title" style={styles.cardTitle}>
                Coding agents
              </h3>
            </div>
            <div style={styles.prefRow}>
              <div style={styles.prefText}>
                <div style={{ ...styles.prefLabel, display: 'flex', justifyContent: 'space-between', gap: 16 }}>
                  <span>Herdr</span>
                  <span style={{ color: agent.capabilities?.herdr ? c.success : c.textMuted, fontSize: 12, fontWeight: 400 }}>
                    {herdrConfigurable && !herdrEnabled ? 'Disabled' : agent.capabilities?.herdr ? 'Available' : 'Not available'}
                  </span>
                </div>
                <p style={styles.prefHint}>View coding agents, read their output, and send prompts through Herdr on this backend.</p>
                <p style={{ ...styles.prefHint, overflowWrap: 'anywhere' }}>
                  {herdrConfigurable
                    ? herdrLocked
                      ? <>Controlled by <code>FILEBOX_AGENT_HERDR_ENABLED</code>. Remove that override and restart the Filebox Agent to use this switch.</>
                      : <>Saved as <code>herdr_enabled</code> in the Agent’s <code>agent.toml</code>. Applies immediately to all browsers. Turning it off stops Filebox monitoring and controls, not your running coding agents.</>
                    : <>Update the Filebox Agent to use this switch. For older Agents, set <code>FILEBOX_AGENT_HERDR_ENABLED=0</code> and restart to disable Herdr.</>}
                </p>
                {herdrConfigurable && !herdrLocked && !agent.capabilities?.herdr && herdrEnabled && (
                  <p style={styles.prefHint}>Herdr is not detected. Open Herdr in the sidebar for an introduction and setup instructions.</p>
                )}
                {agent.status === 'offline' && <p style={styles.prefHint}>Reconnect this backend to change its settings.</p>}
                {savingHerdr && <p style={styles.prefHint} role="status">Saving Herdr settings…</p>}
                {herdrError && <p style={{ ...styles.prefHint, color: c.danger }} role="alert">{herdrError}</p>}
              </div>
              <button type="button" role="switch" aria-label="Herdr integration" aria-checked={herdrEnabled}
                disabled={!herdrConfigurable || herdrLocked || savingHerdr || agent.status === 'offline'}
                onClick={toggleHerdr}
                style={{ ...styles.switchTrack, ...(herdrEnabled ? styles.switchTrackOn : null),
                  ...(!herdrConfigurable || herdrLocked || savingHerdr || agent.status === 'offline' ? { opacity: 0.5, cursor: 'default' } : null) }}>
                <span style={{ ...styles.switchThumb, ...(herdrEnabled ? styles.switchThumbOn : null) }} />
              </button>
            </div>
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
  prefRow: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 16,
    padding: '16px 20px 18px',
  },
  prefText: {
    minWidth: 0,
    flex: 1,
  },
  prefLabel: {
    fontSize: 13.5,
    fontWeight: 500,
    color: c.text,
  },
  prefHint: {
    margin: '6px 0 0',
    fontSize: 12.5,
    lineHeight: 1.45,
    color: c.textSecondary,
  },
  switchTrack: {
    position: 'relative' as const,
    width: 40,
    height: 22,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: c.border,
    background: c.bgMuted,
    cursor: 'pointer',
    flexShrink: 0,
    padding: 0,
    transition: 'background 0.15s, border-color 0.15s',
  },
  switchTrackOn: {
    background: c.accent,
    borderColor: c.accent,
  },
  switchThumb: {
    position: 'absolute' as const,
    top: 2,
    left: 2,
    width: 16,
    height: 16,
    borderRadius: radius.pill,
    background: c.surface,
    boxShadow: shadow.xs,
    transition: 'transform 0.15s',
  },
  switchThumbOn: {
    transform: 'translateX(18px)',
  },
};
