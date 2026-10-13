import type { IDockviewPanelProps } from 'dockview-react';
import { SystemStats } from '@lib/components/SystemStats';
import { useNeoAgent } from '../../preview/agentContext';
import { ChromeNeedAgent, ChromeShell } from './ChromeShell';

export function StatsPanel(_props: IDockviewPanelProps) {
  const { agent } = useNeoAgent();
  if (!agent) {
    return (
      <ChromeShell>
        <ChromeNeedAgent label="Stats" />
      </ChromeShell>
    );
  }
  return (
    <ChromeShell>
      <div style={{ overflow: 'auto', height: '100%' }}>
        <SystemStats agentId={agent.id} />
      </div>
    </ChromeShell>
  );
}
