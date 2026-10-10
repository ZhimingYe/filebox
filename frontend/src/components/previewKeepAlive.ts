import type React from 'react';
import { isOfficePreviewExt } from './officePreviewSupport';

// Inline HTML check (same as isHtmlPreviewExt) to avoid a circular import
// with previewShared, which re-exports park styles from this module.
function isHtmlPreviewExt(ext: string): boolean {
  return ext === 'html' || ext === 'htm';
}

// ── Pin = keep state (mid/long-term preview host model) ───────────────────
//
// Goal: only the *active* tab's preview is interactive and in the normal
// paint path. Pinning means "preserve viewer state across switches", not
// "stack always-visible overlays".
//
// Two strategies (chosen per file type):
//
//  1. `dom-park` — keep the React tree mounted in an offscreen park slot
//     (real size, opacity 0, inert). Used for HTML (iframe session / Safari),
//     PDF, and Office→PDF where remount is expensive or loses irreplaceable
//     session state. Park is ALWAYS offscreen — never visibility:hidden —
//     so a descendant cannot punch through with visibility:visible (the
//     historical pinned-PDF bleed class of bugs).
//
//  2. `state` — unmount when inactive; restore from ViewerStateRegistry on
//     activate. Used for Image / Monaco / Markdown / CSV where state is a
//     small JSON-able snapshot (zoom, scroll, Monaco viewState).
//
// PreviewWorkspace mounts:
//   - active tab → active slot (normal flex layout, interactive)
//   - pinned inactive + dom-park → keep-alive park (capped)
//   - pinned inactive + state → nothing mounted (registry holds state)
//   - unpinned inactive → nothing
//
// Cap: at most MAX_DOM_PARKED pinned inactive dom-park bodies. Excess fall
// back to unmount (state lost for those until restored on next activate —
// prefer unpinning older heavy tabs). Light `state` types are uncapped.

/** Max pinned-inactive DOM keep-alives (HTML/PDF/Office). */
export const MAX_DOM_PARKED = 3;

export type KeepAliveStrategy = 'dom-park' | 'state';

export function previewExtOf(path: string): string {
  return path.split('.').pop()?.toLowerCase() || '';
}

/**
 * Which keep-alive strategy a preview path uses when pinned + inactive.
 * HTML / PDF / Office need a live DOM; everything else prefers state restore.
 */
export function keepAliveStrategyForExt(ext: string): KeepAliveStrategy {
  const e = ext.toLowerCase();
  if (isHtmlPreviewExt(e)) return 'dom-park';
  if (e === 'pdf') return 'dom-park';
  if (isOfficePreviewExt(e)) return 'dom-park';
  return 'state';
}

export function keepAliveStrategyForPath(path: string): KeepAliveStrategy {
  return keepAliveStrategyForExt(previewExtOf(path));
}

export function needsDomPark(path: string): boolean {
  return keepAliveStrategyForPath(path) === 'dom-park';
}

/**
 * Single park style for ALL dom-park panes (including PDF).
 * Offscreen + opacity 0 + pointer-events none — no visibility:hidden, so
 * children cannot re-paint via visibility:visible. Never display:none
 * (Chrome iframe unload; RO/IO zero size for virtualized PDF).
 * Callers must also set inert + aria-hidden.
 */
export const keepAliveParkStyle: React.CSSProperties = {
  position: 'absolute',
  top: 0,
  left: -10000,
  width: '100%',
  height: '100%',
  opacity: 0,
  pointerEvents: 'none',
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
};

// Back-compat aliases used by older tests / comments. Both now mean the
// unified offscreen park (visibility punch-through is designed out).
export const pinnedPaneHiddenStyle = keepAliveParkStyle;
export const pinnedPaneHiddenHtmlStyle = keepAliveParkStyle;

// ── Viewer state registry (pin = keep state for `state` strategy) ─────────

export type ViewerState =
  | { kind: 'scroll'; scrollTop: number; scrollLeft?: number }
  | { kind: 'image'; zoom: number; rotation: number; pos: { x: number; y: number } }
  | { kind: 'monaco'; viewState: unknown }
  | { kind: 'csv'; scrollTop: number; view: 'table' | 'raw' };

const registry = new Map<string, ViewerState>();

/** Stable key for a tab body generation (`tabId` + refresh rev). */
export function viewerStateKey(tabId: string, rev: number): string {
  return `${tabId}@${rev}`;
}

export function getViewerState(key: string): ViewerState | undefined {
  return registry.get(key);
}

export function setViewerState(key: string, state: ViewerState): void {
  registry.set(key, state);
}

/** Read and remove — used on remount so a later refresh starts clean. */
export function takeViewerState(key: string): ViewerState | undefined {
  const v = registry.get(key);
  if (v !== undefined) registry.delete(key);
  return v;
}

export function clearViewerState(key: string): void {
  registry.delete(key);
}

/** Drop entries whose keys are not in `liveKeys` (closed tabs / old revs). */
export function pruneViewerStates(liveKeys: Iterable<string>): void {
  const keep = liveKeys instanceof Set ? liveKeys : new Set(liveKeys);
  for (const key of registry.keys()) {
    if (!keep.has(key)) registry.delete(key);
  }
}

/** Test helper — empty the registry. */
export function resetViewerStateRegistryForTests(): void {
  registry.clear();
}

/**
 * Decide which tab ids should stay DOM-mounted while inactive (parked).
 * `activationOrder` is oldest→newest tab ids (most recently activated last).
 * Returns up to MAX_DOM_PARKED pinned inactive tabs that need dom-park,
 * preferring the most recently activated.
 */
export function selectDomParkTabIds(
  tabs: ReadonlyArray<{ id: string; path: string; pinned: boolean }>,
  activeTabId: string | null,
  activationOrder: readonly string[],
): string[] {
  const candidates = tabs.filter(
    (t) => t.pinned && t.id !== activeTabId && needsDomPark(t.path),
  );
  if (candidates.length <= MAX_DOM_PARKED) {
    return candidates.map((t) => t.id);
  }
  // Prefer most recently activated: walk activationOrder from the end.
  const rank = new Map<string, number>();
  activationOrder.forEach((id, i) => { rank.set(id, i); });
  const sorted = [...candidates].sort((a, b) => {
    const ra = rank.get(a.id) ?? -1;
    const rb = rank.get(b.id) ?? -1;
    return rb - ra;
  });
  return sorted.slice(0, MAX_DOM_PARKED).map((t) => t.id);
}
