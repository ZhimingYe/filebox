/**
 * Open or focus a neo chrome dock panel (Search / Collections / Transfer / …).
 * Idempotent: activates an existing panel id instead of duplicating.
 */

import type { DockviewApi } from 'dockview-react';

export function ensureChromePanel(
  api: DockviewApi,
  opts: {
    id: string;
    component: string;
    title: string;
    /** Prefer stacking below/right of Files when first opened. */
    direction?: 'below' | 'right' | 'within' | 'left' | 'above';
  },
): void {
  const existing = api.getPanel(opts.id);
  if (existing) {
    existing.api.setActive();
    return;
  }
  const files = api.getPanel('file-tree');
  const preview = api.panels.find((p) => p.api.component === 'preview');
  const reference = preview ?? files;
  api.addPanel({
    id: opts.id,
    component: opts.component,
    title: opts.title,
    position: reference
      ? {
          referencePanel: reference.id,
          direction: opts.direction ?? (preview ? 'below' : 'right'),
        }
      : undefined,
  });
}
