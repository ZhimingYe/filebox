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
//  - Each tab carries a `rev` (refresh generation). Two distinct refresh
//    semantics, both documented at their call sites:
//      * `refresh: true` in the open/replace input (search "view"): the
//        preview body remounts and re-fetches even when the file already
//        has a tab — an explicit "look again" must not show stale content.
//      * `refresh(tabId)` (manual refresh button): bumps rev for the
//        active tab.
//    Plain re-opens (file-list clicks) never bump rev — resetting an
//    already-open viewer's state (PDF page, zoom, scroll) on a mere click
//    would be a regression. `replaceActive` (arrow navigation) never bumps:
//    re-activating an existing tab must not reset the viewer.
//  - Tabs are metadata only. Exactly one preview body is mounted at a time
//    (the active tab — PreviewWorkspace renders one pane), so inactive tabs
//    hold no viewer resources and switching back remounts the viewer fresh.
//    The sole exception is the HTML preview's scroll position, which
//    HtmlPreview caches itself keyed by file and restores on switch-back
//    only when the file is unchanged (hub ETag match) — see HtmlPreview.tsx.
//    Everything else (PDF page, zoom, Monaco scroll) resets on tab switch,
//    by design: keeping up to five hidden bodies mounted roughly
//    quintupled HTML preview load.
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
  /** Refresh generation — bumped to force the preview body to remount. */
  rev: number;
}

export interface TabInput {
  agentId: string;
  root: string;
  path: string;
  entry: FsEntry;
  /**
   * Force a remount of the preview body when the file already has a tab
   * (re-fetch content). Only "explicitly look again" intents set this —
   * currently the search pane's "Open in preview" action. Plain file-list
   * clicks keep the old no-refresh semantics so an already-open viewer
   * (PDF page, image zoom, scroll position) is never reset by a click.
   */
  refresh?: boolean;
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
    rev: 0,
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
  survive: (t: PreviewTab, index: number) => boolean,
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
          if (!survive(t, i)) return;
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
  /** Bump a tab's refresh generation so its preview body remounts. */
  refresh: (tabId: string) => void;
  /** Close a tab by id; if it was active, activate the nearest neighbor. */
  close: (tabId: string) => void;
  /** Close every tab. */
  closeAll: () => void;
  /** Close every tab before the referenced tab. */
  closeLeft: (tabId: string) => void;
  /** Close every tab after the referenced tab. */
  closeRight: (tabId: string) => void;
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
        // Refresh entry metadata; bump rev ONLY when the caller asked for
        // it (`refresh: true` — search "view"). A plain re-open (file-list
        // click) must not reset an already-open viewer's state.
        ? prev.tabs.map((t) => (
          t.id === id
            ? {
              ...t,
              entry: input.entry,
              title: input.entry.name,
              rev: input.refresh ? t.rev + 1 : t.rev,
            }
            : t
        ))
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
      // Target file already has a tab: just activate it, leaving the
      // current active tab in place. Arrow navigation must never delete a
      // tab the user opened explicitly, and we never keep two tabs for the
      // same file. When the target IS the active tab itself this is a true
      // no-op.
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
    setState((prev) => {
      if (!prev.tabs.some((t) => t.id === tabId)) return prev;
      return { ...prev, activeTabId: tabId };
    });
  }, []);

  /** Bump a tab's refresh generation so its preview body remounts (manual refresh). */
  const refresh = useCallback((tabId: string) => {
    setState((prev) => {
      if (!prev.tabs.some((t) => t.id === tabId)) return prev;
      return {
        ...prev,
        tabs: prev.tabs.map((t) => (t.id === tabId ? { ...t, rev: t.rev + 1 } : t)),
      };
    });
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

  const closeLeft = useCallback((tabId: string) => {
    setState((prev) => {
      const index = prev.tabs.findIndex((tab) => tab.id === tabId);
      if (index <= 0) return prev;
      return pickNearestSurvivor(prev.tabs, prev.activeTabId, (_, tabIndex) => tabIndex >= index);
    });
  }, []);

  const closeRight = useCallback((tabId: string) => {
    setState((prev) => {
      const index = prev.tabs.findIndex((tab) => tab.id === tabId);
      if (index === -1 || index === prev.tabs.length - 1) return prev;
      return pickNearestSurvivor(prev.tabs, prev.activeTabId, (_, tabIndex) => tabIndex <= index);
    });
  }, []);

  const replaceAll = useCallback((input: TabInput | null) => {
    if (!input) {
      setState(EMPTY);
      return;
    }
    const id = tabIdFor(input);
    setState((prev) => {
      const existing = prev.tabs.find((t) => t.id === id);
      // Mobile re-opens replace the single tab. Bump rev only when the
      // caller asked for it (search "view") — otherwise a plain re-open
      // must not reset the viewer, same rule as openOrActivate.
      const tab = existing
        ? {
          ...existing,
          entry: input.entry,
          title: input.entry.name,
          rev: input.refresh ? existing.rev + 1 : existing.rev,
        }
        : makeTab(input);
      return { tabs: [tab], activeTabId: id };
    });
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
    refresh,
    close,
    closeAll,
    closeLeft,
    closeRight,
    replaceAll,
    pruneByRoots,
  }), [state.tabs, state.activeTabId, activeTab, openOrActivate, replaceActive, activate, refresh, close, closeAll, closeLeft, closeRight, replaceAll, pruneByRoots]);
}
