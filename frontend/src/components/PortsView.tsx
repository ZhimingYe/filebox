import { useState, type CSSProperties, type FormEvent } from 'react';
import * as api from '../api/client';
import { useCopyToClipboard } from '../hooks/useCopyToClipboard';
import { useIsMobile } from '../state/useIsMobile';
import { c, font, radius } from '../theme';
import { IconCheck, IconClipboard, IconTrash } from './icons';

interface Props {
  agent: api.AgentInfo;
  onRefresh: () => void;
}

export function PortsView({ agent, onRefresh }: Props) {
  const isMobile = useIsMobile();
  const { copiedPath, copyToClipboard } = useCopyToClipboard();
  const [port, setPort] = useState('');
  const [name, setName] = useState('');
  const [keepPrefix, setKeepPrefix] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string | null>>({});
  const error = errors.add;
  const setError = (message: string | null) => setErrors((previous) => ({ ...previous, add: message }));
  const forwards = agent.forwards ?? [];
  const pending = agent.pending_forwards_update;

  async function change(operation: () => Promise<api.DesiredStateResponse>, scope = 'add') {
    if (busy) return;
    setBusy(scope);
    setErrors((previous) => ({ ...previous, [scope]: null }));
    try {
      await operation();
      if (scope === 'add') { setPort(''); setName(''); setKeepPrefix(false); }
    } catch (cause) {
      const details = cause as api.ApiError;
      setErrors((previous) => ({ ...previous, [scope]: details?.message || api.friendlyMessage(cause) }));
    } finally {
      setBusy(null);
      onRefresh();
    }
  }

  function add(event: FormEvent) {
    event.preventDefault();
    const value = Number(port);
    if (!/^\d+$/.test(port) || !Number.isInteger(value) || value < 1 || value > 65535) {
      setError('Enter a port from 1 to 65535.');
      return;
    }
    if (forwards.some((forward) => forward.port === value)) {
      setError('This port is already listed.');
      return;
    }
    void change(() => api.addForward(agent.id, { port: value, name: name.trim() || `Port ${value}`, ...(keepPrefix ? { keep_prefix: true } : {}) }));
  }

  return <section style={{ ...styles.view, padding: isMobile ? 16 : 24 }} aria-label="Ports">
    <h2 style={styles.title}>Ports</h2>
    {!agent.capabilities?.port_forward ? <p style={styles.notice}>
      Port forwarding is unavailable on this Agent.
    </p> : <>
      <p style={styles.description}>Open the agent’s local web apps through this Hub.</p>
      <div style={{ ...styles.notice, background: c.warningBg, borderColor: c.warning }}>
        <strong>Only forward apps you trust.</strong> Forwarded pages share the Hub origin: their scripts can act as you and call Filebox APIs.
        {' '}Services can do anything they can do locally, including running code and writing files, bypassing Filebox’s read-only protections.
        {' '}Anyone signed in to this Hub can open them.
      </div>
      {(pending || agent.status === 'offline') && <p role="status" style={styles.notice}>
        {agent.status === 'offline' ? 'Agent offline. Changes will sync on reconnect.' : 'Pending sync with Agent…'}
      </p>}
      {agent.last_config_error && !Object.values(errors).includes(agent.last_config_error) && <p role="alert" style={{ ...styles.notice, color: c.danger, background: c.dangerBg }}>
        {agent.last_config_error}
      </p>}
      <form onSubmit={add} style={styles.form}>
        <label style={{ ...styles.label, flex: '0 1 84px' }}>Port
          <input aria-label="Port" type="number" min="1" max="65535" step="1" required value={port}
            onChange={(event) => setPort(event.target.value)} style={styles.input} disabled={busy === 'add'} placeholder="9001" />
        </label>
        <label style={{ ...styles.label, flex: '1 1 136px' }}>Name <span style={{ color: c.textMuted }}>(optional)</span>
          <input aria-label="Name (optional)" value={name} onChange={(event) => setName(event.target.value)}
            style={styles.input} disabled={busy === 'add'} placeholder="Local app" />
        </label>
        <button type="submit" disabled={!!busy} style={{ ...styles.button, color: c.onAccent, background: c.accent, borderColor: c.accent, opacity: busy ? 0.6 : 1 }}>
          {busy === 'add' ? 'Saving…' : 'Add port'}
        </button>
        <details style={{ flex: '1 0 100%', fontSize: 11, color: c.textSecondary }}>
          <summary style={{ cursor: 'pointer' }}>Advanced</summary>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8 }}>
            <input type="checkbox" checked={keepPrefix} disabled={busy === 'add'} onChange={(event) => setKeepPrefix(event.target.checked)} />App uses this base path
          </label>
          <p style={{ margin: '6px 0', lineHeight: 1.5 }}>Keep the forwarding prefix for apps configured with this base URL.</p>
          <code style={{ display: 'block', fontFamily: font.mono, overflowWrap: 'anywhere' }}>{`/_fwd/${encodeURIComponent(agent.id)}/${/^\d+$/.test(port) && Number(port) >= 1 && Number(port) <= 65535 ? Number(port) : '<port>'}/`}</code>
        </details>
        {error && <p role="alert" style={{ ...styles.notice, width: '100%', color: c.danger, background: c.dangerBg }}>{error}</p>}
      </form>
      <div style={styles.list}>
        {forwards.length === 0 ? <div style={styles.empty}>
          <p style={{ margin: '0 0 6px', fontSize: 13.5, fontWeight: 500, color: c.text }}>No ports yet.</p>
          <p style={{ margin: 0 }}>Add a local web service above.</p>
        </div> : forwards.map((forward) => {
          const path = api.forwardPath(agent.id, forward.port);
          const canOpen = forward.trusted === true && agent.status !== 'offline' && !pending;
          return <div key={forward.port} style={styles.row}>
            <div style={styles.identity}><span style={styles.name}>{forward.name}</span><span style={styles.port}>:{forward.port}</span>
              {forward.trusted !== true && <span style={{ fontSize: 11, color: c.textMuted }}>Not trusted by agent</span>}
            </div>
            <div style={styles.actions}>
              {canOpen ? <a href={path} target="_blank" rel="noopener noreferrer" style={styles.button}>Open</a>
                : <button type="button" disabled title={forward.trusted !== true ? 'Not trusted by agent' : agent.status === 'offline' ? 'Agent offline' : 'Waiting for sync'} style={{ ...styles.button, color: c.textMuted, cursor: 'default' }}>Open</button>}
              <button type="button" aria-label={`Copy link for ${forward.name}`} title="Copy link" style={styles.iconButton} onClick={async () => {
                const ok = await copyToClipboard(new URL(path, window.location.origin).href, path);
                setErrors((previous) => ({ ...previous, [forward.port]: ok ? null : 'Could not copy the link.' }));
              }}>{copiedPath === path ? <IconCheck /> : <IconClipboard />}</button>
              <button type="button" aria-label={`Delete ${forward.name}`} title="Delete port" disabled={!!busy}
                style={{ ...styles.iconButton, opacity: busy ? 0.6 : 1 }} onClick={() => void change(() => api.deleteForward(agent.id, forward.port), String(forward.port))}><IconTrash /></button>
            </div>
            <div style={{ flex: '1 0 100%', minWidth: 0, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, fontSize: 11, color: c.textSecondary }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <input type="checkbox" aria-label={`App uses this base path for ${forward.name}`} checked={!!forward.keep_prefix} disabled={!!busy}
                  onChange={(event) => void change(() => api.setForwardPrefix(agent.id, forward.port, event.target.checked), String(forward.port))} />App uses this base path
              </label>
              <code style={{ fontFamily: font.mono, overflowWrap: 'anywhere' }}>{path}</code>
              <button type="button" aria-label={`Copy base path for ${forward.name}`} title="Copy base path" style={styles.iconButton} onClick={async () => {
                const ok = await copyToClipboard(path, `prefix:${path}`);
                setErrors((previous) => ({ ...previous, [forward.port]: ok ? null : 'Could not copy the base path.' }));
              }}>{copiedPath === `prefix:${path}` ? <IconCheck /> : <IconClipboard />}</button>
            </div>
            <span style={{ fontSize: 11, color: c.textMuted }}>Keeps the forwarding prefix for apps configured with this base URL.</span>
            {busy === String(forward.port) && <span role="status" style={{ fontSize: 11, color: c.textSecondary }}>Saving…</span>}
            {errors[forward.port] && <p role="alert" style={{ ...styles.notice, width: '100%', color: c.danger, background: c.dangerBg }}>{errors[forward.port]}</p>}
          </div>;
        })}
      </div>
    </>}
  </section>;
}

