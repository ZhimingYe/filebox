/**
 * Registry of neo preview dock hosts.
 *
 * Knife-cut #1: ≤1 file per panel. Each dock Preview panel hosts classic
 * usePreviewTabs + PreviewWorkspace with at most one tab (agent:root:path via
 * fileTabId). Same path on agent A vs B never shares a host.
 */

import { tabIdFor } from '@lib/hooks/usePreviewTabs';
import type { NeoOpenFileDetail } from '../events/openFile';
import type { PersistedPreviewHost } from './tabPersistence';

export type PreviewHostController = {
  panelId: string;
  /** Open or activate; hosts enforce ≤1 file (replace, never append). */
  openOrActivate: (detail: NeoOpenFileDetail) => void;
  hasTabs: () => boolean;
  hasFile: (detail: Pick<NeoOpenFileDetail, 'agentId' | 'root' | 'path'>) => boolean;
  belongsToOtherAgent: (agentId: string) => boolean;
  closeAll: () => void;
  /** Snapshot tab list for persistence (paths + pin, not viewer DOM state). */
  snapshot: () => PersistedPreviewHost;
  /** Best-effort restore: reopen file(s), re-apply pins, activate. */
  restore: (snap: PersistedPreviewHost) => void;
};

const hosts = new Map<string, PreviewHostController>();
/** At most one pending open per panel (≤1 file semantics). */
const pendingByPanel = new Map<string, NeoOpenFileDetail>();
const pendingRestore = new Map<string, PersistedPreviewHost>();

export function registerPreviewHost(controller: PreviewHostController): void {
  hosts.set(controller.panelId, controller);
  const pending = pendingByPanel.get(controller.panelId);
  if (pending) {
    pendingByPanel.delete(controller.panelId);
    controller.openOrActivate(pending);
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
  return listPreviewHosts().find((h) => !h.hasTabs() && !pendingByPanel.has(h.panelId));
}

export function panelHasPendingOpen(panelId: string): boolean {
  return pendingByPanel.has(panelId);
}

/**
 * Queue one open for a panel that has not mounted yet.
 * ≤1 file: a second different file is rejected (caller should open a new panel).
 */
export function enqueuePendingOpen(panelId: string, detail: NeoOpenFileDetail): void {
  const existing = pendingByPanel.get(panelId);
  if (existing) {
    if (fileTabId(existing) === fileTabId(detail)) return;
    return;
  }
  pendingByPanel.set(panelId, detail);
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

/** Stable id: agentId:root:path — isolates same path across agents. */
export function fileTabId(detail: Pick<NeoOpenFileDetail, 'agentId' | 'root' | 'path'>): string {
  return tabIdFor(detail);
}
