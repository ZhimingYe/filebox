import { useSyncExternalStore } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import { TempTransferView } from '@classic/components/TempTransferView';
import { useNeoAgent } from '../../preview/agentContext';
import {
  clearUploadRequest,
  getTempRefreshNonce,
  getUploadRequest,
  subscribeUploadHandoff,
} from '../../shell/uploadHandoff';
import { ChromeNeedAgent, ChromeShell, ChromeUnsupported } from './ChromeShell';

function useUploadHandoff() {
  return useSyncExternalStore(
    subscribeUploadHandoff,
    () => ({
      uploadRequest: getUploadRequest(),
      tempRefreshNonce: getTempRefreshNonce(),
    }),
    () => ({ uploadRequest: null, tempRefreshNonce: 0 }),
  );
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
