/**
 * Persist / restore dockview layout + best-effort preview tab metadata.
 */

import type { DockviewApi } from 'dockview-react';
import {
  enqueuePendingRestore,
  snapshotAllPreviewHosts,
} from '../preview/hostRegistry';
import {
  clearPreviewTabs,
  loadPreviewTabs,
  savePreviewTabs,
  type PersistedPreviewMap,
} from '../preview/tabPersistence';

const STORAGE_KEY = 'filebox.neo.dockLayout.v1';
const SAVE_DEBOUNCE_MS = 400;

export function loadDockLayout(): unknown | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

export function saveDockLayout(api: DockviewApi): void {
  try {
    const json = api.toJSON();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(json));
    savePreviewTabs(snapshotAllPreviewHosts());
  } catch {
    /* private mode / quota */
  }
}

export function clearDockLayout(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
  clearPreviewTabs();
}

export function bindDockLayoutPersistence(api: DockviewApi): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      saveDockLayout(api);
    }, SAVE_DEBOUNCE_MS);
  };
  const sub = api.onDidLayoutChange(() => schedule());
  // Also persist when preview tabs change (hosts call notifyPreviewTabsChanged).
  const onTabs = () => schedule();
  window.addEventListener('filebox-neo:preview-tabs-changed', onTabs);
  return () => {
    if (timer) clearTimeout(timer);
    sub.dispose();
    window.removeEventListener('filebox-neo:preview-tabs-changed', onTabs);
  };
}

export function notifyPreviewTabsChanged(): void {
  window.dispatchEvent(new Event('filebox-neo:preview-tabs-changed'));
}

export function tryRestoreDockLayout(api: DockviewApi): boolean {
  const data = loadDockLayout();
  if (!data || typeof data !== 'object') return false;
  try {
    api.fromJSON(data as Parameters<DockviewApi['fromJSON']>[0]);
    const tabs = loadPreviewTabs();
    queuePreviewRestores(api, tabs);
    return api.panels.length > 0;
  } catch (err) {
    console.warn('neo: dock layout restore failed, using default', err);
    clearDockLayout();
    return false;
  }
}

function queuePreviewRestores(api: DockviewApi, tabs: PersistedPreviewMap): void {
  for (const panel of api.panels) {
    if (panel.api.component !== 'preview') continue;
    const snap = tabs[panel.id];
    if (snap?.tabs?.length) enqueuePendingRestore(panel.id, snap);
  }
}
