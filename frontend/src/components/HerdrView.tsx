import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as api from '../api/client';
import { friendlyMessage } from '../api/client';
import { c, font, radius, shadow } from '../theme';
import { useIsMobile } from '../state/useIsMobile';
import { IconChevronLeft, IconRefresh } from './icons';

interface Props {
  agent: api.AgentInfo;
}

const QUICK_KEYS: { label: string; keys: string[] }[] = [
  { label: 'Enter', keys: ['enter'] },
  { label: 'Esc', keys: ['esc'] },
  { label: 'Ctrl+C', keys: ['ctrl+c'] },
  { label: 'Tab', keys: ['tab'] },
  { label: 'Y', keys: ['y'] },
  { label: 'N', keys: ['n'] },
  { label: 'Up', keys: ['up'] },
];

const STATUS_ORDER: Record<api.HerdrAgentStatus, number> = {
  blocked: 0,
  working: 1,
  done: 2,
  idle: 3,
  unknown: 4,
};

function statusMeta(status: api.HerdrAgentStatus): { label: string; color: string; bg: string } {
  switch (status) {
    case 'working':
      return { label: 'Working', color: c.accent, bg: c.accentBg };
    case 'blocked':
      return { label: 'Blocked', color: c.warning, bg: c.warningBg };
    case 'done':
      return { label: 'Done', color: c.success, bg: c.successBg };
    case 'idle':
      return { label: 'Idle', color: c.textSecondary, bg: c.bgMuted };
    default:
      return { label: 'Unknown', color: c.textMuted, bg: c.bgMuted };
  }
}

function displayName(item: api.HerdrAgent): string {
  return item.name?.trim() || item.title?.trim() || item.pane_id || item.target;
}

function sortAgents(items: api.HerdrAgent[]): api.HerdrAgent[] {
  return [...items].sort((a, b) => {
    const d = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
    if (d !== 0) return d;
    return displayName(a).localeCompare(displayName(b));
  });
}

/**
 * Sidebar Herdr panel: list coding agents on the selected backend, read the
 * latest output, send a prompt, and tap keys for blocked approvals. The
 * Filebox agent drives the local `herdr` CLI; this UI is a compact control
 * surface, not a clone of the Herdr TUI.
 */
