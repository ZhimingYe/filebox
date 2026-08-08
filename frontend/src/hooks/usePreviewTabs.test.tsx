import { act, StrictMode, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { usePreviewTabs, type PreviewTab, type UsePreviewTabs } from './usePreviewTabs';
import type { FsEntry } from '../api/client';

// React 19 requires this flag for act() to flush updates synchronously.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ── Hook harness ─────────────────────────────────────────────────────────
// Renders a component that captures the hook's return value, so the tab
// reducer's pure-updater semantics can be asserted without a UI. Not under
// StrictMode — updaters run exactly once per dispatch here.

let root: Root;
let api: UsePreviewTabs;

function Harness() {
  const value = usePreviewTabs();
  // Copy into the module-level handle from an effect (not during render) so
  // the hook's latest return value is observable after each act() flush.
  useEffect(() => { api = value; });
  return null;
}

function renderHarness() {
  const el = document.createElement('div');
  root = createRoot(el);
  act(() => { root.render(<Harness />); });
}

afterEach(() => {
  act(() => { root.unmount(); });
});

function entry(name: string): FsEntry {
  return { name, entry_type: 'file', size: null, modified: null, denied: false };
}

function tabOf(input: { agentId: string; root: string; path: string }): PreviewTab {
  const tab = api.tabs.find(
    (t) => t.agentId === input.agentId && t.root === input.root && t.path === input.path,
  );
  expect(tab).toBeDefined();
  return tab!;
}

const A = { agentId: 'a1', root: 'home', path: '/docs/a.md', entry: entry('a.md') };
const B = { agentId: 'a1', root: 'home', path: '/docs/b.md', entry: entry('b.md') };
const C = { agentId: 'a1', root: 'home', path: '/docs/c.md', entry: entry('c.md') };
const D = { agentId: 'a1', root: 'home', path: '/docs/d.md', entry: entry('d.md') };
const E = { agentId: 'a1', root: 'home', path: '/docs/e.md', entry: entry('e.md') };
const F = { agentId: 'a1', root: 'home', path: '/docs/f.md', entry: entry('f.md') };
const G = { agentId: 'a1', root: 'home', path: '/docs/g.md', entry: entry('g.md') };
const WORK = { agentId: 'a1', root: 'work', path: '/x.md', entry: entry('x.md') };

describe('usePreviewTabs rev semantics', () => {
  it('opens a file with rev 0 and activates it', () => {
    renderHarness();
    act(() => { api.openOrActivate(A); });
    expect(api.tabs).toHaveLength(1);
    expect(api.activeTabId).toBe(tabOf(A).id);
    expect(tabOf(A).rev).toBe(0);
  });

  it('re-opening an already-open file with refresh:true bumps rev without duplicating the tab', () => {
    renderHarness();
    act(() => { api.openOrActivate(A); });
    const firstRev = tabOf(A).rev;
    act(() => { api.openOrActivate({ ...A, refresh: true }); });
    expect(api.tabs).toHaveLength(1);
    expect(tabOf(A).rev).toBe(firstRev + 1);
  });

  it('re-opening an already-open file without refresh keeps rev (viewer state preserved)', () => {
    renderHarness();
    act(() => { api.openOrActivate(A); });
    act(() => { api.openOrActivate(A); });
    expect(api.tabs).toHaveLength(1);
    expect(tabOf(A).rev).toBe(0);
  });

  it('leaves other tabs untouched when re-opening an open file', () => {
    renderHarness();
    act(() => {
      api.openOrActivate(A);
      api.openOrActivate(B);
    });
    const bRev = tabOf(B).rev;
    act(() => { api.openOrActivate({ ...A, refresh: true }); });
    expect(tabOf(B).rev).toBe(bRev);
    expect(tabOf(A).rev).toBe(1);
  });

  it('refresh() bumps the target tab rev and keeps active selection', () => {
    renderHarness();
    act(() => { api.openOrActivate(A); });
    const id = tabOf(A).id;
    act(() => { api.refresh(id); });
    expect(tabOf(A).rev).toBe(1);
    expect(api.activeTabId).toBe(id);
    expect(api.tabs).toHaveLength(1);
  });

  it('refresh() on an unknown tab id is a no-op', () => {
    renderHarness();
    act(() => { api.openOrActivate(A); });
    act(() => { api.refresh('nope'); });
    expect(tabOf(A).rev).toBe(0);
    expect(api.tabs).toHaveLength(1);
  });

  it('replaceActive to a different file starts a fresh rev', () => {
    renderHarness();
    act(() => {
      api.openOrActivate(A);
      api.replaceActive(B);
    });
    expect(api.tabs).toHaveLength(1);
    expect(tabOf(B).rev).toBe(0);
    expect(api.activeTabId).toBe(tabOf(B).id);
  });

  it('replaceActive onto a file that already has a tab just activates it', () => {
    renderHarness();
    act(() => {
      api.openOrActivate(A);
      api.openOrActivate(B);
    });
    const aRev = tabOf(A).rev;
    act(() => { api.replaceActive(A); });
    // No rev bump, no duplicate tab — arrow navigation must not refresh.
    expect(tabOf(A).rev).toBe(aRev);
    expect(api.tabs).toHaveLength(2);
    expect(api.activeTabId).toBe(tabOf(A).id);
  });

  it('replaceAll (mobile) on the already-open file with refresh:true bumps rev', () => {
    renderHarness();
    act(() => { api.replaceAll(A); });
    const firstRev = tabOf(A).rev;
    act(() => { api.replaceAll({ ...A, refresh: true }); });
    // Mobile re-opens replace the single tab — search "view" on an open file
    // must remount, otherwise it never refreshes on mobile.
    expect(api.tabs).toHaveLength(1);
    expect(tabOf(A).rev).toBe(firstRev + 1);
  });

  it('replaceAll (mobile) without refresh keeps rev (viewer state preserved)', () => {
    renderHarness();
    act(() => { api.replaceAll(A); });
    act(() => { api.replaceAll(A); });
    expect(api.tabs).toHaveLength(1);
    expect(tabOf(A).rev).toBe(0);
  });

  it('replaceAll (mobile) to a different file starts a fresh rev', () => {
    renderHarness();
    act(() => { api.replaceAll(A); });
    act(() => { api.replaceAll(B); });
    expect(api.tabs).toHaveLength(1);
    expect(tabOf(B).rev).toBe(0);
    expect(api.activeTabId).toBe(tabOf(B).id);
  });
});

describe('usePreviewTabs mounted-body cache (LRU, cap 5)', () => {
  it('caches every tab while at or under the cap, most recent first', () => {
    renderHarness();
    act(() => {
      api.openOrActivate(A);
      api.openOrActivate(B);
      api.openOrActivate(C);
    });
    expect(api.mountedTabIds).toEqual([tabOf(C).id, tabOf(B).id, tabOf(A).id]);
  });

  it('evicts the least-recently-used cached body when a 6th distinct file opens', () => {
    renderHarness();
    act(() => {
      api.openOrActivate(A);
      api.openOrActivate(B);
      api.openOrActivate(C);
      api.openOrActivate(D);
      api.openOrActivate(E);
      api.openOrActivate(F);
    });
    // Tabs themselves are unlimited — only the mounted-body cache is capped.
    expect(api.tabs).toHaveLength(6);
    expect(api.mountedTabIds).toEqual([
      tabOf(F).id, tabOf(E).id, tabOf(D).id, tabOf(C).id, tabOf(B).id,
    ]);
    expect(api.mountedTabIds).not.toContain(tabOf(A).id);
    expect(api.activeTabId).toBe(tabOf(F).id);
  });

  it('evicts by recency, not array position — re-activating an old tab protects it', () => {
    renderHarness();
    act(() => {
      api.openOrActivate(A);
      api.openOrActivate(B);
      api.openOrActivate(C);
      api.openOrActivate(D);
      api.openOrActivate(E);
    });
    act(() => { api.activate(tabOf(A).id); }); // A is now the most recent
    act(() => { api.openOrActivate(F); });
    // B was opened second and never used again — it is the true LRU, even
    // though it sits right behind A in the tab array.
    expect(api.mountedTabIds).toEqual([
      tabOf(F).id, tabOf(A).id, tabOf(E).id, tabOf(D).id, tabOf(C).id,
    ]);
    expect(api.mountedTabIds).not.toContain(tabOf(B).id);
  });

  it('activating a non-cached tab (6th+) mounts it into the cache and evicts the LRU', () => {
    renderHarness();
    act(() => {
      api.openOrActivate(A);
      api.openOrActivate(B);
      api.openOrActivate(C);
      api.openOrActivate(D);
      api.openOrActivate(E);
      api.openOrActivate(F);
    });
    act(() => { api.activate(tabOf(A).id); });
    expect(api.activeTabId).toBe(tabOf(A).id);
    expect(api.mountedTabIds).toEqual([
      tabOf(A).id, tabOf(F).id, tabOf(E).id, tabOf(D).id, tabOf(C).id,
    ]);
    expect(api.mountedTabIds).not.toContain(tabOf(B).id);
  });

  it('re-opening the active cached file does not churn the cache', () => {
    renderHarness();
    act(() => {
      api.openOrActivate(A);
      api.openOrActivate(B);
      api.openOrActivate(C);
      api.openOrActivate(D);
      api.openOrActivate(E);
      api.openOrActivate(F);
    });
    const before = [...api.mountedTabIds];
    act(() => { api.openOrActivate(F); });
    expect(api.mountedTabIds).toEqual(before);
  });

  it('closing a tab lets the previously evicted oldest tab back into the cache', () => {
    renderHarness();
    act(() => {
      api.openOrActivate(A);
      api.openOrActivate(B);
      api.openOrActivate(C);
      api.openOrActivate(D);
      api.openOrActivate(E);
      api.openOrActivate(F);
    });
    act(() => { api.close(tabOf(F).id); });
    expect(api.tabs).toHaveLength(5);
    // With 5 tabs every tab is within the cap — A re-enters the cache.
    expect(api.mountedTabIds).toHaveLength(5);
    expect(api.mountedTabIds).toContain(tabOf(A).id);
  });

  it('closing the ACTIVE tab with 6+ tabs left keeps the survivor cached and the cap intact', () => {
    renderHarness();
    act(() => {
      api.openOrActivate(A);
      api.openOrActivate(B);
      api.openOrActivate(C);
      api.openOrActivate(D);
      api.openOrActivate(E);
      api.openOrActivate(F);
      api.openOrActivate(G);
    });
    act(() => { api.activate(tabOf(A).id); }); // A newest, B oldest
    // Cache before close: [A, G, F, E, D].
    act(() => { api.close(tabOf(A).id); });
    // The survivor is picked by index proximity (B), not recency — but it
    // is now the active tab, so it must enter the cache (union semantics),
    // evicting the 5th-most-recent (C). The mounted set stays at the cap.
    expect(api.activeTabId).toBe(tabOf(B).id);
    expect(api.mountedTabIds).toEqual([
      tabOf(B).id, tabOf(G).id, tabOf(F).id, tabOf(E).id, tabOf(D).id,
    ]);
    expect(api.mountedTabIds).not.toContain(tabOf(C).id);
  });

  it('refresh() keeps a cached tab cached (rev bump must not evict)', () => {
    renderHarness();
    act(() => {
      api.openOrActivate(A);
      api.openOrActivate(B);
      api.openOrActivate(C);
      api.openOrActivate(D);
      api.openOrActivate(E);
      api.openOrActivate(F);
    });
    const before = [...api.mountedTabIds];
    act(() => { api.refresh(tabOf(B).id); });
    expect(tabOf(B).rev).toBe(1);
    expect(api.mountedTabIds).toEqual(before);
  });

  it('closeAll empties the mounted cache', () => {
    renderHarness();
    act(() => {
      api.openOrActivate(A);
      api.openOrActivate(B);
    });
    act(() => { api.closeAll(); });
    expect(api.tabs).toHaveLength(0);
    expect(api.mountedTabIds).toEqual([]);
  });

  it('recency stamps stay deterministic under StrictMode double-invoked updaters', () => {
    const el = document.createElement('div');
    const strictRoot = createRoot(el);
    let strictApi: UsePreviewTabs | undefined;
    function StrictHarness() {
      const value = usePreviewTabs();
      useEffect(() => { strictApi = value; });
      return null;
    }
    act(() => { strictRoot.render(<StrictMode><StrictHarness /></StrictMode>); });
    act(() => { strictApi!.openOrActivate(A); });
    act(() => { strictApi!.openOrActivate(B); });
    act(() => { strictApi!.activate(strictApi!.tabs[0].id); }); // re-activate A
    const idA = strictApi!.tabs.find((t) => t.path === A.path);
    const idB = strictApi!.tabs.find((t) => t.path === B.path);
    expect(idA).toBeDefined();
    expect(idB).toBeDefined();
    expect(strictApi!.tabs).toHaveLength(2);
    // B was opened later, then A re-activated — stamps strictly increase
    // and the active tab is cached first.
    expect(idA!.lastUsed).toBeGreaterThan(idB!.lastUsed);
    expect(strictApi!.activeTabId).toBe(idA!.id);
    expect(strictApi!.mountedTabIds).toEqual([idA!.id, idB!.id]);
    act(() => { strictRoot.unmount(); });
  });

  it('replaceActive into a fresh file bumps recency like an open', () => {
    renderHarness();
    act(() => {
      api.openOrActivate(A);
      api.openOrActivate(B);
      api.openOrActivate(C);
      api.openOrActivate(D);
      api.openOrActivate(E);
      api.openOrActivate(F);
    });
    act(() => { api.replaceActive(G); }); // arrow nav replaces the active F
    expect(api.tabs).toHaveLength(6);
    expect(api.mountedTabIds).toEqual([
      tabOf(G).id, tabOf(E).id, tabOf(D).id, tabOf(C).id, tabOf(B).id,
    ]);
    expect(api.mountedTabIds).not.toContain(tabOf(A).id);
  });

  it('pruned tabs leave the mounted cache', () => {
    renderHarness();
    act(() => {
      api.openOrActivate(A);
      api.openOrActivate(B);
      api.openOrActivate(C);
      api.openOrActivate(D);
      api.openOrActivate(E);
      api.openOrActivate(F);
      api.openOrActivate(WORK);
    });
    expect(api.tabs).toHaveLength(7);
    expect(api.mountedTabIds).not.toContain(tabOf(A).id);
    act(() => { api.pruneByRoots(['home']); });
    expect(api.tabs.some((t) => t.root === 'work')).toBe(false);
    // Cache only ever references live tabs, and shrinks to the cap.
    expect(api.mountedTabIds).toHaveLength(5);
    expect(api.mountedTabIds.every((id) => api.tabs.some((t) => t.id === id))).toBe(true);
  });

  it('replaceAll (mobile) caches exactly the single tab', () => {
    renderHarness();
    act(() => { api.replaceAll(A); });
    expect(api.mountedTabIds).toEqual([tabOf(A).id]);
  });
});
