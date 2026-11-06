import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clampRect, loadRect } from './SearchFloatWindow';

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('innerWidth', 1200);
  vi.stubGlobal('innerHeight', 900);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('clampRect', () => {
  it('keeps an already reachable rectangle unchanged without mutating it', () => {
    const rect = { x: 100, y: 100, w: 500, h: 400 };
    expect(clampRect(rect, 1200, 900)).toEqual(rect);
    expect(rect).toEqual({ x: 100, y: 100, w: 500, h: 400 });
  });

  it('enforces minimum size and caps oversized rectangles to the viewport', () => {
    expect(clampRect({ x: 100, y: 100, w: 1, h: 1 }, 1200, 900))
      .toMatchObject({ w: 340, h: 240 });
    expect(clampRect({ x: 100, y: 100, w: 5000, h: 5000 }, 1200, 900))
      .toMatchObject({ w: 1184, h: 884 });
  });

  it.each([
    [-10000, -10000], [10000, 10000], [-10000, 10000], [10000, -10000],
  ])('recovers an offscreen header from (%i, %i)', (x, y) => {
    const rect = clampRect({ x, y, w: 560, h: 600 }, 1200, 900);
    expect(rect.x + rect.w).toBeGreaterThanOrEqual(56);
    expect(rect.x).toBeLessThanOrEqual(1144);
    expect(rect.y).toBeGreaterThanOrEqual(8);
    expect(rect.y + 40).toBeLessThanOrEqual(900);
  });

  it('keeps a header reachable even when the viewport is smaller than minimum size', () => {
    const rect = clampRect({ x: 5000, y: -5000, w: 1, h: 1 }, 100, 80);
    expect(rect.w).toBe(340);
    expect(rect.h).toBe(240);
    expect(rect.x).toBeLessThan(100);
    expect(rect.x + rect.w).toBeGreaterThan(0);
    expect(rect.y).toBeGreaterThanOrEqual(0);
    expect(rect.y + 40).toBeLessThanOrEqual(80);
  });
});

describe('loadRect', () => {
  it.each(['absent', 'corrupt', 'blocked'])('clamps default geometry with %s storage', mode => {
    vi.stubGlobal('innerWidth', 100);
    vi.stubGlobal('innerHeight', 80);
    if (mode === 'corrupt') localStorage.setItem('filebox.searchWindow', '{broken');
    if (mode === 'blocked') vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    const rect = loadRect();
    expect(rect.y).toBeGreaterThanOrEqual(0);
    expect(rect.y + 40).toBeLessThanOrEqual(80);
    expect(rect.x).toBeLessThan(100);
    expect(rect.x + rect.w).toBeGreaterThan(0);
  });
  it('uses the default when storage is absent', () => {
    expect(loadRect()).toEqual({ x: 632, y: 72, w: 560, h: 600 });
  });

  it.each([
    '{broken', 'null', '[]', '{}',
    '{"x":"1","y":2,"w":500,"h":400}',
    '{"x":1e999,"y":2,"w":500,"h":400}',
    '{"x":1,"y":null,"w":500,"h":400}',
  ])('falls back for malformed or non-finite persisted geometry %j', raw => {
    localStorage.setItem('filebox.searchWindow', raw);
    expect(loadRect()).toEqual({ x: 632, y: 72, w: 560, h: 600 });
  });

  it('recovers persisted geometry rather than trusting offscreen coordinates', () => {
    localStorage.setItem('filebox.searchWindow', JSON.stringify({
      x: -10000, y: -10000, w: 500, h: 400,
    }));
    const rect = loadRect();
    expect(rect.w).toBe(500);
    expect(rect.h).toBe(400);
    expect(rect.y).toBe(8);
    expect(rect.x + rect.w).toBe(56);
  });

  it('tolerates private-mode storage errors', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    expect(loadRect()).toEqual({ x: 632, y: 72, w: 560, h: 600 });
  });
});
