import { lazy, Suspense, useCallback, useEffect, useId, useRef, useState } from 'react';
import * as api from '../api/client';
import { friendlyMessage } from '../api/client';
import { PreviewErrorBoundary } from './PreviewErrorBoundary';
import { c, radius, font } from '../theme';

// xterm is heavy; it only downloads once the user actually opens a terminal.
const TerminalPane = lazy(() =>
  import('./TerminalPane').then((m) => ({ default: m.TerminalPane })),
);

interface Props {
  agent: api.AgentInfo;
}

/** Explicit submission lets users check which authenticator entry they chose. */
function CodeEntry({
  onSubmit,
  pending,
  error,
  submitLabel,
  cooldown = 0,
}: {
  onSubmit: (code: string) => void;
  pending: boolean;
  error: string | null;
  submitLabel: string;
  cooldown?: number;
}) {
  // The parent remounts this on every failure (key = error id), which is
  // what clears the code field and refocuses the input.
  const [code, setCode] = useState('');
  const inputId = useId();
  // `maxLength` is deliberately wider than the 6 digits we keep: pasting a
  // grouped code ("123 456") must not be truncated to "123 45" before the
  // sanitizer below strips the separator.
  const handleChange = (raw: string) => {
    setCode(raw.replace(/\D/g, '').slice(0, 6));
  };
  return (
    <form
      style={styles.codeForm}
      onSubmit={(e) => {
        e.preventDefault();
        if (!pending && !cooldown && code.length === 6) onSubmit(code);
      }}
    >
      <label htmlFor={inputId} style={{ ...styles.body, flexBasis: '100%' }}>6-digit authenticator code</label>
      <input
        id={inputId}
        aria-invalid={!!error}
        aria-describedby={error ? `${inputId}-error` : undefined}
        maxLength={9}
        style={styles.codeInput}
        type="text"
        inputMode="numeric"
        autoComplete="one-time-code"
        placeholder="6-digit code"
        value={code}
        autoFocus
        // Stay typeable during a rate-limit cooldown: the submit button is
        // what waits, and a disabled input would swallow the autofocus this
        // remount relies on.
        disabled={pending}
        onChange={(e) => handleChange(e.target.value)}
      />
      <button
        type="submit"
        style={{ ...styles.primaryBtn, ...(pending || cooldown > 0 || code.length !== 6 ? styles.primaryBtnDisabled : null) }}
        disabled={pending || cooldown > 0 || code.length !== 6}
      >
        {pending ? 'Checking…' : cooldown > 0 ? `Wait ${cooldown}s` : submitLabel}
      </button>
      {error && <p id={`${inputId}-error`} role="alert" style={styles.formError}>{error}</p>}
    </form>
  );
}

/** Display form of a session req_id: strip the `term_` prefix, keep ~12 chars. */
function shortReqId(reqId: string): string {
  const bare = reqId.startsWith('term_') ? reqId.slice(5) : reqId;
  return bare.slice(0, 12);
}

