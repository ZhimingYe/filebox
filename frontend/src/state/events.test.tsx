import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eventsAccessUrl } from '../api/client';
import type { SseEvent } from './events';

vi.mock('../api/client', () => ({ eventsAccessUrl: vi.fn() }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  close = vi.fn();
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { type: string; data: string }) => void) | null = null;
  handlers = new Map<string, (event: { data: string }) => void>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  addEventListener(name: string, callback: (event: { data: string }) => void) {
    this.handlers.set(name, callback);
  }
  emit(name: string, data: string) {
    if (name === 'message') this.onmessage?.({ type: name, data });
    else this.handlers.get(name)?.({ data });
  }
}

let root: Root | null;
let host: HTMLDivElement;
let useSse: typeof import('./events')['useSse'];
let isAgentOnline: typeof import('./agentReconnect')['isAgentOnline'];
let syncAgentOnlineStatus: typeof import('./agentReconnect')['syncAgentOnlineStatus'];
type Listener = (event: SseEvent) => void;
const latest = () => FakeEventSource.instances.at(-1)!;

function Harness({ listener, enabled }: { listener: Listener; enabled: boolean }) {
  useSse(listener, enabled);
  return null;
}

function render(listeners: Listener[], enabled = true) {
  if (!root) {
    host = document.createElement('div');
    root = createRoot(host);
  }
  act(() => {
    root!.render(<>{listeners.map((listener, index) =>
      <Harness key={index} listener={listener} enabled={enabled} />,
    )}</>);
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  vi.resetAllMocks();
  vi.spyOn(Math, 'random').mockReturnValue(0);
  vi.stubGlobal('EventSource', FakeEventSource);
  FakeEventSource.instances = [];
  root = null;
  ({ useSse } = await import('./events'));
  ({ isAgentOnline, syncAgentOnlineStatus } = await import('./agentReconnect'));
  syncAgentOnlineStatus([]);
  vi.mocked(eventsAccessUrl).mockResolvedValue({
    url: '/api/events?access_token=bearer', expiresInSec: 1800,
  });
});
afterEach(() => {
  act(() => { root?.unmount(); });
  host?.remove();
  syncAgentOnlineStatus([]);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('useSse shared connection lifecycle', () => {
  it('shares one pending mint/source and closes only after the last subscriber leaves', async () => {
    const mint = deferred<{ url: string; expiresInSec: number }>();
    vi.mocked(eventsAccessUrl).mockReturnValueOnce(mint.promise);
    const first = vi.fn();
    const second = vi.fn();
    render([first, second]);
    expect(eventsAccessUrl).toHaveBeenCalledTimes(1);
    expect(FakeEventSource.instances).toHaveLength(0);
    await act(async () => {
      mint.resolve({ url: '/events?token=shared', expiresInSec: 1800 });
    });
    expect(FakeEventSource.instances).toHaveLength(1);
    const source = latest();
    expect(source.url).toBe('/events?token=shared');
    source.emit('progress', '{"bytes":12}');
    expect(first).toHaveBeenCalledWith({ event: 'progress', data: { bytes: 12 } });
    expect(second).toHaveBeenCalledWith({ event: 'progress', data: { bytes: 12 } });
    render([first]);
    expect(source.close).not.toHaveBeenCalled();
    source.emit('progress', '{"bytes":13}');
    expect(first).toHaveBeenCalledTimes(2);
    expect(second).toHaveBeenCalledTimes(1);
    render([]);
    expect(source.close).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(3600000); });
    expect(eventsAccessUrl).toHaveBeenCalledTimes(1);
  });

  it('does not connect when disabled and disconnects when disabled later', async () => {
    const listener = vi.fn();
    render([listener], false);
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
    expect(eventsAccessUrl).not.toHaveBeenCalled();
    render([listener]);
    await act(async () => {});
    const source = latest();
    render([listener], false);
    expect(source.close).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses the latest callback without reconnecting or resubscribing', async () => {
    const oldListener = vi.fn();
    const newListener = vi.fn();
    render([oldListener]);
    await act(async () => {});
    const source = latest();
    render([newListener]);
    source.emit('collections_updated', '{"revision":2}');
    expect(oldListener).not.toHaveBeenCalled();
    expect(newListener).toHaveBeenCalledExactlyOnceWith({
      event: 'collections_updated', data: { revision: 2 },
    });
    expect(source.close).not.toHaveBeenCalled();
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(eventsAccessUrl).toHaveBeenCalledTimes(1);
  });

  it.each(['success', 'failure'])('ignores a late mint %s after unsubscribe', async outcome => {
    const mint = deferred<{ url: string; expiresInSec: number }>();
    vi.mocked(eventsAccessUrl).mockReturnValueOnce(mint.promise);
    render([vi.fn()]);
    render([]);
    await act(async () => {
      if (outcome === 'failure') mint.reject(new Error('offline'));
      else mint.resolve({ url: '/late', expiresInSec: 1800 });
    });
    expect(FakeEventSource.instances).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(120000); });
    expect(eventsAccessUrl).toHaveBeenCalledTimes(1);
  });
});

