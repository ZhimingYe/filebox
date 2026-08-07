// Persistence helpers for the browse position, shared by App's refresh
// restore (seeded maps + the vanished-folder validation walk). Kept free of
// React so the storage contract — keys, shapes, and the (agent,root)
// composite key — lives in one place.
import { fsStat } from '../api/client';

/** Refresh-persistence keys: the browse position, the selected agent, and
 *  the Files/Explorer mode survive a page refresh. */
export const VIEW_STORAGE = 'filebox.view';
export const LAST_AGENT_STORAGE = 'filebox.lastAgent';
export const NAV_POS_STORAGE = 'filebox.navPos';
export const PATH_MEM_STORAGE = 'filebox.pathMemory';

/** Composite key for per-(agent,root) state (path memory, restore validation). */
export const memKey = (agentId: string, root: string) => `${agentId}:${root}`;

function loadJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

/** Seed the per-agent position map from localStorage (refresh restore).
 *  Values are shape-checked because the storage is untrusted JSON. */
export function loadNavPosMap(): Map<string, { root: string; path: string }> {
  const saved = loadJson<Record<string, unknown>>(NAV_POS_STORAGE) ?? {};
  const map = new Map<string, { root: string; path: string }>();
  for (const [agentId, pos] of Object.entries(saved)) {
    const p = pos as { root?: unknown; path?: unknown } | null;
    if (p && typeof p.root === 'string' && typeof p.path === 'string') {
      map.set(agentId, { root: p.root, path: p.path });
    }
  }
  return map;
}

/** Seed the per-(agent,root) path memory from localStorage (refresh restore). */
export function loadPathMemoryMap(): Map<string, string> {
  const saved = loadJson<Record<string, unknown>>(PATH_MEM_STORAGE) ?? {};
  const map = new Map<string, string>();
  for (const [key, path] of Object.entries(saved)) {
    if (typeof path === 'string') map.set(key, path);
  }
  return map;
}

/** Persist both maps after a navigation so a refresh restores the position.
 *  Storage may be unavailable in hardened/private contexts — never let a
 *  persistence failure break the session. */
export function persistNavState(
  filePosByAgent: Map<string, { root: string; path: string }>,
  pathMemory: Map<string, string>,
): void {
  try {
    localStorage.setItem(NAV_POS_STORAGE, JSON.stringify(Object.fromEntries(filePosByAgent)));
    localStorage.setItem(PATH_MEM_STORAGE, JSON.stringify(Object.fromEntries(pathMemory)));
  } catch { /* ignore */ }
}

/** Walk up from `path` toward the root until a directory actually exists.
 *  Returns the nearest existing ancestor (or the path itself); null on
 *  transient failures so callers keep the original position untouched.
 *  Passing a signal lets a navigation away abort the walk mid-flight. */
export async function findNearestExistingDir(
  agentId: string,
  root: string,
  path: string,
  signal?: AbortSignal,
): Promise<string | null> {
  let candidate = path;
  for (;;) {
    if (signal?.aborted) return null;
    try {
      const res = await fsStat(agentId, root, candidate, signal);
      if (res.stat && res.stat.entry_type === 'directory') return candidate;
    } catch {
      return null;
    }
    const parent = candidate.replace(/\/[^/]*$/, '') || '/';
    if (parent === candidate) return null;
    candidate = parent;
  }
}