/** Compact duration: `Xm` under an hour, then `Xh Ym`. */
function formatDurationSecs(secs: number): string {
  const m = Math.max(0, Math.floor(secs / 60));
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

const IDLE_WARN_SECS = 10 * 60;
const KILL_CONFIRM_MS = 3000;

/**
 * Collapsible list of the agent's live terminal sessions with a kill path.
 * This is the zombie-recovery tool, so it rides the plain session (no 2FA
 * ticket) and renders in EVERY phase — including before 2FA is passed.
 * `unsupported_feature` (legacy agent) hides the section permanently.
 */
function TerminalSessionsPanel({ agent, onResume }: Props & { onResume: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [sessions, setSessions] = useState<api.TerminalSessionInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [loading, setLoading] = useState(false);
  const [killing, setKilling] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const confirmTimer = useRef<number | null>(null);
  const refreshRequest = useRef(0);
  const refreshController = useRef<AbortController | null>(null);
  const killController = useRef<AbortController | null>(null);
  const [refreshSlow, setRefreshSlow] = useState(false);

  const refresh = useCallback(async () => {
    const current = ++refreshRequest.current;
    refreshController.current?.abort();
    const controller = new AbortController();
    refreshController.current = controller;
    setLoading(true);
    setRefreshSlow(false);
    setError(null);
    const slowTimer = window.setTimeout(() => {
      if (current === refreshRequest.current && !controller.signal.aborted) setRefreshSlow(true);
    }, 8000);
    try {
      const res = await api.listTerminals(agent.id, controller.signal);
      if (current !== refreshRequest.current || controller.signal.aborted) return;
      setSessions(res.sessions);
    } catch (e) {
      if (current !== refreshRequest.current || controller.signal.aborted) return;
      const err = e as api.ApiError;
      if (err?.error === 'unsupported_feature') {
        setUnsupported(true);
        return;
      }
      setError(friendlyMessage(e));
    } finally {
      window.clearTimeout(slowTimer);
      if (current === refreshRequest.current) {
        refreshController.current = null;
        setLoading(false);
        setRefreshSlow(false);
      }
    }
  }, [agent.id]);

  const cancelRefresh = () => {
    ++refreshRequest.current;
    refreshController.current?.abort();
    refreshController.current = null;
    setLoading(false);
    setRefreshSlow(false);
    setError('Session refresh cancelled. Retry when ready.');
  };

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && sessions === null && !loading) void refresh();
  };

  const armConfirm = (reqId: string) => {
    setConfirmId(reqId);
    if (confirmTimer.current !== null) window.clearTimeout(confirmTimer.current);
    confirmTimer.current = window.setTimeout(() => setConfirmId(null), KILL_CONFIRM_MS);
  };

  const kill = async (reqId: string) => {
    if (killController.current) return;
    const controller = new AbortController();
    killController.current = controller;
    ++refreshRequest.current;
    refreshController.current?.abort();
    refreshController.current = null;
    setLoading(false);
    setRefreshSlow(false);
    setKilling(reqId);
    setError(null);
    try {
      await api.killTerminalSession(agent.id, reqId, controller.signal);
      if (controller.signal.aborted) return;
      await refresh();
    } catch (e) {
      if (controller.signal.aborted) return;
      const err = e as api.ApiError;
      if (err?.error === 'unsupported_feature') {
        setUnsupported(true);
        return;
      }
      setError(`Ending this session was not confirmed. Refresh Sessions to check whether it ended. ${friendlyMessage(e)}`);
    } finally {
      if (killController.current === controller) killController.current = null;
      if (!controller.signal.aborted) {
        setKilling(null);
        setConfirmId(null);
      }
    }
  };

  useEffect(() => () => {
    ++refreshRequest.current;
    refreshController.current?.abort();
    killController.current?.abort();
    killController.current = null;
    if (confirmTimer.current !== null) window.clearTimeout(confirmTimer.current);
  }, []);

  if (unsupported) return null;
  // The capability is authoritative when the agent reports it: no point in a
  // guaranteed 400 to discover the panel is unsupported. An older agent that
  // omits the flag still gets probed (and hides itself on that 400).
  if (agent.capabilities?.terminal_manage === false) return null;

  return (
    <div style={styles.sessWrap}>
      <div style={styles.sessCard}>
        <div style={styles.sessHeader}>
          <button
            type="button"
            style={styles.sessToggle}
            onClick={toggle}
            aria-expanded={open}
          >
            <span style={styles.sessCaret}>{open ? '▾' : '▸'}</span>
            Sessions on {agent.name}
            {sessions !== null && (
              <span style={styles.sessCount}>{sessions.length}</span>
            )}
          </button>
          <button
            type="button"
            style={styles.sessRefreshBtn}
            onClick={() => loading ? cancelRefresh() : void refresh()}
          >
            {loading ? 'Cancel refresh' : 'Refresh'}
          </button>
        </div>
        {open && (
          <div style={styles.sessBody}>
            {loading && !error && (sessions === null || refreshSlow) && (
              <p role="status" style={styles.muted}>{refreshSlow ? 'Still waiting for the backend’s sessions…' : 'Loading sessions…'}</p>
            )}
            {error && (
              <div style={styles.sessErrorRow}>
                <p style={styles.formError}>{error}</p>
                <button
                  type="button"
                  style={styles.sessRefreshBtn}
                  onClick={() => void refresh()}
                >
                  Retry
                </button>
              </div>
            )}
            {sessions !== null && sessions.length === 0 && !error && (
              <p style={styles.muted}>No active sessions.</p>
            )}
            {sessions?.map((s) => (
              <div key={s.req_id} style={styles.sessRow}>
                <code style={styles.sessId} title={s.req_id}>{shortReqId(s.req_id)}</code>
                <span style={styles.sessDim}>{s.cols}×{s.rows}</span>
                <span style={styles.sessDim}>age {formatDurationSecs(s.age_secs)}</span>
                <span
                  style={{
                    ...styles.sessDim,
                    ...(s.idle_secs > IDLE_WARN_SECS ? styles.sessIdleWarn : null),
                  }}
                >
                  idle {formatDurationSecs(s.idle_secs)}
                </span>
                <button type="button" style={styles.sessRefreshBtn} onClick={() => onResume(s.req_id)}>Resume</button>
                <button
                  type="button"
                  style={{
                    ...styles.sessKillBtn,
                    ...(confirmId === s.req_id ? styles.sessKillConfirm : null),
                    ...(killing === s.req_id ? styles.primaryBtnDisabled : null),
                  }}
                  disabled={killing === s.req_id}
                  onClick={() => (confirmId === s.req_id ? void kill(s.req_id) : armConfirm(s.req_id))}
                >
                  {killing === s.req_id ? 'Ending…' : confirmId === s.req_id ? 'Confirm end?' : 'End'}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** The Agent owns both the shell and the authenticator. Every mount reauthorizes. */
export function TerminalView({ agent }: Props) {
  const [authorization, setAuthorization] = useState<{ ticket: string; code: string } | null>(null);
  const [sessionId, setSessionId] = useState<string>();
  const sessionRef = useRef<string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [nonce, setNonce] = useState(0);
  const request = useRef(0);
  const submitting = useRef(false);
  const ticketController = useRef<AbortController | null>(null);
  useEffect(() => () => { request.current++; ticketController.current?.abort(); }, []);
  const choose = useCallback((id?: string) => {
    request.current++;
    ticketController.current?.abort();
    ticketController.current = null;
    submitting.current = false;
    setPending(false);
    setAuthorization(null);
    sessionRef.current = id;
    setSessionId(id);
    setError(null);
    setNonce(n => n + 1);
  }, []);
  const opened = useCallback((id: string) => { sessionRef.current = id; }, []);
  const retry = useCallback((code?: string) => {
    choose(sessionRef.current);
    if (code) setError(friendlyMessage({ error: code }));
  }, [choose]);
  const submit = async (code: string) => {
    if (submitting.current) return;
    submitting.current = true;
    const current = ++request.current;
    const controller = new AbortController();
    ticketController.current = controller;
    setPending(true);
    setError(null);
    try {
      const { ticket } = await api.terminalTicket(agent.id, controller.signal);
      if (request.current === current) setAuthorization({ ticket, code });
    } catch (e) {
      if (request.current === current) { setError(friendlyMessage(e)); setNonce(n => n + 1); }
    } finally {
      if (request.current === current) { ticketController.current = null; submitting.current = false; setPending(false); }
    }
  };
  const configured = agent.capabilities?.terminal_agent_2fa && agent.capabilities?.terminal_persistent;
  return (
    <div style={styles.wrap}>
      <TerminalSessionsPanel agent={agent} onResume={choose} />
      {authorization ? (
        <>
          <button type="button" style={styles.primaryBtn} onClick={() => choose()}>New session</button>
          <PreviewErrorBoundary label="Terminal">
            <Suspense fallback={<p style={styles.muted}>Loading terminal…</p>}>
              <TerminalPane agent={agent} ticket={authorization.ticket} agentCode={authorization.code}
                sessionId={sessionId} onSessionOpened={opened} onReconnect={retry} />
            </Suspense>
          </PreviewErrorBoundary>
        </>
      ) : (
        <div style={styles.card}>
          <h2 style={styles.title}>{sessionId ? 'Resume terminal' : 'Open terminal'}</h2>
          {configured ? (
            <>
              <p style={styles.body}>Enter this Agent’s authenticator code. A fresh code is required each time you open or resume a terminal.</p>
              <p style={styles.muted}>Leaving this view or disconnecting keeps the shell running. Use Sessions → End to stop it.</p>
              <CodeEntry key={nonce} onSubmit={submit} pending={pending} error={error} submitLabel={pending ? 'Connecting…' : sessionId ? 'Resume' : 'Open terminal'} />
              {(pending || sessionId) && <button type="button" style={styles.primaryBtn} onClick={() => choose()}>Cancel</button>}
            </>
          ) : (
            <>
              <p style={styles.body}>Configure an authenticator locally on the Agent machine:</p>
              <pre style={styles.body}>agent --setup-terminal-2fa [--config agent.toml]</pre>
              <p style={styles.muted}>Use the latest Agent, complete the wizard, then restart it. The secret stays on the Agent; the Hub forwards codes for local verification.</p>
            </>
          )}
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrap: { display: 'flex', flexDirection: 'column', flex: '1 1 auto', minHeight: 0, minWidth: 0, gap: 12, padding: 12, boxSizing: 'border-box' },
  steps: { display: 'flex', flexWrap: 'wrap', gap: 6, padding: 0, margin: '0 0 8px', listStyle: 'none', fontFamily: font.sans },
  step: { flex: '1 1 auto', padding: '8px 10px', borderRadius: radius.sm, color: c.textSecondary, background: c.bgSubtle, fontSize: 12 },
  stepLabel: { margin: 0, color: c.accent, fontSize: 12, fontWeight: 600, fontFamily: font.sans },
  note: { margin: '4px 0', padding: 12, background: c.bgSubtle, borderRadius: radius.md, color: c.textSecondary, fontSize: 13, lineHeight: 1.6, fontFamily: font.sans },
  secondaryBtn: { padding: '9px 12px', borderRadius: radius.md, border: `1px solid ${c.border}`, background: c.bg, color: c.text, cursor: 'pointer', fontFamily: font.sans },
  helpSummary: { cursor: 'pointer', color: c.accent, fontSize: 13, lineHeight: 1.6, fontFamily: font.sans },
  centerWrap: {
    flex: '1 1 auto',
    minHeight: 0,
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'center',
    padding: 24,
    overflowY: 'auto',
    boxSizing: 'border-box',
  },
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
    width: '100%',
    maxWidth: 480,
    padding: '20px 22px',
    borderRadius: radius.lg,
    border: `1px solid ${c.border}`,
    background: c.bg,
    boxSizing: 'border-box',
  },
  title: {
    margin: 0,
    fontSize: 15,
    fontWeight: 600,
    color: c.text,
    fontFamily: font.sans,
  },
  body: {
    margin: 0,
    fontSize: 12.5,
    lineHeight: 1.5,
    color: c.textSecondary,
    fontFamily: font.sans,
  },
  muted: {
    margin: 0,
    fontSize: 12.5,
    color: c.textMuted,
    fontFamily: font.sans,
  },
  qrWrap: {
    alignSelf: 'center',
    padding: 8,
    borderRadius: radius.md,
    border: `1px solid ${c.border}`,
    background: c.bg,
    lineHeight: 0,
  },
  qrCanvas: {
    display: 'block',
    width: 200,
    height: 200,
  },
  secret: {
    alignSelf: 'center',
    padding: '6px 10px',
    borderRadius: radius.sm,
    border: `1px solid ${c.borderSubtle}`,
    background: c.bgSubtle,
    fontFamily: font.mono,
    fontSize: 13,
    letterSpacing: '0.06em',
    color: c.text,
    userSelect: 'all',
    overflowWrap: 'break-word',
  },
  codeForm: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 8,
    marginTop: 4,
  },
  codeInput: {
    flex: '1 1 140px',
    minWidth: 0,
    padding: '8px 12px',
    borderRadius: radius.md,
    border: `1px solid ${c.border}`,
    background: c.bg,
    color: c.text,
    fontFamily: font.mono,
    // 16px floor: iOS auto-zooms focused inputs with smaller text.
    fontSize: 16,
    letterSpacing: '0.2em',
    textAlign: 'center',
    boxSizing: 'border-box',
  },
  primaryBtn: {
    flexShrink: 0,
    padding: '8px 16px',
    borderRadius: radius.md,
    border: 'none',
    background: c.accent,
    color: c.onAccent,
    cursor: 'pointer',
    fontSize: 13,
    fontWeight: 500,
    fontFamily: font.sans,
  },
  primaryBtnDisabled: {
    opacity: 0.5,
    cursor: 'default',
  },
  formError: {
    margin: 0,
    flex: '1 1 100%',
    fontSize: 12.5,
    lineHeight: 1.4,
    color: c.danger,
    fontFamily: font.sans,
  },
  readyWrap: {
    flex: '1 1 auto',
    minHeight: 0,
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    padding: 12,
    boxSizing: 'border-box',
    background: c.bgSubtle,
  },
  viewWrap: {
    flex: '1 1 auto',
    minHeight: 0,
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    boxSizing: 'border-box',
  },
  sessWrap: {
    flexShrink: 0,
    padding: '12px 12px 0',
    boxSizing: 'border-box',
  },
  sessCard: {
    display: 'flex',
    flexDirection: 'column',
    borderRadius: radius.md,
    border: `1px solid ${c.border}`,
    background: c.bg,
    boxSizing: 'border-box',
  },
  sessHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '4px 6px',
  },
  sessToggle: {
    flex: '1 1 auto',
    minWidth: 0,
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '4px 6px',
    border: 'none',
    background: 'transparent',
    cursor: 'pointer',
    fontSize: 12.5,
    fontWeight: 500,
    color: c.textSecondary,
    fontFamily: font.sans,
    textAlign: 'left',
  },
  sessCaret: {
    fontSize: 10,
    color: c.textMuted,
    width: 10,
    textAlign: 'center',
  },
  sessCount: {
    padding: '0 6px',
    borderRadius: radius.pill,
    background: c.bgMuted,
    color: c.textMuted,
    fontSize: 11,
    fontWeight: 500,
    lineHeight: '16px',
  },
  sessRefreshBtn: {
    flexShrink: 0,
    // 24px minimum hit target (WCAG 2.5.8) — these are icon-sized otherwise.
    minHeight: 24,
    padding: '4px 10px',
    borderRadius: radius.sm,
    border: `1px solid ${c.border}`,
    background: c.bg,
    color: c.textSecondary,
    cursor: 'pointer',
    fontSize: 12,
    fontWeight: 500,
    fontFamily: font.sans,
  },
  sessBody: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    padding: '0 8px 8px',
  },
  sessErrorRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  sessRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '3px 4px',
    borderRadius: radius.sm,
  },
  sessId: {
    fontFamily: font.mono,
    fontSize: 12,
    color: c.text,
    userSelect: 'all',
  },
  sessDim: {
    fontSize: 12,
    color: c.textMuted,
    fontFamily: font.sans,
  },
  sessIdleWarn: {
    color: c.warning,
    fontWeight: 600,
  },
  sessKillBtn: {
    flexShrink: 0,
    marginLeft: 'auto',
    // 24px minimum hit target (WCAG 2.5.8). A kill is destructive, so it also
    // stays a comfortable target on touch.
    minHeight: 24,
    padding: '3px 10px',
    borderRadius: radius.sm,
    border: `1px solid ${c.border}`,
    background: c.bg,
    color: c.danger,
    cursor: 'pointer',
    fontSize: 12,
    fontWeight: 500,
    fontFamily: font.sans,
  },
  sessKillConfirm: {
    background: c.danger,
    border: `1px solid ${c.danger}`,
    color: c.onAccent,
  },
};
