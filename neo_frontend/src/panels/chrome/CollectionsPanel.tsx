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
import { emitNeoOpenFile } from '../../events/openFile';
import { useNeoAgent } from '../../preview/agentContext';
import { ensureFilesThenReveal } from '../../shell/revealInFiles';
import { ChromeNeedAgent, ChromeShell } from './ChromeShell';

export function CollectionsPanel(props: IDockviewPanelProps) {
  const { agent } = useNeoAgent();
  const { refresh } = useHealth(true);

  const onOpenInFiles = useCallback((root: string, path: string) => {
    ensureFilesThenReveal(props.containerApi, {
      root,
      dirPath: path,
      ...(agent ? { agentId: agent.id } : {}),
    });
  }, [props.containerApi, agent]);

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
