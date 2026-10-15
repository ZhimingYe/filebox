import { describe, expect, it, vi } from 'vitest';
import { HerdrQueue } from './herdrQueue';

const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
describe('bounded Herdr queue', () => {
  it('caps concurrency, prioritizes input, and removes cancelled queued reads', async () => {
    const queue = new HerdrQueue();
    const releases: (() => void)[] = [];
    const started: string[] = [];
    const task = (name: string) => () => { started.push(name); return new Promise<void>((resolve) => releases.push(resolve)); };
    const signal = new AbortController().signal;
    const first = queue.run(task('first'), signal);
    const second = queue.run(task('second'), signal);
    const background = queue.run(task('background'), signal);
    const cancelled = new AbortController();
    const obsolete = queue.run(task('obsolete'), cancelled.signal).catch((e) => e.name);
    const input = queue.run(task('input'), signal, 3);
    await flush(); expect(started).toEqual(['first', 'second']);
    cancelled.abort(); expect(await obsolete).toBe('AbortError');
    releases.shift()!(); await flush(); expect(started).toEqual(['first', 'second', 'input']);
    releases.shift()!(); await flush(); expect(started).toEqual(['first', 'second', 'input', 'background']);
    releases.splice(0).forEach((resolve) => resolve());
    await Promise.all([first, second, input, background]);
  });

  it('bounds pending work and fails expired queue entries without running them', async () => {
    vi.useFakeTimers();
    try {
      const queue = new HerdrQueue();
      const signal = new AbortController().signal;
      const active = new Promise<void>(() => {});
      void queue.run(() => active, signal);
      void queue.run(() => active, signal);
      const work = vi.fn(async () => {});
      const pending = Array.from({ length: 8 }, () => queue.run(work, signal).catch((e) => e.error));
      expect(await queue.run(work, signal).catch((e) => e.error)).toBe('agent_busy');
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await Promise.all(pending)).toEqual(Array(8).fill('request_timeout'));
      expect(work).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
});
