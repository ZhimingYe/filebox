import { viewerStateKey } from './previewKeepAlive'

/** Tab ids that were pinned before and are not pinned now (unpin or closed). */
export function droppedPinnedIds(
  prev: ReadonlySet<string>,
  nowPinned: ReadonlySet<string>,
): string[] {
  const out: string[] = []
  for (const id of prev) {
    if (!nowPinned.has(id)) out.push(id)
  }
  return out
}

export function viewerKeysForTabs(ids: readonly string[]): string[] {
  return ids.map((id) => viewerStateKey(id, 0))
}
