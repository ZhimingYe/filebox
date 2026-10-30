import { useState } from 'react';
import * as api from '../api/client';
import { c, radius, font } from '../theme';

interface Props {
  agent: api.AgentInfo;
  onRefresh: () => void;
}

export function HerdrToggle({ agent, onRefresh }: Props) {
  const reported = agent.capabilities?.herdr_settings;
  const [savedSettings, setSavedSettings] = useState<{
    reported: typeof reported;
    settings: NonNullable<typeof reported>;
  } | null>(null);
  const settings = savedSettings && savedSettings.reported === reported
    ? savedSettings.settings
    : reported;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const locked = settings?.environment_override != null;
  const disabled = busy || !settings || locked || agent.status === 'offline';

  async function toggle() {
    if (disabled || !settings) return;
    setBusy(true);
    setError('');
    try {
      const saved = await api.setHerdrEnabled(agent.id, !settings.enabled);
      setSavedSettings({ reported, settings: saved });
      onRefresh();
    } catch (e) {
      setError(api.friendlyMessage(e));
      onRefresh();
    } finally {
      setBusy(false);
    }
  }

  return <div style={{ minWidth: 0 }}>
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
      <span style={{ color: c.text, fontSize: 13.5, fontWeight: 500 }}>Herdr integration</span>
      <button type="button" role="switch" aria-label="Herdr integration"
        aria-checked={settings?.enabled ?? !!agent.capabilities?.herdr}
        disabled={disabled} onClick={() => void toggle()}
        style={{ ...button, minWidth: 64, opacity: disabled ? 0.6 : 1,
          cursor: disabled ? 'default' : 'pointer',
          color: settings?.enabled ? c.accent : c.text,
          background: settings?.enabled ? c.accentBg : c.bgSubtle }}>
        {busy ? 'Saving…' : (settings?.enabled ?? agent.capabilities?.herdr) ? 'On' : 'Off'}
      </button>
    </div>
    <p style={hint}>{!settings
      ? 'Update the Filebox Agent to manage Herdr from the web. Older Agents can use FILEBOX_AGENT_HERDR_ENABLED=0 and restart.'
      : locked
        ? `Controlled by FILEBOX_AGENT_HERDR_ENABLED=${settings.environment_override ? '1' : '0'} on this backend. Change or unset it and restart the Filebox Agent to use this switch.`
        : 'Saved on this backend and shared across browsers. Turning it off stops Filebox’s Herdr controls and monitoring, not Herdr or its running coding agents.'}</p>
    {agent.status === 'offline' && <p style={hint}>Reconnect this backend to change the setting.</p>}
    {error && <p role="alert" style={{ ...hint, color: c.danger }}>{error}</p>}
  </div>;
}

export function HerdrIntroduction({ agent, onOpen }: { agent: api.AgentInfo; onOpen: () => void }) {
  const key = `filebox:herdr-intro:${agent.id}`;
  const [dismissed, setDismissed] = useState(() => {
    try { return localStorage.getItem(key) === 'dismissed'; } catch { return false; }
  });
  if (dismissed || agent.status === 'offline' || !agent.capabilities?.herdr_settings?.enabled || agent.capabilities.herdr) return null;
  function dismiss() {
    setDismissed(true);
    try { localStorage.setItem(key, 'dismissed'); } catch { /* Storage may be unavailable. */ }
  }
  return <aside aria-label="Introducing Herdr" style={{ margin: '6px 12px', padding: '12px 16px',
    flexShrink: 0, maxHeight: '30vh', overflow: 'auto', border: `1px solid ${c.border}`,
    borderRadius: radius.lg, background: c.accentBg, color: c.text, fontFamily: font.sans }}>
    <strong style={{ fontSize: 13 }}>Meet Herdr</strong>
    <p style={hint}>Herdr lets you manage coding agents on {agent.name}: see their status, read output, and respond from Filebox. Its CLI has not been detected on this backend. It is optional; file browsing works without it.</p>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
      <button type="button" style={button} onClick={() => { dismiss(); onOpen(); }}>Learn more</button>
      <button type="button" style={button} onClick={dismiss}>Not now</button>
    </div>
  </aside>;
}

export function HerdrSetup({ agent, onRefresh }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const settings = agent.capabilities?.herdr_settings;
  async function detect() {
    setBusy(true);
    setError('');
    try {
      await api.setHerdrEnabled(agent.id, true);
      onRefresh();
    } catch (e) { setError(api.friendlyMessage(e)); }
    finally { setBusy(false); }
  }
  return <div style={{ padding: 24, overflow: 'auto', width: '100%', boxSizing: 'border-box', fontFamily: font.sans }}>
    <section style={{ maxWidth: 620, margin: '0 auto', color: c.text }}>
      <h2 style={{ fontSize: 20 }}>Herdr</h2>
      <p style={hint}>Manage coding agents running on this backend: check their status, read terminal output, send prompts, and answer approval requests from Filebox.</p>
      <p style={hint}>{settings?.enabled === false ? 'Herdr integration is turned off for this backend.'
        : 'The Herdr CLI has not been detected. Herdr is optional and is installed separately on the Agent machine, not on the Hub or in your browser.'}</p>
      <ol style={{ ...hint, paddingLeft: 20, lineHeight: 1.8 }}>
        <li>Follow the <a href="https://herdr.ink" target="_blank" rel="noopener noreferrer" style={{ color: c.accent }}>official Herdr installation guide</a> on this backend.</li>
        <li>Make <code>herdr</code> available on the Filebox Agent’s PATH, or set <code>FILEBOX_AGENT_HERDR</code> to its executable path and restart the Agent.</li>
        <li>Start <code>herdr</code> or <code>herdr server</code> on this backend, then check again below. Restarting the Filebox Agent also detects the installation.</li>
      </ol>
      {settings?.enabled && settings.environment_override == null && <button type="button" style={button}
        disabled={busy || agent.status === 'offline'} onClick={() => void detect()}>{busy ? 'Checking…' : 'Check installation'}</button>}
      {error && <p role="alert" style={{ ...hint, color: c.danger }}>{error}</p>}
      <div style={{ marginTop: 24, paddingTop: 20, borderTop: `1px solid ${c.border}` }}>
        <HerdrToggle agent={agent} onRefresh={onRefresh} />
      </div>
    </section>
  </div>;
}

const hint: React.CSSProperties = { fontSize: 13, lineHeight: 1.6, color: c.textSecondary, overflowWrap: 'anywhere', margin: '8px 0 12px' };
const button: React.CSSProperties = { minHeight: 40, padding: '6px 12px', cursor: 'pointer',
  border: `1px solid ${c.border}`, borderRadius: radius.md, color: c.text, background: c.surface, fontSize: 13 };
