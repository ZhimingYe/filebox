import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isAgentOnline,
  markAgentConnected,
  markAgentDisconnected,
  syncAgentOnlineStatus,
  waitForAgentOnline,
} from '../state/agentReconnect';

describe('agentReconnect', () => {
  afterEach(() => {
    vi.useRealTimers();
    syncAgentOnlineStatus([]);
  });

  it('resolves waiters when the matching agent reconnects', async () => {
    const controller = new AbortController();
    const pending = waitForAgentOnline('agent-1', controller.signal, 5_000);
    markAgentConnected('agent-1');
    await expect(pending).resolves.toBeUndefined();
  });

  it('resolves immediately when the agent is already online', async () => {
    syncAgentOnlineStatus([{ id: 'agent-1', status: 'online' }]);
    await expect(waitForAgentOnline('agent-1')).resolves.toBeUndefined();
  });

  it('wakes a waiter when health polling observes a reconnect', async () => {
    const pending = waitForAgentOnline('agent-1', undefined, 5_000);
    syncAgentOnlineStatus([{ id: 'agent-1', status: 'slow' }]);
    await expect(pending).resolves.toBeUndefined();
  });

  it('rejects immediately when the abort signal is already set', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(waitForAgentOnline('agent-1', controller.signal, 5_000))
      .rejects.toMatchObject({ name: 'AbortError' });
  });

  it('ignores reconnect notifications for other agents', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const pending = waitForAgentOnline('agent-1', controller.signal, 1_000);
    markAgentConnected('agent-2');
    const assertion = expect(pending).rejects.toThrow(/Timed out waiting for agent/);
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
  });

  it('tracks online status from sync and disconnect events', () => {
    syncAgentOnlineStatus([
      { id: 'agent-1', status: 'online' },
      { id: 'agent-2', status: 'offline' },
    ]);
    expect(isAgentOnline('agent-1')).toBe(true);
    expect(isAgentOnline('agent-2')).toBe(false);
    markAgentDisconnected('agent-1');
    expect(isAgentOnline('agent-1')).toBe(false);
  });
});
