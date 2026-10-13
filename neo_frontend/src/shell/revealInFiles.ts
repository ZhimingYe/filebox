/**
 * Ensure the Files dock panel exists and emit reveal-in-browser.
 * Agent switch + applyNav race lives in FilesPanel (pending reveal after
 * selectedAgentId settles) — this helper must not navigate itself.
 */

import type { DockviewApi } from 'dockview-react';
import {
  emitNeoRevealInBrowser,
  type NeoRevealInBrowserDetail,
} from '../events/openFile';

/** Ensure file-tree panel + focus, then emit reveal (defer if freshly mounted). */
export function ensureFilesThenReveal(
  api: DockviewApi,
  detail: NeoRevealInBrowserDetail,
): void {
  let files = api.getPanel('file-tree');
  const created = !files;
  if (!files) {
    files = api.addPanel({
      id: 'file-tree',
      component: 'fileTree',
      title: 'Files',
      position: { direction: 'left' },
    });
  }
  files.api.setActive();
  if (created) {
    // Let the freshly mounted FilesPanel subscribe before navigating.
    window.setTimeout(() => emitNeoRevealInBrowser(detail), 0);
  } else {
    emitNeoRevealInBrowser(detail);
  }
}
