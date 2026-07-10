import { useCallback, useMemo, useState } from 'react';
import type { FsEntry } from '../api/client';

// ── Preview tabs state ────────────────────────────────────────────────────
//
// This hook owns the multi-tab preview state for the desktop layout. It is
// state-only: it does not render UI, call file APIs, or know about
// desktop/mobile layout. App.tsx and PreviewWorkspace consume it.
//
// Invariants:
//  - `activeTabId` is non-null whenever `tabs` is non-empty, and null when
//    empty. The reducer keeps the two in sync so a tab array always has a
//    valid active selection (or is fully empty).
//  - A tab is identified by a stable id derived from (agentId, root, path).
//    Opening the same file again activates the existing tab instead of
//    creating a duplicate.
//  - All transitions are pure updater functions so they are safe under
//    React StrictMode's double-invoke.

export interface PreviewTab {
  id: string;
  agentId: string;
  root: string;
  path: string;
  entry: FsEntry;
  /** Visible tab title — the file's basename. */
  title: string;
}

export interface TabInput {
  agentId: string;
  root: string;
  path: string;
  entry: FsEntry;
}

export function tabIdFor(input: { agentId: string; root: string; path: string }): string {
  return `${input.agentId}:${input.root}:${input.path}`;
}

function makeTab(input: TabInput): PreviewTab {
  return {
    id: tabIdFor(input),
    agentId: input.agentId,
    root: input.root,
    path: input.path,
    entry: input.entry,
    title: input.entry.name,
  };
}

type State = { tabs: PreviewTab[]; activeTabId: string | null };

const EMPTY: State = { tabs: [], activeTabId: null };

// After removing tabs that fail `survive`, pick a new active id:
//  - if the current active survives, keep it;
//  - otherwise pick the surviving tab whose original index is nearest to the
//    active's original index, breaking ties toward the RIGHT neighbor (the
//    browser convention for "close tab → activate next").
function pickNearestSurvivor(
  tabs: PreviewTab[],
  activeTabId: string | null,
  survive: (t: PreviewTab) => boolean,
): { tabs: PreviewTab[]; activeTabId: string | null } {
  const nextTabs = tabs.filter(survive);
  let nextActiveId: string | null = activeTabId;
  const activeStillPresent = activeTabId !== null && nextTabs.some((t) => t.id === activeTabId);
  if (!activeStillPresent) {
    if (nextTabs.length === 0) {
      nextActiveId = null;
    } else {
      const activeIdx = activeTabId ? tabs.findIndex((t) => t.id === activeTabId) : -1;
      if (activeIdx === -1) {
        nextActiveId = nextTabs[0].id;
      } else {
        // Closest survivor by distance; on a tie prefer the one to the RIGHT
        // of the active index (the browser "close → activate next" convention).
        // At any given distance d there is at most one survivor on each side,
        // so a simple left/right preference resolves ties deterministically.
        let bestIdx = -1;
        let bestDist = Infinity;
        let bestOnRight = false;
        tabs.forEach((t, i) => {
          if (!survive(t)) return;
          const dist = Math.abs(i - activeIdx);
          const onRight = i > activeIdx;
          if (dist < bestDist || (dist === bestDist && onRight && !bestOnRight)) {
            bestDist = dist;
            bestIdx = i;
            bestOnRight = onRight;
          }
        });
        nextActiveId = bestIdx !== -1 ? tabs[bestIdx].id : nextTabs[0].id;
      }
    }
  }
  return { tabs: nextTabs, activeTabId: nextActiveId };
}

export interface UsePreviewTabs {
  tabs: PreviewTab[];
  activeTabId: string | null;
  activeTab: PreviewTab | null;
  /** Activate an existing tab for this file, or append a new one. */
  openOrActivate: (input: TabInput) => void;
  /** Replace the active tab's contents in-place (used by arrow navigation). */
  replaceActive: (input: TabInput) => void;
  /** Activate a tab by id. */
  activate: (tabId: string) => void;
  /** Close a tab by id; if it was active, activate the nearest neighbor. */
  close: (tabId: string) => void;
  /** Close every tab. */
  closeAll: () => void;
  /** Replace the whole tab list with exactly one tab (mobile), or clear (null). */
  replaceAll: (input: TabInput | null) => void;
  /** Remove tabs whose root is no longer enabled; re-pick active if needed. */
  pruneByRoots: (enabledRootNames: Set<string> | string[]) => void;
}

