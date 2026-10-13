/**
 * Route a Files open-file event into neo preview dock hosts.
 *
 * Each preview dock panel hosts classic usePreviewTabs + PreviewWorkspace
 * (#86 pin / DOM park / ViewerStateRegistry). Default open adds/activates a
 * tab inside the focused preview host (same PreviewWorkspace). A new dock
 * preview panel is created only when:
 *  - detail.newPanel is set, or
 *  - no preview host / shell exists yet.
 * Sidebar Preview uses addEmptyPreviewPanel (empty host for splits).
 *
 * Resolve order when opening a file:
 *  1. Host that already has this file (activate tab)
 *  2. Focused / last-focused Preview (survives Files becoming active)
 *  3. Empty Preview shell (user likely opened it to receive the file)
 *  4. Any host with tabs
 *  5. Unmounted preview shell still in the layout
 *  6. Create a new preview panel
 */

import type { DockviewApi } from 'dockview-react';
import type { NeoOpenFileDetail } from '../events/openFile';
import {
  enqueuePendingOpen,
  findEmptyHost,
  findHostForFile,
  getPreviewHost,
  listPreviewHosts,
} from './hostRegistry';
import { PREVIEW_COMPONENT, type PreviewPanelParams } from './types';

let previewSeq = 0;

function nextPreviewId(): string {
  previewSeq += 1;
  return `preview-${previewSeq}-${Date.now().toString(36)}`;
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
    // Stale id (panel closed) — drop it so callers use empty/withTabs fallbacks.
    lastFocusedPreviewId = null;
  }
  return undefined;
}

/**
 * Close preview dock panels whose tabs belong to a different agent.
 */
export function closePreviewsForOtherAgents(api: DockviewApi, agentId: string): void {
  for (const p of findPreviewPanels(api)) {
    const host = getPreviewHost(p.id);
    if (host?.belongsToOtherAgent(agentId)) {
      clearFocusedPreviewIf(p.id);
      p.api.close();
      continue;
    }
  }
  for (const host of listPreviewHosts()) {
    if (host.belongsToOtherAgent(agentId)) host.closeAll();
  }
}

function activateHostPanel(api: DockviewApi, panelId: string): void {
  const panel = api.getPanel(panelId);
  panel?.api.setActive();
  lastFocusedPreviewId = panelId;
}

function previewHostTitle(api: DockviewApi): string {
  const n = findPreviewPanels(api).length;
  return n === 0 ? 'Preview' : `Preview ${n + 1}`;
}

/** Add an empty preview dock panel (sidebar Preview). */
export function addEmptyPreviewPanel(api: DockviewApi): string {
  const focused = findFocusedPreview(api);
  const files = api.getPanel('file-tree');
  const id = nextPreviewId();
  api.addPanel({
    id,
    component: PREVIEW_COMPONENT,
    title: previewHostTitle(api),
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
    title: previewHostTitle(api),
    params: { pendingOpen: detail } satisfies PreviewPanelParams,
    position: focused
      ? { referencePanel: focused.id, direction: 'within' }
      : files
        ? { referencePanel: files.id, direction: 'right' }
        : undefined,
  });
  lastFocusedPreviewId = id;
}

export function openFileInDock(api: DockviewApi, detail: NeoOpenFileDetail): void {
  closePreviewsForOtherAgents(api, detail.agentId);

  // Explicit "open in new dock panel" (rare; sidebar Preview uses addEmptyPreviewPanel).
  if (detail.newPanel) {
    addPreviewPanelWithOpen(api, detail);
    return;
  }

  // File already open somewhere → activate that host + tab.
  const existing = findHostForFile(detail);
  if (existing) {
    existing.openOrActivate(detail);
    activateHostPanel(api, existing.panelId);
    return;
  }

  // Default: add/activate a tab inside the focused preview host's classic
  // usePreviewTabs (same PreviewWorkspace) so #86 pin UI can appear with 2+ tabs.
  const focusedPanel = findFocusedPreview(api);
  if (focusedPanel) {
    const host = getPreviewHost(focusedPanel.id);
    if (host) {
      host.openOrActivate(detail);
      activateHostPanel(api, host.panelId);
      return;
    }
    // Shell exists but host not registered yet — queue until mount.
    enqueuePendingOpen(focusedPanel.id, detail);
    focusedPanel.api.setActive();
    lastFocusedPreviewId = focusedPanel.id;
    return;
  }

  // Focus unknown: prefer an empty Preview shell (user likely opened one to
  // receive the file), then any host that already has tabs.
  const empty = findEmptyHost();
  if (empty) {
    empty.openOrActivate(detail);
    activateHostPanel(api, empty.panelId);
    return;
  }
  const withTabs = listPreviewHosts().find((h) => h.hasTabs());
  if (withTabs) {
    withTabs.openOrActivate(detail);
    activateHostPanel(api, withTabs.panelId);
    return;
  }

  // Unmounted preview shell still in dock layout.
  const shell = findPreviewPanels(api).find((p) => !getPreviewHost(p.id));
  if (shell) {
    enqueuePendingOpen(shell.id, detail);
    const host = getPreviewHost(shell.id);
    if (host) host.openOrActivate(detail);
    shell.api.setActive();
    lastFocusedPreviewId = shell.id;
    return;
  }

  // No preview at all — create the first dock preview panel.
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
