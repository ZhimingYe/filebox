/**
 * Route a Files open-file event into neo preview dock hosts.
 *
 * Knife-cut #1: one file = one dockview Preview panel. Dock tab title is the
 * file basename; classic PreviewWorkspace keeps ≤1 tab so its inner tab strip
 * stays hidden. Empty shells exist only via Sidebar New Preview / default layout.
 *
 * Resolve order when opening a file:
 *  1. Host that already has this file (agent:root:path) → activate
 *  2. Focused / last-focused empty Preview shell → fill + setTitle(basename)
 *  3. Any empty Preview host → fill + retitle
 *  4. Else create a new dock Preview panel (within focused preview group if
 *     possible, else right of Files), title=basename
 *  newPanel: true → skip empty reuse, force new panel
 *
 * Never append an inner tab into a host that already has a file.
 */

import type { DockviewApi } from 'dockview-react';
import type { NeoOpenFileDetail } from '../events/openFile';
import {
  enqueuePendingOpen,
  findEmptyHost,
  findHostForFile,
  getPreviewHost,
  listPreviewHosts,
  panelHasPendingOpen,
} from './hostRegistry';
import { PREVIEW_COMPONENT, basenamePath, type PreviewPanelParams } from './types';

let previewSeq = 0;

function nextPreviewId(): string {
  previewSeq += 1;
  return `preview-${previewSeq}-${Date.now().toString(36)}`;
}

/** Exported for layout restore expand of legacy multi-tab snapshots. */
export function allocatePreviewPanelId(): string {
  return nextPreviewId();
}

function isPreviewPanel(component: string | undefined): boolean {
  return component === PREVIEW_COMPONENT;
}

/** Last focused preview panel id (survives when Files panel becomes active). */
let lastFocusedPreviewId: string | null = null;

export function rememberFocusedPreview(panelId: string | null): void {
  lastFocusedPreviewId = panelId;
}

export function getLastFocusedPreviewId(): string | null {
  return lastFocusedPreviewId;
}

/** Clear sticky focus when the remembered preview panel is disposed. */
export function clearFocusedPreviewIf(panelId: string): void {
  if (lastFocusedPreviewId === panelId) lastFocusedPreviewId = null;
}

export function findPreviewPanels(api: DockviewApi) {
  return api.panels.filter((p) => isPreviewPanel(p.api.component));
}

export function findFocusedPreview(api: DockviewApi) {
  const active = api.activePanel;
  if (active && isPreviewPanel(active.api.component)) return active;
  if (lastFocusedPreviewId) {
    const p = api.getPanel(lastFocusedPreviewId);
    if (p && isPreviewPanel(p.api.component)) return p;
    // Stale id (panel closed) — drop it so callers use empty/create fallbacks.
    lastFocusedPreviewId = null;
  }
  return undefined;
}

/**
 * Close preview dock panels whose tabs belong to this agent.
 * Used when the agent goes offline / disappears from health — not on A→B
 * selection switch (knife-cut #3: sticky Preview ownership).
 */
export function closePreviewsForAgent(api: DockviewApi, agentId: string): void {
  console.debug('[neo] closePreviewsForAgent:start', { agentId });
  for (const p of findPreviewPanels(api)) {
    const host = getPreviewHost(p.id);
    // hasTabs + !belongsToOtherAgent ⇒ this host's file is for agentId
    if (host?.hasTabs() && !host.belongsToOtherAgent(agentId)) {
      clearFocusedPreviewIf(p.id);
      p.api.close();
      continue;
    }
  }
  for (const host of listPreviewHosts()) {
    if (host.hasTabs() && !host.belongsToOtherAgent(agentId)) host.closeAll();
  }
}

function activateHostPanel(api: DockviewApi, panelId: string): void {
  const panel = api.getPanel(panelId);
  panel?.api.setActive();
  lastFocusedPreviewId = panelId;
}

function dockTitleForOpen(detail: NeoOpenFileDetail): string {
  return detail.entry?.name || basenamePath(detail.path) || 'Preview';
}

function retitlePanel(api: DockviewApi, panelId: string, detail: NeoOpenFileDetail): void {
  api.getPanel(panelId)?.api.setTitle(dockTitleForOpen(detail));
}

function emptyShellTitle(api: DockviewApi): string {
  const n = findPreviewPanels(api).length;
  return n === 0 ? 'Preview' : `Preview ${n + 1}`;
}

