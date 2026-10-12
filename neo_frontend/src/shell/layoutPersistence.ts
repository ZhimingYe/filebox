/**
 * Persist / restore dockview layout (panel positions only — React panel
 * state like preview tabs is still ephemeral).
 */

import type { DockviewApi } from 'dockview-react';

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
}

/** Debounced save on layout changes; returns disposer. */
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
  return () => {
    if (timer) clearTimeout(timer);
    sub.dispose();
  };
}

export function tryRestoreDockLayout(api: DockviewApi): boolean {
  const data = loadDockLayout();
  if (!data || typeof data !== 'object') return false;
  try {
    api.fromJSON(data as Parameters<DockviewApi['fromJSON']>[0]);
    return api.panels.length > 0;
  } catch (err) {
    console.warn('neo: dock layout restore failed, using default', err);
    clearDockLayout();
    return false;
  }
}
