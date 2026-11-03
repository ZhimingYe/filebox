import { act, useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import * as api from '../api/client';
import { useAiAgentAttention } from './useAiAgentAttention';

vi.mock('../api/client', async (original) => ({ ...await original<typeof api>(), aiAgentCommand: vi.fn() }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let agents: api.AgentInfo[];
const response: api.AiAgentResponse = { req_id: 'r', agents: [{ target: 'reviewer', status: 'blocked' } as api.AiAgent] };
let root: Root;
let monitor: ReturnType<typeof useAiAgentAttention>;
function Probe() {
  const current = useAiAgentAttention(agents, true, null);
  useLayoutEffect(() => { monitor = current; });
  return null;
}
async function render() { await act(async () => root.render(<Probe />)); }
async function capability(id: string, enabled: boolean) {
  agents = agents.map((a) => a.id === id ? { ...a, capabilities: { ...a.capabilities,
    ai_agents: { available: enabled, backend: enabled ? 'herdr' : null, version: enabled ? '0.9.5' : null,
      settings: { enabled, environment_override: null } } } } : a);
  await render();
}
beforeEach(() => {
  vi.useFakeTimers(); vi.resetAllMocks();
  agents = ['a', 'b'].map((id) => ({ id, name: id, status: 'online', capabilities: {
    ai_agents: { available: true, backend: 'herdr', version: '0.9.5', settings: { enabled: true, environment_override: null } },
  } } as api.AgentInfo));
  vi.mocked(api.aiAgentCommand).mockResolvedValue(response);
  root = createRoot(document.createElement('div'));
});
afterEach(() => { act(() => root.unmount()); vi.useRealTimers(); });

it('Agent A re-registering without the AI Agents capability preserves B acknowledgements and polling cadence', async () => {
  await render();
  const b = monitor.notices.find((n) => n.backendId === 'b')!;
  act(() => monitor.acknowledge([b.id]));
  await capability('a', false);
  expect(monitor.notices).toEqual([{ ...b, acknowledged: true }]);
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(vi.mocked(api.aiAgentCommand).mock.calls.map(([id]) => id)).toEqual(['a', 'b', 'b']);
});

it('aborts only A and discards its old results after a new enabled registration', async () => {
  const pending: { id: string; signal: AbortSignal; finish: (r: api.AiAgentResponse) => void }[] = [];
  vi.mocked(api.aiAgentCommand).mockImplementation((id, _body, signal) => new Promise((resolve) => {
    pending.push({ id, signal: signal!, finish: resolve });
  }));
  await render(); await capability('a', false);
  expect(pending[0].signal.aborted).toBe(true);
  expect(pending[1].signal.aborted).toBe(false);
  await capability('a', true);
  expect(pending).toHaveLength(2);
  await act(async () => pending[0].finish(response));
  expect(monitor.notices).toEqual([]);
  expect(pending.map((p) => p.id)).toEqual(['a', 'b', 'a']);
  await act(async () => pending[1].finish(response));
  expect(monitor.notices.map((n) => n.backendId)).toEqual(['b']);
});
