/**
 * Selected-agent context shared by Preview + chrome dock panels.
 * FilesPanel emits agent-selected; App/chrome panels subscribe.
 */

import { useSyncExternalStore } from 'react';
import type { AgentInfo, RootInfo } from '@classic/api/client';

export type NeoPreviewAgentContext = {
  agentId: string | null;
  agent: AgentInfo | null;
  roots: RootInfo[];
  officeCapable: boolean;
};

let ctx: NeoPreviewAgentContext = {
  agentId: null,
  agent: null,
  roots: [],
  officeCapable: false,
};

const listeners = new Set<() => void>();

export function getPreviewAgentContext(): NeoPreviewAgentContext {
  return ctx;
}

export function setPreviewAgentContext(next: {
  agentId?: string | null;
  agent?: AgentInfo | null;
  roots?: RootInfo[];
  officeCapable?: boolean;
}): void {
  const agent = next.agent !== undefined ? next.agent : ctx.agent;
  const agentId = next.agentId !== undefined ? next.agentId : (agent?.id ?? ctx.agentId);
  const roots = next.roots !== undefined ? next.roots : (agent?.roots ?? ctx.roots);
  const officeCapable = next.officeCapable !== undefined
    ? next.officeCapable
    : (agent ? !!agent.capabilities?.office_pdf_preview : ctx.officeCapable);
  ctx = { agentId, agent, roots, officeCapable };
  for (const l of listeners) l();
}

export function subscribePreviewAgentContext(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Subscribe chrome / preview panels to the selected agent. */
export function useNeoAgent(): NeoPreviewAgentContext {
  return useSyncExternalStore(
    subscribePreviewAgentContext,
    getPreviewAgentContext,
    getPreviewAgentContext,
  );
}
