import type { IDockviewPanelProps } from 'dockview-react';
import { TerminalView } from '@lib/components/TerminalView';
import { useNeoAgent } from '../../preview/agentContext';
import { ChromeNeedAgent, ChromeShell, ChromeUnsupported } from './ChromeShell';

export function TerminalPanel(_props: IDockviewPanelProps) {
  const { agent } = useNeoAgent();
  if (!agent) {
    return (
      <ChromeShell>
        <ChromeNeedAgent label="Terminal" />
      </ChromeShell>
    );
  }
  const capable = !!agent.capabilities?.terminal;
  return (
    <ChromeShell>
      {capable ? (
        <TerminalView key={agent.id} agent={agent} />
      ) : (
        <ChromeUnsupported text="This agent does not support remote terminals." />
      )}
    </ChromeShell>
  );
}
