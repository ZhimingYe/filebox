/**
 * Hook for neo Files → Preview open-file routing.
 *
 * Files panel (FileBrowser) emits; Preview dock (openFileInDock / PreviewPanel)
 * subscribes. Keeps FileBrowser decoupled from dockview panel ids.
 */

import type { AgentInfo, FsEntry, RootInfo } from '@classic/api/client';

export type NeoOpenFileDetail = {
  agentId: string;
  root: string;
  path: string;
  entry: FsEntry;
  /** Agent `capabilities.office_pdf_preview` when known. */
  officeCapable?: boolean;
  /** Agent roots — for PreviewWorkspace copy-full-path / chrome. */
  roots?: RootInfo[];
  /**
   * Force a brand-new preview dock panel even when an empty or matching
   * host already exists. Default openOrActivate semantics ignore this.
   */
  newPanel?: boolean;
  /** Classic search "view again" — bump rev on an existing tab. */
  refresh?: boolean;
};

export type NeoAgentSelectedDetail = {
  agentId: string | null;
  /** Full agent snapshot when selected (chrome panels need capabilities). */
  agent?: AgentInfo | null;
  roots?: RootInfo[];
  officeCapable?: boolean;
};

export type NeoRevealInBrowserDetail = {
  root: string;
  dirPath: string;
};

export const NEO_OPEN_FILE_EVENT = 'filebox-neo:open-file';
export const NEO_AGENT_SELECTED_EVENT = 'filebox-neo:agent-selected';
export const NEO_REVEAL_IN_BROWSER_EVENT = 'filebox-neo:reveal-in-browser';

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
export function emitNeoAgentSelected(detail: NeoAgentSelectedDetail): void {
  window.dispatchEvent(new CustomEvent(NEO_AGENT_SELECTED_EVENT, { detail }));
}

export function onNeoAgentSelected(
  handler: (detail: NeoAgentSelectedDetail) => void,
): () => void {
  const listener = (ev: Event) => {
    const detail = (ev as CustomEvent<NeoAgentSelectedDetail>).detail;
    handler(detail ?? { agentId: null });
  };
  window.addEventListener(NEO_AGENT_SELECTED_EVENT, listener);
  return () => window.removeEventListener(NEO_AGENT_SELECTED_EVENT, listener);
}

/** Preview path click → Files should open the containing directory. */
export function emitNeoRevealInBrowser(detail: NeoRevealInBrowserDetail): void {
  window.dispatchEvent(new CustomEvent(NEO_REVEAL_IN_BROWSER_EVENT, { detail }));
}

export function onNeoRevealInBrowser(
  handler: (detail: NeoRevealInBrowserDetail) => void,
): () => void {
  const listener = (ev: Event) => {
    const detail = (ev as CustomEvent<NeoRevealInBrowserDetail>).detail;
    if (detail) handler(detail);
  };
  window.addEventListener(NEO_REVEAL_IN_BROWSER_EVENT, listener);
  return () => window.removeEventListener(NEO_REVEAL_IN_BROWSER_EVENT, listener);
}
