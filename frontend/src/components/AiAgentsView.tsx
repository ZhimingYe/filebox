import { useCallback, useEffect, useId, useMemo, useLayoutEffect, useRef, useState } from 'react';
import * as api from '../api/client';
import { friendlyMessage } from '../api/client';
import { c, font, radius, settingsLayout as layout, shadow } from '../theme';
import { SettingsSwitch } from './SettingsSwitch';
import { AiAgentShortcuts } from './AiAgentShortcuts';
import { AiAgentButton, AiAgentCallout, AiAgentPopover } from './AiAgentControls';
import { AiAgentQueue } from '../lib/aiAgentQueue';
import { useIsMobile } from '../state/useIsMobile';
import { useCopyToClipboard } from '../hooks/useCopyToClipboard';
import { aiAgentBackend, aiAgentBackendLabel, aiAgentFeatures } from '../lib/aiAgentBackends';
import { aiAgentBackendKey } from '../hooks/useAiAgentAttention';
import { IconChevronLeft, IconRefresh, IconSettings, IconClose, IconSearch, IconClipboard, IconCheck } from './icons';

interface Props {
  agent: api.AgentInfo;
  onStatus?: (agentId: string, response: api.AiAgentResponse) => void;
  onStatusError?: (agentId: string, error: unknown) => void;
  focusRequest?: { backendKey: string; target: string; nonce: number } | null;
}

const OUTPUT_REFRESH_MS = 60 * 1000;
const PROMPT_MAX_BYTES = 32 * 1024;
// Covers hub context (10s + 200ms retry) and max provider review (60s), plus margin.
const PROMPT_REVIEW_ALLOWANCE_MS = 75_000;

function paneIdentity(item: api.AiAgent): string {
  return JSON.stringify([item.target, item.scope, item.id]);
}

function outputSignature(item: api.AiAgent): string {
  return `${item.target}\0${item.status}\0${item.completion_seq ?? ''}`;
}

const STATUS_ORDER: Record<api.AiAgentStatus, number> = {
  blocked: 0,
  working: 1,
  done: 2,
  idle: 3,
  unknown: 4,
};

function statusMeta(status: api.AiAgentStatus): { label: string; color: string; bg: string } {
  switch (status) {
    case 'working':
      return { label: 'Working', color: c.accent, bg: c.accentBg };
    case 'blocked':
      return { label: 'Blocked', color: c.warning, bg: c.warningBg };
    case 'done':
      return { label: 'Done', color: c.success, bg: c.successBg };
    case 'idle':
      return { label: 'Idle', color: c.textSecondary, bg: c.bgMuted };
    default:
      return { label: 'Unknown', color: c.textMuted, bg: c.bgMuted };
  }
}

function displayName(item: api.AiAgent): string {
  return item.name?.trim() || item.title?.trim() || item.id || item.target;
}

function sortAgents(items: api.AiAgent[]): api.AiAgent[] {
  return [...items].sort((a, b) => {
    const d = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
    if (d !== 0) return d;
    return displayName(a).localeCompare(displayName(b));
  });
}

function errorCode(error: unknown): string {
  if (!error || typeof error !== 'object') return '';
  const raw = (error as { error?: unknown }).error;
  if (typeof raw !== 'string') return '';
  return raw.includes(':') ? raw.split(':')[0] : raw;
}

function isAbortError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && (error as { name?: string }).name === 'AbortError';
}

/** Null means the failure should stay quiet (abort, or a superseded request). */
function aiAgentFailureMessage(error: unknown, backendKind?: string | null): string | null {
  if (isAbortError(error)) return null;
  if (errorCode(error) === 'ai_agent_key_unsupported') {
    const note = aiAgentBackend(backendKind).unsupportedKeyNote;
    if (note) return note;
  }
  if (['invalid_request', 'ai_agent_prompt_blocked', 'prompt_review_unavailable', 'prompt_review_not_configured'].includes(errorCode(error) ?? '')) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return message.trim();
  }
  return friendlyMessage(error);
}

/**
 * Sidebar AI Agents panel: list coding agents on the selected backend, read the
 * latest output, send a prompt, and tap keys for blocked approvals. The
 * Filebox Agent drives the local backend; this UI is a compact control
 * surface, not a clone of the backend TUI.
 */
