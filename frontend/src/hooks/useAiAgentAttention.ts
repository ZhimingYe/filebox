import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import * as api from '../api/client';
import { createAiAgentMonitor } from '../lib/aiAgentMonitor';

export interface AiAgentAttention {
  id: number;
  backendId: string;
  backendKey: string;
  target?: string;
  kind: 'blocked' | 'unknown' | 'unavailable';
  name: string;
  message: string;
  acknowledged: boolean;
}

interface BackendState {
  backendId: string;
  notices: AiAgentAttention[];
  failures: number;
  observedAgents: boolean;
  unknown: Record<string, number>;
  identities: Record<string, string>;
}
interface State { nextId: number; backends: Record<string, BackendState> }
type Issue = Pick<AiAgentAttention, 'target' | 'kind' | 'name' | 'message'>;
type Action =
  | { type: 'sync'; backends: { key: string; backendId: string; name: string; status: string }[] }
  | { type: 'status'; id: string; agents: api.AiAgent[] }
  | { type: 'failure'; id: string; message: string }
  | { type: 'inactive'; id: string }
  | { type: 'ack'; ids: number[] }
  | { type: 'reset' };

const emptyBackend = (backendId: string): BackendState => ({ backendId, notices: [], failures: 0, unknown: {}, identities: {}, observedAgents: false });

function reconcile(state: State, key: string, backendId: string, backend: BackendState, issues: Issue[]): State {
  let nextId = state.nextId;
  const notices = issues.map((issue) => {
    const old = backend.notices.find((n) => n.kind === issue.kind && n.target === issue.target);
    return { ...issue, backendId, backendKey: key, id: old?.id ?? nextId++, acknowledged: old?.acknowledged ?? false };
  });
  return { nextId, backends: { ...state.backends, [key]: { ...backend, notices } } };
}

function reducer(state: State, action: Action): State {
  if (action.type === 'reset') return { nextId: state.nextId, backends: {} };
  if (action.type === 'ack') return { ...state, backends: Object.fromEntries(
    Object.entries(state.backends).map(([id, b]) => [id, { ...b,
      notices: b.notices.map((n) => action.ids.includes(n.id) ? { ...n, acknowledged: true } : n),
    }]),
  ) };
  if (action.type === 'sync') {
    const ids = new Set(action.backends.map((b) => b.key));
    let next = { ...state, backends: Object.fromEntries(Object.entries(state.backends).filter(([id]) => ids.has(id))) };
    for (const b of action.backends) {
      const old = next.backends[b.key] ?? emptyBackend(b.backendId);
      if (b.status === 'offline' && old.observedAgents) next = reconcile(next, b.key, b.backendId, old, [{
        kind: 'unavailable', name: 'Backend offline',
        message: 'Cannot check AI Agents while this backend is offline. Checks resume after it reconnects.',
      }]);
      else if (!next.backends[b.key]) next = { ...next, backends: { ...next.backends, [b.key]: old } };
    }
    return next;
  }
  const backend = state.backends[action.id];
  if (!backend) return state; // Ignore a late response after removal/logout.
  if (action.type === 'inactive') return { ...state, backends: { ...state.backends, [action.id]: emptyBackend(backend.backendId) } };
  if (action.type === 'failure') {
    if (!backend.observedAgents) return state;
    const next = { ...backend, failures: backend.failures + 1 };
    if (next.failures < 2) return { ...state, backends: { ...state.backends, [action.id]: next } };
    // Retain known questions until a successful list proves they are resolved.
    return reconcile(state, action.id, backend.backendId, next, [
      ...backend.notices.filter((n) => n.kind !== 'unavailable'),
      { kind: 'unavailable', name: 'Status unavailable', message: `${action.message} Existing questions may still need attention. Checks retry automatically.` },
    ]);
  }
  const unknown: Record<string, number> = {};
  const identities: Record<string, string> = {};
  const issues: Issue[] = [];
  for (const agent of action.agents) {
    identities[agent.target] = JSON.stringify([agent.scope, agent.id]);
    const name = agent.name?.trim() || agent.title?.trim() || agent.target;
    if (agent.status === 'blocked') issues.push({ target: agent.target, name, kind: 'blocked',
      message: 'Waiting for your input. Inspect the screen; use the backend directly if this panel cannot answer the question.' });
    if (agent.status === 'unknown') {
      unknown[agent.target] = (backend.identities[agent.target] === identities[agent.target]
        ? backend.unknown[agent.target] ?? 0 : 0) + 1;
      if (unknown[agent.target] >= 2) issues.push({ target: agent.target, name, kind: 'unknown',
        message: 'The backend cannot determine this agent’s state. Check its screen for a question or an error.' });
    }
  }
  const notices = backend.notices.filter((n) => !n.target || backend.identities[n.target] === identities[n.target]);
  return reconcile(state, action.id, backend.backendId,
    { ...backend, notices, identities, failures: 0, unknown, observedAgents: action.agents.length > 0 }, issues);
}

