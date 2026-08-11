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

describe('usePreviewTabs tab management', () => {
  it('activate() switches the active tab without touching revs', () => {
    renderHarness();
    act(() => {
      api.openOrActivate(A);
      api.openOrActivate(B);
    });
    const aRev = tabOf(A).rev;
    act(() => { api.activate(tabOf(A).id); });
    expect(api.activeTabId).toBe(tabOf(A).id);
    expect(tabOf(A).rev).toBe(aRev);
    expect(api.tabs).toHaveLength(2);
  });

  it('activate() on an unknown tab id is a no-op', () => {
    renderHarness();
    act(() => { api.openOrActivate(A); });
    act(() => { api.activate('nope'); });
    expect(api.activeTabId).toBe(tabOf(A).id);
  });

  it('closing the ACTIVE tab activates the nearest survivor (right neighbor on tie)', () => {
    renderHarness();
    act(() => {
      api.openOrActivate(A);
      api.openOrActivate(B);
      api.openOrActivate(C);
      api.openOrActivate(D);
    });
    // `api` only refreshes after an act flush, so tab lookups need their own
    // act block.
    act(() => { api.activate(tabOf(B).id); });
    expect(api.activeTabId).toBe(tabOf(B).id);
    act(() => { api.close(tabOf(B).id); });
    // A and C are equidistant from B's slot — the right neighbor wins.
    expect(api.activeTabId).toBe(tabOf(C).id);
    act(() => { api.close(tabOf(C).id); });
    expect(api.activeTabId).toBe(tabOf(D).id);
  });

  it('closing the LAST tab empties the state', () => {
    renderHarness();
    act(() => { api.openOrActivate(A); });
    act(() => { api.close(tabOf(A).id); });
    expect(api.tabs).toHaveLength(0);
    expect(api.activeTabId).toBeNull();
  });

  it('closeAll clears tabs and active selection', () => {
    renderHarness();
    act(() => {
      api.openOrActivate(A);
      api.openOrActivate(B);
    });
    act(() => { api.closeAll(); });
    expect(api.tabs).toHaveLength(0);
    expect(api.activeTabId).toBeNull();
  });

  it('pruneByRoots removes tabs of disabled roots and re-picks the active', () => {
    renderHarness();
    act(() => {
      api.openOrActivate(A);
      api.openOrActivate(WORK);
    });
    expect(api.activeTabId).toBe(tabOf(WORK).id);
    act(() => { api.pruneByRoots(['home']); });
    expect(api.tabs).toHaveLength(1);
    expect(api.tabs.some((t) => t.root === 'work')).toBe(false);
    expect(api.activeTabId).toBe(tabOf(A).id);
  });

  it('replaceAll (mobile) keeps exactly one tab', () => {
    renderHarness();
    act(() => {
      api.openOrActivate(A);
      api.openOrActivate(B);
    });
    act(() => { api.replaceAll(C); });
    expect(api.tabs).toHaveLength(1);
    expect(api.activeTabId).toBe(tabOf(C).id);
  });

  // Smoke test: StrictMode double-invokes updaters on the same `prev` and
  // applies the second result — what this pins is that the double-invoked
  // path does not crash, duplicate tabs, or lose the active selection.
  it('survives StrictMode double-invoked updaters without duplicating tabs', () => {
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
    act(() => { strictApi!.activate(strictApi!.tabs[0].id); });
    expect(strictApi!.tabs).toHaveLength(2);
    expect(strictApi!.activeTabId).toBe(strictApi!.tabs[0].id);
    act(() => { strictApi!.close(strictApi!.tabs[0].id); });
    expect(strictApi!.tabs).toHaveLength(1);
    act(() => { strictRoot.unmount(); });
  });
});

describe('usePreviewTabs pinning', () => {
  it('togglePin pins an unpinned tab and unpins a pinned one', () => {
    renderHarness();
    act(() => { api.openOrActivate(A); });
    act(() => { api.openOrActivate(B); });
    expect(tabOf(A).pinned).toBe(false);
    act(() => { api.togglePin(tabOf(A).id); });
    expect(tabOf(A).pinned).toBe(true);
    act(() => { api.togglePin(tabOf(A).id); });
    expect(tabOf(A).pinned).toBe(false);
  });

  it('togglePin on an unknown tab id is a no-op', () => {
    renderHarness();
    act(() => { api.openOrActivate(A); });
    act(() => { api.togglePin('no-such-tab'); });
    expect(api.tabs).toHaveLength(1);
    expect(tabOf(A).pinned).toBe(false);
  });

  it('a pinned tab stays pinned when re-opened, activated, or refreshed', () => {
    renderHarness();
    act(() => { api.openOrActivate(A); });
    act(() => { api.togglePin(tabOf(A).id); });
    // Re-open (plain click): metadata refresh, pin survives.
    act(() => { api.openOrActivate(A); });
    expect(tabOf(A).pinned).toBe(true);
    // Switch away and back.
    act(() => { api.openOrActivate(B); });
    act(() => { api.activate(tabOf(A).id); });
    expect(tabOf(A).pinned).toBe(true);
    // Manual refresh bumps rev, pin survives.
    act(() => { api.refresh(tabOf(A).id); });
    expect(tabOf(A).pinned).toBe(true);
    expect(tabOf(A).rev).toBe(1);
  });

  it('replaceActive to a different file starts unpinned (arrow nav replaces the tab)', () => {
    renderHarness();
    act(() => { api.openOrActivate(A); });
    act(() => { api.openOrActivate(B); });
    act(() => { api.activate(tabOf(A).id); });
    act(() => { api.togglePin(tabOf(A).id); });
    act(() => { api.replaceActive(C); });
    expect(tabOf(C).pinned).toBe(false);
  });

  it('closing other tabs preserves the pin; closing the pinned tab removes it', () => {
    renderHarness();
    act(() => { api.openOrActivate(A); });
    act(() => { api.openOrActivate(B); });
    act(() => { api.togglePin(tabOf(A).id); });
    act(() => { api.close(tabOf(B).id); });
    expect(api.tabs).toHaveLength(1);
    expect(tabOf(A).pinned).toBe(true);
    act(() => { api.close(tabOf(A).id); });
    expect(api.tabs).toHaveLength(0);
  });

  it('pruneByRoots drops pinned tabs of disabled roots', () => {
    renderHarness();
    act(() => { api.openOrActivate(A); });
    act(() => { api.openOrActivate(WORK); });
    act(() => { api.togglePin(tabOf(WORK).id); });
    act(() => { api.pruneByRoots(['home']); });
    expect(api.tabs).toHaveLength(1);
    expect(api.tabs[0].id).toBe(tabOf(A).id);
  });
});
