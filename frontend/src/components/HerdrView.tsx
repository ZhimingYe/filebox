import { useCallback, useEffect, useId, useMemo, useLayoutEffect, useRef, useState } from 'react';
import * as api from '../api/client';
import { friendlyMessage } from '../api/client';
import { c, font, radius } from '../theme';
import { HerdrShortcuts } from './HerdrShortcuts';
import { HerdrButton, HerdrPopover } from './HerdrControls';
import { HerdrQueue } from '../lib/herdrQueue';
import { useIsMobile } from '../state/useIsMobile';
import { useCopyToClipboard } from '../hooks/useCopyToClipboard';
import { IconChevronLeft, IconRefresh, IconSettings, IconClose, IconSearch, IconClipboard, IconCheck } from './icons';

interface Props {
  agent: api.AgentInfo;
  onStatus?: (agentId: string, response: api.HerdrResponse) => void;
  onStatusError?: (agentId: string, error: unknown) => void;
  focusRequest?: { target: string; nonce: number } | null;
}

const OUTPUT_REFRESH_MS = 60 * 1000;
const PROMPT_MAX_BYTES = 32 * 1024;

function paneIdentity(item: api.HerdrAgent): string {
  return JSON.stringify([item.target, item.workspace_id, item.pane_id]);
}

function outputSignature(item: api.HerdrAgent): string {
  return `${item.target}\0${item.status}\0${item.completion_seq ?? ''}`;
}

const STATUS_ORDER: Record<api.HerdrAgentStatus, number> = {
  blocked: 0,
  working: 1,
  done: 2,
  idle: 3,
  unknown: 4,
};

