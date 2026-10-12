/**
 * Best-effort persistence of preview tab metadata (paths + pin flags).
 * Viewer DOM park / registry zoom-scroll state is NOT restored across reload
 * (would need deeper classic PreviewWorkspace hooks).
 */

import type { FsEntry } from '@classic/api/client';

export type PersistedPreviewTab = {
  agentId: string;
  root: string;
  path: string;
  entry: FsEntry;
  title: string;
  pinned: boolean;
};

export type PersistedPreviewHost = {
  tabs: PersistedPreviewTab[];
  activeTabId: string | null;
};

export type PersistedPreviewMap = Record<string, PersistedPreviewHost>;

const STORAGE_KEY = 'filebox.neo.previewTabs.v1';

export function loadPreviewTabs(): PersistedPreviewMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as PersistedPreviewMap;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function savePreviewTabs(map: PersistedPreviewMap): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    /* ignore */
  }
}

export function clearPreviewTabs(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
