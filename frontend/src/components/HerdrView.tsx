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
  { label: 'Down', keys: ['down'] },
  { label: 'Left', keys: ['left'] },
  { label: 'Right', keys: ['right'] },
  { label: 'Shift+Tab', keys: ['shift+tab'] },
];

const PROMPT_MAX_BYTES = 32 * 1024;

function outputSignature(item: api.HerdrAgent): string {
  return `${item.target}\0${item.status}\0${item.completion_seq ?? ''}`;
}

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

function errorCode(error: unknown): string {
  if (!error || typeof error !== 'object') return '';
  const raw = (error as { error?: unknown }).error;
  if (typeof raw !== 'string') return '';
  return raw.includes(':') ? raw.split(':')[0] : raw;
}

function isAbortError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && (error as { name?: string }).name === 'AbortError';
}

/** Null means the failure should stay quiet (abort, or a superseded request). */
function herdrFailureMessage(error: unknown): string | null {
  if (isAbortError(error)) return null;
  if (errorCode(error) === 'invalid_request') {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return message.trim();
  }
  return friendlyMessage(error);
}

/**
 * Sidebar Herdr panel: list coding agents on the selected backend, read the
 * latest output, send a prompt, and tap keys for blocked approvals. The
 * Filebox agent drives the local `herdr` CLI; this UI is a compact control
 * surface, not a clone of the Herdr TUI.
 */
