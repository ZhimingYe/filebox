import { useState } from 'react';
import * as api from '../api/client';
import { c, radius, font, settingsLayout as layout } from '../theme';
import { SettingsSwitch } from './SettingsSwitch';
import { HerdrButton } from './HerdrControls';
import { useIsMobile } from '../state/useIsMobile';

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

  return <div style={layout.prefRow}>
    <div style={layout.prefText}>
      <div style={layout.prefLabel}>Herdr integration</div>
      <p style={layout.prefHint}>{!settings
      ? 'Update the Filebox Agent to manage Herdr from the web. Older Agents can use FILEBOX_AGENT_HERDR_ENABLED=0 and restart.'
      : locked
        ? `Controlled by FILEBOX_AGENT_HERDR_ENABLED=${settings.environment_override ? '1' : '0'} on this backend. Change or unset it and restart the Filebox Agent to use this switch.`
        : 'Saved on this backend and shared across browsers. Turning it off stops Filebox’s Herdr controls and monitoring, not Herdr or its running coding agents.'}</p>
      {busy && <p role="status" style={layout.prefHint}>Saving…</p>}
      {agent.status === 'offline' && <p style={layout.prefHint}>Reconnect this backend to change the setting.</p>}
      {error && <p role="alert" style={{ ...layout.prefHint, color: c.danger }}>{error}</p>}
    </div>
    <SettingsSwitch aria-label="Herdr integration" aria-busy={busy}
      checked={settings?.enabled ?? !!agent.capabilities?.herdr}
      disabled={disabled} onClick={() => void toggle()} />
  </div>;
}

export function HerdrIntroduction({ agent, onOpen }: { agent: api.AgentInfo; onOpen: () => void }) {
  const isMobile = useIsMobile();
  const key = `filebox:herdr-intro:${agent.id}`;
  const [dismissed, setDismissed] = useState(() => {
    try { return localStorage.getItem(key) === 'dismissed'; } catch { return false; }
  });
  if (dismissed || agent.status === 'offline' || !agent.capabilities?.herdr_settings?.enabled || agent.capabilities.herdr) return null;
  function dismiss() {
    setDismissed(true);
    try { localStorage.setItem(key, 'dismissed'); } catch { /* Storage may be unavailable. */ }
  }
  return <aside aria-label="Introducing Herdr" style={{ ...layout.card, margin: '12px 16px 0', padding: '16px 20px',
    flexShrink: 0, maxHeight: '30vh', overflow: 'auto', color: c.text, fontFamily: font.sans }}>
    <strong style={layout.cardTitle}>Meet Herdr</strong>
    <p style={hint}>Herdr lets you manage coding agents on {agent.name}: see their status, read output, and respond from Filebox. Its CLI has not been detected on this backend. It is optional; file browsing works without it.</p>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
      <HerdrButton variant="primary" touch={isMobile} onClick={() => { dismiss(); onOpen(); }}>Learn more</HerdrButton>
      <HerdrButton variant="quiet" touch={isMobile} onClick={dismiss}>Not now</HerdrButton>
    </div>
  </aside>;
}

export function HerdrSetup({ agent, onRefresh }: Props) {
  const isMobile = useIsMobile();
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
  return <div style={layout.page}>
    <header style={layout.pageHeader}>
      <div style={layout.pageHeaderText}>
        <p style={layout.eyebrow}>Coding agents</p>
        <h2 style={layout.pageTitle}>Herdr</h2>
      </div>
    </header>
    <div style={layout.scroll}>
      <div style={layout.stack}>
        <section style={layout.card}>
          <div style={layout.cardHeader}><h3 style={layout.cardTitle}>Set up Herdr</h3></div>
          <div style={layout.cardBody}>
            <p style={hint}>Manage coding agents running on this backend: check their status, read terminal output, send prompts, and answer approval requests from Filebox.</p>
            <p style={hint}>{settings?.enabled === false ? 'Herdr integration is turned off for this backend.'
              : 'The Herdr CLI has not been detected. Herdr is optional and is installed separately on the Agent machine, not on the Hub or in your browser.'}</p>
            <ol style={{ ...hint, paddingLeft: 20, display: 'grid', gap: 16, margin: '20px 0' }}>
              <li><strong style={stepTitle}>Install on the Agent machine</strong>Follow the <a href="https://herdr.ink" target="_blank" rel="noopener noreferrer">official Herdr installation guide</a> on this backend.</li>
              <li><strong style={stepTitle}>Connect the CLI</strong>Make <code style={code}>herdr</code> available on the Filebox Agent’s PATH, or set <code style={code}>FILEBOX_AGENT_HERDR</code> to its executable path and restart the Agent.</li>
              <li><strong style={stepTitle}>Start and check</strong>Start <code style={code}>herdr</code> or <code style={code}>herdr server</code> on this backend, then check again below. Restarting the Filebox Agent also detects the installation.</li>
            </ol>
            {settings?.enabled && settings.environment_override == null && <HerdrButton variant="primary" touch={isMobile}
              disabled={busy || agent.status === 'offline'} onClick={() => void detect()}>{busy ? 'Checking…' : 'Check installation'}</HerdrButton>}
            {error && <p role="alert" style={{ ...hint, color: c.danger }}>{error}</p>}
          </div>
        </section>
        <section style={layout.card}>
          <div style={layout.cardHeader}><h3 style={layout.cardTitle}>Integration</h3></div>
          <HerdrToggle agent={agent} onRefresh={onRefresh} />
        </section>
      </div>
    </div>
  </div>;
}

const hint: React.CSSProperties = { ...layout.prefHint, overflowWrap: 'anywhere', margin: '8px 0 12px' };
const stepTitle: React.CSSProperties = { display: 'block', ...layout.prefLabel, marginBottom: 4 };
const code: React.CSSProperties = { fontFamily: font.mono, fontSize: 12, background: c.bgMuted, borderRadius: radius.sm, padding: '2px 4px', overflowWrap: 'anywhere' };
