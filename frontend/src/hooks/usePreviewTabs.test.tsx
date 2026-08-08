import { act, useEffect } from 'react';
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
