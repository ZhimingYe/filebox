import { afterEach, expect, it, vi } from 'vitest';
import { createHerdrMonitor } from './herdrMonitor';

afterEach(() => vi.useRealTimers());

it('does not restart polling when an aborted request finishes after shutdown', async () => {
  vi.useFakeTimers();
  const pending: { signal: AbortSignal; finish: () => void }[] = [];
  const check = vi.fn((_id: string, signal: AbortSignal) => new Promise<void>((resolve) => {
    pending.push({ signal, finish: resolve });
  }));
  const monitor = createHerdrMonitor(check);
  monitor.sync(['a', 'b', 'c']);
  expect(check).toHaveBeenCalledTimes(2);
  monitor.stop();
  expect(pending.every((p) => p.signal.aborted)).toBe(true);
  pending.forEach((p) => p.finish());
  await vi.advanceTimersByTimeAsync(120_000);
  expect(check).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});

it('gives every backend a turn when slow checks make earlier backends due again', async () => {
  vi.useFakeTimers();
  const calls: string[] = [];
  let active = 0;
  let peak = 0;
  const monitor = createHerdrMonitor(async (id) => {
    calls.push(id); peak = Math.max(peak, ++active);
    await new Promise((resolve) => setTimeout(resolve, 20_000));
    active--;
  });
  try {
    monitor.sync(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls.slice(0, 8)).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
    expect(peak).toBe(2);
  } finally { monitor.stop(); }
});
