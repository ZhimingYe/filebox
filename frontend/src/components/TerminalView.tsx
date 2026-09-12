import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import * as api from '../api/client';
import { friendlyMessage } from '../api/client';
import { c, radius, font } from '../theme';

// xterm is heavy; it only downloads once the user actually opens a terminal.
const TerminalPane = lazy(() =>
  import('./TerminalPane').then((m) => ({ default: m.TerminalPane })),
);

interface Props {
  agent: api.AgentInfo;
}

type Phase = 'loading' | 'bind' | 'verify' | 'agentCode' | 'ready';

function totpErrorMessage(e: unknown): string {
  const err = e as { error?: string; retry_after?: number };
  if (err?.error === 'totp_rate_limited' && typeof err?.retry_after === 'number') {
    return `${friendlyMessage(e)} Retry in ${err.retry_after}s.`;
  }
  return friendlyMessage(e);
}

/** Shared 6-digit TOTP entry: numeric input, auto-submit on 6 digits. */
function CodeEntry({
  onSubmit,
  pending,
  error,
  submitLabel,
}: {
  onSubmit: (code: string) => void;
  pending: boolean;
  error: string | null;
  submitLabel: string;
}) {
  // The parent remounts this on every failure (key = error id), which is
  // what clears the code field and refocuses the input.
  const [code, setCode] = useState('');
  const handleChange = (raw: string) => {
    const digits = raw.replace(/\D/g, '').slice(0, 6);
    setCode(digits);
    if (digits.length === 6) onSubmit(digits);
  };
  return (
    <form
      style={styles.codeForm}
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(code);
      }}
    >
      <input
        style={styles.codeInput}
        type="text"
        inputMode="numeric"
        autoComplete="one-time-code"
        placeholder="6-digit code"
        value={code}
        autoFocus
        disabled={pending}
        onChange={(e) => handleChange(e.target.value)}
      />
      <button
        type="submit"
        style={{ ...styles.primaryBtn, ...(pending || code.length !== 6 ? styles.primaryBtnDisabled : null) }}
        disabled={pending || code.length !== 6}
      >
        {pending ? 'Checking…' : submitLabel}
      </button>
      {error && <p style={styles.formError}>{error}</p>}
    </form>
  );
}

/**
 * Remote terminal gated by per-user TOTP 2FA. First visit binds an
 * authenticator (QR + manual secret), later visits verify a 6-digit code;
 * both yield a short-lived WS ticket. The ticket lives ONLY in component
 * state — a refresh wipes it and the view falls back to verify. App.tsx
 * remounts this view per agent (key = agent.id), so switching agents
 * re-probes and drops any ticket.
 *
 * Agents advertising `terminal_agent_2fa` add a second step (`agentCode`
 * phase): the agent host itself has its own authenticator entry and rejects
 * the shell without its current code. The hub ticket and the agent code are
 * independent — both live only in state, both die on refresh (intended).
 */
