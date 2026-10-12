/**
 * Registry of neo preview dock hosts (one classic PreviewWorkspace per panel).
 */

import { tabIdFor } from '@classic/hooks/usePreviewTabs';
import type { NeoOpenFileDetail } from '../events/openFile';
import type { PersistedPreviewHost } from './tabPersistence';

export type PreviewHostController = {
  panelId: string;
  openOrActivate: (detail: NeoOpenFileDetail) => void;
  hasTabs: () => boolean;
  hasFile: (detail: Pick<NeoOpenFileDetail, 'agentId' | 'root' | 'path'>) => boolean;
  belongsToOtherAgent: (agentId: string) => boolean;
  closeAll: () => void;
  /** Snapshot tab list for persistence (paths + pin, not viewer DOM state). */
  snapshot: () => PersistedPreviewHost;
  /** Best-effort restore: reopen files, re-apply pins, activate. */
  restore: (snap: PersistedPreviewHost) => void;
};

const hosts = new Map<string, PreviewHostController>();
const pendingByPanel = new Map<string, NeoOpenFileDetail[]>();
const pendingRestore = new Map<string, PersistedPreviewHost>();

export function registerPreviewHost(controller: PreviewHostController): void {
  hosts.set(controller.panelId, controller);
  const pending = pendingByPanel.get(controller.panelId);
  if (pending?.length) {
    pendingByPanel.delete(controller.panelId);
    for (const detail of pending) controller.openOrActivate(detail);
  }
  const snap = pendingRestore.get(controller.panelId);
  if (snap) {
    pendingRestore.delete(controller.panelId);
    controller.restore(snap);
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

export function enqueuePendingOpen(panelId: string, detail: NeoOpenFileDetail): void {
  const q = pendingByPanel.get(panelId) ?? [];
  q.push(detail);
  pendingByPanel.set(panelId, q);
}

export function enqueuePendingRestore(panelId: string, snap: PersistedPreviewHost): void {
  pendingRestore.set(panelId, snap);
}

export function snapshotAllPreviewHosts(): Record<string, PersistedPreviewHost> {
  const out: Record<string, PersistedPreviewHost> = {};
  for (const h of hosts.values()) {
    out[h.panelId] = h.snapshot();
  }
  return out;
}

export function fileTabId(detail: Pick<NeoOpenFileDetail, 'agentId' | 'root' | 'path'>): string {
  return tabIdFor(detail);
}