function isHostEmpty(panelId: string): boolean {
  if (panelHasPendingOpen(panelId)) return false;
  const host = getPreviewHost(panelId);
  if (host) return !host.hasTabs();
  // Unmounted shell with no pending open counts as empty.
  return true;
}

/** Add an empty preview dock panel (sidebar Preview). */
export function addEmptyPreviewPanel(api: DockviewApi): string {
  const focused = findFocusedPreview(api);
  const files = api.getPanel('file-tree');
  const id = nextPreviewId();
  api.addPanel({
    id,
    component: PREVIEW_COMPONENT,
    title: emptyShellTitle(api),
    params: {} satisfies PreviewPanelParams,
    position: focused
      ? { referencePanel: focused.id, direction: 'within' }
      : files
        ? { referencePanel: files.id, direction: 'right' }
        : undefined,
  });
  lastFocusedPreviewId = id;
  return id;
}

function addPreviewPanelWithOpen(api: DockviewApi, detail: NeoOpenFileDetail): void {
  const focused = findFocusedPreview(api);
  const files = api.getPanel('file-tree');
  const id = nextPreviewId();
  // Only params.pendingOpen — do not also enqueue (would double-open on mount).
  api.addPanel({
    id,
    component: PREVIEW_COMPONENT,
    title: dockTitleForOpen(detail),
    params: { pendingOpen: detail } satisfies PreviewPanelParams,
    position: focused
      ? { referencePanel: focused.id, direction: 'within' }
      : files
        ? { referencePanel: files.id, direction: 'right' }
        : undefined,
  });
  lastFocusedPreviewId = id;
}

/**
 * Fill an empty host / shell with a file and retitle the dock tab.
 * Returns false if the target is not empty (caller should create a new panel).
 */
function fillEmptyPanel(
  api: DockviewApi,
  panelId: string,
  detail: NeoOpenFileDetail,
): boolean {
  if (!isHostEmpty(panelId)) return false;
  const host = getPreviewHost(panelId);
  if (host) {
    host.openOrActivate(detail);
    retitlePanel(api, panelId, detail);
    activateHostPanel(api, panelId);
    return true;
  }
  // Shell exists but host not registered yet — queue until mount.
  enqueuePendingOpen(panelId, detail);
  retitlePanel(api, panelId, detail);
  const panel = api.getPanel(panelId);
  panel?.api.setActive();
  lastFocusedPreviewId = panelId;
  return true;
}

export function openFileInDock(api: DockviewApi, detail: NeoOpenFileDetail): void {
  // Knife-cut #3: do not close other agents' Preview tabs on open (sticky ownership).
  if (!detail.agentId) {
    console.warn('[neo] openFileInDock: missing detail.agentId; refusing open', {
      root: detail.root,
      path: detail.path,
    });
    return;
  }

  // Explicit "open in new dock panel" — skip empty reuse.
  if (detail.newPanel) {
    addPreviewPanelWithOpen(api, detail);
    return;
  }

  // 1. Same agent:root:path already open → activate that host (never cross-agent).
  const existing = findHostForFile(detail);
  if (existing) {
    existing.openOrActivate(detail);
    retitlePanel(api, existing.panelId, detail);
    activateHostPanel(api, existing.panelId);
    return;
  }

  // 2. Focused / last-focused empty Preview shell → fill + setTitle(basename).
  const focusedPanel = findFocusedPreview(api);
  if (focusedPanel && isHostEmpty(focusedPanel.id)) {
    if (fillEmptyPanel(api, focusedPanel.id, detail)) return;
  }

  // 3. Any empty host → fill + retitle.
  const empty = findEmptyHost();
  if (empty && isHostEmpty(empty.panelId)) {
    if (fillEmptyPanel(api, empty.panelId, detail)) return;
  }

  // Unmounted empty preview shell still in dock layout (no host yet, no pending).
  const shell = findPreviewPanels(api).find((p) => isHostEmpty(p.id) && !getPreviewHost(p.id));
  if (shell) {
    if (fillEmptyPanel(api, shell.id, detail)) return;
  }

  // 4. No empty shell — create a new dock preview panel (do not append inner tabs).
  addPreviewPanelWithOpen(api, detail);
}

/** Same-origin popout of a preview panel (or its group). */
export async function popoutPreviewPanel(
  api: DockviewApi,
  panelId?: string | null,
): Promise<boolean> {
  const panel = panelId
    ? api.getPanel(panelId)
    : findFocusedPreview(api);
  if (!panel || !isPreviewPanel(panel.api.component)) return false;
  return api.addPopoutGroup(panel);
}
