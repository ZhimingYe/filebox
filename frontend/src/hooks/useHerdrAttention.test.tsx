import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../api/client';
import { useHerdrAttention } from './useHerdrAttention';

vi.mock('../api/client', async (original) => ({ ...await original<typeof api>(), herdrCommand: vi.fn() }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const backend = { id: 'b1', name: 'Lab', status: 'online', capabilities: { herdr: true } } as api.AgentInfo;
const codingAgent = { target: 'reviewer', name: 'reviewer', pane_id: 'w1:p1', status: 'blocked' } as api.HerdrAgent;
const response = (status: api.HerdrAgentStatus = 'blocked'): api.HerdrResponse => ({
  req_id: 'r', status: { installed: true, reachable: true }, agents: [{ ...codingAgent, status }],
});
let root: Root;
let container: HTMLDivElement;
let current: ReturnType<typeof useHerdrAttention>;
function Probe({ agents = [backend], enabled = true, active = null }: {
  agents?: api.AgentInfo[]; enabled?: boolean; active?: string | null;
}) { current = useHerdrAttention(agents, enabled, active); return null; }
async function render(props: Parameters<typeof Probe>[0] = {}) {
  await act(async () => root.render(<Probe {...props} />));
}
async function tick() { await act(async () => { await vi.advanceTimersByTimeAsync(30_000); }); }
beforeEach(() => {
  vi.useFakeTimers(); vi.resetAllMocks();
  vi.mocked(api.herdrCommand).mockResolvedValue(response());
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.useRealTimers(); });

describe('Herdr attention monitoring', () => {
  it('monitors every capable backend outside Herdr using only status calls', async () => {
    await render({ agents: [backend, { ...backend, id: 'b2' }, { ...backend, id: 'legacy', capabilities: {} }] });
    expect(current.notices.map((n) => n.backendId)).toEqual(['b1', 'b2']);
    expect(vi.mocked(api.herdrCommand).mock.calls.map(([id, body]) => [id, body])).toEqual([
      ['b1', { op: 'status' }], ['b2', { op: 'status' }],
    ]);
  });

  it('does not repeat an acknowledged question but notifies a later blocked episode', async () => {
    await render();
    const id = current.notices[0].id;
    act(() => current.acknowledge([id]));
    await tick();
    expect(current.notices[0]).toMatchObject({ id, acknowledged: true });
    vi.mocked(api.herdrCommand).mockResolvedValue(response('working'));
    await tick(); expect(current.notices).toEqual([]);
    vi.mocked(api.herdrCommand).mockResolvedValue(response());
    await tick(); expect(current.notices[0].id).not.toBe(id);
    expect(current.notices[0].acknowledged).toBe(false);
  });

  it('requires two unclear observations and clears the notice on recovery', async () => {
    vi.mocked(api.herdrCommand).mockResolvedValue(response('unknown'));
    await render(); expect(current.notices).toEqual([]);
    await tick(); expect(current.notices[0].kind).toBe('unknown');
    vi.mocked(api.herdrCommand).mockResolvedValue(response('idle'));
    await tick(); expect(current.notices).toEqual([]);
  });

  it('does not transfer an acknowledgement to a replacement pane with the same name', async () => {
    await render();
    const oldId = current.notices[0].id;
    act(() => current.acknowledge([oldId]));
    vi.mocked(api.herdrCommand).mockResolvedValue({ ...response(), agents: [{ ...codingAgent, pane_id: 'w1:p99' }] });
    await tick();
    expect(current.notices[0].id).not.toBe(oldId);
    expect(current.notices[0].acknowledged).toBe(false);
  });

  it('retains questions through failures, ignores busy, and recovers after a successful list', async () => {
    await render();
    vi.mocked(api.herdrCommand).mockRejectedValue({ error: 'agent_busy' });
    await tick(); expect(current.notices).toHaveLength(1);
    vi.mocked(api.herdrCommand).mockRejectedValue({ error: 'request_timeout' });
    await tick(); expect(current.notices).toHaveLength(1);
    await tick(); expect(current.notices.map((n) => n.kind)).toEqual(['blocked', 'unavailable']);
    vi.mocked(api.herdrCommand).mockResolvedValue(response('idle'));
    await tick(); expect(current.notices).toEqual([]);
  });

  it('uses visible panel reports without a competing background request', async () => {
    await render({ active: 'b1' });
    expect(api.herdrCommand).not.toHaveBeenCalled();
    act(() => current.reportStatus('b1', response()));
    expect(current.notices[0].kind).toBe('blocked');
    await tick(); expect(api.herdrCommand).not.toHaveBeenCalled();
    await render(); expect(api.herdrCommand).toHaveBeenCalledTimes(1);
  });

  it('caps concurrency at two and never overlaps polling rounds', async () => {
    const releases: (() => void)[] = [];
    vi.mocked(api.herdrCommand).mockImplementation(() => new Promise((resolve) => releases.push(() => resolve(response('idle')))));
    await render({ agents: [backend, { ...backend, id: 'b2' }, { ...backend, id: 'b3' }] });
    expect(api.herdrCommand).toHaveBeenCalledTimes(2);
    await tick(); expect(api.herdrCommand).toHaveBeenCalledTimes(2);
    await act(async () => releases.shift()!());
    expect(api.herdrCommand).toHaveBeenCalledTimes(3);
  });

  it('switches the active panel without cancelling an unrelated backend check', async () => {
    const pending: { id: string; signal: AbortSignal; finish: (r: api.HerdrResponse) => void }[] = [];
    vi.mocked(api.herdrCommand).mockImplementation((id, _body, signal) => new Promise((resolve) => {
      pending.push({ id, signal: signal!, finish: resolve });
    }));
    const agents = [backend, { ...backend, id: 'b2' }];
    await render({ agents });
    await render({ agents, active: 'b1' });
    expect(pending[0].signal.aborted).toBe(true);
    expect(pending[1].signal.aborted).toBe(false);
    await act(async () => pending[1].finish(response()));
    expect(current.notices.map((n) => n.backendId)).toEqual(['b2']);
  });

  it('aborts obsolete checks, drops removed backends, and clears on logout', async () => {
    let signal: AbortSignal | undefined;
    let finish: (value: api.HerdrResponse) => void = () => {};
    vi.mocked(api.herdrCommand).mockImplementation((_id, _body, s) => {
      signal = s; return new Promise((resolve) => { finish = resolve; });
    });
    await render();
    await render({ agents: [] }); expect(signal?.aborted).toBe(true);
    await act(async () => finish(response())); expect(current.notices).toEqual([]);
    vi.mocked(api.herdrCommand).mockResolvedValue(response());
    await render(); expect(current.notices).toHaveLength(1);
    await render({ enabled: false }); expect(current.notices).toEqual([]);
    await tick(); expect(current.notices).toEqual([]);
  });

  it('stays quiet for unused, stopped, and disabled Herdr backends', async () => {
    await render({ agents: [{ ...backend, status: 'offline' }] });
    expect(api.herdrCommand).not.toHaveBeenCalled();
    expect(current.notices).toEqual([]);
    vi.mocked(api.herdrCommand).mockRejectedValue({ error: 'herdr_unavailable' });
    await render();
    await tick(); await tick();
    expect(current.notices).toEqual([]);
    vi.mocked(api.herdrCommand).mockResolvedValue(response());
    await tick(); expect(current.notices).toHaveLength(1);
    vi.mocked(api.herdrCommand).mockRejectedValue({ error: 'herdr_unavailable: not running' });
    await tick(); expect(current.notices).toEqual([]);
    await render({ enabled: false });
    vi.mocked(api.herdrCommand).mockClear();
    await tick();
    expect(api.herdrCommand).not.toHaveBeenCalled();
  });

  it('reports offline only after observing running coding agents', async () => {
    await render();
    await render({ agents: [{ ...backend, status: 'offline' }] });
    expect(current.notices[0].name).toBe('Backend offline');
    vi.mocked(api.herdrCommand).mockResolvedValue(response('idle'));
    await render(); expect(current.notices).toEqual([]);
  });

  it('waits thirty seconds between status rounds', async () => {
    await render();
    await act(async () => { await vi.advanceTimersByTimeAsync(29_999); });
    expect(api.herdrCommand).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(api.herdrCommand).toHaveBeenCalledTimes(2);
  });

  it('does not restart checks on unrelated health updates', async () => {
    await render();
    await render({ agents: [{ ...backend, rtt_ms: 42, inflight: 1 }] });
    expect(api.herdrCommand).toHaveBeenCalledTimes(1);
  });
});
