import type { NeoOpenFileDetail } from '../events/openFile';

/**
 * Dockview panel params for neo preview panels.
 * Each panel hosts classic usePreviewTabs + PreviewWorkspace with ≤1 file
 * (dock tab title = basename). `pendingOpen` is a one-shot queue applied when
 * the host mounts or params update.
 */
export type PreviewPanelParams = {
  pendingOpen?: NeoOpenFileDetail;
};

export const PREVIEW_COMPONENT = 'preview';

export function basenamePath(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? path;
}
