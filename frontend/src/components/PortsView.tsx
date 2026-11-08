import { useState, type CSSProperties, type FormEvent } from 'react';
import * as api from '../api/client';
import { useCopyToClipboard } from '../hooks/useCopyToClipboard';
import { useIsMobile } from '../state/useIsMobile';
import { c, font, radius } from '../theme';
import { IconCheck, IconClipboard, IconPorts, IconTrash } from './icons';

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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const forwards = agent.forwards ?? [];
  const pending = agent.pending_forwards_update;

  async function change(operation: () => Promise<api.DesiredStateResponse>, added = false) {
    setBusy(true);
    setError(null);
    try {
      await operation();
      if (added) { setPort(''); setName(''); setKeepPrefix(false); }
    } catch (cause) {
      const details = cause as api.ApiError;
      setError(details?.message || api.friendlyMessage(cause));
    } finally {
      setBusy(false);
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
    void change(() => api.addForward(agent.id, { port: value, name: name.trim() || `Port ${value}`, ...(keepPrefix ? { keep_prefix: true } : {}) }), true);
  }

  return <section style={{ ...styles.view, padding: isMobile ? 16 : 24 }} aria-label="Ports">
    <div style={styles.heading}><IconPorts /><h2 style={styles.title}>Ports</h2></div>
    {!agent.capabilities?.port_forward ? <p style={styles.notice}>
      Upgrade the Agent or enable port forwarding. Forwarding may be disabled with <code style={{ fontFamily: font.mono }}>FILEBOX_AGENT_PORT_FORWARD=off</code>.
    </p> : <>
      <p style={styles.description}>Open loopback web services through this Hub. No base-path setup needed by default.</p>
      {(pending || agent.status === 'offline') && <p role="status" style={styles.notice}>
        {agent.status === 'offline' ? 'Agent offline. Changes will sync on reconnect.' : 'Pending sync with Agent…'}
      </p>}
      {(error || agent.last_config_error) && <p role="alert" style={{ ...styles.notice, color: c.danger, background: c.dangerBg }}>
        {error || agent.last_config_error}
      </p>}
      <form onSubmit={add} style={styles.form}>
        <label style={{ ...styles.label, flex: '0 1 84px' }}>Port
          <input aria-label="Port" type="number" min="1" max="65535" step="1" required value={port}
            onChange={(event) => setPort(event.target.value)} style={styles.input} disabled={busy} placeholder="9001" />
        </label>
        <label style={{ ...styles.label, flex: '1 1 136px' }}>Name <span style={{ color: c.textMuted }}>(optional)</span>
          <input aria-label="Name (optional)" value={name} onChange={(event) => setName(event.target.value)}
            style={styles.input} disabled={busy} placeholder="Local app" />
        </label>
        <button type="submit" disabled={busy} style={{ ...styles.button, color: c.onAccent, background: c.accent, borderColor: c.accent, opacity: busy ? 0.6 : 1 }}>
          {busy ? 'Saving…' : 'Add port'}
        </button>
        <details style={{ flex: '1 0 100%', fontSize: 11, color: c.textSecondary }}>
          <summary style={{ cursor: 'pointer' }}>Advanced</summary>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8 }}>
            <input type="checkbox" checked={keepPrefix} disabled={busy} onChange={(event) => setKeepPrefix(event.target.checked)} />App uses this base path
          </label>
          <code style={{ display: 'block', marginTop: 6, fontFamily: font.mono, overflowWrap: 'anywhere' }}>{`/_fwd/${encodeURIComponent(agent.id)}/${port || '<port>'}/`}</code>
        </details>
      </form>
      <div style={styles.list}>
        {forwards.length === 0 ? <p style={styles.empty}>No ports yet. Add a local web service above.</p> : forwards.map((forward) => {
          const path = api.forwardPath(agent.id, forward.port);
          const canOpen = agent.status !== 'offline' && !pending;
          return <div key={forward.port} style={styles.row}>
            <div style={styles.identity}><span style={styles.name}>{forward.name}</span><span style={styles.port}>:{forward.port}</span></div>
            <div style={{ order: 1, flex: '1 0 100%', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, fontSize: 11, color: c.textSecondary }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <input type="checkbox" aria-label={`App uses this base path for ${forward.name}`} checked={!!forward.keep_prefix} disabled={busy}
                  onChange={(event) => void change(() => api.setForwardPrefix(agent.id, forward.port, event.target.checked))} />App uses this base path
              </label>
              <code style={{ fontFamily: font.mono, overflowWrap: 'anywhere' }}>{path}</code>
              <button type="button" aria-label={`Copy base path for ${forward.name}`} style={styles.iconButton} onClick={async () => {
                if (!await copyToClipboard(path, `prefix:${path}`)) setError('Could not copy the base path.');
              }}>{copiedPath === `prefix:${path}` ? <IconCheck /> : <IconClipboard />}</button>
            </div>
            <div style={styles.actions}>
              {canOpen ? <a href={path} target="_blank" rel="noopener noreferrer" style={styles.button}>Open</a>
                : <span title="Available when the Agent is connected and synced" style={{ ...styles.button, color: c.textMuted }}>Open</span>}
              <button type="button" aria-label={`Copy link for ${forward.name}`} title="Copy link" style={styles.iconButton} onClick={async () => {
                const ok = await copyToClipboard(new URL(path, window.location.origin).href, path);
                if (!ok) setError('Could not copy the link. Open the service and copy its address.');
              }}>{copiedPath === path ? <IconCheck /> : <IconClipboard />}</button>
              <button type="button" aria-label={`Delete ${forward.name}`} title="Delete port" disabled={busy}
                style={{ ...styles.iconButton, opacity: busy ? 0.6 : 1 }} onClick={() => void change(() => api.deleteForward(agent.id, forward.port))}><IconTrash /></button>
            </div>
          </div>;
        })}
      </div>
    </>}
  </section>;
}

