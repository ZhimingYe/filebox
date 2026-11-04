import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../api/client';
import { aiAgentBackendKey, useAiAgentAttention } from './useAiAgentAttention';

vi.mock('../api/client', async (original) => ({ ...await original<typeof api>(), aiAgentCommand: vi.fn() }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const backend = { id: 'b1', name: 'Lab', status: 'online', capabilities: { ai_agents: { available: true, backend: 'herdr', version: '0.9.5', settings: { enabled: true, environment_override: null } } } } as api.AgentInfo;
const codingAgent = { target: 'reviewer', name: 'reviewer', id: 'w1:p1', status: 'blocked' } as api.AiAgent;
const response = (status: api.AiAgentStatus = 'blocked'): api.AiAgentResponse => ({
  req_id: 'r', status: { installed: true, reachable: true }, agents: [{ ...codingAgent, status }],
});
let root: Root;
let container: HTMLDivElement;
let current: ReturnType<typeof useAiAgentAttention>;
function Probe({ agents = [backend], enabled = true, active = null }: {
  agents?: api.AgentInfo[]; enabled?: boolean; active?: string | null;
}) { current = useAiAgentAttention(agents, enabled, active); return null; }
async function render(props: Parameters<typeof Probe>[0] = {}) {
  await act(async () => root.render(<Probe {...props} />));
}
async function tick() { await act(async () => { await vi.advanceTimersByTimeAsync(30_000); }); }
beforeEach(() => {
  vi.useFakeTimers(); vi.resetAllMocks();
  vi.mocked(api.aiAgentCommand).mockResolvedValue(response());
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.useRealTimers(); });

describe('AI Agent attention monitoring', () => {
  it('monitors every capable backend outside AI Agents using only status calls', async () => {
    await render({ agents: [backend, { ...backend, id: 'b2' }, { ...backend, id: 'legacy', capabilities: {} }] });
    expect(current.notices.map((n) => n.backendId)).toEqual(['b1', 'b2']);
    expect(vi.mocked(api.aiAgentCommand).mock.calls.map(([id, body]) => [id, body])).toEqual([
      ['b1', { op: 'status', backend: 'herdr' }], ['b2', { op: 'status', backend: 'herdr' }],
    ]);
  });

  it('does not repeat an acknowledged question but notifies a later blocked episode', async () => {
    await render();
    const id = current.notices[0].id;
    act(() => current.acknowledge([id]));
    await tick();
    expect(current.notices[0]).toMatchObject({ id, acknowledged: true });
    vi.mocked(api.aiAgentCommand).mockResolvedValue(response('working'));
    await tick(); expect(current.notices).toEqual([]);
    vi.mocked(api.aiAgentCommand).mockResolvedValue(response());
    await tick(); expect(current.notices[0].id).not.toBe(id);
    expect(current.notices[0].acknowledged).toBe(false);
  });

  it('requires two unclear observations and clears the notice on recovery', async () => {
    vi.mocked(api.aiAgentCommand).mockResolvedValue(response('unknown'));
    await render(); expect(current.notices).toEqual([]);
    await tick(); expect(current.notices[0].kind).toBe('unknown');
    vi.mocked(api.aiAgentCommand).mockResolvedValue(response('idle'));
    await tick(); expect(current.notices).toEqual([]);
  });

  it('does not transfer an acknowledgement to a replacement pane with the same name', async () => {
    await render();
    const oldId = current.notices[0].id;
    act(() => current.acknowledge([oldId]));
    vi.mocked(api.aiAgentCommand).mockResolvedValue({ ...response(), agents: [{ ...codingAgent, id: 'w1:p99' }] });
    await tick();
    expect(current.notices[0].id).not.toBe(oldId);
    expect(current.notices[0].acknowledged).toBe(false);
  });

  it('clears attention state when the active backend changes', async () => {
    await render();
    expect(current.notices).toHaveLength(1);
    vi.mocked(api.aiAgentCommand).mockResolvedValue(response('idle'));
    const switched = { ...backend, capabilities: { ...backend.capabilities,
      ai_agents: { ...backend.capabilities?.ai_agents, backend: 'other' } } } as api.AgentInfo;
    await render({ agents: [switched] });
    expect(current.notices).toEqual([]);
  });

  it('retains questions through failures, ignores busy, and recovers after a successful list', async () => {
    await render();
    vi.mocked(api.aiAgentCommand).mockRejectedValue({ error: 'agent_busy' });
    await tick(); expect(current.notices).toHaveLength(1);
    vi.mocked(api.aiAgentCommand).mockRejectedValue({ error: 'request_timeout' });
    await tick(); expect(current.notices).toHaveLength(1);
    await tick(); expect(current.notices.map((n) => n.kind)).toEqual(['blocked', 'unavailable']);
    vi.mocked(api.aiAgentCommand).mockResolvedValue(response('idle'));
    await tick(); expect(current.notices).toEqual([]);
  });

  it('uses visible panel reports without a competing background request', async () => {
    await render({ active: aiAgentBackendKey('b1', 'herdr') });
    expect(api.aiAgentCommand).not.toHaveBeenCalled();
    act(() => current.reportStatus(aiAgentBackendKey('b1', 'herdr'), response()));
    expect(current.notices[0].kind).toBe('blocked');
    await tick(); expect(api.aiAgentCommand).not.toHaveBeenCalled();
    await render(); expect(api.aiAgentCommand).toHaveBeenCalledTimes(1);
  });

  it('caps concurrency at two and never overlaps polling rounds', async () => {
    const releases: (() => void)[] = [];
    vi.mocked(api.aiAgentCommand).mockImplementation(() => new Promise((resolve) => releases.push(() => resolve(response('idle')))));
    await render({ agents: [backend, { ...backend, id: 'b2' }, { ...backend, id: 'b3' }] });
    expect(api.aiAgentCommand).toHaveBeenCalledTimes(2);
    await tick(); expect(api.aiAgentCommand).toHaveBeenCalledTimes(2);
    await act(async () => releases.shift()!());
    expect(api.aiAgentCommand).toHaveBeenCalledTimes(3);
  });

  it('switches the active panel without cancelling an unrelated backend check', async () => {
    const pending: { id: string; signal: AbortSignal; finish: (r: api.AiAgentResponse) => void }[] = [];
    vi.mocked(api.aiAgentCommand).mockImplementation((id, _body, signal) => new Promise((resolve) => {
      pending.push({ id, signal: signal!, finish: resolve });
    }));
    const agents = [backend, { ...backend, id: 'b2' }];
    await render({ agents });
    await render({ agents, active: aiAgentBackendKey('b1', 'herdr') });
    expect(pending[0].signal.aborted).toBe(true);
    expect(pending[1].signal.aborted).toBe(false);
    await act(async () => pending[1].finish(response()));
    expect(current.notices.map((n) => n.backendId)).toEqual(['b2']);
  });

  it('aborts obsolete checks, drops removed backends, and clears on logout', async () => {
    let signal: AbortSignal | undefined;
    let finish: (value: api.AiAgentResponse) => void = () => {};
    vi.mocked(api.aiAgentCommand).mockImplementation((_id, _body, s) => {
      signal = s; return new Promise((resolve) => { finish = resolve; });
    });
    await render();
    await render({ agents: [] }); expect(signal?.aborted).toBe(true);
    await act(async () => finish(response())); expect(current.notices).toEqual([]);
    vi.mocked(api.aiAgentCommand).mockResolvedValue(response());
    await render(); expect(current.notices).toHaveLength(1);
    await render({ enabled: false }); expect(current.notices).toEqual([]);
    await tick(); expect(current.notices).toEqual([]);
  });

  it('stays quiet for unused, stopped, and disabled AI agent backends', async () => {
    await render({ agents: [{ ...backend, status: 'offline' }] });
    expect(api.aiAgentCommand).not.toHaveBeenCalled();
    expect(current.notices).toEqual([]);
    vi.mocked(api.aiAgentCommand).mockRejectedValue({ error: 'ai_agent_backend_unavailable' });
    await render();
    await tick(); await tick();
    expect(current.notices).toEqual([]);
    vi.mocked(api.aiAgentCommand).mockResolvedValue(response());
    await tick(); expect(current.notices).toHaveLength(1);
    vi.mocked(api.aiAgentCommand).mockRejectedValue({ error: 'ai_agent_backend_unavailable: not running' });
    await tick(); expect(current.notices).toEqual([]);
    await render({ enabled: false });
    vi.mocked(api.aiAgentCommand).mockClear();
    await tick();
    expect(api.aiAgentCommand).not.toHaveBeenCalled();
  });

  it('reports offline only after observing running coding agents', async () => {
    await render();
    await render({ agents: [{ ...backend, status: 'offline' }] });
    expect(current.notices[0].name).toBe('Backend offline');
    vi.mocked(api.aiAgentCommand).mockResolvedValue(response('idle'));
    await render(); expect(current.notices).toEqual([]);
  });

  it('waits thirty seconds between status rounds', async () => {
    await render();
    await act(async () => { await vi.advanceTimersByTimeAsync(29_999); });
    expect(api.aiAgentCommand).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(api.aiAgentCommand).toHaveBeenCalledTimes(2);
  });

  it('does not restart checks on unrelated health updates', async () => {
    await render();
    await render({ agents: [{ ...backend, rtt_ms: 42, inflight: 1 }] });
    expect(api.aiAgentCommand).toHaveBeenCalledTimes(1);
  });
});