function statusMeta(status: api.HerdrAgentStatus): { label: string; color: string; bg: string } {
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

function displayName(item: api.HerdrAgent): string {
  return item.name?.trim() || item.title?.trim() || item.pane_id || item.target;
}

function sortAgents(items: api.HerdrAgent[]): api.HerdrAgent[] {
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
function herdrFailureMessage(error: unknown): string | null {
  if (isAbortError(error)) return null;
  if (errorCode(error) === 'invalid_request') {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return message.trim();
  }
  return friendlyMessage(error);
}

/**
 * Sidebar Herdr panel: list coding agents on the selected backend, read the
 * latest output, send a prompt, and tap keys for blocked approvals. The
 * Filebox agent drives the local `herdr` CLI; this UI is a compact control
 * surface, not a clone of the Herdr TUI.
 */
export function HerdrView({ agent, onStatus, onStatusError, focusRequest }: Props) {
  const isMobile = useIsMobile();
  const isMobileRef = useRef(isMobile);
  isMobileRef.current = isMobile;
  const [status, setStatus] = useState<api.HerdrServerStatus | null>(null);
  const [agents, setAgents] = useState<api.HerdrAgent[]>([]);
  const [agentQuery, setAgentQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<api.HerdrAgentStatus | 'all'>('all');
  const [selected, setSelected] = useState<string | null>(null);
  const [output, setOutput] = useState<string>('');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [wait, setWait] = useState(false);
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
  const queue = useRef(new HerdrQueue());
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

  const command = useCallback((body: api.HerdrCommandBody, signal: AbortSignal, timeoutMs: number, priority = 0, valid: () => boolean = () => true) =>
    queue.current.run(() => {
      if (signal.aborted || !valid()) throw new DOMException('Obsolete request', 'AbortError');
      return api.herdrCommand(agent.id, body, signal, timeoutMs);
    }, signal, priority), [agent.id]);

  const selectedAgent = useMemo(
    () => agents.find((a) => a.target === selected) ?? null,
    [agents, selected],
  );
  const selectedIdentity = selectedAgent ? paneIdentity(selectedAgent) : null;
  const prompt = selectedIdentity ? drafts[selectedIdentity] ?? '' : '';
  const promptBytes = new TextEncoder().encode(prompt.trim()).length;
  const filteredAgents = useMemo(() => {
    const query = agentQuery.trim().toLocaleLowerCase();
    return agents.filter((item) => (statusFilter === 'all' || item.status === statusFilter)
      && [displayName(item), item.kind, item.cwd, item.pane_id, item.target].join(' ').toLocaleLowerCase().includes(query));
  }, [agents, agentQuery, statusFilter]);

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
      statusCallbacks.current.onStatus?.(agent.id, res);
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
      if (mountedRef.current && !controller.signal.aborted) statusCallbacks.current.onStatusError?.(agent.id, e);
      if (!mountedRef.current || controller.signal.aborted) return;
      const message = herdrFailureMessage(e);
      if (message === null) return;
      if (silent && errorCode(e) === 'agent_busy') return;
      setListError(message);
      if (errorCode(e) === 'herdr_unavailable') {
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
  }, [agent.id, command]);

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
        { op: 'read', target: itemAtStart.pane_id || target, lines: 120, read_source: visible ? 'visible' : 'detection' },
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
          const next = prev.map((a) => (a.target === res.agent!.target || a.pane_id === res.agent!.pane_id ? res.agent! : a));
          return sortAgents(next);
        });
      }
      return true;
    } catch (e) {
      if (!mountedRef.current || controller.signal.aborted || outputGenRef.current !== gen || selectedRef.current !== target) return;
      const message = herdrFailureMessage(e);
      if (message === null) return;
      if (silent && (errorCode(e) === 'agent_busy' || errorCode(e) === 'herdr_not_idle')) return;
      setOutputError(message);
    } finally {
      parentSignal?.removeEventListener('abort', abort);
      if (outputGenRef.current === gen) { abortOutput.current = null; if (mountedRef.current) setLoadingOutput(false); }
    }
  }, [command]);

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
    if (!focusRequest || handledFocus.current === focusRequest.nonce || loadingList) return;
    if (agents.some((a) => a.target === focusRequest.target)) {
      handledFocus.current = focusRequest.nonce;
      setSelected(focusRequest.target);
    }
  }, [focusRequest, agents, loadingList]);

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
    el.style.height = `${Math.min(isMobile ? 120 : 160, Math.max(56, el.scrollHeight))}px`;
  }, [prompt, selectedIdentity, isMobile]);

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
    body: api.HerdrCommandBody,
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
    if (!text || promptBytes > PROMPT_MAX_BYTES || selectedAgent.status === 'blocked') return;
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
            target: selectedAgent.pane_id || target,
            text,
            wait,
            timeout_ms: wait ? 60_000 : undefined,
          },
          controller.signal,
          wait ? 80_000 : 25_000,
          valid,
        );
        if (controller.signal.aborted || !mountedRef.current || !valid()) return;
        setDrafts((prev) => ({ ...prev, [identity]: '' }));
        if (selectedRef.current === target) {
          setActionNotice(res.agent?.status === 'blocked'
            ? 'The agent needs your input. Read the output, then use the keys below.'
            : wait ? 'Finished waiting. Review the latest output below.' : 'Prompt sent. Refresh this window to see further output.');
        }
        await loadOutput(target, true, false, controller.signal);
        if (!controller.signal.aborted) await loadList(true, controller.signal);
      } catch (e) {
        if (controller.signal.aborted || isAbortError(e) || !mountedRef.current || !valid()) return;
        const message = herdrFailureMessage(e);
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
          { op: 'send_keys', target: selectedAgent.pane_id || target, keys },
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
        const message = herdrFailureMessage(e);
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
    || promptBytes > PROMPT_MAX_BYTES || selectedAgent?.status === 'blocked';
  const outputChanged = selectedAgent && seenSignature !== null && seenSignature !== outputSignature(selectedAgent);
  const copyLabel = JSON.stringify([selectedIdentity, updatedAt]);
  const copied = copiedPath === copyLabel;
  const promptHint = promptBytes > PROMPT_MAX_BYTES ? 'Prompt exceeds the 32 KiB limit. Shorten it before sending.'
    : sending ? 'Input submitted. Stop waiting only stops Filebox from waiting.'
    : !reachable ? 'Herdr is unavailable. Your draft is kept here.'
    : selectedAgent?.status === 'blocked' ? 'Waiting for approval. Use the remote keys before sending a message.'
    : wait ? 'Wait for result is on · up to 60 seconds'
    : isMobile ? 'Enter for new line' : 'Ctrl / ⌘ + Enter to send · Enter for new line';

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
  const listControl = <HerdrButton touch={isMobile}
    aria-label={loadingList ? 'Cancel status refresh' : 'Refresh agent list'}
    title={loadingList ? 'Cancel status refresh' : 'Refresh agent list'}
    onClick={() => loadingList ? cancelList() : void loadList(false)}>
    {loadingList ? <IconClose /> : <IconRefresh />}
  </HerdrButton>;

  const settingsControl = (
    <HerdrPopover key={selectedIdentity ?? 'list'} label="Herdr settings" trigger={<IconSettings />} touch={isMobile}>
      <div style={styles.menuTitle}>Workspace settings</div>
      {selectedAgent && <>
        <label style={styles.settingRow}>
          <span>Auto-refresh every minute</span>
          <input type="checkbox" checked={autoRefresh[selectedAgent.target] !== false}
            onChange={(event) => setAutoRefresh((prev) => ({ ...prev, [selectedAgent.target]: event.target.checked }))} />
        </label>
        <label style={styles.settingRow}><span>Wrap output</span>
          <input type="checkbox" checked={wrapOutput} onChange={(event) => setWrapOutput(event.target.checked)} />
        </label>
        <label style={styles.settingRow} title="Wait up to 60 seconds for completion or a request for input.">
          <span>Wait for result after sending</span>
          <input type="checkbox" checked={wait} disabled={sending} onChange={(event) => setWait(event.target.checked)} />
        </label>
      </>}
      <p style={styles.menuNote}>{updatedAt ? `Output updated ${new Date(updatedAt).toLocaleTimeString()}. ` : ''}Status checks every 30 seconds.{status?.version ? ` Herdr ${status.version}.` : ''}</p>
    </HerdrPopover>
  );

  return (
    <div style={styles.page}>
      {!showDetail && <header style={styles.header}>
        <div style={styles.titleRow}>
          <h1 style={styles.title}>Herdr</h1>
          <span style={styles.countChip}>{agents.length}</span>
          {!isMobile && <span style={styles.subtitle}>Agent workspace</span>}
        </div>
        <div style={styles.keyRow}>
          {listControl}
          {settingsControl}
        </div>
      </header>}

      {listError && reachable && (
        <div style={styles.banner}>{listError}</div>
      )}

      <div style={isMobile ? styles.bodyMobile : styles.bodyDesktop}>
        {showList && (
          <aside style={isMobile ? styles.listMobile : styles.listDesktop} aria-label="Herdr agents">
            {!isMobile && showDetail && <div style={styles.listHeading}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 600 }}>Herdr <span style={styles.countChip}>{agents.length}</span></span>
              {listControl}
            </div>}
            {reachable && (agents.length > 1 || agentQuery || statusFilter !== 'all') && <div style={styles.listTools}>
              <label style={styles.searchBox}>
                <IconSearch style={{ width: 14, height: 14, flexShrink: 0 }} />
                <input type="search" aria-label="Search agents" placeholder="Search agents…" value={agentQuery}
                  onChange={(event) => setAgentQuery(event.target.value)}
                  style={{ ...styles.searchInput, fontSize: isMobile ? 16 : 12, minHeight: isMobile ? 44 : 32 }} />
              </label>
              <select aria-label="Filter agents by status" value={statusFilter}
                onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)}
                style={{ ...styles.filterSelect, fontSize: isMobile ? 16 : 12, minHeight: isMobile ? 44 : 32 }}>
                <option value="all">All agents · {agents.length}</option>
                {(['blocked', 'working', 'done', 'idle', 'unknown'] as const).map((value) => <option key={value} value={value}>
                  {value === 'blocked' ? 'Needs input' : statusMeta(value).label} · {agents.filter((item) => item.status === value).length}
                </option>)}
              </select>
            </div>}
            {loadingList && agents.length === 0 && !listError ? (
              <div style={styles.empty}>Looking for agents…</div>
            ) : !reachable && listError && !status?.installed ? (
              <div style={styles.emptyCard}>
                <div style={styles.emptyTitle}>Could not reach Herdr</div>
                <p style={styles.emptyText}>{listError}</p>
                <button type="button" style={styles.primaryBtn} onClick={() => void loadList(false)} disabled={loadingList}>
                  Check again
                </button>
              </div>
            ) : !reachable ? (
              <div style={styles.emptyCard}>
                <div style={styles.emptyTitle}>Herdr is not running</div>
                <p style={styles.emptyText}>
                  Start Herdr on this backend with <span style={styles.inlineCode}>herdr</span> or{' '}
                  <span style={styles.inlineCode}>herdr server</span>, then refresh. Filebox only talks to the local CLI — never to agents on other machines.
                </p>
                <button type="button" style={styles.primaryBtn} onClick={() => void loadList(false)} disabled={loadingList}>
                  Check again
                </button>
              </div>
            ) : agents.length === 0 ? (
              <div style={styles.emptyCard}>
                <div style={styles.emptyTitle}>No agents running</div>
                <p style={styles.emptyText}>
                  Start a coding agent inside Herdr on this machine. Filebox will list it here so you can read output and send a prompt from your phone.
                </p>
              </div>
            ) : (
              filteredAgents.length === 0 ? <div style={styles.emptyCard}>
                <div style={styles.emptyTitle}>No matching agents</div>
                <p style={styles.emptyText}>Try another name, folder, or status.</p>
                <HerdrButton onClick={() => { setAgentQuery(''); setStatusFilter('all'); }} touch={isMobile}>Clear filters</HerdrButton>
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
                    style={{
                      ...styles.card,
                      ...(active ? styles.cardActive : null),
                    }}
                  >
                    <span style={{ ...styles.dot, background: meta.color }} />
                    <span style={styles.cardBody}>
                      <span style={styles.cardName}>{displayName(item)}</span>
                      <span style={styles.cardMeta}>
                        {item.kind || 'agent'}
                        {item.cwd ? ` · ${item.cwd}` : item.pane_id ? ` · ${item.pane_id}` : ''}
                      </span>
                      {drafts[paneIdentity(item)]?.trim() && <span style={styles.draftBadge}>Draft</span>}
                    </span>
                    <span style={{ ...styles.badge, color: meta.color, background: meta.bg }}>
                      {meta.label}
                    </span>
                  </button>
                );
              })
            )}
          </aside>
        )}

        {showDetail && selectedAgent && (
          <section style={styles.detail}>
            <div style={{ ...styles.detailHead, ...(isMobile ? { gap: 4, padding: '4px 8px' } : null) }}>
              {isMobile && <HerdrButton touch aria-label="Back to agent list" onClick={() => setSelected(null)}><IconChevronLeft /></HerdrButton>}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={styles.titleRow}>
                  <div style={styles.detailName}>{displayName(selectedAgent)}</div>
                  <span style={{ ...styles.badge, color: statusMeta(selectedAgent.status).color, background: statusMeta(selectedAgent.status).bg }}>
                    {statusMeta(selectedAgent.status).label}
                  </span>
                </div>
                <div style={styles.detailMeta} title={selectedAgent.cwd ?? undefined}>
                  {selectedAgent.kind || 'agent'}{selectedAgent.cwd ? ` · ${selectedAgent.cwd}` : ''}
                </div>
              </div>
              <HerdrButton touch={isMobile} aria-label={loadingOutput ? 'Cancel refresh' : 'Refresh output'}
                title={loadingOutput ? 'Reading output · click to cancel' : updatedAt ? `Refresh output · updated ${new Date(updatedAt).toLocaleTimeString()}` : 'Refresh output'}
                disabled={!reachable} style={{ borderColor: c.border, minWidth: isMobile ? 44 : 84 }}
                onClick={refreshOutput}>{loadingOutput ? <IconClose /> : <IconRefresh />}{!isMobile && (loadingOutput ? 'Reading…' : 'Refresh')}</HerdrButton>
              {settingsControl}
            </div>

            {actionError && <div role="alert" style={styles.actionError}><span style={{ flex: 1 }}>{actionError}</span>
              <HerdrButton aria-label="Dismiss error" onClick={() => setActionError(null)}><IconClose /></HerdrButton>
            </div>}
            {outputError && <div role="alert" style={styles.actionError}>{outputError} Use Refresh to retry.</div>}
            {selectedAgent.status === 'blocked' && !sending && <div style={styles.notice}>Needs your input. Use the remote keys below to respond.</div>}
            {selectedAgent.status === 'unknown' && !sending && <div style={styles.notice}>Status unavailable. Check the output before continuing.</div>}
            {(sending || (loadingOutput && outputElapsed >= 8) || actionNotice) && <div style={styles.outputBar}>
              <span role="status" style={{ minWidth: 0, overflow: 'auto', maxHeight: 64 }}>
                {sending ? `${wait ? 'Waiting for' : 'Sending to'} ${actionTarget} · ${elapsed}s`
                  : loadingOutput ? (outputElapsed >= 8 ? `Taking longer than usual · ${outputElapsed}s` : 'Refreshing…')
                  : actionNotice || (seenSignature !== null && seenSignature !== outputSignature(selectedAgent)
                    ? 'Status changed · refresh to see the latest output'
                    : updatedAt ? `Updated ${new Date(updatedAt).toLocaleTimeString()}` : 'Latest output')}
              </span>
              {sending ? <HerdrButton touch={isMobile} onClick={stopWaiting}>Stop waiting</HerdrButton>
                : actionNotice && <HerdrButton touch={isMobile} aria-label="Dismiss notice" onClick={() => setActionNotice(null)}><IconClose /></HerdrButton>}
            </div>}
            <div style={{ ...styles.snapshotBar, padding: isMobile ? '0 8px' : '0 12px' }}>
              <div role="group" aria-label="Output snapshot details" style={{ display: 'flex', flex: 1, minWidth: 0, alignItems: 'center', flexWrap: 'wrap', gap: '0 8px' }}>
                <span style={styles.snapshotMeta} title="A snapshot, not a live terminal stream. Only the selected window is refreshed.">
                  {updatedAt ? `Snapshot · ${new Date(updatedAt).toLocaleTimeString()}` : loadingOutput ? 'Reading output…' : 'No snapshot yet'}
                  <span style={{ color: c.textMuted }}>{autoRefresh[selectedAgent.target] === false ? 'Manual' : 'Auto · 1m'}</span>
                </span>
                {outputChanged && <HerdrButton touch={isMobile} aria-label="Refresh changed output" disabled={loadingOutput || !reachable}
                  onClick={refreshOutput} style={{ color: c.accent, padding: '0 4px' }}>Status changed · Refresh</HerdrButton>}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                {!followingOutput && <HerdrButton touch={isMobile} aria-label="Jump to latest output"
                  title="Scroll to the bottom of this snapshot without sending remote input" onClick={jumpToLatest}>Latest ↓</HerdrButton>}
                <HerdrButton touch={isMobile} aria-label="Copy output" title={copied ? 'Copied!' : 'Copy this output snapshot'}
                  disabled={!output || copying} onClick={() => void copyOutput()}>
                  {copied ? <IconCheck style={{ color: c.success }} /> : <IconClipboard />}
                  {!isMobile && (copied ? 'Copied' : copying ? 'Copying…' : 'Copy')}
                </HerdrButton>
                <span role="status" style={styles.srOnly}>{copied ? 'Output copied to clipboard.' : ''}</span>
              </div>
            </div>
            {copyFailedFor === copyLabel && <div role="alert" style={styles.notice}>Could not copy. Select the output text and copy it manually.</div>}
            <pre
              ref={outputBoxRef}
              style={{ ...styles.output, whiteSpace: wrapOutput ? 'pre-wrap' : 'pre' }}
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

            <div style={{ ...styles.composer, ...(isMobile ? { padding: '4px 8px max(8px, env(safe-area-inset-bottom))' } : null) }}>
              <HerdrShortcuts key={JSON.stringify([selectedIdentity, selectedAgent.kind])} kind={selectedAgent.kind}
                disabled={sending || !reachable} onSend={sendKeys} />
              <div style={styles.inputCard}>
                <div style={styles.composerLabel}>Message to <strong style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{displayName(selectedAgent)}</strong>
                  {promptBytes >= PROMPT_MAX_BYTES * 0.75 && <span style={{ marginLeft: 'auto', whiteSpace: 'nowrap' }}>{(promptBytes / 1024).toFixed(1)} / 32 KiB</span>}
                </div>
                <textarea
                  ref={promptRef}
                  value={prompt}
                  onChange={(e) => {
                    if (selectedIdentity) setDrafts((prev) => ({ ...prev, [selectedIdentity]: e.target.value }));
                  }}
                  aria-label={`Prompt for ${displayName(selectedAgent)}`}
                  aria-describedby={promptHintId}
                  placeholder={`Message ${selectedAgent.kind || 'agent'}…`}
                  rows={2}
                  maxLength={PROMPT_MAX_BYTES}
                  disabled={sending}
                  style={{ ...styles.textarea, fontSize: isMobile ? 16 : 14 }}
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
                  <button
                    type="button"
                    onClick={() => void sendPrompt()}
                    disabled={promptDisabled}
                    title={promptDisabled ? promptHint : `Send to ${displayName(selectedAgent)}`}
                    style={{
                      ...styles.primaryBtn,
                      ...(isMobile ? { minHeight: 44 } : null),
                      ...(promptDisabled ? styles.primaryBtnDisabled : null),
                    }}
                  >
                    {sending ? (wait ? 'Waiting…' : 'Sending…') : 'Send'}
                  </button>
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

const styles: Record<string, React.CSSProperties> = {
  listTools: { display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 4, flexShrink: 0 },
  searchBox: { display: 'flex', alignItems: 'center', gap: 6, padding: '0 8px', border: `1px solid ${c.border}`, borderRadius: radius.sm, background: c.surface, color: c.textSecondary },
  searchInput: { width: '100%', minWidth: 0, border: 'none', background: 'transparent', color: c.text, fontFamily: font.sans },
  filterSelect: { width: '100%', border: `1px solid ${c.border}`, borderRadius: radius.sm, background: c.surface, color: c.textSecondary, fontFamily: font.sans, fontSize: 12, padding: '0 8px' },
  draftBadge: { alignSelf: 'flex-start', fontSize: 10, color: c.accent, fontWeight: 500 },
  snapshotBar: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 4, flexShrink: 0, flexWrap: 'wrap', borderBottom: `1px solid ${c.borderSubtle}`, background: c.bgSubtle, minHeight: 32 },
  snapshotMeta: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0 8px', fontSize: 11, color: c.textSecondary, padding: '4px 0' },
  composerLabel: { display: 'flex', alignItems: 'center', gap: 4, minWidth: 0, padding: '8px 12px 0', fontSize: 11, color: c.textSecondary },
  srOnly: { position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden', clipPath: 'inset(50%)', whiteSpace: 'nowrap', border: 0 },
  menuTitle: { fontSize: 13, fontWeight: 600, marginBottom: 8 },
  menuNote: { fontSize: 11, lineHeight: 1.5, color: c.textSecondary, margin: '8px 0' },
  settingRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, minHeight: 44, cursor: 'pointer' },
  listHeading: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 4px 8px', fontSize: 11, fontWeight: 500, color: c.textSecondary },
  inputCard: { border: `1px solid ${c.border}`, borderRadius: radius.lg, background: c.bgSubtle },
  page: {
    flex: 1,
    minHeight: 0,
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    background: c.bg,
    fontFamily: font.sans,
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    padding: '8px 16px',
    flexShrink: 0,
    borderBottom: `1px solid ${c.border}`,
    background: c.bg,
  },
  titleRow: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 },
  title: {
    margin: 0,
    fontSize: 16,
    fontWeight: 600,
    color: c.text,
    fontFamily: font.sans,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  countChip: {
    minWidth: 20,
    height: 20,
    padding: '0 6px',
    borderRadius: radius.pill,
    background: c.accentBg,
    color: c.accent,
    fontSize: 11,
    fontWeight: 600,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  subtitle: {
    margin: 0,
    fontSize: 12,
    color: c.textMuted,
    fontFamily: font.sans,
  },

  banner: {
    margin: '12px 20px 0',
    padding: '10px 12px',
    borderRadius: radius.md,
    background: c.warningBg,
    color: c.text,
    fontSize: 13,
    border: `1px solid ${c.border}`,
  },
  bodyDesktop: {
    flex: 1,
    minHeight: 0,
    display: 'flex',
  },
  bodyMobile: {
    flex: 1,
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
  },
  listDesktop: {
    width: 224,
    flexShrink: 0,
    overflow: 'auto',
    borderRight: `1px solid ${c.border}`,
    padding: 8,
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    background: c.bgSubtle,
  },
  listMobile: {
    flex: 1,
    minHeight: 0,
    overflow: 'auto',
    padding: 12,
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  card: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    textAlign: 'left',
    width: '100%',
    padding: '11px 10px',
    minHeight: 52,
    borderRadius: radius.md,
    borderWidth: 1, borderStyle: 'solid', borderColor: 'transparent',
    background: 'transparent',
    cursor: 'pointer',
    fontFamily: font.sans,
  },
  cardActive: {
    borderColor: c.accentBg,
    background: c.accentBg,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: radius.pill,
    flexShrink: 0,
  },
  cardBody: {
    flex: 1,
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
  },
  cardName: {
    fontSize: 13,
    fontWeight: 600,
    color: c.text,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  cardMeta: {
    fontSize: 11,
    color: c.textMuted,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  badge: {
    flexShrink: 0,
    fontSize: 10,
    fontWeight: 500,
    letterSpacing: 0.02,
    padding: '3px 7px',
    borderRadius: radius.pill,
  },
  empty: {
    padding: 24,
    textAlign: 'center',
    color: c.textMuted,
    fontSize: 13,
  },
  emptyCard: {
    padding: 20,
    borderRadius: radius.lg,
    border: `1px solid ${c.border}`,
    background: c.surface,
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
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
    padding: '8px 12px',
    flexShrink: 0,
    borderBottom: `1px solid ${c.border}`,
  },
  detailName: {
    minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    fontSize: 14,
    fontWeight: 600,
    color: c.text,
  },
  detailMeta: {
    marginTop: 2,
    fontSize: 11,
    color: c.textSecondary,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  actionError: {
    display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0,
    margin: '8px 16px 0',
    padding: '8px 10px',
    borderRadius: radius.md,
    background: c.dangerBg,
    color: c.danger,
    fontSize: 12,
  },
  notice: {
    padding: '8px 16px',
    flexShrink: 0,
    background: c.warningBg,
    color: c.text,
    fontSize: 12,
    lineHeight: 1.5,
  },
  outputBar: {
    display: 'flex',
    flexShrink: 0,
    minHeight: 32,
    boxSizing: 'border-box',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    padding: '0 16px',
    color: c.textSecondary,
    fontSize: 11,
    borderBottom: `1px solid ${c.border}`,
  },
  composerHint: { fontSize: 11, lineHeight: 1.4 },
  output: {
    flex: 1,
    minHeight: 80,
    overscrollBehavior: 'contain',
    margin: 0,
    padding: '16px 20px',
    overflow: 'auto',
    background: c.bg,
    color: c.text,
    fontFamily: font.mono,
    fontSize: 12,
    lineHeight: 1.7,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    borderBottom: `1px solid ${c.border}`,
  },
  composer: {
    padding: '4px 16px 12px',
    flexShrink: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    background: c.surface,
  },
  keyRow: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 6,
  },

  textarea: {
    width: '100%',
    resize: 'vertical',
    minHeight: 56,
    maxHeight: 160,
    padding: '10px 12px',
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
    padding: '0 8px 8px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  primaryBtn: {
    minHeight: 32,
    padding: '0 16px',
    borderRadius: radius.md,
    border: 'none',
    background: c.accent,
    color: c.onAccent,
    fontSize: 13,
    fontWeight: 600,
    fontFamily: font.sans,
    cursor: 'pointer',
  },
  primaryBtnDisabled: {
    background: c.bgMuted,
    color: c.textMuted,
    cursor: 'default',
  },
};