export function HerdrView({ agent }: Props) {
  const isMobile = useIsMobile();
  const [status, setStatus] = useState<api.HerdrServerStatus | null>(null);
  const [agents, setAgents] = useState<api.HerdrAgent[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [output, setOutput] = useState<string>('');
  const [prompt, setPrompt] = useState('');
  const [wait, setWait] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [loadingList, setLoadingList] = useState(true);
  const [loadingOutput, setLoadingOutput] = useState(false);
  const [sending, setSending] = useState(false);
  const genRef = useRef(0);
  const outputGenRef = useRef(0);
  const abortList = useRef<AbortController | null>(null);
  const abortOutput = useRef<AbortController | null>(null);
  const abortSend = useRef<AbortController | null>(null);
  const outputBoxRef = useRef<HTMLPreElement | null>(null);
  const promptRef = useRef<HTMLTextAreaElement | null>(null);

  const selectedAgent = useMemo(
    () => agents.find((a) => a.target === selected) ?? null,
    [agents, selected],
  );

  const loadList = useCallback(async (silent = false) => {
    const gen = ++genRef.current;
    abortList.current?.abort();
    const controller = new AbortController();
    abortList.current = controller;
    if (!silent) setLoadingList(true);
    try {
      const res = await api.herdrCommand(agent.id, { op: 'status' }, controller.signal, 20_000);
      if (genRef.current !== gen) return;
      setStatus(res.status ?? null);
      setAgents(sortAgents(res.agents ?? []));
      setListError(res.error ? friendlyMessage({ error: res.error }) : null);
    } catch (e) {
      if (genRef.current !== gen) return;
      setListError(friendlyMessage(e));
      const details = e as { error?: string };
      if (details?.error === 'herdr_unavailable') {
        setStatus({
          installed: true,
          reachable: false,
          version: status?.version ?? null,
          message: friendlyMessage(e),
        });
      }
    } finally {
      if (genRef.current === gen) setLoadingList(false);
    }
  }, [agent.id, status?.version]);

  const loadOutput = useCallback(async (target: string, silent = false) => {
    const gen = ++outputGenRef.current;
    abortOutput.current?.abort();
    const controller = new AbortController();
    abortOutput.current = controller;
    if (!silent) setLoadingOutput(true);
    setActionError(null);
    try {
      const res = await api.herdrCommand(
        agent.id,
        { op: 'read', target, lines: 120 },
        controller.signal,
        25_000,
      );
      if (outputGenRef.current !== gen) return;
      setOutput(res.output ?? '');
      if (res.agent) {
        setAgents((prev) => {
          const next = prev.map((a) => (a.target === res.agent!.target || a.pane_id === res.agent!.pane_id ? res.agent! : a));
          return sortAgents(next);
        });
      }
    } catch (e) {
      if (outputGenRef.current !== gen) return;
      setActionError(friendlyMessage(e));
    } finally {
      if (outputGenRef.current === gen) setLoadingOutput(false);
    }
  }, [agent.id]);

  useEffect(() => {
    void loadList(false);
    return () => {
      abortList.current?.abort();
      abortOutput.current?.abort();
      abortSend.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.id]);

  useEffect(() => {
    if (!selected) {
      setOutput('');
      return;
    }
    void loadOutput(selected, false);
  }, [selected, loadOutput]);

  // Live list (and working/blocked output) while this view is open.
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (sending) return;
      void loadList(true);
      if (selectedAgent && (selectedAgent.status === 'working' || selectedAgent.status === 'blocked')) {
        void loadOutput(selectedAgent.target, true);
      }
    }, 8000);
    return () => window.clearInterval(timer);
  }, [loadList, loadOutput, selectedAgent, sending]);

  useEffect(() => {
    const el = outputBoxRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [output]);

  const selectAgent = (target: string) => {
    setSelected(target);
    setActionError(null);
  };

  const sendPrompt = async () => {
    if (!selectedAgent || sending) return;
    const text = prompt.trim();
    if (!text) return;
    abortSend.current?.abort();
    const controller = new AbortController();
    abortSend.current = controller;
    setSending(true);
    setActionError(null);
    try {
      await api.herdrCommand(
        agent.id,
        {
          op: 'prompt',
          target: selectedAgent.target,
          text,
          wait,
          timeout_ms: wait ? 60_000 : undefined,
        },
        controller.signal,
        wait ? 80_000 : 25_000,
      );
      setPrompt('');
      await loadOutput(selectedAgent.target, true);
      await loadList(true);
    } catch (e) {
      setActionError(friendlyMessage(e));
      void loadOutput(selectedAgent.target, true);
    } finally {
      setSending(false);
    }
  };

  const sendKeys = async (keys: string[]) => {
    if (!selectedAgent || sending) return;
    abortSend.current?.abort();
    const controller = new AbortController();
    abortSend.current = controller;
    setSending(true);
    setActionError(null);
    try {
      await api.herdrCommand(
        agent.id,
        { op: 'send_keys', target: selectedAgent.target, keys },
        controller.signal,
        15_000,
      );
      await loadOutput(selectedAgent.target, true);
      await loadList(true);
    } catch (e) {
      setActionError(friendlyMessage(e));
    } finally {
      setSending(false);
    }
  };

  const reachable = status?.reachable === true;
  const showDetail = !!selectedAgent && (!isMobile || selected !== null);
  const showList = !isMobile || !selectedAgent;

  return (
    <div style={styles.page}>
      <header style={styles.header}>
        <div style={styles.headerText}>
          <div style={styles.titleRow}>
            {isMobile && selectedAgent && (
              <button
                type="button"
                onClick={() => setSelected(null)}
                style={styles.backBtn}
                aria-label="Back to agent list"
              >
                <IconChevronLeft />
              </button>
            )}
            <h1 style={styles.title}>
              {isMobile && selectedAgent ? displayName(selectedAgent) : 'Herdr'}
            </h1>
            {!selectedAgent && (
              <span style={styles.countChip}>{agents.length}</span>
            )}
          </div>
          <p style={styles.subtitle}>
            {status?.reachable
              ? (status.version ? `Herdr ${status.version} on this backend` : 'Herdr is running on this backend')
              : status?.installed
                ? 'Herdr is installed, but the server is not running'
                : loadingList
                  ? 'Checking Herdr on this backend…'
                  : 'Could not reach Herdr on this backend'}
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            void loadList(false);
            if (selectedAgent) void loadOutput(selectedAgent.target, false);
          }}
          style={styles.iconBtn}
          title="Refresh"
          aria-label="Refresh"
          disabled={loadingList || sending}
        >
          <IconRefresh />
        </button>
      </header>

      {listError && reachable && (
        <div style={styles.banner}>{listError}</div>
      )}

      <div style={isMobile ? styles.bodyMobile : styles.bodyDesktop}>
        {showList && (
          <aside style={isMobile ? styles.listMobile : styles.listDesktop} aria-label="Herdr agents">
            {loadingList && agents.length === 0 ? (
              <div style={styles.empty}>Looking for agents…</div>
            ) : !reachable ? (
              <div style={styles.emptyCard}>
                <div style={styles.emptyTitle}>Herdr is not running</div>
                <p style={styles.emptyText}>
                  Start Herdr on this backend with <span style={styles.inlineCode}>herdr</span> or{' '}
                  <span style={styles.inlineCode}>herdr server</span>, then refresh. Filebox only talks to the local CLI — never to agents on other machines.
                </p>
                <button type="button" style={styles.primaryBtn} onClick={() => void loadList(false)}>
                  Check again
                </button>
              </div>
            ) : agents.length === 0 ? (
              <div style={styles.emptyCard}>
                <div style={styles.emptyTitle}>No agents running</div>
                <p style={styles.emptyText}>
                  Start a coding agent inside Herdr on this machine. Filebox will list it here so you can read output and send a prompt from your phone.
                </p>
              </div>
            ) : (
              agents.map((item) => {
                const meta = statusMeta(item.status);
                const active = item.target === selected;
                return (
                  <button
                    key={item.target}
                    type="button"
                    onClick={() => selectAgent(item.target)}
                    style={{
                      ...styles.card,
                      ...(active ? styles.cardActive : null),
                    }}
                  >
                    <span style={{ ...styles.dot, background: meta.color }} />
                    <span style={styles.cardBody}>
                      <span style={styles.cardName}>{displayName(item)}</span>
                      <span style={styles.cardMeta}>
                        {item.kind || 'agent'}
                        {item.cwd ? ` · ${item.cwd}` : item.pane_id ? ` · ${item.pane_id}` : ''}
                      </span>
                    </span>
                    <span style={{ ...styles.badge, color: meta.color, background: meta.bg }}>
                      {meta.label}
                    </span>
                  </button>
                );
              })
            )}
          </aside>
        )}

        {showDetail && selectedAgent && (
          <section style={styles.detail}>
            {!isMobile && (
              <div style={styles.detailHead}>
                <div>
                  <div style={styles.detailName}>{displayName(selectedAgent)}</div>
                  <div style={styles.detailMeta}>
                    {selectedAgent.kind || 'agent'} · {selectedAgent.pane_id}
                    {selectedAgent.cwd ? ` · ${selectedAgent.cwd}` : ''}
                  </div>
                </div>
                <span
                  style={{
                    ...styles.badge,
                    color: statusMeta(selectedAgent.status).color,
                    background: statusMeta(selectedAgent.status).bg,
                  }}
                >
                  {statusMeta(selectedAgent.status).label}
                </span>
              </div>
            )}

            {actionError && <div style={styles.actionError}>{actionError}</div>}

            <pre ref={outputBoxRef} style={styles.output} aria-live="polite">
              {loadingOutput && !output
                ? 'Reading latest output…'
                : output || 'No output yet. Send a prompt or wait for the agent to write.'}
            </pre>

            <div style={styles.composer}>
              <div style={styles.keyRow}>
                {QUICK_KEYS.map((k) => (
                  <button
                    key={k.label}
                    type="button"
                    disabled={sending}
                    onClick={() => void sendKeys(k.keys)}
                    style={styles.keyChip}
                  >
                    {k.label}
                  </button>
                ))}
              </div>
              <textarea
                ref={promptRef}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="Send a prompt to this agent"
                rows={isMobile ? 3 : 4}
                disabled={sending}
                style={styles.textarea}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                    e.preventDefault();
                    void sendPrompt();
                  }
                }}
              />
              <div style={styles.composerBar}>
                <label style={styles.waitLabel}>
                  <input
                    type="checkbox"
                    checked={wait}
                    onChange={(e) => setWait(e.target.checked)}
                    disabled={sending}
                  />
                  Wait until idle
                </label>
                <button
                  type="button"
                  onClick={() => void sendPrompt()}
                  disabled={sending || !prompt.trim()}
                  style={{
                    ...styles.primaryBtn,
                    ...((sending || !prompt.trim()) ? styles.primaryBtnDisabled : null),
                  }}
                >
                  {sending ? (wait ? 'Waiting…' : 'Sending…') : 'Send'}
                </button>
              </div>
            </div>
          </section>
        )}

        {!isMobile && !selectedAgent && reachable && agents.length > 0 && (
          <section style={styles.detailEmpty}>
            <div style={styles.emptyTitle}>Select an agent</div>
            <p style={styles.emptyText}>
              Read the latest output, send a prompt, or tap a key for an approval dialog.
            </p>
          </section>
        )}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    flex: 1,
    minHeight: 0,
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    background: c.bg,
  },
  header: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
    padding: '16px 20px 12px',
    borderBottom: `1px solid ${c.border}`,
    background: c.bgSubtle,
  },
  headerText: { minWidth: 0, flex: 1 },
  titleRow: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 },
  title: {
    margin: 0,
    fontSize: 16,
    fontWeight: 600,
    color: c.text,
    fontFamily: font.sans,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  countChip: {
    minWidth: 20,
    height: 20,
    padding: '0 6px',
    borderRadius: radius.pill,
    background: c.accentBg,
    color: c.accent,
    fontSize: 11,
    fontWeight: 600,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  subtitle: {
    margin: '4px 0 0',
    fontSize: 12,
    color: c.textMuted,
    fontFamily: font.sans,
  },
  backBtn: {
    border: 'none',
    background: 'transparent',
    color: c.textSecondary,
    padding: 4,
    marginLeft: -4,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
  },
  iconBtn: {
    border: `1px solid ${c.border}`,
    background: c.surface,
    color: c.textSecondary,
    width: 32,
    height: 32,
    borderRadius: radius.md,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  banner: {
    margin: '12px 20px 0',
    padding: '10px 12px',
    borderRadius: radius.md,
    background: c.warningBg,
    color: c.text,
    fontSize: 13,
    border: `1px solid ${c.border}`,
  },
  bodyDesktop: {
    flex: 1,
    minHeight: 0,
    display: 'flex',
  },
  bodyMobile: {
    flex: 1,
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
  },
  listDesktop: {
    width: 280,
    flexShrink: 0,
    overflow: 'auto',
    borderRight: `1px solid ${c.border}`,
    padding: 12,
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    background: c.bgSubtle,
  },
  listMobile: {
    flex: 1,
    minHeight: 0,
    overflow: 'auto',
    padding: 12,
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  card: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    textAlign: 'left',
    width: '100%',
    padding: '12px 12px',
    minHeight: 52,
    borderRadius: radius.md,
    border: `1px solid ${c.border}`,
    background: c.surface,
    cursor: 'pointer',
    fontFamily: font.sans,
    boxShadow: shadow.xs,
  },
  cardActive: {
    borderColor: c.accent,
    background: c.accentBg,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: radius.pill,
    flexShrink: 0,
  },
  cardBody: {
    flex: 1,
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
  },
  cardName: {
    fontSize: 13,
    fontWeight: 600,
    color: c.text,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  cardMeta: {
    fontSize: 11,
    color: c.textMuted,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  badge: {
    flexShrink: 0,
    fontSize: 10,
    fontWeight: 600,
    letterSpacing: 0.02,
    padding: '3px 7px',
    borderRadius: radius.pill,
    textTransform: 'uppercase',
  },
  empty: {
    padding: 24,
    textAlign: 'center',
    color: c.textMuted,
    fontSize: 13,
  },
  emptyCard: {
    padding: 20,
    borderRadius: radius.lg,
    border: `1px solid ${c.border}`,
    background: c.surface,
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
  },
  emptyTitle: {
    fontSize: 14,
    fontWeight: 600,
    color: c.text,
  },
  emptyText: {
    margin: 0,
    fontSize: 13,
    color: c.textSecondary,
    lineHeight: 1.5,
  },
  inlineCode: {
    fontFamily: font.mono,
    fontSize: 12,
    background: c.bgMuted,
    padding: '1px 5px',
    borderRadius: radius.sm,
  },
  detail: {
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
  },
  detailEmpty: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    padding: 32,
    color: c.textMuted,
  },
  detailHead: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    padding: '12px 16px',
    borderBottom: `1px solid ${c.border}`,
  },
  detailName: {
    fontSize: 14,
    fontWeight: 600,
    color: c.text,
  },
  detailMeta: {
    marginTop: 2,
    fontSize: 11,
    color: c.textMuted,
    fontFamily: font.mono,
  },
  actionError: {
    margin: '8px 16px 0',
    padding: '8px 10px',
    borderRadius: radius.md,
    background: c.dangerBg,
    color: c.danger,
    fontSize: 12,
  },
  output: {
    flex: 1,
    minHeight: 120,
    margin: 0,
    padding: 16,
    overflow: 'auto',
    background: c.bgSubtle,
    color: c.text,
    fontFamily: font.mono,
    fontSize: 12,
    lineHeight: 1.55,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    borderBottom: `1px solid ${c.border}`,
  },
  composer: {
    padding: 12,
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    background: c.surface,
    borderTop: `1px solid ${c.border}`,
  },
  keyRow: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 6,
  },
  keyChip: {
    minHeight: 36,
    padding: '0 12px',
    borderRadius: radius.md,
    border: `1px solid ${c.border}`,
    background: c.bgMuted,
    color: c.text,
    fontSize: 12,
    fontFamily: font.mono,
    cursor: 'pointer',
  },
  textarea: {
    width: '100%',
    resize: 'vertical',
    minHeight: 72,
    padding: '10px 12px',
    borderRadius: radius.md,
    border: `1px solid ${c.border}`,
    background: c.bg,
    color: c.text,
    fontFamily: font.sans,
    fontSize: 14,
    lineHeight: 1.45,
    boxSizing: 'border-box',
  },
  composerBar: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  waitLabel: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    fontSize: 12,
    color: c.textSecondary,
    fontFamily: font.sans,
    minHeight: 36,
  },
  primaryBtn: {
    minHeight: 40,
    padding: '0 16px',
    borderRadius: radius.md,
    border: 'none',
    background: c.accent,
    color: c.onAccent,
    fontSize: 13,
    fontWeight: 600,
    fontFamily: font.sans,
    cursor: 'pointer',
  },
  primaryBtnDisabled: {
    opacity: 0.55,
    cursor: 'default',
  },
};
