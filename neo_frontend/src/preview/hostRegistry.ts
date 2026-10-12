/**
 * Registry of neo preview dock hosts (one classic PreviewWorkspace per panel).
 * openFileInDock talks to hosts instead of stuffing a single file into params.
 */

import { tabIdFor } from '@classic/hooks/usePreviewTabs';
import type { NeoOpenFileDetail } from '../events/openFile';

export type PreviewHostController = {
  panelId: string;
  openOrActivate: (detail: NeoOpenFileDetail) => void;
  hasTabs: () => boolean;
  hasFile: (detail: Pick<NeoOpenFileDetail, 'agentId' | 'root' | 'path'>) => boolean;
  /** True when any open tab belongs to a different agent. */
  belongsToOtherAgent: (agentId: string) => boolean;
  /** Close all tabs in this host (agent clear). */
  closeAll: () => void;
};

const hosts = new Map<string, PreviewHostController>();
const pendingByPanel = new Map<string, NeoOpenFileDetail[]>();

export function registerPreviewHost(controller: PreviewHostController): void {
  hosts.set(controller.panelId, controller);
  const pending = pendingByPanel.get(controller.panelId);
  if (pending?.length) {
    pendingByPanel.delete(controller.panelId);
    for (const detail of pending) controller.openOrActivate(detail);
  }
}

export function unregisterPreviewHost(panelId: string): void {
  hosts.delete(panelId);
  pendingByPanel.delete(panelId);
}

export function getPreviewHost(panelId: string): PreviewHostController | undefined {
  return hosts.get(panelId);
}

export function listPreviewHosts(): PreviewHostController[] {
  return [...hosts.values()];
}

export function findHostForFile(
  detail: Pick<NeoOpenFileDetail, 'agentId' | 'root' | 'path'>,
): PreviewHostController | undefined {
  return listPreviewHosts().find((h) => h.hasFile(detail));
}

export function findEmptyHost(): PreviewHostController | undefined {
  return listPreviewHosts().find((h) => !h.hasTabs());
}

/** Queue an open until the panel host registers (addPanel → mount race). */
export function enqueuePendingOpen(panelId: string, detail: NeoOpenFileDetail): void {
  const q = pendingByPanel.get(panelId) ?? [];
  q.push(detail);
  pendingByPanel.set(panelId, q);
}

export function fileTabId(detail: Pick<NeoOpenFileDetail, 'agentId' | 'root' | 'path'>): string {
  return tabIdFor(detail);
}
