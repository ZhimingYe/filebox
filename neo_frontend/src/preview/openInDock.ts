/**
 * Route a Files open-file event into neo preview dock hosts.
 *
 * Each preview dock panel hosts classic usePreviewTabs + PreviewWorkspace
 * (#86 pin / DOM park / ViewerStateRegistry). Routing mirrors
 * openOrActivate across hosts:
 *  - file already open in a host → activate that host + tab
 *  - else open into an empty host (no tabs)
 *  - else add a new preview dock panel and queue the open until mount
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

export function findPreviewPanels(api: DockviewApi) {
  return api.panels.filter((p) => isPreviewPanel(p.api.component));
}

export function findFocusedPreview(api: DockviewApi) {
  const active = api.activePanel;
  if (active && isPreviewPanel(active.api.component)) return active;
  if (lastFocusedPreviewId) {
    const p = api.getPanel(lastFocusedPreviewId);
    if (p && isPreviewPanel(p.api.component)) return p;
  }
  return findPreviewPanels(api)[0];
}

/**
 * Close preview dock panels whose tabs belong to a different agent.
 */
export function closePreviewsForOtherAgents(api: DockviewApi, agentId: string): void {
  for (const p of findPreviewPanels(api)) {
    const host = getPreviewHost(p.id);
    if (host?.belongsToOtherAgent(agentId)) {
      if (lastFocusedPreviewId === p.id) lastFocusedPreviewId = null;
      p.api.close();
      continue;
    }
    // Host not mounted yet / empty — leave empty shells alone.
  }
  // Also drop in-host tabs for other agents when the host is shared (shouldn't
  // happen with per-agent close-panel policy, but keep hosts consistent).
  for (const host of listPreviewHosts()) {
    if (host.belongsToOtherAgent(agentId)) host.closeAll();
  }
}

/** Add an empty preview dock panel (header "New Preview"). */
export function addEmptyPreviewPanel(api: DockviewApi): string {
  const focused = findFocusedPreview(api);
  const files = api.getPanel('file-tree');
  const id = nextPreviewId();
  api.addPanel({
    id,
    component: PREVIEW_COMPONENT,
    title: 'Preview',
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

export function openFileInDock(api: DockviewApi, detail: NeoOpenFileDetail): void {
  closePreviewsForOtherAgents(api, detail.agentId);

  if (!detail.newPanel) {
    const existing = findHostForFile(detail);
    if (existing) {
      existing.openOrActivate(detail);
      const panel = api.getPanel(existing.panelId);
      panel?.api.setActive();
      lastFocusedPreviewId = existing.panelId;
      return;
    }

    const empty = findEmptyHost();
    if (empty) {
      empty.openOrActivate(detail);
      const panel = api.getPanel(empty.panelId);
      panel?.api.setActive();
      lastFocusedPreviewId = empty.panelId;
      return;
    }

    // Prefer a dock panel with no host yet (initial empty "Preview" shell).
    const shell = findPreviewPanels(api).find((p) => !getPreviewHost(p.id));
    if (shell) {
      enqueuePendingOpen(shell.id, detail);
      // Host may already be registering — also try immediate if it appears.
      const host = getPreviewHost(shell.id);
      if (host) host.openOrActivate(detail);
      shell.api.setActive();
      lastFocusedPreviewId = shell.id;
      return;
    }
  }

  const focused = findFocusedPreview(api);
  const files = api.getPanel('file-tree');
  const id = nextPreviewId();
  enqueuePendingOpen(id, detail);
  api.addPanel({
    id,
    component: PREVIEW_COMPONENT,
    title: detail.entry.name || 'Preview',
    params: { pendingOpen: detail } satisfies PreviewPanelParams,
    position: focused
      ? { referencePanel: focused.id, direction: 'within' }
      : files
        ? { referencePanel: files.id, direction: 'right' }
        : undefined,
  });
  lastFocusedPreviewId = id;
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
