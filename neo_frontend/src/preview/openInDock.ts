/**
 * Route a Files open-file event into dockview preview panels.
 *
 * Semantics mirror classic `usePreviewTabs.openOrActivate`:
 *  - same file already open → activate that panel (keep rev / viewer state)
 *  - else fill an empty preview panel if one exists
 *  - else add a new preview panel as a tab in the focused preview group
 *
 * Opening a file for agent A closes preview panels that still belong to
 * another agent (classic: previews never outlive the agent).
 *
 * `detail.newPanel` always creates a fresh panel.
 */

import type { DockviewApi } from 'dockview-react';
import type { NeoOpenFileDetail } from '../events/openFile';
import {
  PREVIEW_COMPONENT,
  basenamePath,
  previewPanelHasFile,
  type PreviewPanelParams,
} from './types';

let previewSeq = 0;

function nextPreviewId(): string {
  previewSeq += 1;
  return `preview-${previewSeq}-${Date.now().toString(36)}`;
}

function isPreviewPanel(component: string | undefined): boolean {
  return component === PREVIEW_COMPONENT;
}

function toParams(detail: NeoOpenFileDetail, rev = 0): PreviewPanelParams {
  return {
    agentId: detail.agentId,
    root: detail.root,
    path: detail.path,
    entryType: detail.entry.entry_type,
    denied: detail.entry.denied,
    officeCapable: detail.officeCapable,
    rev,
  };
}

function titleFor(detail: NeoOpenFileDetail): string {
  return detail.entry.name || basenamePath(detail.path) || 'Preview';
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

export function findEmptyPreview(api: DockviewApi) {
  return findPreviewPanels(api).find((p) => !previewPanelHasFile(p.api.getParameters<PreviewPanelParams>()));
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

export function findPanelForFile(api: DockviewApi, detail: NeoOpenFileDetail) {
  return findPreviewPanels(api).find((p) => {
    const prm = p.api.getParameters<PreviewPanelParams>();
    return (
      prm?.agentId === detail.agentId &&
      prm?.root === detail.root &&
      prm?.path === detail.path
    );
  });
}

/**
 * Close preview panels whose file belongs to a different agent.
 * Safe to call from Files on agent switch without importing dock internals.
 */
export function closePreviewsForOtherAgents(api: DockviewApi, agentId: string): void {
  for (const p of findPreviewPanels(api)) {
    const prm = p.api.getParameters<PreviewPanelParams>();
    if (prm?.agentId && prm.agentId !== agentId) {
      if (lastFocusedPreviewId === p.id) lastFocusedPreviewId = null;
      p.api.close();
    }
  }
}

/** Add an empty preview panel (header "New Preview" affordance). */
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
  // Classic: previews never outlive the agent they belong to.
  closePreviewsForOtherAgents(api, detail.agentId);

  const title = titleFor(detail);

  if (!detail.newPanel) {
    const existing = findPanelForFile(api, detail);
    if (existing) {
      const prev = existing.api.getParameters<PreviewPanelParams>();
      // Preserve rev so a plain re-click does not remount / reset the viewer.
      existing.api.updateParameters(toParams(detail, prev?.rev ?? 0));
      existing.api.setTitle(title);
      existing.api.setActive();
      lastFocusedPreviewId = existing.id;
      return;
    }

    const empty = findEmptyPreview(api);
    if (empty) {
      empty.api.updateParameters(toParams(detail, 0));
      empty.api.setTitle(title);
      empty.api.setActive();
      lastFocusedPreviewId = empty.id;
      return;
    }
  }

  const focused = findFocusedPreview(api);
  const files = api.getPanel('file-tree');
  const id = nextPreviewId();
  api.addPanel({
    id,
    component: PREVIEW_COMPONENT,
    title,
    params: toParams(detail, 0),
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
