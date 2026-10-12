/**
 * Last-known agent preview context for PreviewWorkspace (roots / office).
 * Updated from Files open-file and agent-selected events — avoids prop-drilling
 * dockview panel params through FileBrowser.
 */

import type { RootInfo } from '@classic/api/client';

export type NeoPreviewAgentContext = {
  agentId: string | null;
  roots: RootInfo[];
  officeCapable: boolean;
};

let ctx: NeoPreviewAgentContext = {
  agentId: null,
  roots: [],
  officeCapable: false,
};

const listeners = new Set<() => void>();

export function getPreviewAgentContext(): NeoPreviewAgentContext {
  return ctx;
}

export function setPreviewAgentContext(next: {
  agentId?: string | null;
  roots?: RootInfo[];
  officeCapable?: boolean;
}): void {
  ctx = {
    agentId: next.agentId !== undefined ? next.agentId : ctx.agentId,
    roots: next.roots !== undefined ? next.roots : ctx.roots,
    officeCapable: next.officeCapable !== undefined ? next.officeCapable : ctx.officeCapable,
  };
  for (const l of listeners) l();
}

export function subscribePreviewAgentContext(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
