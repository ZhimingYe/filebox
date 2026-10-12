import type { IDockviewPanelProps } from 'dockview-react';
import { TempTransferView } from '@classic/components/TempTransferView';
import { useNeoAgent } from '../../preview/agentContext';
import { ChromeNeedAgent, ChromeShell, ChromeUnsupported } from './ChromeShell';

export function TransferPanel(_props: IDockviewPanelProps) {
  const { agent } = useNeoAgent();
  if (!agent) {
    return (
      <ChromeShell>
        <ChromeNeedAgent label="Transfer" />
      </ChromeShell>
    );
  }
  const capable = !!agent.capabilities?.temp_upload && !!agent.temp_root_name;
  return (
    <ChromeShell>
      {capable ? (
        <TempTransferView agent={agent} />
      ) : (
        <ChromeUnsupported text="This agent does not support temp uploads." />
      )}
    </ChromeShell>
  );
}
