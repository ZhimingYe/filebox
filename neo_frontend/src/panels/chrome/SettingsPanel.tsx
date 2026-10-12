import type { IDockviewPanelProps } from 'dockview-react';
import { AgentSettings } from '@classic/components/AgentSettings';
import { useHealth } from '@classic/state/health';
import { useNeoAgent } from '../../preview/agentContext';
import { ChromeNeedAgent, ChromeShell } from './ChromeShell';

export function SettingsPanel(_props: IDockviewPanelProps) {
  const { agent } = useNeoAgent();
  const { refresh } = useHealth(true);
  if (!agent) {
    return (
      <ChromeShell>
        <ChromeNeedAgent label="Settings" />
      </ChromeShell>
    );
  }
  return (
    <ChromeShell>
      <div style={{ overflow: 'auto', height: '100%' }}>
        <AgentSettings agent={agent} onRefresh={refresh} />
      </div>
    </ChromeShell>
  );
}
