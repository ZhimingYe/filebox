import { useSyncExternalStore } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import { TempTransferView } from '@lib/components/TempTransferView';
import { useNeoAgent } from '../../preview/agentContext';
import {
  clearUploadRequest,
  getTempRefreshNonce,
  getUploadRequest,
  subscribeUploadHandoff,
} from '../../shell/uploadHandoff';
import { ChromeNeedAgent, ChromeShell, ChromeUnsupported } from './ChromeShell';

function useUploadHandoff() {
  // Separate subscriptions so each getSnapshot returns a stable value
  // (a fresh object per call triggers React #185 infinite re-render).
  const uploadRequest = useSyncExternalStore(subscribeUploadHandoff, getUploadRequest, () => null);
  const tempRefreshNonce = useSyncExternalStore(subscribeUploadHandoff, getTempRefreshNonce, () => 0);
  return { uploadRequest, tempRefreshNonce };
}

export function TransferPanel(_props: IDockviewPanelProps) {
  const { agent } = useNeoAgent();
  const { uploadRequest, tempRefreshNonce } = useUploadHandoff();

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
        <TempTransferView
          agent={agent}
          uploadRequest={uploadRequest}
          onUploadsHandled={() => clearUploadRequest()}
          tempRefreshNonce={tempRefreshNonce}
        />
      ) : (
        <ChromeUnsupported text="This agent does not support temp uploads." />
      )}
    </ChromeShell>
  );
}
