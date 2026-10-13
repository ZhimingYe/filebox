/**
 * Best-effort persistence of preview tab metadata (paths + pin flags).
 * Viewer DOM park / registry zoom-scroll state is NOT restored across reload
 * (would need deeper classic PreviewWorkspace hooks).
 *
 * v2: one file per dock panel. Legacy v1 multi-tab snapshots are still loaded
 * and expanded into multiple panels on restore (see layoutPersistence).
 */

import type { FsEntry } from '@lib/api/client';

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

const STORAGE_KEY = 'filebox.neo.previewTabs.v2';
const LEGACY_STORAGE_KEY = 'filebox.neo.previewTabs.v1';

function parseMap(raw: string | null): PersistedPreviewMap {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as PersistedPreviewMap;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function loadPreviewTabs(): PersistedPreviewMap {
  try {
    const v2 = parseMap(localStorage.getItem(STORAGE_KEY));
    if (Object.keys(v2).length > 0) return v2;
    // Migrate: return v1 as-is; expand multi-tab hosts at restore time.
    return parseMap(localStorage.getItem(LEGACY_STORAGE_KEY));
  } catch {
    return {};
  }
}

export function savePreviewTabs(map: PersistedPreviewMap): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
    // Drop legacy key once we have written v2 so reloads prefer the new shape.
    localStorage.removeItem(LEGACY_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

export function clearPreviewTabs(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(LEGACY_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
