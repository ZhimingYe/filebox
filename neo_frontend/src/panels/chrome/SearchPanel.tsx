/**
 * Thin dock wrapper around classic WorkspaceSearch.
 * Hit rows keep classic open-in-Files / open-in-preview behavior.
 */

import { useCallback } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import type { FsEntry } from '@lib/api/client';
import { WorkspaceSearch } from '@lib/components/WorkspaceSearch';
import {
  emitNeoOpenFile,
  emitNeoRevealInBrowser,
} from '../../events/openFile';
import { useNeoAgent } from '../../preview/agentContext';
import { getBrowsePos, setBrowsePos } from '../../shell/browsePos';
import { ensureFilesThenReveal } from '../../shell/revealInFiles';
import { ChromeNeedAgent, ChromeShell } from './ChromeShell';

export function SearchPanel(props: IDockviewPanelProps) {
  const { agent } = useNeoAgent();
  const api = props.containerApi;

  // Classic `openInFiles`: a search hit row opens its folder in Files (or
  // reveals it in Explorer when that is the active browsing surface). In neo
  // that means making sure the Files dock panel exists and is focused, then
  // navigating it; Explorer follows the shared browse position.
  const onOpenFile = useCallback((root: string, path: string) => {
    if (agent) setBrowsePos({ agentId: agent.id, root, path });
    const detail = {
      root,
      dirPath: path,
      ...(agent ? { agentId: agent.id } : {}),
    };
    if (api.activePanel?.id === 'chrome-explorer') {
      emitNeoRevealInBrowser(detail);
      return;
    }
    ensureFilesThenReveal(api, detail);
  }, [agent, api]);

  const onPreviewFile = useCallback((root: string, path: string) => {
    if (!agent) return;
    const name = path.split('/').filter(Boolean).pop() ?? path;
    const entry: FsEntry = {
      name,
      entry_type: 'file',
      size: null,
      modified: null,
      denied: false,
    };
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
        <ChromeNeedAgent label="Search" />
      </ChromeShell>
    );
  }

  const pos = getBrowsePos();
  const initialRoot =
    pos && pos.agentId === agent.id ? pos.root : null;

  return (
    <ChromeShell>
      <WorkspaceSearch
        agent={agent}
        initialRoot={initialRoot}
        onOpenFile={onOpenFile}
        onPreviewFile={onPreviewFile}
      />
    </ChromeShell>
  );
}
