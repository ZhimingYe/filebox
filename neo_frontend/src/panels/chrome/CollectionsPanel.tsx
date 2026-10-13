/**
 * Thin dock wrapper around @lib CollectionsView.
 * List-only: open files via main dock Preview host (emitNeoOpenFile),
 * not an embedded PreviewWorkspace / WorkspaceSplit preview half.
 */

import { useCallback } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import type { FsEntry } from '@lib/api/client';
import { CollectionsView } from '@lib/components/CollectionsView';
import { useHealth } from '@lib/state/health';
import { emitNeoOpenFile, emitNeoRevealInBrowser } from '../../events/openFile';
import { useNeoAgent } from '../../preview/agentContext';
import { ChromeNeedAgent, ChromeShell } from './ChromeShell';

export function CollectionsPanel(_props: IDockviewPanelProps) {
  const { agent } = useNeoAgent();
  const { refresh } = useHealth(true);

  const onOpenInFiles = useCallback((root: string, path: string) => {
    emitNeoRevealInBrowser({ root, dirPath: path });
  }, []);

  const onPreviewFile = useCallback((root: string, path: string, entry: FsEntry) => {
    if (!agent) return;
    emitNeoOpenFile({
      agentId: agent.id,
      root,
      path,
      entry,
      roots: agent.roots,
      officeCapable: !!agent.capabilities?.office_pdf_preview,
      refresh: true,
    });
  }, [agent]);

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
        hidePreview
        onPreviewFile={onPreviewFile}
        onOpenInFiles={onOpenInFiles}
        onRefresh={refresh}
      />
    </ChromeShell>
  );
}
