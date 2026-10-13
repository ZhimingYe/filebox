/**
 * Persist / restore dockview layout + best-effort preview tab metadata.
 *
 * On restore, legacy v1 multi-tab preview hosts are expanded into one dock
 * panel per file (knife-cut #1).
 */

import type { DockviewApi } from 'dockview-react';
import { tabIdFor } from '@lib/hooks/usePreviewTabs';
import {
  enqueuePendingRestore,
  snapshotAllPreviewHosts,
} from '../preview/hostRegistry';
import { allocatePreviewPanelId } from '../preview/openInDock';
import {
  clearPreviewTabs,
  loadPreviewTabs,
  savePreviewTabs,
  type PersistedPreviewHost,
  type PersistedPreviewMap,
  type PersistedPreviewTab,
} from '../preview/tabPersistence';
import { PREVIEW_COMPONENT } from '../preview/types';

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

function pickPrimaryTab(snap: PersistedPreviewHost): PersistedPreviewTab | undefined {
  if (!snap.tabs.length) return undefined;
  if (snap.activeTabId) {
    const active = snap.tabs.find((t) => tabIdFor(t) === snap.activeTabId);
    if (active) return active;
  }
  return snap.tabs[0];
}

function singleTabSnap(tab: PersistedPreviewTab): PersistedPreviewHost {
  return {
    tabs: [tab],
    activeTabId: tabIdFor(tab),
  };
}

/**
 * Restore preview files onto dock panels. If a legacy snapshot has multiple
 * tabs on one panel, keep the primary on that panel and expand the rest into
 * sibling dock panels (within the same group).
 */
function queuePreviewRestores(api: DockviewApi, tabs: PersistedPreviewMap): void {
  for (const panel of [...api.panels]) {
    if (panel.api.component !== PREVIEW_COMPONENT) continue;
    const snap = tabs[panel.id];
    if (!snap?.tabs?.length) continue;

    const primary = pickPrimaryTab(snap);
    if (!primary) continue;

    enqueuePendingRestore(panel.id, singleTabSnap(primary));
    panel.api.setTitle(primary.title || primary.entry?.name || primary.path);

    const primaryId = tabIdFor(primary);
    const extras = snap.tabs.filter((t) => tabIdFor(t) !== primaryId);
    for (const t of extras) {
      const id = allocatePreviewPanelId();
      api.addPanel({
        id,
        component: PREVIEW_COMPONENT,
        title: t.title || t.entry?.name || t.path,
        params: {},
        position: { referencePanel: panel.id, direction: 'within' },
      });
      enqueuePendingRestore(id, singleTabSnap(t));
    }
  }
}
