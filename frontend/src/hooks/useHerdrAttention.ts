import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import * as api from '../api/client';

export interface HerdrAttention {
  id: number;
  backendId: string;
  target?: string;
  kind: 'blocked' | 'unknown' | 'unavailable';
  name: string;
  message: string;
  acknowledged: boolean;
}

interface BackendState {
  notices: HerdrAttention[];
  failures: number;
  unknown: Record<string, number>;
}
interface State { nextId: number; backends: Record<string, BackendState> }
type Issue = Pick<HerdrAttention, 'target' | 'kind' | 'name' | 'message'>;
type Action =
  | { type: 'sync'; backends: { id: string; name: string; status: string }[] }
  | { type: 'status'; id: string; agents: api.HerdrAgent[] }
  | { type: 'failure'; id: string; message: string }
  | { type: 'ack'; ids: number[] }
  | { type: 'reset' };

const emptyBackend = (): BackendState => ({ notices: [], failures: 0, unknown: {} });

function reconcile(state: State, id: string, backend: BackendState, issues: Issue[]): State {
  let nextId = state.nextId;
  const notices = issues.map((issue) => {
    const old = backend.notices.find((n) => n.kind === issue.kind && n.target === issue.target);
    return { ...issue, backendId: id, id: old?.id ?? nextId++, acknowledged: old?.acknowledged ?? false };
  });
  return { nextId, backends: { ...state.backends, [id]: { ...backend, notices } } };
}

function reducer(state: State, action: Action): State {
  if (action.type === 'reset') return { nextId: state.nextId, backends: {} };
  if (action.type === 'ack') return { ...state, backends: Object.fromEntries(
    Object.entries(state.backends).map(([id, b]) => [id, { ...b,
      notices: b.notices.map((n) => action.ids.includes(n.id) ? { ...n, acknowledged: true } : n),
    }]),
  ) };
  if (action.type === 'sync') {
    const ids = new Set(action.backends.map((b) => b.id));
    let next = { ...state, backends: Object.fromEntries(Object.entries(state.backends).filter(([id]) => ids.has(id))) };
    for (const b of action.backends) {
      const old = next.backends[b.id] ?? emptyBackend();
      if (b.status !== 'online') next = reconcile(next, b.id, old, [{
        kind: 'unavailable', name: 'Backend offline',
        message: 'Cannot check Herdr while this backend is offline. Checks resume after it reconnects.',
      }]);
      else if (!next.backends[b.id]) next = { ...next, backends: { ...next.backends, [b.id]: old } };
    }
    return next;
  }
  const backend = state.backends[action.id];
  if (!backend) return state; // Ignore a late response after removal/logout.
  if (action.type === 'failure') {
    const next = { ...backend, failures: backend.failures + 1 };
    if (next.failures < 2) return { ...state, backends: { ...state.backends, [action.id]: next } };
    // Retain known questions until a successful list proves they are resolved.
    return reconcile(state, action.id, next, [
      ...backend.notices.filter((n) => n.kind !== 'unavailable'),
      { kind: 'unavailable', name: 'Status unavailable', message: `${action.message} Existing questions may still need attention. Checks retry automatically.` },
    ]);
  }
  const unknown: Record<string, number> = {};
  const issues: Issue[] = [];
  for (const agent of action.agents) {
    const name = agent.name?.trim() || agent.title?.trim() || agent.target;
    if (agent.status === 'blocked') issues.push({ target: agent.target, name, kind: 'blocked',
      message: 'Waiting for your input. Inspect the screen; use Herdr directly if this panel cannot answer the question.' });
    if (agent.status === 'unknown') {
      unknown[agent.target] = (backend.unknown[agent.target] ?? 0) + 1;
      if (unknown[agent.target] >= 2) issues.push({ target: agent.target, name, kind: 'unknown',
        message: 'Herdr cannot determine this agent’s state. Check its screen for a question or an error.' });
    }
  }
  return reconcile(state, action.id, { ...backend, failures: 0, unknown }, issues);
}

/** Status-only monitoring: no terminal reads, input, focus changes, or OS notifications. */
export function useHerdrAttention(agents: api.AgentInfo[], enabled: boolean, activeBackendId: string | null) {
  const [state, dispatch] = useReducer(reducer, { nextId: 1, backends: {} });
  // Health updates (RTT, stats, etc.) must not restart the polling loop.
  const backendKey = JSON.stringify(agents.filter((a) => a.capabilities?.herdr)
    .map(({ id, name, status }) => ({ id, name, status })));
  const backends = useMemo(() => JSON.parse(backendKey) as { id: string; name: string; status: string }[], [backendKey]);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const reportFailure = useCallback((id: string, error: unknown) => {
    if (!enabledRef.current) return;
    const e = error as { name?: string; error?: string } | null;
    if (e?.name === 'AbortError' || e?.error === 'agent_busy' || e?.error === 'cancelled') return;
    dispatch({ type: 'failure', id, message: api.friendlyMessage(error) });
  }, []);
  const reportStatus = useCallback((id: string, response: api.HerdrResponse) => {
    if (!enabledRef.current) return;
    if (response.error || response.status?.reachable === false) {
      reportFailure(id, { error: response.error || 'herdr_unavailable' });
    } else dispatch({ type: 'status', id, agents: response.agents ?? [] });
  }, [reportFailure]);

  useEffect(() => {
    if (!enabled) { dispatch({ type: 'reset' }); return; }
    dispatch({ type: 'sync', backends });
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const controllers = new Set<AbortController>();
    const poll = async () => {
      // The visible Herdr view reports its own results, avoiding competing commands.
      const queue = backends.filter((b) => b.status === 'online' && b.id !== activeBackendId);
      let index = 0;
      const worker = async () => {
        while (!stopped && index < queue.length) {
          const backend = queue[index++];
          const controller = new AbortController();
          controllers.add(controller);
          try {
            const result = await api.herdrCommand(backend.id, { op: 'status' }, controller.signal, 20_000);
            if (!stopped) reportStatus(backend.id, result);
          } catch (e) { if (!stopped) reportFailure(backend.id, e); }
          finally { controllers.delete(controller); }
        }
      };
      await Promise.all([worker(), worker()]);
      if (!stopped) timer = setTimeout(() => { void poll(); }, 15_000);
    };
    void poll();
    return () => { stopped = true; clearTimeout(timer); controllers.forEach((c) => c.abort()); };
  }, [enabled, backends, activeBackendId, reportStatus, reportFailure]);

  const notices = Object.values(state.backends).flatMap((b) => b.notices);
  const acknowledge = useCallback((ids: number[]) => dispatch({ type: 'ack', ids }), []);
  return { notices, acknowledge, reportStatus, reportFailure };
}
