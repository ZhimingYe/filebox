import { beforeEach, describe, expect, it } from 'vitest'
import {
  getViewerState,
  resetViewerStateRegistryForTests,
  setViewerState,
  clearViewerState,
  viewerStateKey,
} from './previewKeepAlive'
import { droppedPinnedIds, viewerKeysForTabs } from './pinRegistry'

describe('pin-only viewer registry cleanup', () => {
  beforeEach(() => resetViewerStateRegistryForTests())

  it('reports only tabs that stopped being pinned', () => {
    const prev = new Set(['a', 'b', 'c'])
    const now = new Set(['a', 'c'])
    expect(droppedPinnedIds(prev, now)).toEqual(['b'])
    expect(droppedPinnedIds(new Set(), now)).toEqual([])
    expect(droppedPinnedIds(prev, new Set())).toEqual(['a', 'b', 'c'])
  })

  it('clearing dropped tabs removes scroll/csv snapshots but keeps still-pinned ones', () => {
    setViewerState(viewerStateKey('a', 0), { kind: 'scroll', scrollTop: 10 })
    setViewerState(viewerStateKey('b', 0), { kind: 'csv', scrollTop: 20, view: 'raw' })
    setViewerState(viewerStateKey('c', 0), { kind: 'scroll', scrollTop: 30 })
    const dropped = droppedPinnedIds(new Set(['a', 'b', 'c']), new Set(['a', 'c']))
    for (const key of viewerKeysForTabs(dropped)) clearViewerState(key)
    expect(getViewerState(viewerStateKey('b', 0))).toBeUndefined()
    expect(getViewerState(viewerStateKey('a', 0))).toEqual({ kind: 'scroll', scrollTop: 10 })
    expect(getViewerState(viewerStateKey('c', 0))).toEqual({ kind: 'scroll', scrollTop: 30 })
  })
})
