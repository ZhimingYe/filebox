/**
 * Thin dock wrapper around classic ExplorerView (tree dual-mode).
 * Shares browse position with Files via browsePos store.
 */

import { useCallback, useSyncExternalStore } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import type { FsEntry } from '@classic/api/client';
import { ExplorerView } from '@classic/components/ExplorerView';
import { useHealth } from '@classic/state/health';
import {
  emitNeoCollectionPicker,
  emitNeoOpenFile,
  emitNeoRevealInBrowser,
} from '../../events/openFile';
import { useNeoAgent } from '../../preview/agentContext';
import { getBrowsePos, setBrowsePos, subscribeBrowsePos } from '../../shell/browsePos';
import { ChromeNeedAgent, ChromeShell } from './ChromeShell';

function useBrowsePos() {
  return useSyncExternalStore(subscribeBrowsePos, getBrowsePos, () => null);
}

export function ExplorerPanel(_props: IDockviewPanelProps) {
  const { agent } = useNeoAgent();
  const { refresh } = useHealth(true);
  const browse = useBrowsePos();

  const onNavigateDir = useCallback((root: string, path: string) => {
    if (!agent) return;
    setBrowsePos({ agentId: agent.id, root, path });
    emitNeoRevealInBrowser({ root, dirPath: path });
  }, [agent]);

  const onFileSelect = useCallback((root: string, path: string, entry: FsEntry) => {
    if (!agent) return;
    emitNeoOpenFile({
      agentId: agent.id,
      root,
      path,
      entry,
      roots: agent.roots,
      officeCapable: !!agent.capabilities?.office_pdf_preview,
    });
  }, [agent]);

  const onAddToCollection = useCallback((root: string, path: string, anchor: HTMLElement) => {
    emitNeoCollectionPicker({ agentId: agent?.id, root, path, anchor });
  }, [agent]);

  if (!agent) {
    return (
      <ChromeShell>
        <ChromeNeedAgent label="Explorer" />
      </ChromeShell>
    );
  }

  const currentDir =
    browse && browse.agentId === agent.id
      ? { root: browse.root, path: browse.path }
      : agent.roots.find((r) => r.enabled)
        ? { root: agent.roots.find((r) => r.enabled)!.name, path: '/' }
        : null;

  return (
    <ChromeShell>
      <ExplorerView
        agentId={agent.id}
        roots={agent.roots}
        active
        currentDir={currentDir}
        onNavigateDir={onNavigateDir}
        onFileSelect={onFileSelect}
        onAddToCollection={onAddToCollection}
        onRootsChange={refresh}
      />
    </ChromeShell>
  );
}