export function aiAgentBackendKey(agentId: string, kind?: string | null): string {
  return JSON.stringify([agentId, kind ?? null]);
}

/** Status-only monitoring: no terminal reads, input, focus changes, or OS notifications. */
export function useAiAgentAttention(agents: api.AgentInfo[], enabled: boolean, activeBackendId: string | null) {
  const [state, dispatch] = useReducer(reducer, { nextId: 1, backends: {} });
  const backendKey = JSON.stringify(agents.filter((a) => a.capabilities?.ai_agents?.available)
    .map((agent) => ({
      key: aiAgentBackendKey(agent.id, agent.capabilities?.ai_agents?.backend),
      backendId: agent.id,
      backendKind: agent.capabilities?.ai_agents?.backend,
      name: agent.name,
      status: agent.status,
    })));
  const backends = useMemo(() => JSON.parse(backendKey) as {
    key: string; backendId: string; backendKind: string | null | undefined; name: string; status: string;
  }[], [backendKey]);
  const allowed = useMemo(() => new Set(backends.map((backend) => backend.key)), [backends]);
  // Health updates (RTT, stats, etc.) must not restart the polling loop.
  const enabledRef = useRef({
    enabled,
    allowed,
    backendRequests: new Map<string, { agentId: string; backendKind: string | null | undefined }>(),
  });
  enabledRef.current = {
    enabled,
    allowed,
    backendRequests: new Map(backends.map((backend) => [
      backend.key,
      { agentId: backend.backendId, backendKind: backend.backendKind },
    ] as const)),
  };
  const reportFailure = useCallback((id: string, error: unknown) => {
    if (!enabledRef.current.enabled || !enabledRef.current.allowed.has(id)) return;
    const e = error as { name?: string; error?: string } | null;
    const code = e?.error?.split(':')[0];
    if (e?.name === 'AbortError' || code === 'agent_busy' || code === 'cancelled') return;
    if (code === 'ai_agent_backend_unavailable' || code === 'ai_agent_backend_not_detected'
      || code === 'unsupported' || code === 'unsupported_feature') {
      dispatch({ type: 'inactive', id });
      return;
    }
    dispatch({ type: 'failure', id, message: api.friendlyMessage(error) });
  }, []);
  const reportStatus = useCallback((id: string, response: api.AiAgentResponse) => {
    if (!enabledRef.current.enabled || !enabledRef.current.allowed.has(id)) return;
    if (response.error || response.status?.reachable === false) {
      reportFailure(id, { error: response.error || 'ai_agent_backend_unavailable' });
    } else dispatch({ type: 'status', id, agents: response.agents ?? [] });
  }, [reportFailure]);

  const monitor = useRef<ReturnType<typeof createAiAgentMonitor> | null>(null);
  useEffect(() => {
    const instance = createAiAgentMonitor(async (key, signal) => {
      const request = enabledRef.current.backendRequests.get(key);
      if (!request) return;
      try {
        const result = await api.aiAgentCommand(
          request.agentId,
          { op: 'status', ...(request.backendKind ? { backend: request.backendKind } : {}) },
          signal,
          20_000,
        );
        // An old request stays invalid even if the backend was re-enabled.
        if (!signal.aborted) reportStatus(key, result);
      } catch (e) { if (!signal.aborted) reportFailure(key, e); }
    });
    monitor.current = instance;
    return () => { instance.stop(); monitor.current = null; };
  }, [reportStatus, reportFailure]);

  useEffect(() => {
    dispatch(enabled ? { type: 'sync', backends } : { type: 'reset' });
    // The visible AI Agents view reports its own status. Switching one view or
    // disabling one backend must not abort another backend's request.
    monitor.current?.sync(enabled
      ? backends.filter((b) => b.status !== 'offline' && b.key !== activeBackendId).map((b) => b.key)
      : []);
  }, [enabled, backends, activeBackendId]);

  const notices = Object.values(state.backends).flatMap((b) => b.notices);
  const acknowledge = useCallback((ids: number[]) => dispatch({ type: 'ack', ids }), []);
  return { notices: enabled ? notices.filter((n) => allowed.has(n.backendKey)) : [], acknowledge, reportStatus, reportFailure };
}
