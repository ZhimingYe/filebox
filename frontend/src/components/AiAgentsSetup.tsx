import { useState } from 'react';
import * as api from '../api/client';
import { c, radius, font, settingsLayout as layout } from '../theme';
import { SettingsSwitch } from './SettingsSwitch';
import { AiAgentButton } from './AiAgentControls';
import { useIsMobile } from '../state/useIsMobile';
import { supportedAiAgentBackends } from '../lib/aiAgentBackends';

interface Props {
  agent: api.AgentInfo;
  onRefresh: () => void;
}

export function AiAgentsToggle({ agent, onRefresh }: Props) {
  const reported = agent.capabilities?.ai_agents;
  const [savedSettings, setSavedSettings] = useState<{
    reported: typeof reported;
    settings: api.AiAgentSettings;
  } | null>(null);
  const settings = savedSettings && savedSettings.reported === reported
    ? savedSettings.settings
    : reported?.settings;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const locked = settings?.environment_override != null;
  const disabled = busy || !settings || locked || agent.status === 'offline';

  async function toggle() {
    if (disabled || !settings) return;
    setBusy(true);
    setError('');
    try {
      const saved = await api.setAiAgentsEnabled(agent.id, !settings.enabled);
      setSavedSettings({ reported, settings: saved.settings });
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
      <div style={layout.prefLabel}>AI Agents</div>
      <p style={layout.prefHint}>{!settings
      ? 'Update the Filebox Agent to manage AI Agents from the web. Older Agents can use FILEBOX_AGENT_AI_AGENTS_ENABLED=0 and restart.'
      : locked
        ? `Controlled by FILEBOX_AGENT_AI_AGENTS_ENABLED=${settings.environment_override ? '1' : '0'} on this backend. Change or unset it and restart the Filebox Agent to use this switch.`
        : 'Saved on this backend and shared across browsers. Turning it off stops Filebox’s AI Agents controls and monitoring, not the backend or its running coding agents.'}</p>
      {busy && <p role="status" style={layout.prefHint}>Saving…</p>}
      {agent.status === 'offline' && <p style={layout.prefHint}>Reconnect this backend to change the setting.</p>}
      {error && <p role="alert" style={{ ...layout.prefHint, color: c.danger }}>{error}</p>}
    </div>
    <SettingsSwitch aria-label="AI Agents" aria-busy={busy}
      checked={settings?.enabled ?? false}
      disabled={disabled} onClick={() => void toggle()} />
  </div>;
}

export function AiAgentsIntroduction({ agent, onOpen }: { agent: api.AgentInfo; onOpen: () => void }) {
  const isMobile = useIsMobile();
  const key = `filebox:ai-agents-intro:${agent.id}`;
  const [dismissed, setDismissed] = useState(() => {
    try { return localStorage.getItem(key) === 'dismissed'; } catch { return false; }
  });
  if (dismissed || agent.status === 'offline'
    || !agent.capabilities?.ai_agents?.settings.enabled
    || agent.capabilities.ai_agents.available) return null;
  function dismiss() {
    setDismissed(true);
    try { localStorage.setItem(key, 'dismissed'); } catch { /* Storage may be unavailable. */ }
  }
  return <aside aria-label="Introducing AI Agents" style={{ ...layout.card, margin: isMobile ? '8px 12px' : '12px 20px', padding: isMobile ? '14px 16px' : '16px 20px',
    flexShrink: 0, maxHeight: '30vh', overflow: 'auto', color: c.text, fontFamily: font.sans }}>
    <strong style={layout.cardTitle}>Meet AI Agents</strong>
    <p style={hint}>Manage coding agents on {agent.name}: see their status, read output, and respond from Filebox. No supported backend has been detected. The integration is optional; file browsing works without it.</p>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
      <AiAgentButton variant="primary" size="sm" touch={isMobile} onClick={() => { dismiss(); onOpen(); }}>Learn more</AiAgentButton>
      <AiAgentButton variant="quiet" size="sm" touch={isMobile} onClick={dismiss}>Not now</AiAgentButton>
    </div>
  </aside>;
}

export function AiAgentsSetup({ agent, onRefresh }: Props) {
  const isMobile = useIsMobile();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const capability = agent.capabilities?.ai_agents;
  const settings = capability?.settings;
  const needsAgentUpdate = capability == null;
  async function detect() {
    setBusy(true);
    setError('');
    try {
      await api.setAiAgentsEnabled(agent.id, true);
      onRefresh();
    } catch (e) { setError(api.friendlyMessage(e)); }
    finally { setBusy(false); }
  }
  return <div style={layout.page}>
    <header style={layout.pageHeader}>
      <div style={layout.pageHeaderText}>
        <p style={layout.eyebrow}>Coding agents</p>
        <h2 style={layout.pageTitle}>AI Agents</h2>
      </div>
    </header>
    <div style={layout.scroll}>
      <div style={layout.stack}>
        <section style={layout.card}>
          <div style={layout.cardHeader}><h3 style={layout.cardTitle}>Set up AI Agents</h3></div>
          <div style={layout.cardBody}>
            <p style={hint}>Manage coding agents running on this backend: check their status, read terminal output, send prompts, and answer approval requests from Filebox.</p>
            <p style={hint}>{needsAgentUpdate
              ? 'Update the Filebox Agent to manage AI Agents from the web.'
              : settings?.enabled === false ? 'AI Agents is turned off for this backend.'
                : 'No supported AI agent backend has been detected. Backends are installed separately on the Agent machine, not on the Hub or in your browser.'}</p>
            {!needsAgentUpdate && supportedAiAgentBackends.map((supportedBackend) => (
              <div key={supportedBackend.kind}>
                <strong style={stepTitle}>{supportedBackend.label}</strong>
                <ol style={{ ...hint, paddingLeft: 20, display: 'grid', gap: 16, margin: '12px 0 20px' }}>
                  <li>Install on the Agent machine using the {supportedBackend.installUrl
                    ? <a href={supportedBackend.installUrl} target="_blank" rel="noopener noreferrer">{supportedBackend.installGuide}</a>
                    : supportedBackend.installGuide}.</li>
                  <li>Make <code style={code}>{supportedBackend.binaryName}</code> available on the Filebox Agent’s PATH
                    {supportedBackend.binaryEnvironment && <> or set <code style={code}>{supportedBackend.binaryEnvironment}</code> to its executable path</>}, then restart the Agent.</li>
                  {supportedBackend.serverCommand && <li>Start <code style={code}>{supportedBackend.serverCommand}</code> on this backend, then check again below.</li>}
                </ol>
              </div>
            ))}
            {settings?.enabled && settings.environment_override == null && <AiAgentButton variant="primary" touch={isMobile}
              disabled={busy || agent.status === 'offline'} onClick={() => void detect()}>{busy ? 'Checking…' : 'Check installation'}</AiAgentButton>}
            {error && <p role="alert" style={{ ...hint, color: c.danger }}>{error}</p>}
          </div>
        </section>
        <section style={layout.card}>
          <div style={layout.cardHeader}><h3 style={layout.cardTitle}>Integration</h3></div>
          <AiAgentsToggle agent={agent} onRefresh={onRefresh} />
        </section>
      </div>
    </div>
  </div>;
}

const hint: React.CSSProperties = { ...layout.prefHint, overflowWrap: 'anywhere', margin: '8px 0 12px' };
const stepTitle: React.CSSProperties = { display: 'block', ...layout.prefLabel, marginBottom: 4 };
const code: React.CSSProperties = { fontFamily: font.mono, fontSize: 12, background: c.bgMuted, borderRadius: radius.sm, padding: '2px 4px', overflowWrap: 'anywhere' };
