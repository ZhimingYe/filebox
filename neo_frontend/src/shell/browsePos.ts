/**
 * Shared Files ↔ Explorer browse position (classic App-owned nav, neo store).
 */

export type NeoBrowsePos = {
  agentId: string;
  root: string;
  path: string;
};

let pos: NeoBrowsePos | null = null;
const listeners = new Set<() => void>();

export function getBrowsePos(): NeoBrowsePos | null {
  return pos;
}

export function setBrowsePos(next: NeoBrowsePos | null): void {
  if (
    pos?.agentId === next?.agentId
    && pos?.root === next?.root
    && pos?.path === next?.path
  ) {
    return;
  }
  pos = next;
  for (const l of listeners) l();
}

export function subscribeBrowsePos(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
