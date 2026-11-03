import { useState } from 'react';
import * as api from '../api/client';
import { c, radius, font, settingsLayout as layout } from '../theme';
import { SettingsSwitch } from './SettingsSwitch';
import { AiAgentButton } from './AiAgentControls';
import { useIsMobile } from '../state/useIsMobile';
import { aiAgentBackend, aiAgentBackends, supportedAiAgentBackends } from '../lib/aiAgentBackends';

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
  const enabledLocked = settings?.environment_override != null;
  const backendLocked = settings?.backend_environment_override != null;
  const backends = reported?.backends ?? [];
  const selectionMissing = settings?.backend != null
    && !backends.some((backend) => backend.kind === settings.backend);
  const showBackendSelect = !!settings
    && (backends.length >= 2 || selectionMissing || !!settings.backend_environment_override);
  const disabled = busy || !settings || enabledLocked || agent.status === 'offline';
  const backendSelectDisabled = busy || !settings || backendLocked || agent.status === 'offline';

  async function saveSettings(next: api.AiAgentSettings) {
    if (!settings || busy || agent.status === 'offline') return;
    setBusy(true);
    setError('');
    try {
      const saved = await api.setAiAgentsSettings(agent.id, {
        enabled: next.enabled,
        backend: next.backend,
      });
      setSavedSettings({ reported, settings: saved.settings });
      onRefresh();
    } catch (e) {
      setError(api.friendlyMessage(e));
      onRefresh();
    } finally {
      setBusy(false);
    }
  }

  function backendLabel(kind: string, version?: string) {
    const descriptor = aiAgentBackend(kind);
    const label = descriptor.kind === 'generic' ? kind : descriptor.label;
    return version ? `${label} ${version}` : label;
  }

  return <div style={layout.prefRow}>
    <div style={layout.prefText}>
      <div style={layout.prefLabel}>AI Agents</div>
      {!settings
        ? <p style={layout.prefHint}>Update the Filebox Agent to manage AI Agents from the web. Older Agents can use FILEBOX_AGENT_AI_AGENTS_ENABLED=0 and restart.</p>
        : enabledLocked
          ? <p style={layout.prefHint}>Controlled by FILEBOX_AGENT_AI_AGENTS_ENABLED={settings.environment_override ? '1' : '0'} on this backend. Change or unset it and restart the Filebox Agent to use this switch.</p>
          : <p style={layout.prefHint}>Saved on this backend and shared across browsers. Turning it off stops Filebox’s AI Agents controls and monitoring, not the backend or its running coding agents.</p>}
      {backendLocked && settings.backend_environment_override && <p style={layout.prefHint}>
        Controlled by FILEBOX_AGENT_AI_AGENTS_BACKEND={settings.backend_environment_override} on this backend. Change or unset it and restart the Filebox Agent to select a backend here.
      </p>}
      {busy && <p role="status" style={layout.prefHint}>Saving…</p>}
      {agent.status === 'offline' && <p style={layout.prefHint}>Reconnect this backend to change the setting.</p>}
      {error && <p role="alert" style={{ ...layout.prefHint, color: c.danger }}>{error}</p>}
    </div>
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
      {showBackendSelect && settings && <select aria-label="AI Agents backend"
        value={settings.backend ?? ''} disabled={backendSelectDisabled}
        onChange={(event) => void saveSettings({ ...settings, backend: event.currentTarget.value || null })}
        style={{ color: c.text, background: c.bg, border: `1px solid ${c.border}`, borderRadius: radius.sm,
          padding: '4px 22px 4px 7px', fontFamily: font.sans, fontSize: 12, maxWidth: 145 }}>
        <option value="">Automatic</option>
        {backends.map((backend) => <option key={backend.kind} value={backend.kind}>
          {backendLabel(backend.kind, backend.version)}
        </option>)}
        {selectionMissing && settings.backend && <option value={settings.backend}>
          {backendLabel(settings.backend)} (not detected)
        </option>}
      </select>}
      <SettingsSwitch aria-label="AI Agents" aria-busy={busy}
        checked={settings?.enabled ?? false}
        disabled={disabled} onClick={() => void saveSettings({ ...settings!, enabled: !settings!.enabled })} />
    </div>
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
      await api.setAiAgentsSettings(agent.id, { enabled: true, backend: settings?.backend ?? null });
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
            {!needsAgentUpdate && (capability?.backend
              ? [aiAgentBackend(capability.backend)]
              : supportedAiAgentBackends).map((supportedBackend) => (
              <div key={supportedBackend.kind}>
                <strong style={stepTitle}>{supportedBackend.label}</strong>
                {capability?.backend && !aiAgentBackends[capability.backend]
                  ? <p style={hint}>{capability.backend} is not detected. {supportedBackend.noServerMessage}</p>
                  : <>
                <ol style={{ ...hint, paddingLeft: 20, display: 'grid', gap: 16, margin: '12px 0 20px' }}>
                  <li>Install on the Agent machine using the {supportedBackend.installUrl
                    ? <a href={supportedBackend.installUrl} target="_blank" rel="noopener noreferrer">{supportedBackend.installGuide}</a>
                    : supportedBackend.installGuide}.</li>
                  <li>Make <code style={code}>{supportedBackend.binaryName}</code> available on the Filebox Agent’s PATH
                    {supportedBackend.binaryEnvironment && <> or set <code style={code}>{supportedBackend.binaryEnvironment}</code> to its executable path</>}, then restart the Agent.</li>
                  {supportedBackend.serverCommand && <li>Start <code style={code}>{supportedBackend.serverCommand}</code> on this backend, then check again below.</li>}
                </ol>
                  </>}
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
