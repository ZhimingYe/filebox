import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import * as api from '../api/client';
import { useIsMobile } from '../state/useIsMobile';
import { c, radius, font } from '../theme';

interface Props {
  ticket: string;
  agent: api.AgentInfo;
  /** Agent's own TOTP code, only for `terminal_agent_2fa` agents. */
  agentCode?: string;
  /** Ticket renewal failed with 401 — drop the ticket and re-verify. */
  onTicketExpired: () => void;
  /** The agent rejected/missed its own code (`terminal_2fa_*` frames). */
  onAgentCodeError?: (code: string) => void;
}

type ConnStatus = 'connecting' | 'open' | 'closed';

interface ServerFrame {
  type: 'opened' | 'output' | 'closed' | 'error';
  data?: string;
  reason?: string;
  error?: string;
}

/** UTF-8-safe base64 for terminal input. */
function base64Encode(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/** base64 → raw bytes; xterm handles UTF-8 split across chunk boundaries. */
function base64Decode(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/**
 * Live terminal pane: xterm.js on top of the per-agent terminal WebSocket.
 * The TOTP ticket is the WS bearer; it never leaves JS memory. Reconnect
 * reuses the same ticket (and agent code, when set) without losing
 * scrollback. While mounted, the ticket is renewed every 5 minutes.
 */
export function TerminalPane({ ticket, agent, agentCode, onTicketExpired, onAgentCodeError }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const resizeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Sticky modifier keys (aux toolbar): armed state lives in refs so the
  // onData closure always sees the current value; useState mirrors it for
  // the button highlight.
  const ctrlRef = useRef(false);
  const altRef = useRef(false);
  const [ctrlArmed, setCtrlArmed] = useState(false);
  const [altArmed, setAltArmed] = useState(false);
  const isMobile = useIsMobile();
  const [status, setStatus] = useState<ConnStatus>('connecting');
  const [notice, setNotice] = useState<string | null>(null);
  // Bumped by Reconnect to re-open the socket against the same terminal.
  const [connNonce, setConnNonce] = useState(0);

  const sendInput = (s: string) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'input', data: base64Encode(s) }));
    }
  };

  /** Apply armed Ctrl/Alt modifiers to one input chunk, then disarm. */
  const applyStickyModifiers = (d: string): string => {
    if (ctrlRef.current && d.length === 1) {
      const ch = d.toLowerCase();
      const code = ch.charCodeAt(0);
      if (code >= 97 && code <= 122) d = String.fromCharCode(code - 96); // a-z → ^A-^Z
      else if (ch === '[') d = '\x1b';
      else if (ch === '\\') d = '\x1c';
      else if (ch === ']') d = '\x1d';
      else if (ch === '^') d = '\x1e';
      else if (ch === '_') d = '\x1f';
      else if (ch === '?') d = '\x7f';
    }
    if (altRef.current && d.length === 1 && d.charCodeAt(0) < 0x80) {
      d = `\x1b${d}`; // Meta prefix
    }
    if (ctrlRef.current) { ctrlRef.current = false; setCtrlArmed(false); }
    if (altRef.current) { altRef.current = false; setAltArmed(false); }
    return d;
  };

  const sendArrow = (dir: 'up' | 'down' | 'left' | 'right') => {
    const term = termRef.current;
    if (!term) return;
    const letter = { up: 'A', down: 'B', right: 'C', left: 'D' }[dir];
    // Respect application-cursor-keys mode (vim, less, …).
    sendInput(term.modes.applicationCursorKeysMode ? `\x1bO${letter}` : `\x1b[${letter}`);
  };

  // Terminal lifecycle: created once per (agent, ticket), disposed on unmount.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: font.mono,
      fontSize: isMobile ? 12 : 13,
      // A remote shell must not drive browser-side window/reporting
      // features: no remote resize (DECSLPP/DECCOLM), no size/title reports
      // back to the shell, no title stack.
      windowOptions: {
        getCellSizePixels: false,
        getIconTitle: false,
        getScreenSizeChars: false,
        getScreenSizePixels: false,
        getWinSizeChars: false,
        getWinTitle: false,
        popTitle: false,
        pushTitle: false,
        setWinLines: false,
      },
      theme: {
        // Dark slate surface (c.text) keeps the terminal dark on the light
        // app; ANSI palette stays at xterm defaults.
        background: c.text,
        foreground: c.bgSubtle,
        cursor: c.accent,
        cursorAccent: c.text,
        selectionBackground: `${c.accent}55`,
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    // Swallow OSC 52 (clipboard write): xterm.js 6.0 has no default handler
    // for it; register a sink anyway so no addon/future default ever lets a
    // remote shell push text onto the user's clipboard.
    term.parser.registerOscHandler(52, () => true);
    term.open(el);
    termRef.current = term;
    fitRef.current = fit;
    const safeFit = () => {
      try { fit.fit(); } catch { /* hidden container — next resize refits */ }
    };
    safeFit();
    // Don't auto-focus on touch devices: that pops the soft keyboard before
    // the user asked for it. They tap the terminal to type.
    if (!isMobile) term.focus();

    const sendResize = () => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      }
    };
    const debouncedRefit = () => {
      if (resizeTimer.current) clearTimeout(resizeTimer.current);
      resizeTimer.current = setTimeout(() => {
        safeFit();
        sendResize();
      }, 100);
    };
    const observer = new ResizeObserver(debouncedRefit);
    observer.observe(el);
    // The soft keyboard shrinks the visible viewport without necessarily
    // changing the container right away — refit on visualViewport changes too.
    const vv = window.visualViewport;
    vv?.addEventListener('resize', debouncedRefit);

    const dataSub = term.onData((d) => {
      sendInput(applyStickyModifiers(d));
    });

    return () => {
      observer.disconnect();
      vv?.removeEventListener('resize', debouncedRefit);
      dataSub.dispose();
      if (resizeTimer.current) clearTimeout(resizeTimer.current);
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [agent.id, ticket, isMobile]);

  // Socket lifecycle: re-runs on Reconnect (connNonce) without touching the
  // terminal, so scrollback survives a reconnect.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    setStatus('connecting');
    setNotice(null);
    const ws = new WebSocket(
      api.terminalWsUrl(agent.id, term.cols, term.rows, agentCode),
      api.terminalWsProtocols(ticket),
    );
    wsRef.current = ws;

    ws.onopen = () => {
      setStatus('open');
      // The PTY was sized from the query params; re-send in case the pane
      // resized (or a reconnect happened at a different size).
      ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    };
    ws.onmessage = (ev) => {
      let frame: ServerFrame;
      try {
        frame = JSON.parse(typeof ev.data === 'string' ? ev.data : '') as ServerFrame;
      } catch {
        return;
      }
      switch (frame.type) {
        case 'opened':
          break;
        case 'output':
          if (typeof frame.data === 'string') {
            try { term.write(base64Decode(frame.data)); } catch { /* drop corrupt frame */ }
          }
          break;
        case 'closed':
          term.write(`\r\n\x1b[2m[session closed${frame.reason ? `: ${frame.reason}` : ''}]\x1b[0m\r\n`);
          setStatus('closed');
          setNotice('Session closed. Reconnect starts a new shell.');
          break;
        case 'error':
          if (frame.error === 'terminal_2fa_required' || frame.error === 'terminal_2fa_invalid') {
            // The agent's own TOTP gate rejected us — hand back to the view
            // for re-entry (it unmounts/remounts this pane).
            const code = frame.error;
            try { ws.close(); } catch { /* already gone */ }
            onAgentCodeError?.(code);
            break;
          }
          setNotice(frame.error ? `Terminal error: ${frame.error}` : 'Terminal error.');
          break;
      }
    };
    ws.onclose = () => {
      if (wsRef.current !== ws) return;
      setStatus((prev) => {
        if (prev !== 'closed') {
          setNotice('Disconnected. Reconnect with the same authorization, or go back and re-verify.');
        }
        return 'closed';
      });
    };
    ws.onerror = () => {
      // onclose follows and flips the state; nothing extra to do here.
    };

    return () => {
      if (wsRef.current === ws) wsRef.current = null;
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify({ type: 'close' })); } catch { /* already gone */ }
      }
      ws.close();
    };
  }, [agent.id, ticket, agentCode, connNonce, onAgentCodeError]);

  // Ticket renewal: keep the 30-min ticket alive while the pane is mounted.
  // A 401 / terminal_ticket_invalid means the ticket is dead — stop and hand
  // back to re-verify; transient failures just retry at the next interval.
  useEffect(() => {
    const interval = setInterval(() => {
      api.terminalRenewTicket(ticket).catch((e) => {
        const err = e as { status?: number; error?: string };
        if (err?.status === 401 || err?.error === 'terminal_ticket_invalid') {
          clearInterval(interval);
          onTicketExpired();
        }
      });
    }, 5 * 60_000);
    return () => clearInterval(interval);
  }, [ticket, onTicketExpired]);

  const keyBtnStyle = (armed = false): React.CSSProperties => ({
    ...(armed ? { ...styles.keyBtn, ...styles.keyBtnArmed } : styles.keyBtn),
    ...(isMobile ? styles.keyBtnMobile : null),
  });

  return (
    <div style={styles.wrap}>
      <div ref={containerRef} style={{ ...styles.termHost, ...(isMobile ? styles.termHostMobile : null) }} />
      {/* Aux keys for keyboards without Esc/Tab/Ctrl/arrows (mobile), and a
          convenience row on desktop. Ctrl/Alt are sticky one-shot modifiers. */}
      <div style={{ ...styles.toolbar, ...(isMobile ? styles.toolbarMobile : null) }}>
        <KeyButton label="Esc" style={keyBtnStyle()} onPress={() => sendInput('\x1b')} />
        <KeyButton label="Tab" style={keyBtnStyle()} onPress={() => sendInput('\t')} />
        <KeyButton
          label="Ctrl"
          style={keyBtnStyle(ctrlArmed)}
          onPress={() => {
            ctrlRef.current = !ctrlRef.current;
            setCtrlArmed(ctrlRef.current);
          }}
        />
        <KeyButton
          label="Alt"
          style={keyBtnStyle(altArmed)}
          onPress={() => {
            altRef.current = !altRef.current;
            setAltArmed(altRef.current);
          }}
        />
        <span style={styles.toolbarGap} />
        <KeyButton label="←" style={keyBtnStyle()} onPress={() => sendArrow('left')} />
        <KeyButton label="↑" style={keyBtnStyle()} onPress={() => sendArrow('up')} />
        <KeyButton label="↓" style={keyBtnStyle()} onPress={() => sendArrow('down')} />
        <KeyButton label="→" style={keyBtnStyle()} onPress={() => sendArrow('right')} />
      </div>
      {status !== 'open' && (
        <div style={styles.footer}>
          <span style={styles.footerText}>
            {status === 'connecting' ? 'Connecting…' : (notice ?? 'Disconnected.')}
          </span>
          {status === 'closed' && (
            <button
              type="button"
              style={styles.reconnectBtn}
              onClick={() => setConnNonce((n) => n + 1)}
            >
              Reconnect
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * One aux-key button. `onPointerDown` prevents default so pressing a key
 * never steals focus from the terminal (which would collapse the soft
 * keyboard on touch devices); the press fires on click.
 */
function KeyButton({
  label,
  style,
  onPress,
}: {
  label: string;
  style: React.CSSProperties;
  onPress: () => void;
}) {
  return (
    <button
      type="button"
      style={style}
      onPointerDown={(e) => e.preventDefault()}
      onClick={onPress}
    >
      {label}
    </button>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrap: {
    display: 'flex',
    flexDirection: 'column',
    flex: '1 1 auto',
    minHeight: 0,
    minWidth: 0,
    borderRadius: radius.md,
    border: `1px solid ${c.border}`,
    background: c.text,
    overflow: 'hidden',
  },
  termHost: {
    flex: '1 1 auto',
    minHeight: 0,
    padding: '8px 4px 4px 10px',
    boxSizing: 'border-box',
  },
  termHostMobile: {
    padding: '4px 2px 2px 6px',
  },
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '4px 10px',
    borderTop: `1px solid ${c.border}40`,
    background: c.text,
    userSelect: 'none',
    WebkitUserSelect: 'none',
    touchAction: 'manipulation',
    overflowX: 'auto',
  },
  toolbarMobile: {
    padding: '6px 8px',
    gap: 8,
  },
  toolbarGap: {
    flex: '1 1 auto',
  },
  keyBtn: {
    flexShrink: 0,
    minWidth: 30,
    minHeight: 26,
    padding: '2px 8px',
    borderRadius: radius.sm,
    border: `1px solid ${c.bgSubtle}44`,
    background: 'transparent',
    color: c.bgSubtle,
    cursor: 'pointer',
    fontSize: 12,
    fontWeight: 500,
    fontFamily: font.mono,
    touchAction: 'manipulation',
  },
  keyBtnArmed: {
    background: c.accent,
    border: `1px solid ${c.accent}`,
    color: c.onAccent,
  },
  keyBtnMobile: {
    minWidth: 40,
    minHeight: 36,
    fontSize: 13,
  },
  footer: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '6px 12px',
    borderTop: `1px solid ${c.border}40`,
    background: c.text,
  },
  footerText: {
    flex: '1 1 auto',
    minWidth: 0,
    fontSize: 12,
    fontFamily: font.sans,
    color: c.textFaint,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  reconnectBtn: {
    flexShrink: 0,
    padding: '4px 12px',
    borderRadius: radius.sm,
    border: 'none',
    background: c.accent,
    color: c.onAccent,
    cursor: 'pointer',
    fontSize: 12,
    fontWeight: 500,
    fontFamily: font.sans,
  },
};