export function HerdrView({ agent }: Props) {
  const isMobile = useIsMobile();
  const isMobileRef = useRef(isMobile);
  isMobileRef.current = isMobile;
  const [status, setStatus] = useState<api.HerdrServerStatus | null>(null);
  const [agents, setAgents] = useState<api.HerdrAgent[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [output, setOutput] = useState<string>('');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const prompt = selected ? drafts[selected] ?? '' : '';
  const promptBytes = new TextEncoder().encode(prompt.trim()).length;
  const [wait, setWait] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [outputError, setOutputError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [wrapOutput, setWrapOutput] = useState(true);
  const [elapsed, setElapsed] = useState(0);
  const [actionTarget, setActionTarget] = useState('');
  const [loadingList, setLoadingList] = useState(true);
  const [loadingOutput, setLoadingOutput] = useState(false);
  const [sending, setSending] = useState(false);
  const genRef = useRef(0);
  const mountedRef = useRef(true);
  const outputGenRef = useRef(0);
  const abortList = useRef<AbortController | null>(null);
  const abortOutput = useRef<AbortController | null>(null);
  const abortSend = useRef<AbortController | null>(null);
  const outputBoxRef = useRef<HTMLPreElement | null>(null);
  const promptRef = useRef<HTMLTextAreaElement | null>(null);
  const tailRef = useRef<Promise<unknown>>(Promise.resolve());
  const sendingRef = useRef(false);
  const selectedRef = useRef<string | null>(null);
  const refreshScheduled = useRef(false);
  const versionRef = useRef<string | null>(null);
  const agentsRef = useRef(agents);
  const stickToBottomRef = useRef(true);
  // Last target+status refreshed by the poll. User input invalidates it so
  // even a turn that finishes between ticks gets a final successful read.
  const seenPollRef = useRef<string | null>(null);
  versionRef.current = status?.version ?? null;
  selectedRef.current = selected;
  agentsRef.current = agents;

  const enqueue = useCallback((task: () => Promise<unknown>) => {
    const guarded = () => mountedRef.current ? task() : undefined;
    const run = tailRef.current.then(guarded, guarded);
    tailRef.current = run.then(() => undefined, () => undefined);
    return run;
  }, []);

  const selectedAgent = useMemo(
    () => agents.find((a) => a.target === selected) ?? null,
    [agents, selected],
  );

  const loadList = useCallback(async (silent = false) => {
    if (!mountedRef.current) return;
    const gen = ++genRef.current;
    abortList.current?.abort();
    const controller = new AbortController();
    abortList.current = controller;
    if (!silent) setLoadingList(true);
    try {
      const res = await api.herdrCommand(agent.id, { op: 'status' }, controller.signal, 20_000);
      if (!mountedRef.current || controller.signal.aborted || genRef.current !== gen) return;
      const next = sortAgents(res.agents ?? []);
      setStatus(res.status ?? null);
      setAgents(next);
      agentsRef.current = next;
      setListError(res.error ? friendlyMessage({ error: res.error }) : null);
      setSelected((prev) => {
        if (prev && next.some((a) => a.target === prev)) return prev;
        // Desktop lands on the highest-priority agent so output is visible.
        // Mobile stays on the list until the user taps a card.
        if (isMobileRef.current) return null;
        return next[0]?.target ?? null;
      });
    } catch (e) {
      if (genRef.current !== gen) return;
      const message = herdrFailureMessage(e);
      if (message === null) return;
      if (silent && errorCode(e) === 'agent_busy') return;
      setListError(message);
      if (errorCode(e) === 'herdr_unavailable') {
        setStatus({
          installed: true,
          reachable: false,
          version: versionRef.current,
          message,
        });
        setAgents([]);
        agentsRef.current = [];
      }
    } finally {
      if (genRef.current === gen) setLoadingList(false);
    }
  }, [agent.id]);

  const loadOutput = useCallback(async (target: string, silent = false) => {
    if (!mountedRef.current || selectedRef.current !== target) return;
    const gen = ++outputGenRef.current;
    abortOutput.current?.abort();
    const controller = new AbortController();
    abortOutput.current = controller;
    setLoadingOutput(true);
    if (!silent) setOutputError(null);
    try {
      const res = await api.herdrCommand(
        agent.id,
        { op: 'read', target, lines: 120 },
        controller.signal,
        25_000,
      );
      if (!mountedRef.current || controller.signal.aborted || outputGenRef.current !== gen || selectedRef.current !== target) return;
      setOutput(res.output ?? '');
      setOutputError(null);
      setUpdatedAt(Date.now());
      if (res.agent) {
        setAgents((prev) => {
          const next = prev.map((a) => (a.target === res.agent!.target || a.pane_id === res.agent!.pane_id ? res.agent! : a));
          return sortAgents(next);
        });
      }
      return true;
    } catch (e) {
      if (outputGenRef.current !== gen || selectedRef.current !== target) return;
      const message = herdrFailureMessage(e);
      if (message === null) return;
      if (silent && (errorCode(e) === 'agent_busy' || errorCode(e) === 'herdr_not_idle')) return;
      setOutputError(message);
    } finally {
      if (outputGenRef.current === gen) setLoadingOutput(false);
    }
  }, [agent.id]);

  useEffect(() => {
    mountedRef.current = true;
    void enqueue(() => loadList(false));
    return () => {
      mountedRef.current = false;
      abortList.current?.abort();
      abortOutput.current?.abort();
      abortSend.current?.abort();
    };
  }, [agent.id, enqueue, loadList]);

  useEffect(() => {
    // Invalidate an in-flight read before it can paint the previous agent
    // under this header. The generation bump wins even if the response
    // arrives before the abort is observed.
    outputGenRef.current += 1;
    abortOutput.current?.abort();
    stickToBottomRef.current = true;
    setUpdatedAt(null);
    setOutputError(null);
    setActionNotice(null);
    setLoadingOutput(false);
    if (!selected) {
      seenPollRef.current = null;
      setOutput('');
      return;
    }
    const item = agentsRef.current.find((a) => a.target === selected);
    seenPollRef.current = null;
    setOutput('');
    setActionError(null);
    let current = true;
    void enqueue(async () => {
      if (!current) return;
      if (await loadOutput(selected, false) && current && !sendingRef.current) {
        seenPollRef.current = item ? outputSignature(item) : null;
      }
    });
    return () => { current = false; };
  }, [selected, loadOutput, enqueue]);

  // Live list (and working/blocked output) while this view is open.
  // One refresh at a time, and never alongside a user send — the agent
  // only runs a couple of Herdr commands at once.
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (sendingRef.current || refreshScheduled.current) return;
      refreshScheduled.current = true;
      void enqueue(async () => {
        try {
          if (sendingRef.current) return;
          await loadList(true);
          const target = selectedRef.current;
          const item = agentsRef.current.find((a) => a.target === target);
          if (!item || sendingRef.current) return;
          const signature = outputSignature(item);
          const statusChanged = seenPollRef.current !== signature;
          // Keep reading while a turn is in progress, and once more when it
          // finishes, so the idle card does not keep the mid-turn transcript.
          if (
            statusChanged
            || item.status === 'working'
            || item.status === 'blocked'
          ) {
            if (await loadOutput(item.target, true) && !sendingRef.current) {
              seenPollRef.current = signature;
            }
          }
        } finally {
          refreshScheduled.current = false;
        }
      });
    }, 8000);
    return () => window.clearInterval(timer);
  }, [enqueue, loadList, loadOutput]);

  useEffect(() => {
    const el = outputBoxRef.current;
    if (!el || !stickToBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [output]);

  useEffect(() => {
    if (!sending) return;
    const started = Date.now();
    setElapsed(0);
    const timer = window.setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [sending]);

  const selectAgent = (target: string) => {
    setSelected(target);
    setActionError(null);
  };

  const runCommand = async (
    body: api.HerdrCommandBody,
    signal: AbortSignal,
    timeoutMs: number,
  ) => {
    try {
      return await api.herdrCommand(agent.id, body, signal, timeoutMs);
    } catch (e) {
      if (isAbortError(e) || errorCode(e) !== 'agent_busy') throw e;
      await new Promise((resolve) => window.setTimeout(resolve, 300));
      if (signal.aborted) throw e;
      return api.herdrCommand(agent.id, body, signal, timeoutMs);
    }
  };

  const beginUserAction = () => {
    seenPollRef.current = null;
    // Drop in-flight list/read so a Send is not rejected as agent_busy.
    abortList.current?.abort();
    abortOutput.current?.abort();
    sendingRef.current = true;
    setSending(true);
    setActionError(null);
    setActionNotice(null);
    setActionTarget(selectedAgent ? displayName(selectedAgent) : 'agent');
  };

  const stopWaiting = () => {
    abortSend.current?.abort();
    abortOutput.current?.abort();
    abortList.current?.abort();
    setActionNotice('Stopped waiting. Already submitted input may still be running; refresh the output before retrying.');
  };

  const sendPrompt = () => {
    if (!selectedAgent || sendingRef.current) return;
    const text = prompt.trim();
    if (!text || promptBytes > PROMPT_MAX_BYTES || selectedAgent.status === 'blocked') return;
    const target = selectedAgent.target;
    beginUserAction();
    abortSend.current?.abort();
    const controller = new AbortController();
    abortSend.current = controller;
    void enqueue(async () => {
      try {
        const res = await runCommand(
          {
            op: 'prompt',
            target,
            text,
            wait,
            timeout_ms: wait ? 60_000 : undefined,
          },
          controller.signal,
          wait ? 80_000 : 25_000,
        );
        if (controller.signal.aborted || !mountedRef.current) return;
        setDrafts((prev) => ({ ...prev, [target]: '' }));
        if (selectedRef.current === target) {
          setActionNotice(res.agent?.status === 'blocked'
            ? 'The agent needs your input. Read the output, then use the keys below.'
            : wait ? 'Finished waiting. Review the latest output below.' : 'Prompt sent. Output refreshes automatically.');
        }
        await loadOutput(target, true);
        if (!controller.signal.aborted) await loadList(true);
      } catch (e) {
        if (isAbortError(e) || !mountedRef.current) return;
        const message = herdrFailureMessage(e);
        if (message && selectedRef.current === target) setActionError(message);
        await loadOutput(target, true);
      } finally {
        sendingRef.current = false;
        setSending(false);
      }
    });
  };

  const sendKeys = (keys: string[]) => {
    if (!selectedAgent || sendingRef.current) return;
    const target = selectedAgent.target;
    beginUserAction();
    abortSend.current?.abort();
    const controller = new AbortController();
    abortSend.current = controller;
    void enqueue(async () => {
      try {
        await runCommand(
          { op: 'send_keys', target, keys },
          controller.signal,
          15_000,
        );
        if (controller.signal.aborted || !mountedRef.current) return;
        if (selectedRef.current === target) setActionNotice(`Sent ${keys.join(' + ')}.`);
        await loadOutput(target, true);
        if (!controller.signal.aborted) await loadList(true);
      } catch (e) {
        if (isAbortError(e) || !mountedRef.current) return;
        const message = herdrFailureMessage(e);
        if (message && selectedRef.current === target) setActionError(message);
      } finally {
        sendingRef.current = false;
        setSending(false);
      }
    });
  };

  const reachable = status?.reachable === true;
  const showDetail = !!selectedAgent && (!isMobile || selected !== null);
  const showList = !isMobile || !selectedAgent;
  const promptDisabled = sending || !reachable || !prompt.trim()
    || promptBytes > PROMPT_MAX_BYTES || selectedAgent?.status === 'blocked';

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
            const target = selectedRef.current;
            void enqueue(async () => {
              await loadList(false);
              if (target) await loadOutput(target, false);
            });
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
            {loadingList && agents.length === 0 && !listError ? (
              <div style={styles.empty}>Looking for agents…</div>
            ) : !reachable && listError && !status?.installed ? (
              <div style={styles.emptyCard}>
                <div style={styles.emptyTitle}>Could not reach Herdr</div>
                <p style={styles.emptyText}>{listError}</p>
                <button type="button" style={styles.primaryBtn} onClick={() => void enqueue(() => loadList(false))}>
                  Check again
                </button>
              </div>
            ) : !reachable ? (
              <div style={styles.emptyCard}>
                <div style={styles.emptyTitle}>Herdr is not running</div>
                <p style={styles.emptyText}>
                  Start Herdr on this backend with <span style={styles.inlineCode}>herdr</span> or{' '}
                  <span style={styles.inlineCode}>herdr server</span>, then refresh. Filebox only talks to the local CLI — never to agents on other machines.
                </p>
                <button type="button" style={styles.primaryBtn} onClick={() => void enqueue(() => loadList(false))}>
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
                    aria-pressed={active}
                    title={`${displayName(item)}${item.cwd ? ` · ${item.cwd}` : ''}`}
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

            {actionError && <div role="alert" style={styles.actionError}>{actionError}</div>}
            {outputError && <div role="alert" style={styles.actionError}>{outputError} Use Refresh to retry.</div>}
            {actionNotice && <div role="status" style={styles.notice}>{actionNotice}</div>}
            {selectedAgent.status === 'blocked' && !sending && (
              <div style={styles.notice}>Needs your input. Read the output and use the keys below to answer.</div>
            )}
            {sending && (
              <div style={styles.outputBar}>
                <span role="status">{wait ? 'Waiting for' : 'Sending to'} {actionTarget} · {elapsed}s</span>
                <button type="button" style={styles.keyChip} onClick={stopWaiting}>Stop waiting</button>
              </div>
            )}
            <div style={styles.outputBar}>
              <span>{loadingOutput ? 'Refreshing output…' : updatedAt
                ? `Updated ${new Date(updatedAt).toLocaleTimeString()}` : 'Latest output'}</span>
              <div style={styles.keyRow}>
                <button type="button" style={styles.keyChip} aria-pressed={wrapOutput} onClick={() => setWrapOutput((prev) => !prev)}>Wrap</button>
                <button type="button" style={styles.keyChip} onClick={() => {
                  stickToBottomRef.current = true;
                  const el = outputBoxRef.current;
                  if (el) el.scrollTop = el.scrollHeight;
                }}>Jump to latest</button>
              </div>
            </div>

            <pre
              ref={outputBoxRef}
              style={{ ...styles.output, whiteSpace: wrapOutput ? 'pre-wrap' : 'pre' }}
              aria-label={`Output from ${displayName(selectedAgent)}`}
              tabIndex={0}
              onScroll={(e) => {
                const el = e.currentTarget;
                const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
                stickToBottomRef.current = distance < 48;
              }}
            >
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
                    disabled={sending || !reachable}
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
                onChange={(e) => {
                  if (selected) setDrafts((prev) => ({ ...prev, [selected]: e.target.value }));
                }}
                aria-label={`Prompt for ${displayName(selectedAgent)}`}
                placeholder="Send a prompt to this agent"
                rows={isMobile ? 3 : 4}
                maxLength={PROMPT_MAX_BYTES}
                disabled={sending}
                style={{ ...styles.textarea, fontSize: isMobile ? 16 : 14 }}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                    e.preventDefault();
                    void sendPrompt();
                  }
                }}
              />
              <div style={{ ...styles.composerHint, color: promptBytes > PROMPT_MAX_BYTES ? c.danger : c.textMuted }}>
                {promptBytes > PROMPT_MAX_BYTES
                  ? 'Prompt exceeds the 32 KiB limit. Shorten it before sending.'
                  : `${promptBytes.toLocaleString()} / ${PROMPT_MAX_BYTES.toLocaleString()} bytes${isMobile ? '' : ' · Ctrl/Cmd+Enter to send'}`}
              </div>
              <div style={styles.composerBar}>
                <label style={styles.waitLabel} title="Wait up to 60 seconds for completion or a request for input.">
                  <input
                    type="checkbox"
                    checked={wait}
                    onChange={(e) => setWait(e.target.checked)}
                    disabled={sending}
                  />
                  Wait for result
                </label>
                <button
                  type="button"
                  onClick={() => void sendPrompt()}
                  disabled={promptDisabled}
                  style={{
                    ...styles.primaryBtn,
                    ...(promptDisabled ? styles.primaryBtnDisabled : null),
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
    border: `1px solid ${c.accent}`,
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
  notice: {
    padding: '8px 16px',
    background: c.accentBg,
    color: c.text,
    fontSize: 12,
    lineHeight: 1.5,
  },
  outputBar: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    padding: '6px 12px',
    color: c.textMuted,
    fontSize: 11,
    borderBottom: `1px solid ${c.border}`,
  },
  composerHint: { fontSize: 11, lineHeight: 1.4 },
  output: {
    flex: 1,
    minHeight: 80,
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
    minHeight: 44,
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
    maxHeight: 160,
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