export function TerminalView({ agent }: Props) {
  const [phase, setPhase] = useState<Phase>('loading');
  const [ticket, setTicket] = useState<string | null>(null);
  const [agentCode, setAgentCode] = useState<string | null>(null);
  const [bindData, setBindData] = useState<api.TerminalBindStartResult | null>(null);
  const [probeError, setProbeError] = useState<string | null>(null);
  const [bindStartError, setBindStartError] = useState<string | null>(null);
  const [codeError, setCodeError] = useState<{ msg: string; id: number } | null>(null);
  const [agentCodeError, setAgentCodeError] = useState<{ msg: string; id: number } | null>(null);
  const [pending, setPending] = useState(false);
  // Nonces re-arm the probe / bind-start effects (Retry buttons, pending
  // bind expiry) without an agent switch.
  const [probeNonce, setProbeNonce] = useState(0);
  const [bindNonce, setBindNonce] = useState(0);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const needsAgentCode = !!agent.capabilities?.terminal_agent_2fa;

  // Probe binding state. Resets happen on remount (per agent) or in the
  // Retry handler — never synchronously inside this effect.
  useEffect(() => {
    let cancelled = false;
    api.getTerminal2faStatus()
      .then((s) => {
        if (!cancelled) setPhase(s.bound ? 'verify' : 'bind');
      })
      .catch((e) => {
        if (!cancelled) setProbeError(totpErrorMessage(e));
      });
    return () => { cancelled = true; };
  }, [agent.id, probeNonce]);

  // Entering bind: mint a fresh secret + otpauth URI from the hub.
  useEffect(() => {
    if (phase !== 'bind') return;
    let cancelled = false;
    api.terminalBindStart()
      .then((d) => {
        if (!cancelled) setBindData(d);
      })
      .catch((e) => {
        if (cancelled) return;
        const err = e as { error?: string };
        if (err?.error === 'totp_already_bound') {
          setPhase('verify');
          return;
        }
        setBindStartError(totpErrorMessage(e));
      });
    return () => { cancelled = true; };
  }, [phase, bindNonce]);

  // Render the otpauth URI as a scannable QR once the canvas is mounted.
  useEffect(() => {
    if (phase !== 'bind' || !bindData || !canvasRef.current) return;
    QRCode.toCanvas(canvasRef.current, bindData.otpauth_uri, {
      width: 200,
      margin: 1,
      color: { dark: c.text, light: c.bg },
    }).catch(() => { /* manual secret entry remains available */ });
  }, [phase, bindData]);

  const submitCode = useCallback(async (code: string) => {
    if (pending) return;
    setPending(true);
    setCodeError(null);
    try {
      const t = phase === 'bind'
        ? await api.terminalBindConfirm(code, agent.id)
        : await api.terminalVerify(code, agent.id);
      setTicket(t.ticket);
      setPhase(needsAgentCode ? 'agentCode' : 'ready');
    } catch (e) {
      const err = e as { error?: string };
      if (err?.error === 'totp_already_bound') {
        setPhase('verify');
      } else if (err?.error === 'totp_no_pending_bind') {
        // Pending bind expired server-side — mint a fresh secret.
        setBindData(null);
        setBindNonce((n) => n + 1);
      }
      setCodeError({ msg: totpErrorMessage(e), id: Date.now() });
    } finally {
      setPending(false);
    }
  }, [pending, phase, agent.id, needsAgentCode]);

  // Agent-side code is only validated by the agent over the WS, so there is
  // nothing to submit here — stash it and mount the pane.
  const submitAgentCode = useCallback((code: string) => {
    setAgentCode(code);
    setAgentCodeError(null);
    setPhase('ready');
  }, []);

  // The pane reports the agent rejected/missed its code. Keep the ticket —
  // it may still be valid — and ask for the current code again.
  const handleAgentCodeError = useCallback((errorCode: string) => {
    setAgentCode(null);
    setAgentCodeError({ msg: friendlyMessage({ error: errorCode }), id: Date.now() });
    setPhase('agentCode');
  }, []);

  // The pane's renewal loop hit 401 — the ticket is dead; re-verify.
  const handleTicketExpired = useCallback(() => {
    setTicket(null);
    setAgentCode(null);
    setCodeError({ msg: friendlyMessage({ error: 'terminal_ticket_invalid' }), id: Date.now() });
    setPhase('verify');
  }, []);

  if (phase === 'loading') {
    return (
      <div style={styles.centerWrap}>
        {probeError ? (
          <div style={styles.card}>
            <p style={styles.formError}>{probeError}</p>
            <button
              type="button"
              style={styles.primaryBtn}
              onClick={() => {
                setProbeError(null);
                setProbeNonce((n) => n + 1);
              }}
            >
              Retry
            </button>
          </div>
        ) : (
          <p style={styles.muted}>Checking two-factor status…</p>
        )}
      </div>
    );
  }

  if (phase === 'ready' && ticket) {
    return (
      <div style={styles.readyWrap}>
        <Suspense fallback={<div style={styles.centerWrap}><p style={styles.muted}>Loading terminal…</p></div>}>
          <TerminalPane
            ticket={ticket}
            agent={agent}
            agentCode={agentCode ?? undefined}
            onTicketExpired={handleTicketExpired}
            onAgentCodeError={handleAgentCodeError}
          />
        </Suspense>
      </div>
    );
  }

  if (phase === 'agentCode') {
    return (
      <div style={styles.centerWrap}>
        <div style={styles.card}>
          <h2 style={styles.title}>Backend authenticator code</h2>
          <p style={styles.body}>
            <strong>{agent.name}</strong> requires its own authenticator code
            before opening a shell. This is a separate entry in your
            authenticator app, provisioned on the backend host — not the code
            you just entered.
          </p>
          <CodeEntry
            key={agentCodeError?.id ?? 0}
            onSubmit={submitAgentCode}
            pending={false}
            error={agentCodeError?.msg ?? null}
            submitLabel="Continue"
          />
        </div>
      </div>
    );
  }

  if (phase === 'bind') {
    return (
      <div style={styles.centerWrap}>
        <div style={styles.card}>
          <h2 style={styles.title}>Set up two-factor authentication</h2>
          <p style={styles.body}>
            The terminal runs commands on <strong>{agent.name}</strong> as the agent's
            user. Bind a TOTP authenticator (e.g. 1Password, Authy, Google
            Authenticator) to continue — you will confirm with a code.
          </p>
          {bindStartError && (
            <>
              <p style={styles.formError}>{bindStartError}</p>
              <button
                type="button"
                style={styles.primaryBtn}
                onClick={() => {
                  setBindStartError(null);
                  setBindNonce((n) => n + 1);
                }}
              >
                Retry
              </button>
            </>
          )}
          {!bindStartError && !bindData && <p style={styles.muted}>Generating secret…</p>}
          {bindData && (
            <>
              <div style={styles.qrWrap}>
                <canvas ref={canvasRef} style={styles.qrCanvas} />
              </div>
              <p style={styles.body}>Or enter this key manually:</p>
              <code style={styles.secret}>{bindData.secret}</code>
              <CodeEntry
                key={codeError?.id ?? 0}
                onSubmit={(code) => void submitCode(code)}
                pending={pending}
                error={codeError?.msg ?? null}
                submitLabel="Confirm"
              />
            </>
          )}
        </div>
      </div>
    );
  }

  // verify
  return (
    <div style={styles.centerWrap}>
      <div style={styles.card}>
        <h2 style={styles.title}>Verify two-factor code</h2>
        <p style={styles.body}>
          Enter the 6-digit code from your authenticator to open a terminal
          on <strong>{agent.name}</strong>.
        </p>
        <CodeEntry
          key={codeError?.id ?? 0}
          onSubmit={(code) => void submitCode(code)}
          pending={pending}
          error={codeError?.msg ?? null}
          submitLabel="Verify"
        />
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
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
    maxWidth: 420,
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
    outline: 'none',
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
};