export function usePreviewTabs(): UsePreviewTabs {
  const [state, setState] = useState<State>(EMPTY);

  const openOrActivate = useCallback((input: TabInput) => {
    const id = tabIdFor(input);
    setState((prev) => {
      const exists = prev.tabs.some((t) => t.id === id);
      const tabs = exists
        // Refresh entry metadata in case the file changed; keep tab order.
        ? prev.tabs.map((t) => (t.id === id ? { ...t, entry: input.entry, title: input.entry.name } : t))
        : [...prev.tabs, makeTab(input)];
      return { tabs, activeTabId: id };
    });
  }, []);

  const replaceActive = useCallback((input: TabInput) => {
    const newId = tabIdFor(input);
    setState((prev) => {
      if (prev.tabs.length === 0) {
        return { tabs: [makeTab(input)], activeTabId: newId };
      }
      const activeIdx = prev.activeTabId ? prev.tabs.findIndex((t) => t.id === prev.activeTabId) : -1;
      // Target file already has a tab: just activate it, leaving the current
      // active tab in place. Arrow navigation must never delete a tab the user
      // opened explicitly, and we never keep two tabs for the same file. (When
      // the target IS the active tab itself, this is a harmless no-op.)
      if (prev.tabs.some((t) => t.id === newId)) {
        return prev.activeTabId === newId ? prev : { ...prev, activeTabId: newId };
      }
      if (activeIdx === -1) {
        return { tabs: [...prev.tabs, makeTab(input)], activeTabId: newId };
      }
      const tabs = [...prev.tabs];
      tabs[activeIdx] = makeTab(input);
      return { tabs, activeTabId: newId };
    });
  }, []);

  const activate = useCallback((tabId: string) => {
    setState((prev) => (prev.tabs.some((t) => t.id === tabId) ? { ...prev, activeTabId: tabId } : prev));
  }, []);

  const close = useCallback((tabId: string) => {
    setState((prev) => {
      const res = pickNearestSurvivor(prev.tabs, prev.activeTabId, (t) => t.id !== tabId);
      // No-op if nothing was actually removed (closing an unknown id).
      if (res.tabs.length === prev.tabs.length) return prev;
      return res;
    });
  }, []);

  const closeAll = useCallback(() => {
    setState((prev) => (prev.tabs.length === 0 ? prev : EMPTY));
  }, []);

  const replaceAll = useCallback((input: TabInput | null) => {
    if (!input) {
      setState(EMPTY);
      return;
    }
    const tab = makeTab(input);
    setState({ tabs: [tab], activeTabId: tab.id });
  }, []);

  const pruneByRoots = useCallback((enabledRootNames: Set<string> | string[]) => {
    const set = enabledRootNames instanceof Set ? enabledRootNames : new Set(enabledRootNames);
    setState((prev) => {
      const res = pickNearestSurvivor(prev.tabs, prev.activeTabId, (t) => set.has(t.root));
      if (res.tabs.length === prev.tabs.length) return prev;
      return res;
    });
  }, []);

  const activeTab = useMemo(
    () => (state.activeTabId ? state.tabs.find((t) => t.id === state.activeTabId) ?? null : null),
    [state.tabs, state.activeTabId],
  );

  // Stable return object so consumers can depend on `tabs` without churning
  // (e.g. the keyboard effect in App.tsx) across unrelated re-renders.
  return useMemo<UsePreviewTabs>(() => ({
    tabs: state.tabs,
    activeTabId: state.activeTabId,
    activeTab,
    openOrActivate,
    replaceActive,
    activate,
    close,
    closeAll,
    replaceAll,
    pruneByRoots,
  }), [state.tabs, state.activeTabId, activeTab, openOrActivate, replaceActive, activate, close, closeAll, replaceAll, pruneByRoots]);
}
