import { describe, expect, it, beforeEach } from 'vitest';
import {
  MAX_DOM_PARKED,
  clearViewerState,
  getViewerState,
  keepAliveParkStyle,
  keepAliveStrategyForExt,
  keepAliveStrategyForPath,
  needsDomPark,
  pinnedPaneHiddenHtmlStyle,
  pinnedPaneHiddenStyle,
  pruneViewerStates,
  resetViewerStateRegistryForTests,
  selectDomParkTabIds,
  setViewerState,
  takeViewerState,
  viewerStateKey,
} from './previewKeepAlive';

describe('keepAliveStrategy', () => {
  it('parks HTML / ipynb / PDF / Office in the DOM (expensive or sessionful)', () => {
    expect(keepAliveStrategyForExt('html')).toBe('dom-park');
    expect(keepAliveStrategyForExt('htm')).toBe('dom-park');
    expect(keepAliveStrategyForExt('ipynb')).toBe('dom-park');
    expect(keepAliveStrategyForExt('pdf')).toBe('dom-park');
    expect(keepAliveStrategyForExt('docx')).toBe('dom-park');
    expect(keepAliveStrategyForExt('xlsx')).toBe('dom-park');
    expect(keepAliveStrategyForExt('pptx')).toBe('dom-park');
    expect(needsDomPark('/docs/report.pdf')).toBe(true);
    expect(needsDomPark('/site/index.html')).toBe(true);
    expect(needsDomPark('/nb/analysis.ipynb')).toBe(true);
  });

  it('uses state restore for light viewers (image / code / md / csv)', () => {
    expect(keepAliveStrategyForExt('png')).toBe('state');
    expect(keepAliveStrategyForExt('jpg')).toBe('state');
    expect(keepAliveStrategyForExt('ts')).toBe('state');
    expect(keepAliveStrategyForExt('py')).toBe('state');
    expect(keepAliveStrategyForExt('qmd')).toBe('state');
    expect(keepAliveStrategyForExt('rmd')).toBe('state');
    expect(keepAliveStrategyForExt('md')).toBe('state');
    expect(keepAliveStrategyForExt('csv')).toBe('state');
    expect(keepAliveStrategyForExt('tsv')).toBe('state');
    expect(keepAliveStrategyForPath('/img/photo.png')).toBe('state');
    expect(needsDomPark('/notes/readme.md')).toBe(false);
  });
});

describe('keepAliveParkStyle', () => {
  it('is offscreen + opacity 0 and never display:none or visibility:hidden', () => {
    // Unified park: visibility punch-through is designed out — no
    // visibility:hidden path remains for pinned inactive bodies.
    expect(keepAliveParkStyle.opacity).toBe(0);
    expect(keepAliveParkStyle.pointerEvents).toBe('none');
    expect(keepAliveParkStyle.display).not.toBe('none');
    expect(keepAliveParkStyle.position).toBe('absolute');
    expect(keepAliveParkStyle.left).toBe(-10000);
    expect(keepAliveParkStyle.visibility).toBeUndefined();
    // Aliases converge on the same object / contract.
    expect(pinnedPaneHiddenStyle.opacity).toBe(0);
    expect(pinnedPaneHiddenStyle.left).toBe(-10000);
    expect(pinnedPaneHiddenHtmlStyle.left).toBe(-10000);
    expect(pinnedPaneHiddenStyle.display).not.toBe('none');
  });
});

describe('selectDomParkTabIds', () => {
  const tabs = [
    { id: 'a', path: '/a.pdf', pinned: true },
    { id: 'b', path: '/b.md', pinned: true },
    { id: 'c', path: '/c.html', pinned: true },
    { id: 'd', path: '/d.docx', pinned: true },
    { id: 'e', path: '/e.pdf', pinned: true },
    { id: 'f', path: '/f.pdf', pinned: false },
  ];

  it('ignores unpinned and state-strategy tabs', () => {
    const ids = selectDomParkTabIds(tabs, 'active', ['a', 'b', 'c', 'd', 'e']);
    expect(ids).not.toContain('b'); // md → state
    expect(ids).not.toContain('f'); // unpinned
    expect(ids).not.toContain('active');
  });

  it('caps parked DOM keep-alives at MAX_DOM_PARKED, preferring recent activation', () => {
    // Active is unrelated; park candidates: a,c,d,e (4 pdf/html/office) > 3.
    const ids = selectDomParkTabIds(
      tabs,
      'other',
      ['a', 'c', 'd', 'e'], // e most recent
    );
    expect(ids).toHaveLength(MAX_DOM_PARKED);
    expect(ids).toEqual(['e', 'd', 'c']); // newest first
    expect(ids).not.toContain('a'); // oldest dropped from park
  });

  it('returns all candidates when under the cap', () => {
    const few = [
      { id: 'a', path: '/a.pdf', pinned: true },
      { id: 'b', path: '/b.html', pinned: true },
    ];
    expect(selectDomParkTabIds(few, null, ['a', 'b'])).toEqual(['a', 'b']);
  });
});

describe('ViewerStateRegistry', () => {
  beforeEach(() => {
    resetViewerStateRegistryForTests();
  });

  it('stores, gets, takes, and clears entries', () => {
    const key = viewerStateKey('tab:1', 0);
    setViewerState(key, { kind: 'scroll', scrollTop: 120 });
    expect(getViewerState(key)).toEqual({ kind: 'scroll', scrollTop: 120 });
    expect(takeViewerState(key)).toEqual({ kind: 'scroll', scrollTop: 120 });
    expect(getViewerState(key)).toBeUndefined();
    setViewerState(key, { kind: 'image', zoom: 2, rotation: 90, pos: { x: 1, y: 2 } });
    clearViewerState(key);
    expect(getViewerState(key)).toBeUndefined();
  });

  it('prunes keys that are no longer live', () => {
    setViewerState('a@0', { kind: 'scroll', scrollTop: 1 });
    setViewerState('b@0', { kind: 'scroll', scrollTop: 2 });
    setViewerState('a@1', { kind: 'scroll', scrollTop: 3 });
    pruneViewerStates(['a@1']);
    expect(getViewerState('a@0')).toBeUndefined();
    expect(getViewerState('b@0')).toBeUndefined();
    expect(getViewerState('a@1')).toEqual({ kind: 'scroll', scrollTop: 3 });
  });
});
