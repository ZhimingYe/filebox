import type { AgentInfo } from '../api/client';
import { c, radius, font, shadow } from '../theme';

interface Props {
  agents: AgentInfo[];
  isMobile: boolean;
  /** Open the sidebar drawer (mobile). Ignored on desktop. */
  onOpenSidebar?: () => void;
  onSelectAgent: (id: string) => void;
}

function statusPresentation(status: string): { label: string; color: string } {
  if (status === 'online') return { label: 'Online', color: c.success };
  if (status === 'slow') return { label: 'Slow', color: c.warning };
  return { label: 'Offline', color: c.textMuted };
}

/** Simple machine / plug illustration — stroke icon, no emoji. */
function IconAgentHero() {
  return (
    <svg
      width="40"
      height="40"
      viewBox="0 0 40 40"
      fill="none"
      aria-hidden
      style={{ display: 'block' }}
    >
      <rect
        x="8"
        y="10"
        width="24"
        height="18"
        rx="3"
        stroke="currentColor"
        strokeWidth="1.6"
      />
      <path
        d="M14 10V8a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v2"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <circle cx="16" cy="19" r="1.4" fill="currentColor" />
      <circle cx="24" cy="19" r="1.4" fill="currentColor" />
      <path
        d="M15 24h10"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <path
        d="M20 28v3M16 31h8"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * Main-area empty state when no agent is selected.
 * Commercial products never leave a blank pane with a single muted line —
 * they explain context, show next steps, and (when possible) let the user
 * act without hunting the sidebar.
 */
export function NoAgentSelected({
  agents,
  isMobile,
  onOpenSidebar,
  onSelectAgent,
}: Props) {
  const hasAgents = agents.length > 0;
  const onlineCount = agents.filter((a) => a.status === 'online' || a.status === 'slow').length;

  return (
    <div style={styles.page}>
      <div style={styles.card}>
        <div style={styles.iconWrap}>
          <span style={styles.icon}>
            <IconAgentHero />
          </span>
        </div>

        {hasAgents ? (
          <>
            <h2 style={styles.title}>Select an agent</h2>
            <p style={styles.subtitle}>
              {onlineCount > 0
                ? `${agents.length} machine${agents.length === 1 ? '' : 's'} available — pick one to browse files and system stats.`
                : `${agents.length} agent${agents.length === 1 ? '' : 's'} registered, but none are online right now. You can still open Settings when one reconnects.`}
            </p>

            <ul style={styles.agentList} aria-label="Available agents">
              {agents.map((a) => {
                const st = statusPresentation(a.status);
                return (
                  <li key={a.id}>
                    <button
                      type="button"
                      onClick={() => onSelectAgent(a.id)}
                      style={styles.agentRow}
                    >
                      <span
                        style={{ ...styles.agentDot, background: st.color }}
                        aria-hidden
                      />
                      <span style={styles.agentName}>{a.name}</span>
                      <span style={{ ...styles.agentStatus, color: st.color }}>
                        {st.label}
                      </span>
                      {a.rtt_ms !== null && (
                        <span style={styles.agentMeta}>{a.rtt_ms} ms</span>
                      )}
                      <span style={styles.agentChevron} aria-hidden>
                        →
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>

            {isMobile && onOpenSidebar && (
              <button
                type="button"
                onClick={onOpenSidebar}
                style={styles.secondaryBtn}
              >
                Or open the sidebar
              </button>
            )}
          </>
        ) : (
          <>
            <h2 style={styles.title}>No agents connected</h2>
            <p style={styles.subtitle}>
              Filebox shows remote machines that have dialed out to this hub.
              Once an agent is running, it appears here and in the sidebar.
            </p>

            <ol style={styles.steps}>
              <li style={styles.step}>
                <span style={styles.stepNum}>1</span>
                <span style={styles.stepBody}>
                  <strong style={styles.stepStrong}>Start an agent</strong>
                  {' '}on the machine you want to browse, pointed at this hub
                  with a valid agent token.
                </span>
              </li>
              <li style={styles.step}>
                <span style={styles.stepNum}>2</span>
                <span style={styles.stepBody}>
                  <strong style={styles.stepStrong}>Wait for connect</strong>
                  {' '}— agents reconnect automatically; the list updates live.
                </span>
              </li>
              <li style={styles.step}>
                <span style={styles.stepNum}>3</span>
                <span style={styles.stepBody}>
                  <strong style={styles.stepStrong}>Select it</strong>
                  {' '}to open files, roots, and system stats.
                </span>
              </li>
            </ol>

            {isMobile && onOpenSidebar && (
              <button
                type="button"
                onClick={onOpenSidebar}
                style={styles.primaryBtn}
              >
                Open sidebar
              </button>
            )}

            <p style={styles.footnote}>
              Agents connect outbound over WebSocket — no inbound ports or VPN
              required on the remote host.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '24px 20px',
    background: c.bgSubtle,
    overflow: 'auto',
    fontFamily: font.sans,
  },
  card: {
    width: '100%',
    maxWidth: 440,
    background: c.surface,
    border: `1px solid ${c.border}`,
    borderRadius: radius.lg,
    boxShadow: shadow.sm,
    padding: '28px 24px 24px',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'stretch',
    gap: 0,
  },
  iconWrap: {
    display: 'flex',
    justifyContent: 'center',
    marginBottom: 16,
  },
  icon: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 64,
    height: 64,
    borderRadius: radius.lg,
    background: c.accentBg,
    color: c.accent,
  },
  title: {
    margin: 0,
    fontSize: 17,
    fontWeight: 600,
    color: c.text,
    textAlign: 'center',
    letterSpacing: '-0.02em',
  },
  subtitle: {
    margin: '8px 0 0',
    fontSize: 13.5,
    lineHeight: 1.5,
    color: c.textSecondary,
    textAlign: 'center',
  },

  agentList: {
    listStyle: 'none',
    margin: '20px 0 0',
    padding: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  agentRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    width: '100%',
    padding: '11px 12px',
    borderRadius: radius.md,
    border: `1px solid ${c.border}`,
    background: c.bg,
    cursor: 'pointer',
    fontFamily: font.sans,
    textAlign: 'left',
    transition: 'border-color 0.12s, background 0.12s',
  },
  agentDot: {
    width: 8,
    height: 8,
    borderRadius: radius.pill,
    flexShrink: 0,
  },
  agentName: {
    flex: 1,
    minWidth: 0,
    fontSize: 13.5,
    fontWeight: 600,
    color: c.text,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  agentStatus: {
    fontSize: 12,
    fontWeight: 500,
    flexShrink: 0,
  },
  agentMeta: {
    fontSize: 11.5,
    fontFamily: font.mono,
    color: c.textMuted,
    flexShrink: 0,
    fontVariantNumeric: 'tabular-nums',
  },
  agentChevron: {
    color: c.textFaint,
    fontSize: 13,
    flexShrink: 0,
  },

  steps: {
    listStyle: 'none',
    margin: '20px 0 0',
    padding: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
  },
  step: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 12,
  },
  stepNum: {
    flexShrink: 0,
    width: 22,
    height: 22,
    borderRadius: radius.pill,
    background: c.bgMuted,
    color: c.textSecondary,
    fontSize: 11.5,
    fontWeight: 600,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
  },
  stepBody: {
    fontSize: 13,
    lineHeight: 1.45,
    color: c.textSecondary,
    minWidth: 0,
  },
  stepStrong: {
    color: c.text,
    fontWeight: 600,
  },

  primaryBtn: {
    marginTop: 20,
    padding: '10px 16px',
    borderRadius: radius.md,
    border: 'none',
    background: c.accent,
    color: c.onAccent,
    fontSize: 13.5,
    fontWeight: 500,
    fontFamily: font.sans,
    cursor: 'pointer',
    width: '100%',
  },
  secondaryBtn: {
    marginTop: 14,
    padding: '9px 14px',
    borderRadius: radius.md,
    border: `1px solid ${c.border}`,
    background: 'transparent',
    color: c.textSecondary,
    fontSize: 13,
    fontWeight: 500,
    fontFamily: font.sans,
    cursor: 'pointer',
    width: '100%',
  },
  footnote: {
    margin: '18px 0 0',
    fontSize: 12,
    lineHeight: 1.45,
    color: c.textMuted,
    textAlign: 'center',
  },
};