describe('SSE retry and token refresh through useSse', () => {
  it('grows reconnect backoff to the cap with deterministic jitter, reusing then reminting', async () => {
    vi.mocked(Math.random).mockReturnValue(0.5);
    render([vi.fn()]);
    await act(async () => {});
    for (const delay of [1250, 2500, 5000, 10000, 20000, 37500, 37500]) {
      const source = latest();
      const count = FakeEventSource.instances.length;
      act(() => { source.onerror?.(); });
      expect(source.close).toHaveBeenCalledTimes(1);
      await act(async () => { await vi.advanceTimersByTimeAsync(delay - 1); });
      expect(FakeEventSource.instances).toHaveLength(count);
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      expect(FakeEventSource.instances).toHaveLength(count + 1);
      if (count <= 2) expect(eventsAccessUrl).toHaveBeenCalledTimes(1);
    }
    expect(eventsAccessUrl).toHaveBeenCalledTimes(6);
    act(() => { latest().onopen?.(); latest().onerror?.(); });
    const count = FakeEventSource.instances.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(1249); });
    expect(FakeEventSource.instances).toHaveLength(count);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(FakeEventSource.instances).toHaveLength(count + 1);
  });

  it('backs off on mint failure and stops retrying after unmount', async () => {
    vi.mocked(eventsAccessUrl).mockRejectedValue(new Error('offline'));
    render([vi.fn()]);
    await act(async () => {});
    expect(FakeEventSource.instances).toHaveLength(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(999); });
    expect(eventsAccessUrl).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(eventsAccessUrl).toHaveBeenCalledTimes(2);
    act(() => { root!.unmount(); root = null; });
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
    expect(eventsAccessUrl).toHaveBeenCalledTimes(2);
  });

  it.each([
    [120, 60000], [60, 5000], [1, 5000],
  ])('refreshes a %is token after %ims with a five-second floor', async (ttl, delay) => {
    vi.mocked(eventsAccessUrl).mockResolvedValueOnce({ url: '/old', expiresInSec: ttl })
      .mockResolvedValueOnce({ url: '/new', expiresInSec: 1800 });
    render([vi.fn()]);
    await act(async () => {});
    const old = latest();
    await act(async () => { await vi.advanceTimersByTimeAsync(delay - 1); });
    expect(eventsAccessUrl).toHaveBeenCalledTimes(1);
    expect(old.close).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(old.close).toHaveBeenCalledTimes(1);
    expect(eventsAccessUrl).toHaveBeenCalledTimes(2);
    expect(latest().url).toBe('/new');
  });
});

describe('SSE dispatch', () => {
  it.each([
    'agent_connected', 'agent_disconnected', 'resources_updated',
    'collections_updated', 'ai_agent_settings_updated', 'progress', 'sync_required',
    'message',
  ])('dispatches parsed %s events and ignores malformed JSON', async event => {
    const listener = vi.fn();
    render([listener]);
    await act(async () => {});
    expect(() => latest().emit(event, 'not JSON')).not.toThrow();
    expect(listener).not.toHaveBeenCalled();
    latest().emit(event, '{"agent_id":"a","revision":2}');
    expect(listener).toHaveBeenCalledExactlyOnceWith({
      event, data: { agent_id: 'a', revision: 2 },
    });
  });

  it('updates the online registry before notifying subscribers', async () => {
    const observations: boolean[] = [];
    render([() => { observations.push(isAgentOnline('a')); }]);
    await act(async () => {});
    expect(isAgentOnline('a')).toBe(false);
    latest().emit('agent_connected', '{"agent_id":"a"}');
    expect(isAgentOnline('a')).toBe(true);
    latest().emit('agent_disconnected', '{"agent_id":"a"}');
    expect(isAgentOnline('a')).toBe(false);
    expect(observations).toEqual([true, false]);
  });
});
