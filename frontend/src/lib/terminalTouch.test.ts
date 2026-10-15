import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Terminal } from '@xterm/xterm';
import { installTerminalTouchScroll } from './terminalTouch';

let host: HTMLDivElement;
let active: { type: 'normal' | 'alternate'; viewportY: number };
let modes: { mouseTrackingMode: 'none' | 'vt200' };
let scroll: ReturnType<typeof vi.fn>;
let wheel: ReturnType<typeof vi.fn>;
let gesture: ReturnType<typeof installTerminalTouchScroll>;
let reduced: boolean;
function touch(type: string, y: number, count = 1, x = 50) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'touches', { value: Array.from({ length: count }, (_, identifier) => ({ identifier, clientX: x, clientY: y })) });
  host.dispatchEvent(event);
  return event;
}
beforeEach(() => {
  vi.useFakeTimers(); reduced = false;
  vi.stubGlobal('matchMedia', () => ({ get matches() { return reduced; } }));
  host = document.createElement('div'); document.body.append(host);
  vi.spyOn(host, 'getBoundingClientRect').mockReturnValue({ height: 200 } as DOMRect);
  active = { type: 'normal', viewportY: 100 }; modes = { mouseTrackingMode: 'none' };
  scroll = vi.fn((lines: number) => { active.viewportY = Math.max(0, Math.min(100, active.viewportY + lines)); });
  wheel = vi.fn(); host.addEventListener('wheel', wheel);
  gesture = installTerminalTouchScroll(host, { rows: 20, buffer: { active }, modes, scrollLines: scroll } as unknown as Terminal);
});
afterEach(() => { gesture.dispose(); host.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });
it('coalesces a burst of finger moves into one local scroll per animation frame', () => {
  touch('touchstart', 20);
  for (let y = 30; y <= 120; y += 10) expect(touch('touchmove', y).defaultPrevented).toBe(true);
  expect(scroll).not.toHaveBeenCalled();
  vi.advanceTimersByTime(17);
  expect(scroll).toHaveBeenCalledTimes(1); expect(scroll).toHaveBeenCalledWith(-10);
  expect(wheel).not.toHaveBeenCalled();
});
it('does not intercept taps, horizontal gestures, or multi-finger zoom', () => {
  touch('touchstart', 20);
  expect(touch('touchmove', 23).defaultPrevented).toBe(false);
  touch('touchend', 23, 0);
  touch('touchstart', 20);
  expect(touch('touchmove', 30, 1, 100).defaultPrevented).toBe(false);
  touch('touchstart', 20);
  expect(touch('touchmove', 40, 2).defaultPrevented).toBe(false);
  vi.advanceTimersByTime(1000);
  expect(scroll).not.toHaveBeenCalled(); expect(wheel).not.toHaveBeenCalled();
});
it('adds bounded momentum to local history and stops immediately on another touch', () => {
  touch('touchstart', 20); vi.advanceTimersByTime(20); touch('touchmove', 60);
  vi.advanceTimersByTime(17); touch('touchend', 60, 0); vi.advanceTimersByTime(100);
  expect(scroll.mock.calls.length).toBeGreaterThan(1);
  touch('touchstart', 60);
  const count = scroll.mock.calls.length;
  vi.advanceTimersByTime(1000); expect(scroll).toHaveBeenCalledTimes(count);
});
it('honors reduced motion and removes pending animation on dispose', () => {
  reduced = true;
  touch('touchstart', 20); vi.advanceTimersByTime(20); touch('touchmove', 60);
  vi.advanceTimersByTime(17); touch('touchend', 60, 0); vi.advanceTimersByTime(1000);
  expect(scroll).toHaveBeenCalledTimes(1);
  touch('touchstart', 20); touch('touchmove', 60); gesture.dispose();
  vi.advanceTimersByTime(1000); expect(scroll).toHaveBeenCalledTimes(1);
});
it.each(['alternate', 'mouse'] as const)('uses xterm wheel semantics for %s without sending momentum', kind => {
  if (kind === 'alternate') active.type = 'alternate'; else modes.mouseTrackingMode = 'vt200';
  touch('touchstart', 20); touch('touchmove', 120); vi.advanceTimersByTime(17);
  expect(scroll).not.toHaveBeenCalled(); expect(wheel).toHaveBeenCalledTimes(1);
  expect((wheel.mock.calls[0][0] as WheelEvent).deltaY).toBe(-50);
  touch('touchend', 120, 0); vi.advanceTimersByTime(1000);
  expect(wheel).toHaveBeenCalledTimes(1);
});
it('does not turn history momentum into input after switching to an alternate screen', () => {
  touch('touchstart', 20); touch('touchmove', 60); vi.advanceTimersByTime(17);
  touch('touchend', 60, 0); active.type = 'alternate'; vi.advanceTimersByTime(1000);
  expect(scroll).toHaveBeenCalledTimes(1); expect(wheel).not.toHaveBeenCalled();
});
it('stops momentum at history boundaries and after the maximum duration', () => {
  touch('touchstart', 20); touch('touchmove', 60); touch('touchend', 60, 0);
  vi.advanceTimersByTime(650);
  const count = scroll.mock.calls.length;
  vi.advanceTimersByTime(2000); expect(scroll).toHaveBeenCalledTimes(count);
  active.viewportY = 0;
  touch('touchstart', 20); touch('touchmove', 60); touch('touchend', 60, 0);
  vi.advanceTimersByTime(1000); expect(scroll.mock.calls.length - count).toBe(1);
});
