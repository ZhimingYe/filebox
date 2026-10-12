/**
 * Hook for neo Files → Preview open-file routing.
 *
 * 开发助手3 owns Files browsing; 开发助手2 owns PreviewPane reuse.
 * FilesPanel emits here on file click; App/preview dock subscribes and
 * routes into the focused (or new) preview panel without coupling to
 * FileBrowser internals.
 */

import type { FsEntry } from '@classic/api/client';

export type NeoOpenFileDetail = {
  agentId: string;
  root: string;
  path: string;
  entry: FsEntry;
  /** Agent `capabilities.office_pdf_preview` when known. */
  officeCapable?: boolean;
  /**
   * Force a brand-new preview dock panel even when an empty or matching
   * panel already exists. Default openOrActivate semantics ignore this.
   */
  newPanel?: boolean;
};

export const NEO_OPEN_FILE_EVENT = 'filebox-neo:open-file';

export function emitNeoOpenFile(detail: NeoOpenFileDetail): void {
  window.dispatchEvent(new CustomEvent(NEO_OPEN_FILE_EVENT, { detail }));
}

export function onNeoOpenFile(
  handler: (detail: NeoOpenFileDetail) => void,
): () => void {
  const listener = (ev: Event) => {
    const detail = (ev as CustomEvent<NeoOpenFileDetail>).detail;
    if (detail) handler(detail);
  };
  window.addEventListener(NEO_OPEN_FILE_EVENT, listener);
  return () => window.removeEventListener(NEO_OPEN_FILE_EVENT, listener);
}