const styles = {
  view: { flex: 1, minWidth: 0, maxWidth: 900, boxSizing: 'border-box', minHeight: 0, overflowY: 'auto', color: c.text, fontFamily: font.sans },
  title: { margin: 0, fontSize: 17, fontWeight: 600 },
  description: { margin: '4px 0 14px', fontSize: 12.5, color: c.textMuted, lineHeight: 1.45 },
  notice: { margin: '0 0 14px', padding: '8px 14px', boxSizing: 'border-box', fontSize: 12.5, lineHeight: 1.5, background: c.bgSubtle, borderWidth: 1, borderStyle: 'solid', borderColor: c.border, borderRadius: radius.md, overflowWrap: 'anywhere' },
  form: { display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: 10, marginBottom: 20 },
  label: { fontSize: 11, color: c.textSecondary, minWidth: 0 },
  input: { display: 'block', boxSizing: 'border-box', width: '100%', height: 30, marginTop: 5, padding: '4px 8px', border: `1px solid ${c.border}`, borderRadius: radius.sm, background: c.bg, color: c.text, fontFamily: font.sans, fontSize: 12 },
  button: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', height: 30, boxSizing: 'border-box', padding: '0 10px', borderWidth: 1, borderStyle: 'solid', borderColor: c.border, borderRadius: radius.sm, background: c.bg, color: c.textSecondary, fontFamily: font.sans, fontSize: 12, textDecoration: 'none', cursor: 'pointer', whiteSpace: 'nowrap' },
  iconButton: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, padding: 0, border: 0, borderRadius: radius.sm, background: 'transparent', color: c.textSecondary, cursor: 'pointer' },
  list: { borderTop: `1px solid ${c.border}` },
  row: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '12px 0', borderBottom: `1px solid ${c.borderSubtle}` },
  identity: { display: 'flex', alignItems: 'baseline', flexWrap: 'wrap', gap: 8, minWidth: 0, flex: '1 1 120px' },
  name: { fontSize: 13, fontWeight: 500, overflowWrap: 'anywhere' },
  port: { fontSize: 11, fontFamily: font.mono, color: c.textMuted },
  actions: { display: 'flex', alignItems: 'center', gap: 6 },
  empty: { fontSize: 12.5, lineHeight: 1.45, textAlign: 'center', color: c.textMuted, padding: '28px 16px', marginTop: 14, border: `1px solid ${c.border}`, borderRadius: radius.md },
} satisfies Record<string, CSSProperties>;
