/**
 * Route a Files open-file event into dockview preview panels.
 *
 * Semantics mirror classic `usePreviewTabs.openOrActivate`:
 *  - same file already open → activate that panel
 *  - else fill an empty preview panel if one exists
 *  - else add a new preview panel as a tab in the focused preview group
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

function toParams(detail: NeoOpenFileDetail): PreviewPanelParams {
  return {
    agentId: detail.agentId,
    root: detail.root,
    path: detail.path,
    entryType: detail.entry.entry_type,
    denied: detail.entry.denied,
    officeCapable: detail.officeCapable,
    rev: 0,
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
  const params = toParams(detail);
  const title = titleFor(detail);

  if (!detail.newPanel) {
    const existing = findPanelForFile(api, detail);
    if (existing) {
      existing.api.updateParameters(params);
      existing.api.setTitle(title);
      existing.api.setActive();
      lastFocusedPreviewId = existing.id;
      return;
    }

    const empty = findEmptyPreview(api);
    if (empty) {
      empty.api.updateParameters(params);
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
    params,
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
