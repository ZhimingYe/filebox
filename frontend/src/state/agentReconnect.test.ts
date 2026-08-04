import { afterEach, describe, expect, it, vi } from 'vitest';
import { notifyAgentConnected, waitForAgentOnline } from '../state/agentReconnect';

describe('agentReconnect', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves waiters when the matching agent reconnects', async () => {
    const controller = new AbortController();
    const pending = waitForAgentOnline('agent-1', controller.signal, 5_000);
    notifyAgentConnected('agent-1');
    await expect(pending).resolves.toBeUndefined();
  });

  it('ignores reconnect notifications for other agents', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const pending = waitForAgentOnline('agent-1', controller.signal, 1_000);
    notifyAgentConnected('agent-2');
    const assertion = expect(pending).rejects.toThrow(/Timed out waiting for agent/);
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
  });
});