export function AiAgentsView({ agent, onStatus, onStatusError, focusRequest }: Props) {
  const capability = agent.capabilities?.ai_agents;
  const backendKind = capability?.backend;
  const features = aiAgentFeatures(capability);
  const statusDetection = features.status_detection;
  const backendKey = aiAgentBackendKey(agent.id, backendKind);
  const backend = aiAgentBackend(backendKind);
  const isMobile = useIsMobile();
  const isMobileRef = useRef(isMobile);
  isMobileRef.current = isMobile;
  const [status, setStatus] = useState<api.AiAgentBackendStatus | null>(null);
  const backendVersion = status?.version ?? capability?.version;
  const backendLabel = aiAgentBackendLabel(backendKind, backendVersion);
  const backendVersionNote = backend.versionNote?.(backendVersion) ?? null;
  const [promptReview, setPromptReview] = useState<api.AiAgentPromptReview | null>(null);
  const [agents, setAgents] = useState<api.AiAgent[]>([]);
  const [agentQuery, setAgentQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<api.AiAgentStatus | 'all'>('all');
  const [selected, setSelected] = useState<string | null>(null);
  const [output, setOutput] = useState<string>('');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [wait, setWait] = useState(false);
  const waitEnabled = features.prompt_wait && wait;
  const [listError, setListError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [outputError, setOutputError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [wrapOutput, setWrapOutput] = useState(true);
  const [elapsed, setElapsed] = useState(0);
  const [actionTarget, setActionTarget] = useState('');
  const [loadingList, setLoadingList] = useState(true);
  const [loadingOutput, setLoadingOutput] = useState(false);
  const [sending, setSending] = useState(false);
  const [followingOutput, setFollowingOutput] = useState(true);
  const [copying, setCopying] = useState(false);
  const [copyFailedFor, setCopyFailedFor] = useState<string | null>(null);
  const [hoveredCard, setHoveredCard] = useState<string | null>(null);
  const [composerFocused, setComposerFocused] = useState(false);
  const [searchFocused, setSearchFocused] = useState(false);
  const [filterFocused, setFilterFocused] = useState(false);
  const [compactHeight, setCompactHeight] = useState(() => typeof window !== 'undefined' && window.innerHeight < 560);
  useEffect(() => {
    const update = () => setCompactHeight(window.innerHeight < 560);
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);
  const { copiedPath, copyToClipboard } = useCopyToClipboard();
  const promptHintId = useId();
  const genRef = useRef(0);
  const mountedRef = useRef(true);
  const statusCallbacks = useRef({ onStatus, onStatusError });
  statusCallbacks.current = { onStatus, onStatusError };
  const handledFocus = useRef<number | null>(null);
  const outputGenRef = useRef(0);
  const abortList = useRef<AbortController | null>(null);
  const abortOutput = useRef<AbortController | null>(null);
  const abortSend = useRef<AbortController | null>(null);
  const outputBoxRef = useRef<HTMLPreElement | null>(null);
  const promptRef = useRef<HTMLTextAreaElement | null>(null);
  const queue = useRef(new AiAgentQueue());
  const outputCache = useRef(new Map<string, { identity: string; output: string; updatedAt: number; signature: string }>());
  const [autoRefresh, setAutoRefresh] = useState<Record<string, boolean>>({});
  const autoRefreshRef = useRef(autoRefresh);
  useLayoutEffect(() => { autoRefreshRef.current = autoRefresh; }, [autoRefresh]);
  const lastReadAttempt = useRef(new Map<string, number>());
  const [outputElapsed, setOutputElapsed] = useState(0);
  const sendingRef = useRef(false);
  const selectedRef = useRef<string | null>(null);
  const versionRef = useRef<string | null>(null);
  const agentsRef = useRef(agents);
  const stickToBottomRef = useRef(true);
  // Status represented by the displayed snapshot; completion changes show a
  // refresh hint without fetching output on the 30-second status cadence.
  const [seenSignature, setSeenSignature] = useState<string | null>(null);
  versionRef.current = status?.version ?? null;
  selectedRef.current = selected;
  agentsRef.current = agents;

  const command = useCallback((body: api.AiAgentCommandBody, signal: AbortSignal, timeoutMs: number, priority = 0, valid: () => boolean = () => true) =>
    queue.current.run(() => {
      if (signal.aborted || !valid()) throw new DOMException('Obsolete request', 'AbortError');
      const requestBody = { ...body };
      if (backendKind) requestBody.backend = backendKind;
      return api.aiAgentCommand(agent.id, requestBody, signal, timeoutMs);
    }, signal, priority), [agent.id, backendKind]);

  const selectedAgent = useMemo(
    () => agents.find((a) => a.target === selected) ?? null,
    [agents, selected],
  );
  const selectedIdentity = selectedAgent ? paneIdentity(selectedAgent) : null;
  const prompt = selectedIdentity ? drafts[selectedIdentity] ?? '' : '';
  const promptBytes = new TextEncoder().encode(prompt.trim()).length;
  const filteredAgents = useMemo(() => {
    const query = agentQuery.trim().toLocaleLowerCase();
    return agents.filter((item) => (!statusDetection || statusFilter === 'all' || item.status === statusFilter)
      && [displayName(item), item.kind, item.cwd, item.id, item.target].join(' ').toLocaleLowerCase().includes(query));
  }, [agents, agentQuery, statusFilter, statusDetection]);

  const loadList = useCallback(async (silent = false, parentSignal?: AbortSignal) => {
    if (!mountedRef.current || parentSignal?.aborted || (silent && abortList.current)) return;
    const gen = ++genRef.current;
    abortList.current?.abort();
    const controller = new AbortController();
    abortList.current = controller;
    const abort = () => {
      controller.abort();
      if (genRef.current === gen) {
        genRef.current++;
        abortList.current = null;
        if (mountedRef.current) setLoadingList(false);
      }
    };
    parentSignal?.addEventListener('abort', abort, { once: true });
    if (!silent) setLoadingList(true);
    try {
      const res = await command({ op: 'status' }, controller.signal, 20_000, silent ? 1 : 2);
      if (!mountedRef.current || controller.signal.aborted || genRef.current !== gen) return;
      statusCallbacks.current.onStatus?.(backendKey, res);
      const next = sortAgents(res.agents ?? []);
      const identities = new Map(next.map((a) => [a.target, paneIdentity(a)]));
      const liveIdentities = new Set(identities.values());
      setDrafts((prev) => {
        const entries = Object.entries(prev).filter(([identity]) => liveIdentities.has(identity));
        return entries.length === Object.keys(prev).length ? prev : Object.fromEntries(entries);
      });
      const unchanged = new Set(agentsRef.current.filter((a) => identities.get(a.target) === paneIdentity(a)).map((a) => a.target));
      const current = agentsRef.current.find((a) => a.target === selectedRef.current);
      if (current && !unchanged.has(current.target)) {
        outputGenRef.current++;
        abortOutput.current?.abort();
        abortOutput.current = null;
      }
      setStatus(res.status ?? null);
      setPromptReview(res.prompt_review ?? null);
      setAgents(next);
      agentsRef.current = next;
      for (const [target, cached] of outputCache.current) if (identities.get(target) !== cached.identity) outputCache.current.delete(target);
      for (const target of lastReadAttempt.current.keys()) if (!unchanged.has(target)) lastReadAttempt.current.delete(target);
      setAutoRefresh((prev) => Object.fromEntries(Object.entries(prev).filter(([target]) => unchanged.has(target))));
      setListError(res.error ? friendlyMessage({ error: res.error }) : null);
      setSelected((prev) => {
        if (prev && next.some((a) => a.target === prev)) return prev;
        // Desktop lands on the highest-priority agent so output is visible.
        // Mobile stays on the list until the user taps a card.
        if (isMobileRef.current) return null;
        return next[0]?.target ?? null;
      });
    } catch (e) {
      if (genRef.current !== gen) return;
      if (mountedRef.current && !controller.signal.aborted) statusCallbacks.current.onStatusError?.(backendKey, e);
      if (!mountedRef.current || controller.signal.aborted) return;
      const message = aiAgentFailureMessage(e, backendKind);
      if (message === null) return;
      if (silent && errorCode(e) === 'agent_busy') return;
      setListError(message);
      if (errorCode(e) === 'ai_agent_backend_unavailable') {
        setStatus({
          installed: true,
          reachable: false,
          version: versionRef.current,
          message,
        });
        setAgents([]);
        agentsRef.current = [];
        setSelected(null);
        outputCache.current.clear();
        lastReadAttempt.current.clear();
      }
    } finally {
      parentSignal?.removeEventListener('abort', abort);
      if (genRef.current === gen) { abortList.current = null; if (mountedRef.current) setLoadingList(false); }
    }
  }, [backendKey, backendKind, command, setStatus]);

  const loadOutput = useCallback(async (target: string, silent = false, visible = false, parentSignal?: AbortSignal) => {
    if (!mountedRef.current || parentSignal?.aborted || selectedRef.current !== target || (silent && abortOutput.current)) return;
    const gen = ++outputGenRef.current;
    abortOutput.current?.abort();
    const controller = new AbortController();
    abortOutput.current = controller;
    const abort = () => {
      controller.abort();
      if (outputGenRef.current === gen) {
        outputGenRef.current++;
        abortOutput.current = null;
        if (mountedRef.current) setLoadingOutput(false);
      }
    };
    parentSignal?.addEventListener('abort', abort, { once: true });
    setLoadingOutput(true);
    setOutputElapsed(0);
    lastReadAttempt.current.set(target, Date.now());
    if (!silent) setOutputError(null);
    try {
      const itemAtStart = agentsRef.current.find((a) => a.target === target);
      if (!itemAtStart) return;
      const identity = paneIdentity(itemAtStart);
      const res = await command(
        { op: 'read', target: itemAtStart.id || target, lines: 120,
          read_source: visible && features.read_visible ? 'visible' : 'bottom' },
        controller.signal,
        25_000,
        silent ? 0 : 2,
        () => agentsRef.current.some((a) => a.target === target && paneIdentity(a) === identity),
      );
      if (!mountedRef.current || controller.signal.aborted || outputGenRef.current !== gen || selectedRef.current !== target) return;
      const current = agentsRef.current.find((a) => a.target === target);
      if (!current || paneIdentity(current) !== identity) return;
      const signature = outputSignature(itemAtStart);
      setSeenSignature(signature);
      outputCache.current.delete(target);
      outputCache.current.set(target, { identity, output: res.output ?? '', updatedAt: Date.now(), signature });
      // At most eight bounded CLI snapshots; switching many panes cannot grow memory forever.
      if (outputCache.current.size > 8) outputCache.current.delete(outputCache.current.keys().next().value!);
      setOutput(res.output ?? '');
      setOutputError(null);
      setUpdatedAt(Date.now());
      if (res.agent) {
        setAgents((prev) => {
          const next = prev.map((a) => (a.target === res.agent!.target || a.id === res.agent!.id ? res.agent! : a));
          return sortAgents(next);
        });
      }
      return true;
    } catch (e) {
      if (!mountedRef.current || controller.signal.aborted || outputGenRef.current !== gen || selectedRef.current !== target) return;
      const message = aiAgentFailureMessage(e, backendKind);
      if (message === null) return;
      if (silent && (errorCode(e) === 'agent_busy' || errorCode(e) === 'ai_agent_not_idle')) return;
      setOutputError(message);
    } finally {
      parentSignal?.removeEventListener('abort', abort);
      if (outputGenRef.current === gen) { abortOutput.current = null; if (mountedRef.current) setLoadingOutput(false); }
    }
  }, [backendKind, command, features.read_visible]);

  useEffect(() => {
    mountedRef.current = true;
    void loadList(false);
    return () => {
      mountedRef.current = false;
      abortList.current?.abort();
      abortOutput.current?.abort();
      abortSend.current?.abort();
    };
  }, [agent.id, loadList]);

  useEffect(() => {
    if (!focusRequest || focusRequest.backendKey !== backendKey || handledFocus.current === focusRequest.nonce || loadingList) return;
    if (agents.some((a) => a.target === focusRequest.target)) {
      handledFocus.current = focusRequest.nonce;
      setSelected(focusRequest.target);
    }
  }, [focusRequest, backendKey, agents, loadingList]);

  useLayoutEffect(() => {
    // Invalidate an in-flight read before it can paint the previous agent
    // under this header. The generation bump wins even if the response
    // arrives before the abort is observed.
    outputGenRef.current += 1;
    abortOutput.current?.abort();
    abortOutput.current = null;
    stickToBottomRef.current = true;
    setFollowingOutput(true);
    setUpdatedAt(null);
    setOutputError(null);
    setActionNotice(null);
    setLoadingOutput(false);
    if (!selected) {
      setSeenSignature(null);
      setOutput('');
      return;
    }
    const snapshot = outputCache.current.get(selected);
    const cached = snapshot?.identity === selectedIdentity ? snapshot : undefined;
    setSeenSignature(cached?.signature ?? null);
    setOutput(cached?.output ?? '');
    setUpdatedAt(cached?.updatedAt ?? null);
    setActionError(null);
    if (!cached) void loadOutput(selected, false);
  }, [selected, selectedIdentity, loadOutput]);

  // Status is lightweight and independent of output. Never silently turn a
  // 30-second status tick into a transcript read, even on completion changes.
  useEffect(() => {
    const timer = window.setInterval(() => { void loadList(true); }, 30_000);
    return () => window.clearInterval(timer);
  }, [loadList]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const target = selectedRef.current;
      if (!target || sendingRef.current || abortOutput.current || autoRefreshRef.current[target] === false) return;
      if (Date.now() - (lastReadAttempt.current.get(target) ?? 0) >= OUTPUT_REFRESH_MS) {
        void loadOutput(target, true);
      }
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [loadOutput]);

  useEffect(() => {
    if (!loadingOutput) return;
    const started = Date.now();
    const timer = window.setInterval(() => setOutputElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [loadingOutput]);

  useEffect(() => {
    const el = outputBoxRef.current;
    if (!el || !stickToBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [output, updatedAt]);

  useLayoutEffect(() => {
    const el = promptRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(isMobile ? 120 : compactHeight ? 96 : 160, Math.max(compactHeight ? 40 : 56, el.scrollHeight))}px`;
  }, [prompt, selectedIdentity, isMobile, compactHeight]);

  useEffect(() => {
    if (!sending) return;
    const started = Date.now();
    setElapsed(0);
    const timer = window.setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [sending]);

  useEffect(() => {
    if (!actionNotice?.startsWith('Sent ') && !actionNotice?.startsWith('Prompt sent.')) return;
    const timer = window.setTimeout(() => setActionNotice(null), 4000);
    return () => window.clearTimeout(timer);
  }, [actionNotice]);

  const selectAgent = (target: string) => {
    setSelected(target);
    setActionError(null);
  };

  const runCommand = async (
    body: api.AiAgentCommandBody,
    signal: AbortSignal,
    timeoutMs: number,
    valid: () => boolean,
  ) => {
    try {
      return await command(body, signal, timeoutMs, 3, valid);
    } catch (e) {
      if (isAbortError(e) || errorCode(e) !== 'agent_busy') throw e;
      await new Promise((resolve) => window.setTimeout(resolve, 300));
      if (signal.aborted) throw e;
      return command(body, signal, timeoutMs, 3, valid);
    }
  };

  const beginUserAction = () => {
    setSeenSignature(null);
    // User input supersedes obsolete reads; the bounded queue prioritizes it.
    abortList.current?.abort();
    abortOutput.current?.abort();
    sendingRef.current = true;
    setSending(true);
    setComposerFocused(false);
    setActionError(null);
    setActionNotice(null);
    setActionTarget(selectedAgent ? displayName(selectedAgent) : 'agent');
  };

  const stopWaiting = () => {
    abortSend.current?.abort();
    abortSend.current = null;
    sendingRef.current = false;
    setSending(false);
    setActionNotice(`Stopped waiting for ${actionTarget}. Already submitted input may still be running; refresh the output before retrying.`);
  };

  const sendPrompt = () => {
    if (!selectedAgent || sendingRef.current) return;
    const text = prompt.trim();
    if (!text || promptBytes > PROMPT_MAX_BYTES || selectedAgent.status === 'blocked' || promptReview?.state === 'not_configured') return;
    const target = selectedAgent.target;
    const identity = paneIdentity(selectedAgent);
    const valid = () => agentsRef.current.some((a) => a.target === target && paneIdentity(a) === identity);
    beginUserAction();
    abortSend.current?.abort();
    const controller = new AbortController();
    abortSend.current = controller;
    void (async () => {
      try {
        const res = await runCommand(
          {
            op: 'prompt',
            target: selectedAgent.id || target,
            text,
            wait: waitEnabled,
            timeout_ms: waitEnabled ? 60_000 : undefined,
          },
          controller.signal,
          (waitEnabled ? 80_000 : 25_000) + PROMPT_REVIEW_ALLOWANCE_MS,
          valid,
        );
        if (controller.signal.aborted || !mountedRef.current || !valid()) return;
        setDrafts((prev) => ({ ...prev, [identity]: '' }));
        if (selectedRef.current === target) {
          setActionNotice(res.agent?.status === 'blocked'
            ? 'The agent needs your input. Read the output, then use the keys below.'
            : waitEnabled ? 'Finished waiting. Review the latest output below.' : 'Prompt sent. Refresh this window to see further output.');
        }
        await loadOutput(target, true, false, controller.signal);
        if (!controller.signal.aborted) await loadList(true, controller.signal);
      } catch (e) {
        if (controller.signal.aborted || isAbortError(e) || !mountedRef.current || !valid()) return;
        const message = aiAgentFailureMessage(e, capability?.backend);
        if (message && selectedRef.current === target) setActionError(message);
        await loadOutput(target, true, false, controller.signal);
      } finally {
        if (abortSend.current === controller) {
          abortSend.current = null;
          sendingRef.current = false;
          if (mountedRef.current) setSending(false);
        }
      }
    })();
  };

  const sendKeys = (keys: string[]) => {
    if (!selectedAgent || sendingRef.current) return;
    const target = selectedAgent.target;
    const identity = paneIdentity(selectedAgent);
    const valid = () => agentsRef.current.some((a) => a.target === target && paneIdentity(a) === identity);
    beginUserAction();
    abortSend.current?.abort();
    const controller = new AbortController();
    abortSend.current = controller;
    void (async () => {
      try {
        await runCommand(
          { op: 'send_keys', target: selectedAgent.id || target, keys },
          controller.signal,
          15_000,
          valid,
        );
        if (controller.signal.aborted || !mountedRef.current || !valid()) return;
        if (selectedRef.current === target) setActionNotice(`Sent ${keys.join(' + ')}.`);
        await loadOutput(target, false, true, controller.signal);
        if (!controller.signal.aborted) await loadList(true, controller.signal);
      } catch (e) {
        if (controller.signal.aborted || isAbortError(e) || !mountedRef.current || !valid()) return;
        const message = aiAgentFailureMessage(e, capability?.backend);
        if (message && selectedRef.current === target) setActionError(message);
      } finally {
        if (abortSend.current === controller) {
          abortSend.current = null;
          sendingRef.current = false;
          if (mountedRef.current) setSending(false);
        }
      }
    })();
  };

  const reachable = status?.reachable === true;
  const showDetail = !!selectedAgent && (!isMobile || selected !== null);
  const showList = !isMobile || !selectedAgent;
  const promptDisabled = sending || !reachable || !prompt.trim()
    || promptBytes > PROMPT_MAX_BYTES || selectedAgent?.status === 'blocked' || promptReview?.state === 'not_configured';
  const outputChanged = features.status_detection && selectedAgent && seenSignature !== null && seenSignature !== outputSignature(selectedAgent);
  const copyLabel = JSON.stringify([selectedIdentity, updatedAt]);
  const copied = copiedPath === copyLabel;
  const promptHint = promptBytes > PROMPT_MAX_BYTES ? 'Prompt exceeds the 32 KiB limit. Shorten it before sending.'
    : sending ? (isMobile || compactHeight ? 'Input submitted.' : 'Input submitted. Stop waiting only stops Filebox from waiting.')
    : !reachable ? 'AI agent backend is unavailable. Your draft is kept here.'
    : promptReview?.state === 'not_configured' ? (isMobile || compactHeight ? 'Prompt review not configured' : 'Prompts disabled: configure prompt_review in hub.json')
    : selectedAgent?.status === 'blocked' ? 'Waiting for approval. Use the remote keys before sending a message.'
    : waitEnabled ? 'Wait for result is on · up to 60 seconds'
    : isMobile ? 'Enter for new line' : compactHeight && promptReview?.state ? 'Ctrl / ⌘ + Enter to send' : 'Ctrl / ⌘ + Enter to send · Enter for new line';

  const inlineNotice = compactHeight && !isMobile;
  const inlineError = inlineNotice && !sending ? actionError : null;
  const statusWarning = !features.status_detection || sending || !selectedAgent ? null
    : selectedAgent.status === 'blocked' ? 'Needs your input. Use the remote keys below to respond.'
    : selectedAgent.status === 'unknown' ? 'Status unavailable. Check the output before continuing.' : null;
  const noticeActive = sending || (loadingOutput && outputElapsed >= 8) || !!actionNotice;
  const reviewing = promptReview?.state === 'on';
  const reviewLabel = promptReview?.state === 'on' ? `Reviewed by ${promptReview.model || 'LLM'}`
    : promptReview?.state === 'off' ? 'Prompt review off' : null;
  const noticeText = sending ? `${reviewing ? (waitEnabled ? 'Reviewing, then waiting for' : 'Reviewing and sending to') : waitEnabled ? 'Waiting for' : 'Sending to'} ${actionTarget} · ${elapsed}s`
    : loadingOutput ? (outputElapsed >= 8 ? `Taking longer than usual · ${outputElapsed}s` : 'Refreshing…')
    : actionNotice;
  const stopWaitingButton = sending && <AiAgentButton variant="quiet" size="sm" touch={isMobile} onClick={stopWaiting}
    style={{ color: c.accent, height: isMobile ? 24 : 22, padding: '0 6px' }}>Stop waiting</AiAgentButton>;

  const jumpToLatest = () => {
    stickToBottomRef.current = true;
    setFollowingOutput(true);
    if (outputBoxRef.current) outputBoxRef.current.scrollTop = outputBoxRef.current.scrollHeight;
  };
  const refreshOutput = () => {
    if (loadingOutput) {
      outputGenRef.current++; abortOutput.current?.abort(); abortOutput.current = null;
      setLoadingOutput(false); setOutputError(null); setActionNotice('Output refresh cancelled.');
      return;
    }
    setActionNotice(null);
    jumpToLatest();
    if (selected) void loadOutput(selected, false);
  };
  const copyOutput = async () => {
    if (copying || !output) return;
    setCopying(true);
    setCopyFailedFor(null);
    const success = await copyToClipboard(output, copyLabel);
    if (!mountedRef.current) return;
    setCopying(false);
    if (!success) setCopyFailedFor(copyLabel);
  };

  const cancelList = () => {
    genRef.current++;
    abortList.current?.abort();
    abortList.current = null;
    setLoadingList(false);
    setListError('Status refresh cancelled.');
  };
  const listControl = <AiAgentButton touch={isMobile} variant="quiet" icon
    aria-label={loadingList ? 'Cancel status refresh' : 'Refresh agent list'}
    title={loadingList ? 'Cancel status refresh' : 'Refresh agent list'}
    onClick={() => loadingList ? cancelList() : void loadList(false)}>
    {loadingList ? <IconClose style={iconSm} /> : <IconRefresh style={iconSm} />}
  </AiAgentButton>;

  const settingsControl = (
    <AiAgentPopover key={selectedIdentity ?? 'list'} label="AI Agents settings" trigger={<IconSettings style={iconSm} />} touch={isMobile}>
      <div style={styles.menuTitle}>Workspace settings</div>
      {selectedAgent && <>
        <label style={styles.settingRow}>
          <span>Auto-refresh every minute</span>
          <SettingsSwitch aria-label="Auto-refresh every minute" checked={autoRefresh[selectedAgent.target] !== false}
            onClick={() => setAutoRefresh((prev) => ({ ...prev, [selectedAgent.target]: prev[selectedAgent.target] === false }))} />
        </label>
        <label style={styles.settingRow}><span>Wrap output</span>
          <SettingsSwitch aria-label="Wrap output" checked={wrapOutput} onClick={() => setWrapOutput((value) => !value)} />
        </label>
        {features.prompt_wait && <label style={styles.settingRow} title="Wait up to 60 seconds for completion or a request for input.">
          <span>Wait for result after sending</span>
          <SettingsSwitch aria-label="Wait for result after sending" checked={waitEnabled} disabled={sending} onClick={() => setWait((value) => !value)} />
        </label>}
      </>}
      <p style={styles.menuNote}>{updatedAt ? `Output updated ${new Date(updatedAt).toLocaleTimeString()}. ` : ''}Status checks every 30 seconds. {backendLabel}.{backendVersionNote ? ` ${backendVersionNote}` : ''}{promptReview?.state === 'on' ? ` Prompt review on · ${promptReview.model || 'LLM'}.` : promptReview?.state === 'off' ? ' Prompt review off.' : promptReview?.state === 'not_configured' ? ' Prompt review not configured; prompts are disabled.' : ''}</p>
    </AiAgentPopover>
  );

  return (
    <div style={styles.page}>
      {(!isMobile || !showDetail) && <header style={{ ...styles.header, ...(isMobile ? { padding: '12px 16px' } : null), ...(compactHeight ? { paddingTop: 10, paddingBottom: 10, alignItems: 'center' } : null) }}>
        <div style={layout.pageHeaderText}>
          {!compactHeight && <p style={layout.eyebrow}>{backendLabel}</p>}
          <h1 style={layout.pageTitle}>AI Agents</h1>
        </div>
        <div style={styles.keyRow}>
          {listControl}
          {!showDetail && settingsControl}
        </div>
      </header>}

      {listError && reachable && (
        <AiAgentCallout tone="warning" role="status" style={{ margin: isMobile ? '12px 16px 0' : '16px 20px 0' }}>{listError}</AiAgentCallout>
      )}

      <div style={isMobile ? styles.bodyMobile : compactHeight ? { ...styles.bodyDesktop, padding: '8px 12px 12px', gap: 12 } : styles.bodyDesktop}>
        {showList && (
          <aside style={{ ...(isMobile ? styles.listMobile : styles.listDesktop),
            ...(!isMobile && agents.length === 0 ? { width: '100%', maxWidth: 680, margin: '0 auto', border: 0, background: 'transparent', boxShadow: 'none', padding: 0 } : null) }} aria-label="AI agents">
            {agents.length > 0 && <div style={styles.listHeading}>
              <span>Coding agents</span><span style={styles.countChip}>{agents.length}</span>
            </div>}
            {reachable && (agents.length > 1 || agentQuery || (features.status_detection && statusFilter !== 'all')) && <div style={{ ...styles.listTools, flexDirection: 'row' }}>
              <label style={{ ...styles.searchBox, ...(searchFocused ? styles.fieldFocused : null) }}>
                <IconSearch style={{ width: 14, height: 14, flexShrink: 0 }} />
                <input type="text" role="searchbox" aria-label="Search agents" placeholder="Search…" value={agentQuery}
                  onChange={(event) => setAgentQuery(event.target.value)}
                  onFocus={() => setSearchFocused(true)} onBlur={() => setSearchFocused(false)}
                  onKeyDown={(event) => { if (event.key === 'Escape' && agentQuery) { event.preventDefault(); setAgentQuery(''); } }}
                  style={{ ...styles.searchInput, fontSize: isMobile ? 13 : 12.5, minHeight: isMobile ? 32 : 30 }} />
                {agentQuery && <AiAgentButton variant="quiet" icon size="sm" aria-label="Clear search" title="Clear search"
                  onClick={() => setAgentQuery('')} style={{ width: 20, minWidth: 20, height: 20, marginRight: -4, color: c.textMuted }}>
                  <IconClose style={{ width: 12, height: 12 }} />
                </AiAgentButton>}
              </label>
              {features.status_detection && <select aria-label="Filter agents by status" value={statusFilter}
                onFocus={() => setFilterFocused(true)} onBlur={() => setFilterFocused(false)}
                onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)}
                style={{ ...styles.filterSelect, fontSize: isMobile ? 13 : 12, minHeight: isMobile ? 32 : 30, width: 'auto', maxWidth: isMobile ? 128 : 96, flexShrink: 0, ...(filterFocused ? styles.fieldFocused : null) }}>
                <option value="all">{`All · ${agents.length}`}</option>
                {(['blocked', 'working', 'done', 'idle', 'unknown'] as const).map((value) => <option key={value} value={value}>
                  {value === 'blocked' ? 'Needs input' : statusMeta(value).label} · {agents.filter((item) => item.status === value).length}
                </option>)}
              </select>}
            </div>}
            {loadingList && agents.length === 0 && !listError ? (
              <div style={styles.empty}>Looking for agents…</div>
            ) : !reachable && listError && !status?.installed ? (
              <div style={styles.emptyCard}>
                <div style={styles.emptyTitle}>Could not reach AI agent backend</div>
                <p style={styles.emptyText}>{listError}</p>
                <AiAgentButton variant="primary" touch={isMobile} onClick={() => void loadList(false)} disabled={loadingList}>
                  Check again
                </AiAgentButton>
              </div>
            ) : !reachable ? (
              <div style={styles.emptyCard}>
                <div style={styles.emptyTitle}>AI agent backend is not running</div>
                <p style={styles.emptyText}>{backend.noServerMessage}</p>
                <AiAgentButton variant="primary" touch={isMobile} onClick={() => void loadList(false)} disabled={loadingList}>
                  Check again
                </AiAgentButton>
              </div>
            ) : agents.length === 0 ? (
              <div style={styles.emptyCard}>
                <div style={styles.emptyTitle}>No agents running</div>
                <p style={styles.emptyText}>
                  {backend.noAgentsMessage}
                </p>
              </div>
            ) : (
              filteredAgents.length === 0 ? <div style={styles.noMatch}>
                <div style={{ ...styles.emptyTitle, fontSize: 13 }}>No matching agents</div>
              <p style={{ ...styles.emptyText, fontSize: 12.5 }}>{features.status_detection ? 'Try another name, folder, or status.' : 'Try another name or folder.'}</p>
                <AiAgentButton size="sm" onClick={() => { setAgentQuery(''); setStatusFilter('all'); }} touch={isMobile}>Clear filters</AiAgentButton>
              </div> : filteredAgents.map((item) => {
                const meta = statusMeta(item.status);
                const active = item.target === selected;
                return (
                  <button
                    key={item.target}
                    type="button"
                    aria-pressed={active}
                    title={`${displayName(item)}${item.cwd ? ` · ${item.cwd}` : ''}`}
                    onClick={() => selectAgent(item.target)}
                    onMouseEnter={() => setHoveredCard(item.target)}
                    onMouseLeave={() => setHoveredCard((value) => value === item.target ? null : value)}
                    style={{
                      ...styles.card,
                      ...(active ? styles.cardActive : hoveredCard === item.target ? styles.cardHover : null),
                    }}
                  >
                    <span style={styles.cardBody}>
                      <span style={styles.cardTop}>
                        <span style={{ ...styles.cardName, ...(active ? { color: c.accent } : null) }}>{displayName(item)}</span>
                        {drafts[paneIdentity(item)]?.trim() && <span style={styles.draftBadge}>Draft</span>}
                        {features.status_detection && <span style={{ ...styles.badge, color: meta.color, background: active ? c.surface : meta.bg }}>
                          <span style={{ ...styles.dot, background: meta.color }} />{meta.label}
                        </span>}
                      </span>
                      <span style={styles.cardMeta}>
                        {item.kind || 'agent'}
                        {item.cwd ? ` · ${item.cwd}` : item.id ? ` · ${item.id}` : ''}
                      </span>
                    </span>
                  </button>
                );
              })
            )}
          </aside>
        )}

        {showDetail && selectedAgent && (
          <section style={{ ...styles.detail, ...(isMobile ? { border: 0, borderRadius: 0, boxShadow: 'none' } : null) }}>
            <div style={{ ...styles.detailHead, ...(isMobile ? { gap: 4, padding: '6px 8px' } : compactHeight ? { paddingTop: 8 } : null) }}>
              {isMobile && <AiAgentButton touch variant="quiet" icon aria-label="Back to agent list" onClick={() => setSelected(null)}><IconChevronLeft /></AiAgentButton>}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={styles.titleRow}>
                  <div style={styles.detailName} title={`${displayName(selectedAgent)}${selectedAgent.cwd ? ` · ${selectedAgent.cwd}` : ''}`}>{displayName(selectedAgent)}</div>
                  {features.status_detection && <span style={{ ...styles.badge, color: statusMeta(selectedAgent.status).color, background: statusMeta(selectedAgent.status).bg }}>
                    <span style={{ ...styles.dot, background: statusMeta(selectedAgent.status).color }} />{statusMeta(selectedAgent.status).label}
                  </span>}
                </div>
                {!inlineNotice && <div style={styles.detailMeta} title={selectedAgent.cwd ?? undefined}>
                  {selectedAgent.kind || 'agent'}{selectedAgent.cwd ? ` · ${selectedAgent.cwd}` : ''}
                </div>}
              </div>
              <div style={styles.headActions}>
                <AiAgentButton touch={isMobile} variant="quiet" icon aria-label={loadingOutput ? 'Cancel refresh' : 'Refresh output'}
                  title={loadingOutput ? 'Reading output · click to cancel' : updatedAt ? `Refresh output · updated ${new Date(updatedAt).toLocaleTimeString()}` : 'Refresh output'}
                  disabled={!reachable} onClick={refreshOutput}>{loadingOutput ? <IconClose style={iconSm} /> : <IconRefresh style={iconSm} />}</AiAgentButton>
                {settingsControl}
              </div>
            </div>

            {((actionError && !inlineError) || outputError || (!inlineNotice && statusWarning)
              || (!inlineNotice && noticeActive) || copyFailedFor === copyLabel) && <div style={{ ...styles.callouts, ...(isMobile ? { padding: '8px 8px 0' } : null) }}>
              {actionError && !inlineError && <AiAgentCallout tone="danger" role="alert" touch={isMobile} dismissLabel="Dismiss error" onDismiss={() => setActionError(null)}>{actionError}</AiAgentCallout>}
              {outputError && <AiAgentCallout tone="danger" role="alert">{outputError} Use Refresh to retry.</AiAgentCallout>}
              {!inlineNotice && statusWarning && <AiAgentCallout tone="warning">{statusWarning}</AiAgentCallout>}
              {!inlineNotice && noticeActive && <AiAgentCallout role="status" touch={isMobile}
                onDismiss={sending ? undefined : actionNotice ? () => setActionNotice(null) : undefined} dismissLabel="Dismiss notice">
                <span style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span>{noticeText}</span>
                  {stopWaitingButton}
                </span>
              </AiAgentCallout>}
              {copyFailedFor === copyLabel && <AiAgentCallout tone="danger" role="alert">Could not copy. Select the output text and copy it manually.</AiAgentCallout>}
            </div>}
            <div style={{ ...styles.snapshotBar, padding: isMobile ? '0 4px 0 12px' : '0 8px 0 20px', ...(compactHeight ? { marginTop: 6, minHeight: 30 } : null) }}>
              <div role="group" aria-label="Output snapshot details" style={{ display: 'flex', flex: 1, minWidth: 0, alignItems: 'center', flexWrap: 'wrap', gap: '0 8px' }}>
                {inlineError ? <span role="alert" style={{ ...styles.snapshotMeta, flex: 1, minWidth: 0, flexWrap: 'nowrap', color: c.danger }}>
                  <span aria-hidden="true" style={{ ...styles.dot, background: c.danger }} />
                  <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={inlineError}>{inlineError}</span>
                  <AiAgentButton variant="quiet" icon size="sm" aria-label="Dismiss error" title="Dismiss error"
                    onClick={() => setActionError(null)} style={{ width: 20, minWidth: 20, height: 20, color: c.textMuted }}>
                    <IconClose style={{ width: 12, height: 12 }} />
                  </AiAgentButton>
                </span> : inlineNotice && (noticeActive || statusWarning) ? <span role="status" style={{ ...styles.snapshotMeta, flex: 1, minWidth: 0, flexWrap: 'nowrap', color: c.text }}>
                  <span aria-hidden="true" style={{ ...styles.dot, background: noticeActive ? c.textMuted : c.warning }} />
                  <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={(noticeActive ? noticeText : statusWarning) ?? undefined}>{noticeActive ? noticeText : statusWarning}</span>
                  {stopWaitingButton}
                  {!sending && actionNotice && <AiAgentButton variant="quiet" icon size="sm" aria-label="Dismiss notice" title="Dismiss notice"
                    onClick={() => setActionNotice(null)} style={{ width: 20, minWidth: 20, height: 20, color: c.textMuted }}>
                    <IconClose style={{ width: 12, height: 12 }} />
                  </AiAgentButton>}
                </span> : <span style={styles.snapshotMeta} title="A snapshot, not a live terminal stream. Only the selected window is refreshed.">
                  <span>{updatedAt ? `Snapshot · ${new Date(updatedAt).toLocaleTimeString()}` : loadingOutput ? 'Reading output…' : 'No snapshot yet'}</span>
                  <span style={{ color: c.textFaint }} aria-hidden="true">·</span>
                  <span style={{ color: c.textMuted }}>{autoRefresh[selectedAgent.target] === false ? 'Manual' : 'Auto · 1m'}</span>
                </span>}
                {outputChanged && <AiAgentButton variant="quiet" size="sm" touch={isMobile} aria-label="Refresh changed output" disabled={loadingOutput || !reachable}
                  onClick={refreshOutput} style={{ color: c.accent, height: isMobile ? 24 : 22, padding: '0 6px', fontSize: 11 }}>
                  <span aria-hidden="true" style={{ ...styles.dot, background: c.accent }} />Status changed · Refresh</AiAgentButton>}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                {!followingOutput && <AiAgentButton variant="quiet" size="sm" touch={isMobile} aria-label="Jump to latest output"
                  title="Scroll to the bottom of this snapshot without sending remote input" onClick={jumpToLatest}>Latest ↓</AiAgentButton>}
                <AiAgentButton variant="quiet" size="sm" touch={isMobile} aria-label="Copy output" title={copied ? 'Copied!' : 'Copy this output snapshot'}
                  disabled={!output || copying} onClick={() => void copyOutput()}>
                  {copied ? <IconCheck style={{ ...iconXs, color: c.success }} /> : <IconClipboard style={iconXs} />}
                  {!isMobile && (copied ? 'Copied' : copying ? 'Copying…' : 'Copy')}
                </AiAgentButton>
                <span role="status" style={styles.srOnly}>{copied ? 'Output copied to clipboard.' : ''}</span>
              </div>
            </div>
            <pre
              ref={outputBoxRef}
              style={{ ...styles.output, whiteSpace: wrapOutput ? 'pre-wrap' : 'pre', ...(compactHeight ? { minHeight: 16, padding: '8px 20px' } : null) }}
              aria-label={`Output from ${displayName(selectedAgent)}`}
              tabIndex={0}
              onScroll={(e) => {
                const el = e.currentTarget;
                const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
                stickToBottomRef.current = distance < 48;
                setFollowingOutput(distance < 48);
              }}
            >
              {loadingOutput && !output
                ? 'Reading latest output…'
                : output || 'No output yet. Send a prompt or wait for the agent to write.'}
            </pre>

            <div style={{ ...styles.composer, ...(isMobile ? { padding: '4px 8px max(8px, env(safe-area-inset-bottom))' } : compactHeight ? { padding: '8px 12px 10px', gap: 8 } : null) }}>
              <AiAgentShortcuts key={JSON.stringify([selectedIdentity, selectedAgent.kind])} kind={selectedAgent.kind}
                disabled={sending || !reachable} onSend={sendKeys} compact={compactHeight} allowedKeys={features.keys} />
              <div style={{ ...styles.inputCard, ...(composerFocused ? styles.inputCardFocused : null) }}
                onFocus={() => setComposerFocused(true)} onBlur={() => setComposerFocused(false)}>
                <textarea
                  ref={promptRef}
                  value={prompt}
                  onChange={(e) => {
                    if (selectedIdentity) setDrafts((prev) => ({ ...prev, [selectedIdentity]: e.target.value }));
                  }}
                  aria-label={`Prompt for ${displayName(selectedAgent)}`}
                  aria-describedby={promptHintId}
                  placeholder={`Message ${displayName(selectedAgent)}…`}
                  rows={2}
                  maxLength={PROMPT_MAX_BYTES}
                  disabled={sending}
                  style={{ ...styles.textarea, fontSize: 13.5, ...(compactHeight ? { minHeight: 40, padding: '10px 14px 4px' } : null) }}
                  onKeyDown={(e) => {
                    if (!e.nativeEvent.isComposing && (e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                      e.preventDefault();
                      void sendPrompt();
                    }
                  }}
                />
                <div style={styles.composerBar}>
                  <span id={promptHintId} style={{ ...styles.composerHint, color: promptBytes > PROMPT_MAX_BYTES ? c.danger : c.textSecondary }}>
                    {promptHint}
                  </span>
                  {promptBytes >= PROMPT_MAX_BYTES * 0.75 && <span style={{ ...styles.composerHint, marginLeft: 'auto', whiteSpace: 'nowrap', color: promptBytes > PROMPT_MAX_BYTES ? c.danger : c.textMuted }}>{(promptBytes / 1024).toFixed(1)} / 32 KiB</span>}
                  {reviewLabel && <span style={{ ...styles.composerHint, marginLeft: promptBytes >= PROMPT_MAX_BYTES * 0.75 ? undefined : 'auto', flexShrink: 0, maxWidth: '45%', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: promptReview?.state === 'off' ? c.warning : c.textMuted }} title={reviewLabel}>{reviewLabel}</span>}
                  <AiAgentButton
                    variant="primary" touch={isMobile} style={{ padding: '0 14px' }}
                    onClick={() => void sendPrompt()}
                    disabled={promptDisabled}
                    title={promptDisabled ? promptHint : `Send to ${displayName(selectedAgent)}`}
                  >
                {sending ? (waitEnabled ? 'Waiting…' : reviewing ? 'Reviewing…' : 'Sending…') : 'Send'}
                  </AiAgentButton>
                </div>
              </div>
            </div>
          </section>
        )}

        {!isMobile && !selectedAgent && reachable && agents.length > 0 && (
          <section style={styles.detailEmpty}>
            <div style={styles.emptyTitle}>Select an agent</div>
            <p style={styles.emptyText}>
              Read the latest output, send a prompt, or tap a key for an approval dialog.
            </p>
          </section>
        )}
      </div>
    </div>
  );
}

const iconSm: React.CSSProperties = { width: 15, height: 15 };
const iconXs: React.CSSProperties = { width: 13, height: 13 };

const styles: Record<string, React.CSSProperties> = {
  listTools: { display: 'flex', flexDirection: 'column', gap: 6, padding: '0 0 10px', flexShrink: 0 },
  searchBox: { flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 6, padding: '0 8px', borderWidth: 1, borderStyle: 'solid', borderColor: c.border, borderRadius: radius.md, background: c.surface, color: c.textMuted, transition: 'border-color 0.12s, box-shadow 0.12s' },
  searchInput: { width: '100%', minWidth: 0, padding: 0, border: 'none', outline: 'none', background: 'transparent', color: c.text, fontFamily: font.sans },
  filterSelect: { width: '100%', borderWidth: 1, borderStyle: 'solid', borderColor: c.border, outline: 'none', transition: 'border-color 0.12s, box-shadow 0.12s', borderRadius: radius.md, background: c.surface, color: c.textSecondary, fontFamily: font.sans, fontSize: 12, padding: '0 8px' },
  draftBadge: { flexShrink: 0, fontSize: 10.5, color: c.accent, fontWeight: 500 },
  callouts: { display: 'flex', flexDirection: 'column', gap: 6, padding: '14px 20px 0', flexShrink: 0 },
  headActions: { display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0 },
  cardTop: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 },
  cardHover: { background: c.bgSubtle },
  fieldFocused: { borderColor: c.accent, boxShadow: `0 0 0 3px ${c.accentBg}` },
  noMatch: { display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 8, padding: '16px 10px' },
  inputCardFocused: { borderColor: c.accent, boxShadow: `0 0 0 3px ${c.accentBg}` },
  snapshotBar: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 4, flexShrink: 0, flexWrap: 'wrap', marginTop: 10, borderTop: `1px solid ${c.borderSubtle}`, borderBottom: `1px solid ${c.borderSubtle}`, background: c.bgSubtle, minHeight: 34 },
  snapshotMeta: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0 6px', fontSize: 11, color: c.textSecondary, padding: '4px 0', fontVariantNumeric: 'tabular-nums' },
  srOnly: { position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden', clipPath: 'inset(50%)', whiteSpace: 'nowrap', border: 0 },
  menuTitle: { ...layout.cardTitle, fontSize: 13, marginBottom: 4 },
  menuNote: { ...layout.prefHint, paddingTop: 12, borderTop: `1px solid ${c.borderSubtle}` },
  settingRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, minHeight: 32, fontSize: 12.5, lineHeight: 1.45, color: c.text, cursor: 'pointer' },
  listHeading: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '2px 2px 12px', ...layout.cardTitle, fontSize: 13 },
  inputCard: { display: 'flex', flexDirection: 'column', flexShrink: 1, minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain',
    borderWidth: 1, borderStyle: 'solid', borderColor: c.border, borderRadius: radius.lg, background: c.surface, boxShadow: shadow.xs,
    transition: 'border-color 0.12s, box-shadow 0.12s' },
  page: {
    flex: 1,
    minHeight: 0,
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    background: c.bgSubtle,
    fontFamily: font.sans,
  },
  header: {
    ...layout.pageHeader,
    alignItems: 'center',
  },
  titleRow: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 },
  countChip: {
    minWidth: 18,
    height: 18,
    padding: '0 6px',
    borderRadius: radius.pill,
    background: c.bgMuted,
    color: c.textSecondary,
    fontSize: 10.5,
    fontWeight: 600,
    fontVariantNumeric: 'tabular-nums',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
  },

  bodyDesktop: {
    flex: 1,
    minHeight: 0,
    display: 'flex',
    gap: 16,
    padding: 20,
    overflow: 'hidden',
  },
  bodyMobile: {
    flex: 1,
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
  },
  listDesktop: {
    width: 'clamp(220px, 28%, 300px)',
    flexShrink: 0,
    overflow: 'auto',
    border: `1px solid ${c.border}`,
    borderRadius: radius.lg,
    boxShadow: shadow.xs,
    padding: 12,
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    background: c.surface,
  },
  listMobile: {
    flex: 1,
    minHeight: 0,
    overflow: 'auto',
    padding: 16,
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  },
  card: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    textAlign: 'left',
    width: '100%',
    padding: '9px 10px',
    flexShrink: 0,
    borderRadius: radius.md,
    borderWidth: 1, borderStyle: 'solid', borderColor: 'transparent',
    background: 'transparent',
    cursor: 'pointer',
    fontFamily: font.sans,
    transition: 'background 0.12s',
  },
  cardActive: {
    background: c.accentBg,
  },
  dot: {
    width: 5,
    height: 5,
    borderRadius: radius.pill,
    flexShrink: 0,
  },
  cardBody: {
    flex: 1,
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 3,
  },
  cardName: {
    flex: 1,
    minWidth: 0,
    fontSize: 13,
    fontWeight: 500,
    color: c.text,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  cardMeta: {
    fontSize: 11.5,
    color: c.textMuted,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  badge: {
    flexShrink: 0,
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
    height: 18,
    boxSizing: 'border-box',
    fontSize: 10.5,
    fontWeight: 500,
    lineHeight: 1,
    padding: '0 7px',
    borderRadius: radius.pill,
  },
  empty: {
    padding: 24,
    textAlign: 'center',
    color: c.textMuted,
    fontSize: 13,
  },
  emptyCard: {
    ...layout.card,
    padding: 24,
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
    alignItems: 'flex-start',
  },
  emptyTitle: {
    fontSize: 14,
    fontWeight: 600,
    color: c.text,
  },
  emptyText: {
    margin: 0,
    fontSize: 13,
    color: c.textSecondary,
    lineHeight: 1.5,
  },
  inlineCode: {
    fontFamily: font.mono,
    fontSize: 12,
    background: c.bgMuted,
    padding: '1px 5px',
    borderRadius: radius.sm,
  },
  detail: {
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
    background: c.surface,
    border: `1px solid ${c.border}`,
    borderRadius: radius.lg,
    boxShadow: shadow.xs,
    overflow: 'auto',
  },
  detailEmpty: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    padding: 32,
    color: c.textMuted,
  },
  detailHead: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    padding: '18px 12px 0 20px',
    flexShrink: 0,
  },
  detailName: {
    minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    fontSize: 14,
    fontWeight: 600,
    color: c.text,
  },
  detailMeta: {
    marginTop: 3,
    fontSize: 11.5,
    color: c.textMuted,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  composerHint: { fontSize: 11, lineHeight: 1.4, minWidth: 0 },
  output: {
    flex: 1,
    minHeight: 80,
    overscrollBehavior: 'contain',
    margin: 0,
    padding: '16px 20px',
    overflow: 'auto',
    background: c.bgSubtle,
    color: c.text,
    fontFamily: font.mono,
    fontSize: 12.5,
    lineHeight: 1.65,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    borderBottom: `1px solid ${c.border}`,
  },
  composer: {
    padding: '10px 16px 16px',
    flexShrink: 0,
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
    background: c.surface,
  },
  keyRow: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 2,
  },

  textarea: {
    width: '100%',
    resize: 'none',
    outline: 'none',
    minHeight: 56,
    maxHeight: 160,
    padding: '12px 14px 6px',
    borderRadius: radius.md,
    border: 'none',
    background: 'transparent',
    color: c.text,
    fontFamily: font.sans,
    fontSize: 14,
    lineHeight: 1.45,
    boxSizing: 'border-box',
  },
  composerBar: {
    padding: '0 8px 8px 14px',
    display: 'flex',
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
};
