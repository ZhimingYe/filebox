/**
 * Hook for neo Files → Preview open-file routing.
 *
 * Files panel (FileBrowser) emits; Preview dock (openFileInDock / PreviewPanel)
 * subscribes. Keeps FileBrowser decoupled from dockview panel ids.
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
export const NEO_AGENT_SELECTED_EVENT = 'filebox-neo:agent-selected';

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

/** Files emits when the selected agent changes so Preview can drop foreign tabs. */
export function emitNeoAgentSelected(agentId: string | null): void {
  window.dispatchEvent(new CustomEvent(NEO_AGENT_SELECTED_EVENT, { detail: { agentId } }));
}

export function onNeoAgentSelected(
  handler: (agentId: string | null) => void,
): () => void {
  const listener = (ev: Event) => {
    const detail = (ev as CustomEvent<{ agentId: string | null }>).detail;
    handler(detail?.agentId ?? null);
  };
  window.addEventListener(NEO_AGENT_SELECTED_EVENT, listener);
  return () => window.removeEventListener(NEO_AGENT_SELECTED_EVENT, listener);
}
