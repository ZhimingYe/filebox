import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../api/client';
import { isAgentOnline, syncAgentOnlineStatus } from './agentReconnect';
import { useHealth } from './health';

vi.mock('../api/client', () => ({ getHealth: vi.fn(), getAgents: vi.fn() }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null;
let host: HTMLDivElement;
let value: ReturnType<typeof useHealth>;
const healthy: api.HealthResponse = { hub: { status: 'ok', version: '1', uptime_sec: 10 } };
const agent: api.AgentInfo = {
  id: 'a', name: 'Agent', status: 'online', last_seen: 0, rtt_ms: null,
  inflight: 0, resource_revision: 1, pending_resource_update: false,
  last_config_error: null, roots: [], collections_revision: 1,
  pending_collections_update: false, collections: [],
};

function Harness({ enabled }: { enabled: boolean }) {
  const result = useHealth(enabled, 1000);
  useEffect(() => { value = result; });
  return null;
}

function render(enabled: boolean) {
  if (!root) {
    host = document.createElement('div');
    root = createRoot(host);
  }
  act(() => { root!.render(<Harness enabled={enabled} />); });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  root = null;
  syncAgentOnlineStatus([]);
  vi.mocked(api.getHealth).mockResolvedValue(healthy);
  vi.mocked(api.getAgents).mockResolvedValue([agent]);
});
afterEach(() => {
  act(() => { root?.unmount(); });
  host?.remove();
  syncAgentOnlineStatus([]);
  vi.useRealTimers();
});

describe('useHealth', () => {
  it('does not poll while disabled', async () => {
    render(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
    expect(api.getHealth).not.toHaveBeenCalled();
    expect(api.getAgents).not.toHaveBeenCalled();
    expect(value).toMatchObject({ health: null, agents: [], error: null });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('fetches immediately, shares an abort signal, and polls only after completion', async () => {
    const pending = deferred<api.HealthResponse>();
    vi.mocked(api.getHealth).mockReturnValueOnce(pending.promise);
    render(true);
    expect(api.getHealth).toHaveBeenCalledTimes(1);
    expect(api.getAgents).toHaveBeenCalledTimes(1);
    const signal = vi.mocked(api.getHealth).mock.calls[0][0]!;
    expect(vi.mocked(api.getAgents).mock.calls[0][0]).toBe(signal);
    await act(async () => {
      await value.refresh();
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(api.getHealth).toHaveBeenCalledTimes(1);
    await act(async () => { pending.resolve(healthy); });
    expect(value.health).toBe(healthy);
    expect(value.agents).toEqual([agent]);
    expect(isAgentOnline('a')).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(api.getHealth).toHaveBeenCalledTimes(2);
  });

  it('retains state identity for an unchanged cloned payload', async () => {
    render(true);
    await act(async () => {});
    const previous = value;
    vi.mocked(api.getHealth).mockResolvedValue(structuredClone(healthy));
    vi.mocked(api.getAgents).mockResolvedValue(structuredClone([agent]));
    await act(async () => { await value.refresh(); });
    expect(value.health).toBe(previous.health);
    expect(value.agents).toBe(previous.agents);
    expect(value).toBe(previous);
  });

  it('applies changed payloads and clears the online registry and agents on disable', async () => {
    render(true);
    await act(async () => {});
    const changed = { ...agent, name: 'Renamed', status: 'offline' };
    const nextHealth = { hub: { ...healthy.hub, uptime_sec: 20 } };
    vi.mocked(api.getHealth).mockResolvedValue(nextHealth);
    vi.mocked(api.getAgents).mockResolvedValue([changed]);
    await act(async () => { await value.refresh(); });
    expect(value.health).toBe(nextHealth);
    expect(value.agents).toEqual([changed]);
    expect(isAgentOnline('a')).toBe(false);
    syncAgentOnlineStatus([agent]);
    render(false);
    expect(value.agents).toEqual([]);
    expect(isAgentOnline('a')).toBe(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(api.getHealth).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    render(true);
    await act(async () => {});
    expect(value.agents).toEqual([changed]);
  });

  it.each(['success', 'failure'])('ignores stale generation %s after disable/re-enable', async outcome => {
    const oldHealth = deferred<api.HealthResponse>();
    const oldAgents = deferred<api.AgentInfo[]>();
    const newHealth = deferred<api.HealthResponse>();
    const newAgents = deferred<api.AgentInfo[]>();
    vi.mocked(api.getHealth)
      .mockReturnValueOnce(oldHealth.promise).mockReturnValueOnce(newHealth.promise);
    vi.mocked(api.getAgents)
      .mockReturnValueOnce(oldAgents.promise).mockReturnValueOnce(newAgents.promise);
    render(true);
    const oldSignal = vi.mocked(api.getHealth).mock.calls[0][0]!;
    render(false);
    expect(oldSignal.aborted).toBe(true);
    render(true);
    await act(async () => {
      if (outcome === 'success') oldHealth.resolve(healthy);
      else oldHealth.reject(new Error('old failure'));
      oldAgents.resolve([agent]);
    });
    expect(value).toMatchObject({ health: null, agents: [], error: null });
    expect(isAgentOnline('a')).toBe(false);
    await act(async () => { await value.refresh(); });
    expect(api.getHealth).toHaveBeenCalledTimes(2);
    const current = { ...agent, id: 'current' };
    await act(async () => { newHealth.resolve(healthy); newAgents.resolve([current]); });
    expect(value.agents).toEqual([current]);
    expect(isAgentOnline('current')).toBe(true);
    expect(isAgentOnline('a')).toBe(false);
  });

  it.each([
    [new Error('offline'), 'offline'],
    [{ status: 503 }, 'Failed to fetch health'],
  ])('reports a current error and recovers on the next refresh', async (error, message) => {
    vi.mocked(api.getHealth).mockRejectedValueOnce(error);
    render(true);
    await act(async () => {});
    expect(value.error).toBe(message);
    expect(value.health).toBeNull();
    await act(async () => { await value.refresh(); });
    expect(value.error).toBeNull();
    expect(value.health).toBe(healthy);
  });

  it('aborts an in-flight poll and removes its interval on unmount', async () => {
    const pending = deferred<api.HealthResponse>();
    vi.mocked(api.getHealth).mockReturnValue(pending.promise);
    render(true);
    const signal = vi.mocked(api.getHealth).mock.calls[0][0]!;
    act(() => { root!.unmount(); root = null; });
    expect(signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => {
      pending.resolve(healthy);
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(api.getHealth).toHaveBeenCalledTimes(1);
    expect(isAgentOnline('a')).toBe(false);
  });
});
