import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useIsMobile } from './useIsMobile';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let mobile: boolean;

function Harness() {
  const value = useIsMobile();
  useEffect(() => { mobile = value; });
  return null;
}

afterEach(() => {
  act(() => { root?.unmount(); root = null; });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('useIsMobile', () => {
  it.each([767, 768])('initializes at %ipx, handles resize, and removes its listener', width => {
    vi.stubGlobal('innerWidth', width);
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    root = createRoot(document.createElement('div'));
    act(() => { root!.render(<Harness />); });
    expect(mobile).toBe(width === 767);
    vi.stubGlobal('innerWidth', width === 767 ? 768 : 767);
    act(() => { window.dispatchEvent(new Event('resize')); });
    expect(mobile).toBe(width !== 767);
    const subscription = add.mock.calls.find(([name]) => name === 'resize')!;
    act(() => { root!.unmount(); root = null; });
    expect(remove).toHaveBeenCalledWith('resize', subscription[1]);
  });
});
