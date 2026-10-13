import { useCallback, useState } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import { CollectionsView } from '@lib/components/CollectionsView';
import { usePreviewTabs } from '@lib/hooks/usePreviewTabs';
import { useHealth } from '@lib/state/health';
import { emitNeoRevealInBrowser } from '../../events/openFile';
import { useNeoAgent } from '../../preview/agentContext';
import { ChromeNeedAgent, ChromeShell } from './ChromeShell';

/** Thin dock wrapper — classic CollectionsView with its own PreviewWorkspace. */
export function CollectionsPanel(_props: IDockviewPanelProps) {
  const { agent } = useNeoAgent();
  const { refresh } = useHealth(true);
  const previewTabs = usePreviewTabs();
  const [splitRatio, setSplitRatio] = useState(0.42);

  const onOpenInFiles = useCallback((root: string, path: string) => {
    emitNeoRevealInBrowser({ root, dirPath: path });
  }, []);

  if (!agent) {
    return (
      <ChromeShell>
        <ChromeNeedAgent label="Collections" />
      </ChromeShell>
    );
  }

  return (
    <ChromeShell>
      <CollectionsView
        agent={agent}
        previewTabs={previewTabs}
        splitRatio={splitRatio}
        onSplitRatioChange={setSplitRatio}
        onOpenInFiles={onOpenInFiles}
        onRefresh={refresh}
      />
    </ChromeShell>
  );
}
