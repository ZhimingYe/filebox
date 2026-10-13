/**
 * Hook for neo Files ↔ Preview / chrome routing.
 * Keeps FileBrowser decoupled from dockview panel ids.
 */

import type { AgentInfo, FsEntry, RootInfo } from '@lib/api/client';

export type NeoOpenFileDetail = {
  agentId: string;
  root: string;
  path: string;
  entry: FsEntry;
  officeCapable?: boolean;
  roots?: RootInfo[];
  newPanel?: boolean;
  refresh?: boolean;
};

export type NeoAgentSelectedDetail = {
  agentId: string | null;
  agent?: AgentInfo | null;
  roots?: RootInfo[];
  officeCapable?: boolean;
};

export type NeoRevealInBrowserDetail = {
  root: string;
  dirPath: string;
  /** When set and ≠ Files selected agent, Files switches agent then navigates. */
  agentId?: string;
};

export type NeoCollectionPickerDetail = {
  /** Agent that owns the file; resolved against live health in App. */
  agentId?: string;
  root: string;
  path: string;
  anchor: HTMLElement;
};

export const NEO_OPEN_FILE_EVENT = 'filebox-neo:open-file';
export const NEO_AGENT_SELECTED_EVENT = 'filebox-neo:agent-selected';
export const NEO_REVEAL_IN_BROWSER_EVENT = 'filebox-neo:reveal-in-browser';
export const NEO_SELECT_AGENT_EVENT = 'filebox-neo:select-agent';
export const NEO_COLLECTION_PICKER_EVENT = 'filebox-neo:collection-picker';

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

/** Sidebar BackendList → FilesPanel agent selection. */
export function emitNeoSelectAgent(agentId: string): void {
  window.dispatchEvent(new CustomEvent(NEO_SELECT_AGENT_EVENT, { detail: { agentId } }));
}

export function onNeoSelectAgent(handler: (agentId: string) => void): () => void {
  const listener = (ev: Event) => {
    const detail = (ev as CustomEvent<{ agentId: string }>).detail;
    if (detail?.agentId) handler(detail.agentId);
  };
  window.addEventListener(NEO_SELECT_AGENT_EVENT, listener);
  return () => window.removeEventListener(NEO_SELECT_AGENT_EVENT, listener);
}

export function emitNeoCollectionPicker(detail: NeoCollectionPickerDetail): void {
  window.dispatchEvent(new CustomEvent(NEO_COLLECTION_PICKER_EVENT, { detail }));
}

export function onNeoCollectionPicker(
  handler: (detail: NeoCollectionPickerDetail) => void,
): () => void {
  const listener = (ev: Event) => {
    const detail = (ev as CustomEvent<NeoCollectionPickerDetail>).detail;
    if (detail) handler(detail);
  };
  window.addEventListener(NEO_COLLECTION_PICKER_EVENT, listener);
  return () => window.removeEventListener(NEO_COLLECTION_PICKER_EVENT, listener);
}