const styles = {
  view: { flex: 1, minHeight: 0, overflowY: 'auto', color: c.text, fontFamily: font.sans },
  heading: { display: 'flex', alignItems: 'center', gap: 8 },
  title: { margin: 0, fontSize: 16, fontWeight: 600 },
  description: { margin: '8px 0 20px', fontSize: 12, color: c.textSecondary, lineHeight: 1.5 },
  notice: { padding: '10px 12px', fontSize: 12, lineHeight: 1.5, background: c.bgSubtle, borderRadius: radius.sm, overflowWrap: 'anywhere' },
  form: { display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: 8, maxWidth: 640, marginBottom: 20 },
  label: { fontSize: 11, color: c.textSecondary, minWidth: 0 },
  input: { display: 'block', boxSizing: 'border-box', width: '100%', height: 30, marginTop: 5, padding: '4px 8px', border: `1px solid ${c.border}`, borderRadius: radius.sm, background: c.bg, color: c.text, fontFamily: font.sans, fontSize: 12 },
  button: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', height: 30, boxSizing: 'border-box', padding: '0 10px', border: `1px solid ${c.border}`, borderRadius: radius.sm, background: c.bg, color: c.textSecondary, fontFamily: font.sans, fontSize: 12, textDecoration: 'none', cursor: 'pointer', whiteSpace: 'nowrap' },
  iconButton: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, padding: 0, border: 0, borderRadius: radius.sm, background: 'transparent', color: c.textSecondary, cursor: 'pointer' },
  list: { maxWidth: 640, borderTop: `1px solid ${c.border}` },
  row: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '12px 0', borderBottom: `1px solid ${c.borderSubtle}` },
  identity: { display: 'flex', alignItems: 'baseline', flexWrap: 'wrap', gap: 8, minWidth: 0, flex: '1 1 120px' },
  name: { fontSize: 13, fontWeight: 500, overflowWrap: 'anywhere' },
  port: { fontSize: 11, fontFamily: font.mono, color: c.textMuted },
  actions: { display: 'flex', alignItems: 'center', gap: 6 },
  empty: { fontSize: 12, color: c.textMuted, padding: '20px 0', margin: 0 },
} satisfies Record<string, CSSProperties>;
