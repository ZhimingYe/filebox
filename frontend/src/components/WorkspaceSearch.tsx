import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from 'react';
import { VariableSizeList as VList, type ListChildComponentProps } from 'react-window';
import type { AgentInfo, SearchHit, SearchMode, WorkspaceSearchResult } from '../api/client';
import { cancelRequest, friendlyMessage, workspaceSearch } from '../api/client';
import { IconChevronRight } from './icons';
import { useSse } from '../state/events';
import { c, radius, font } from '../theme';

/** Path header + border; context lines are fixed-pitch for VariableSizeList. */
const HIT_PATH_H = 32;
const HIT_LINE_H = 18;
const HIT_CTX_PAD_Y = 12;
const HIT_GAP = 6;
/** Card top + bottom border (1px each). */
const HIT_BORDER = 2;

function estimateHitHeight(hit: SearchHit): number {
  const n = hit.context?.length ?? 0;
  const body = n === 0 ? 0 : HIT_CTX_PAD_Y + n * HIT_LINE_H;
  return HIT_PATH_H + body + HIT_BORDER + HIT_GAP;
}

/** Case-insensitive substring over path/root/context (client-side only). */
function hitMatchesFilter(hit: SearchHit, needle: string): boolean {
  const q = needle.trim().toLowerCase();
  if (!q) return true;
  if (hit.path.toLowerCase().includes(q)) return true;
  if (hit.root.toLowerCase().includes(q)) return true;
  for (const line of hit.context ?? []) {
    if (line.text.toLowerCase().includes(q)) return true;
  }
  return false;
}

interface Props {
  agent: AgentInfo;
  /** Prefer the currently selected Files root when present. */
  initialRoot?: string | null;
  onOpenFile?: (root: string, path: string) => void;
}

const DEFAULT_CONTEXT = 10;
const MAX_CONTEXT = 20;
/** Default dirs to skip so package / venv trees do not flood hits. */
const DEFAULT_SEARCH_IGNORE = [
  'renv',
  'packrat',
  'venv',
  '.venv',
  'node_modules',
  '__pycache__',
  'site-packages',
  '.tox',
  '.nox',
  'target',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
  '.cache',
  'bower_components',
  '.parcel-cache',
  '.turbo',
  '.bundle',
  '.gradle',
  '.pixi',
];
/** Soft UI cap; hub clamps to 256. Empty / 0 = unlimited. */
const HARD_MAX_DEPTH = 256;
/** Keep in sync with hub `search_proxy` caps. */
const MAX_IGNORE_NAMES = 128;
const MAX_IGNORE_NAME_LEN = 128;
/** Cap raw ignore field / localStorage size before parse. */
const MAX_IGNORE_RAW_LEN = 8192;
/** Exact-name ignore — reject path/glob/shell/control edge characters. */
const IGNORE_META_RE = /[/*?\[\]{}\\"'`<>|\0]/;
const IGNORE_CONTROL_RE = /\p{Cc}/u;

function ignoreStorageKey(agentId: string): string {
  return `filebox.search.ignore.${agentId}`;
}

function depthStorageKey(agentId: string): string {
  return `filebox.search.maxDepth.${agentId}`;
}

function loadStoredIgnore(agentId: string): string {
  try {
    const specific = localStorage.getItem(ignoreStorageKey(agentId));
    if (specific != null) return specific;
    // Migrate once from the pre-per-agent key.
    const legacy = localStorage.getItem('filebox.search.ignore');
    if (legacy != null) return legacy;
  } catch {
    /* private mode / blocked storage */
  }
  return DEFAULT_SEARCH_IGNORE.join(', ');
}

function loadStoredMaxDepth(agentId: string): string {
  try {
    const specific = localStorage.getItem(depthStorageKey(agentId));
    if (specific != null) return specific;
    const legacy = localStorage.getItem('filebox.search.maxDepth');
    if (legacy != null) return legacy;
  } catch {
    /* ignore */
  }
  return '';
}

function isValidIgnoreName(name: string): boolean {
  if (!name || name === '.' || name === '..') return false;
  if (name.length > MAX_IGNORE_NAME_LEN) return false;
  if (IGNORE_META_RE.test(name)) return false;
  if (IGNORE_CONTROL_RE.test(name)) return false;
  return true;
}

/** Parse ignore text into names; invalid tokens are dropped (not sent to hub). */
function parseIgnoreList(raw: string): {
  names: string[];
  dropped: number;
  truncated: boolean;
} {
  const truncated = raw.length > MAX_IGNORE_RAW_LEN;
  const text = truncated ? raw.slice(0, MAX_IGNORE_RAW_LEN) : raw;
  const out: string[] = [];
  let dropped = 0;
  for (const part of text.split(/[,\s]+/)) {
    const name = part.trim().replace(/^\/+|\/+$/g, '');
    if (!name) continue;
    if (!isValidIgnoreName(name)) {
      dropped += 1;
      continue;
    }
    if (out.some((x) => x.toLowerCase() === name.toLowerCase())) continue;
    if (out.length >= MAX_IGNORE_NAMES) {
      dropped += 1;
      continue;
    }
    out.push(name);
  }
  return { names: out, dropped, truncated };
}

function parseMaxDepth(raw: string): number | null {
  const t = raw.trim();
  if (!t) return null;
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(HARD_MAX_DEPTH, Math.floor(n));
}

function searchErrorMessage(err: unknown): string {
  const mapped = friendlyMessage(err);
  if (mapped !== 'An unexpected error occurred.') return mapped;
  const e = err as { message?: string; error?: string } | null;
  const raw = e?.message || e?.error;
  if (typeof raw === 'string' && raw.trim()) return raw.trim();
  return mapped;
}

/** Normalize folder input; `./` and `.` mean root. */
function normalizeFolderPath(path: string): string {
  let p = path.trim();
  if (!p || p === '.' || p === './') return '/';
  if (p.startsWith('./')) p = p.slice(1);
  if (!p.startsWith('/')) p = `/${p}`;
  if (p.length > 1 && p.endsWith('/')) p = p.replace(/\/+$/, '');
  return p || '/';
}

function clampContext(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_CONTEXT;
  return Math.max(0, Math.min(MAX_CONTEXT, Math.floor(n)));
}

function rememberIgnoredReqId(set: Set<string>, reqId: string) {
  set.add(reqId);
  // Bound memory if the user runs many searches in one session.
  if (set.size > 64) {
    const first = set.values().next().value;
    if (first !== undefined) set.delete(first);
  }
}

export function WorkspaceSearch({ agent, initialRoot, onOpenFile }: Props) {
  const enabledRoots = (agent.roots ?? []).filter((r) => r.enabled);
  const [mode, setMode] = useState<SearchMode>('content');
  const [root, setRoot] = useState(initialRoot || enabledRoots[0]?.name || '');
  const [folder, setFolder] = useState('/');
  const [query, setQuery] = useState('');
  const [extensions, setExtensions] = useState('');
  const [contextLines, setContextLines] = useState(DEFAULT_CONTEXT);
  const [ignoreText, setIgnoreText] = useState(() => loadStoredIgnore(agent.id));
  const [maxDepthText, setMaxDepthText] = useState(() => loadStoredMaxDepth(agent.id));
  const [result, setResult] = useState<WorkspaceSearchResult | null>(null);
  /** Client-side filter over the last result set (does not re-query the agent). */
  const [resultFilter, setResultFilter] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const listRef = useRef<VList>(null);
  const listBoxRef = useRef<HTMLDivElement>(null);
  const [listHeight, setListHeight] = useState(240);
  const [slow, setSlow] = useState(false);
  const [progressText, setProgressText] = useState<string | null>(null);
  const [scannedLive, setScannedLive] = useState<number | null>(null);
  /** Advanced filters stay collapsed by default — primary query row stays dominant. */
  const [optionsOpen, setOptionsOpen] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const reqIdRef = useRef<string | null>(null);
  /** Client-generated nonce for the active search; binds SSE before req_id exists. */
  const clientNonceRef = useRef<string | null>(null);
  /** req_ids from superseded searches — ignore their late progress. */
  const ignoredReqIdsRef = useRef<Set<string>>(new Set());
  const reqGen = useRef(0);
  /** Synced immediately in runSearch (not waiting for React render). */
  const searchingRef = useRef(false);
  /** Previous agent id for cancel-on-switch (updated only in the effect). */
  const agentIdRef = useRef(agent.id);

  useEffect(() => {
    const roots = (agent.roots ?? []).filter((r) => r.enabled);
    if (!roots.some((r) => r.name === root)) {
      setRoot(initialRoot && roots.some((r) => r.name === initialRoot)
        ? initialRoot
        : (roots[0]?.name ?? ''));
    }
  }, [agent.id, agent.roots, root, initialRoot]);

  useEffect(() => {
    if (initialRoot && enabledRoots.some((r) => r.name === initialRoot)) {
      setRoot(initialRoot);
    }
  }, [agent.id, initialRoot]);

  useEffect(() => {
    // Agent switch: cancel any in-flight search for the previous agent.
    const prevAgent = agentIdRef.current;
    const prevReq = reqIdRef.current;
    abortRef.current?.abort();
    abortRef.current = null;
    if (prevReq) rememberIgnoredReqId(ignoredReqIdsRef.current, prevReq);
    reqIdRef.current = null;
    clientNonceRef.current = null;
    searchingRef.current = false;
    reqGen.current += 1;
    setResult(null);
    setResultFilter('');
    setError(null);
    setLoading(false);
    setSlow(false);
    setProgressText(null);
    setScannedLive(null);
    setQuery('');
    setFolder('/');
    setIgnoreText(loadStoredIgnore(agent.id));
    setMaxDepthText(loadStoredMaxDepth(agent.id));
    if (prevReq && prevAgent && prevAgent !== agent.id) {
      void cancelRequest(prevAgent, prevReq).catch(() => {});
    }
    agentIdRef.current = agent.id;
  }, [agent.id]);

  const filteredHits = useMemo(() => {
    const hits = result?.hits ?? [];
    if (!resultFilter.trim()) return hits;
    return hits.filter((h) => hitMatchesFilter(h, resultFilter));
  }, [result, resultFilter]);

  const showHitList = Boolean(result && result.hits.length > 0 && !loading);

  const getHitSize = useCallback(
    (index: number) => estimateHitHeight(filteredHits[index]!),
    [filteredHits],
  );

  useEffect(() => {
    listRef.current?.resetAfterIndex(0, true);
  }, [filteredHits]);

  // Re-attach when the list box mounts (including after filter-to-zero → back).
  useEffect(() => {
    if (!showHitList) return;
    const el = listBoxRef.current;
    if (!el) return;
    let raf = 0;
    const obs = new ResizeObserver(([entry]) => {
      const h = entry.contentRect.height;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        setListHeight((prev) => (Math.abs(prev - h) < 1 ? prev : Math.max(120, h)));
      });
    });
    obs.observe(el);
    // Immediate measure in case ResizeObserver is slow on remount.
    const rect = el.getBoundingClientRect();
    if (rect.height > 0) {
      setListHeight((prev) => (Math.abs(prev - rect.height) < 1 ? prev : Math.max(120, rect.height)));
    }
    return () => {
      cancelAnimationFrame(raf);
      obs.disconnect();
    };
  }, [showHitList]);

  // True unmount (logout / deselect agent): stop the worker.
  useEffect(() => () => {
    const req = reqIdRef.current;
    const aid = agentIdRef.current;
    searchingRef.current = false;
    clientNonceRef.current = null;
    if (req) rememberIgnoredReqId(ignoredReqIdsRef.current, req);
    abortRef.current?.abort();
    if (req) void cancelRequest(aid, req).catch(() => {});
  }, []);

  // Stay subscribed while mounted (App keeps this view mounted across nav) so
  // progress/cancel keep working if the user browses Files mid-search.
  useSse(useCallback((evt) => {
    if (evt.event !== 'progress') return;
    const d = evt.data as {
      req_id?: string;
      phase?: string;
      processed?: number;
      message?: string | null;
      client_nonce?: string | null;
    };
    if (d.phase !== 'search' || !d.req_id) return;
    if (!searchingRef.current) return;
    if (ignoredReqIdsRef.current.has(d.req_id)) return;

    const owned = reqIdRef.current;
    if (owned) {
      // Already bound — ignore late progress from a superseded search.
      if (d.req_id !== owned) {
        rememberIgnoredReqId(ignoredReqIdsRef.current, d.req_id);
        return;
      }
    } else if (d.client_nonce) {
      // Hub "Search started" carries our nonce — bind only that req_id.
      if (d.client_nonce !== clientNonceRef.current) {
        rememberIgnoredReqId(ignoredReqIdsRef.current, d.req_id);
        return;
      }
      reqIdRef.current = d.req_id;
    } else {
      // Agent progress without nonce before bind — wait for hub start event.
      return;
    }

    if (typeof d.processed === 'number') setScannedLive(d.processed);
    if (d.message) setProgressText(d.message);
  }, []));

  async function runSearch() {
    if (!root) {
      setError('Select a root first');
      return;
    }
    if (mode === 'content' && !query.trim()) {
      setError('Enter a search pattern');
      return;
    }

    // Cancel previous search (if any) before starting another.
    const prevReq = reqIdRef.current;
    abortRef.current?.abort();
    if (prevReq) {
      rememberIgnoredReqId(ignoredReqIdsRef.current, prevReq);
      void cancelRequest(agent.id, prevReq).catch(() => {});
    }

    const ac = new AbortController();
    abortRef.current = ac;
    const gen = ++reqGen.current;
    const clientNonce =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `search_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    reqIdRef.current = null;
    clientNonceRef.current = clientNonce;
    searchingRef.current = true;

    setLoading(true);
    setSlow(false);
    setError(null);
    setResult(null);
    setResultFilter('');
    setProgressText('Starting search…');
    setScannedLive(0);
    setOptionsOpen(false);

    const slowTimer = window.setTimeout(() => {
      if (reqGen.current === gen) setSlow(true);
    }, 8000);

    const ctx = clampContext(contextLines);
    const { names: ignore } = parseIgnoreList(ignoreText);
    const maxDepth = parseMaxDepth(maxDepthText);
    try {
      const ignoreToStore =
        ignoreText.length > MAX_IGNORE_RAW_LEN
          ? ignoreText.slice(0, MAX_IGNORE_RAW_LEN)
          : ignoreText;
      localStorage.setItem(ignoreStorageKey(agent.id), ignoreToStore);
      localStorage.setItem(depthStorageKey(agent.id), maxDepthText);
    } catch {
      /* ignore */
    }

    try {
      const exts = extensions
        .split(/[,\s]+/)
        .map((e) => e.trim().replace(/^\./, '').toLowerCase())
        .filter(Boolean);
      const data = await workspaceSearch(
        agent.id,
        {
          mode,
          root,
          path: normalizeFolderPath(folder),
          query: query.trim(),
          extensions: exts,
          max_results: mode === 'find' ? 200 : 60,
          context: mode === 'content' ? ctx : 0,
          ignore,
          max_depth: maxDepth,
          client_nonce: clientNonce,
        },
        ac.signal,
      );
      if (gen !== reqGen.current) return;
      if (data.req_id) {
        if (!ignoredReqIdsRef.current.has(data.req_id)) {
          reqIdRef.current = data.req_id;
        }
      }
      if (data.error) {
        setResult(null);
        setError(searchErrorMessage({ error: data.error, message: data.error }));
      } else {
        setResult(data.result);
        setError(null);
      }
    } catch (e: unknown) {
      if (gen !== reqGen.current) return;
      if ((e as { name?: string })?.name === 'AbortError') {
        setError('Cancelled');
        return;
      }
      setResult(null);
      setError(searchErrorMessage(e));
    } finally {
      window.clearTimeout(slowTimer);
      if (gen === reqGen.current) {
        searchingRef.current = false;
        clientNonceRef.current = null;
        setLoading(false);
        setSlow(false);
        setProgressText(null);
      }
    }
  }

  async function handleCancel() {
    const reqId = reqIdRef.current;
    reqGen.current += 1;
    searchingRef.current = false;
    clientNonceRef.current = null;
    if (reqId) rememberIgnoredReqId(ignoredReqIdsRef.current, reqId);
    setLoading(false);
    setSlow(false);
    setProgressText(null);
    setError('Cancelled');
    // Prefer hub cancel (stops agent worker) then abort the HTTP wait.
    if (reqId) {
      try {
        await cancelRequest(agent.id, reqId);
      } catch {
        /* best-effort */
      }
    }
    abortRef.current?.abort();
  }

  const parsedExts = useMemo(
    () =>
      extensions
        .split(/[,\s]+/)
        .map((e) => e.trim().replace(/^\./, '').toLowerCase())
        .filter(Boolean),
    [extensions],
  );
  const parsedIgnore = useMemo(() => parseIgnoreList(ignoreText), [ignoreText]);
  const parsedDepth = useMemo(() => parseMaxDepth(maxDepthText), [maxDepthText]);
  const ctxLines = clampContext(contextLines);

  /** Non-default filters — shown as a quiet count on the Options toggle. */
  const activeOptionCount = useMemo(() => {
    let n = 0;
    if (parsedExts.length > 0) n += 1;
    if (mode === 'content' && ctxLines !== DEFAULT_CONTEXT) n += 1;
    if (parsedDepth != null) n += 1;
    const defaultIgnore = DEFAULT_SEARCH_IGNORE.join(', ');
    if (ignoreText.trim() !== defaultIgnore) n += 1;
    return n;
  }, [parsedExts.length, mode, ctxLines, parsedDepth, ignoreText]);

  const onQueryKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !loading) void runSearch();
  };

  const folderNorm = normalizeFolderPath(folder);
  const queryTrim = query.trim();
  const planReady =
    Boolean(root) && (mode === 'find' || queryTrim.length > 0);

  /** Live restatement of what Search will run — helps catch mistyped intent. */
  const planExpression = useMemo(() => {
    const scope = `${root || '?'}:${folderNorm}`;
    const typePart = parsedExts.length
      ? parsedExts.map((e) => `.${e}`).join(' ')
      : 'all types';
    const depthPart = parsedDepth != null ? `depth ≤ ${parsedDepth}` : 'unlimited depth';
    const ignorePart = parsedIgnore.names.length
      ? `ignore ${parsedIgnore.names.slice(0, 5).join(', ')}${parsedIgnore.names.length > 5 ? '…' : ''}`
      : 'no ignore';
    const modePart = mode === 'content'
      ? (queryTrim
        ? <>Content matching <code style={styles.planCode}>{queryTrim}</code></>
        : <>Content matching <span style={styles.planPlaceholder}>pattern…</span></>)
      : (queryTrim
        ? <>Files named like <code style={styles.planCode}>{queryTrim}</code></>
        : <>Files · <span style={styles.planPlaceholder}>any name</span></>);
    const constraintParts = [
      mode === 'content' ? `±${ctxLines} lines` : null,
      typePart,
      depthPart,
      ignorePart,
    ].filter(Boolean) as string[];
    return { modePart, scope, constraintParts, ready: planReady };
  }, [
    root, folderNorm, mode, queryTrim, parsedExts, parsedDepth,
    parsedIgnore.names, ctxLines, planReady,
  ]);

  return (
    <div style={styles.container}>
      <div style={styles.toolbar}>
        <div
          role="tablist"
          aria-label="Search mode"
          style={styles.modeSeg}
        >
          <ModeButton
            active={mode === 'content'}
            onClick={() => setMode('content')}
            label="Content"
            position="start"
          />
          <ModeButton
            active={mode === 'find'}
            onClick={() => setMode('find')}
            label="Files"
            position="end"
          />
        </div>

        <div style={styles.queryRow}>
          <label style={styles.fieldRoot}>
            <span style={styles.fieldCaption}>Root</span>
            <select
              value={root}
              onChange={(e) => setRoot(e.target.value)}
              style={styles.select}
              disabled={enabledRoots.length === 0 || loading}
              aria-label="Search root"
            >
              {enabledRoots.length === 0 && <option value="">No roots</option>}
              {enabledRoots.map((r) => (
                <option key={r.name} value={r.name}>{r.name}</option>
              ))}
            </select>
          </label>

          <label style={styles.fieldFolder}>
            <span style={styles.fieldCaption}>Folder</span>
            <input
              value={folder}
              onChange={(e) => setFolder(e.target.value)}
              onKeyDown={onQueryKeyDown}
              placeholder="/"
              style={styles.input}
              disabled={loading}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              aria-label="Folder under root"
              title="Folder under the selected root (/ = root)"
            />
          </label>

          <label style={styles.fieldQuery}>
            <span style={styles.fieldCaption}>
              {mode === 'find' ? 'Name' : 'Pattern'}
            </span>
            <div style={styles.queryGroup}>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onQueryKeyDown}
                placeholder={mode === 'find' ? 'Filename contains…' : 'Regex pattern…'}
                style={styles.inputQuery}
                disabled={loading}
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                aria-label={mode === 'find' ? 'Filename contains' : 'Content regex pattern'}
              />
              <button
                type="button"
                onClick={() => void (loading ? handleCancel() : runSearch())}
                disabled={!root && !loading}
                style={{
                  ...(loading ? styles.cancelBtn : styles.searchBtn),
                  opacity: !root && !loading ? 0.55 : 1,
                  cursor: !root && !loading ? 'default' : 'pointer',
                }}
              >
                {loading ? 'Cancel' : 'Search'}
              </button>
            </div>
          </label>
        </div>

        <div style={styles.optionsBar}>
          <button
            type="button"
            onClick={() => setOptionsOpen((v) => !v)}
            style={styles.optionsToggle}
            aria-expanded={optionsOpen}
            aria-controls="search-options-panel"
          >
            <IconChevronRight
              style={{
                width: 14,
                height: 14,
                flexShrink: 0,
                transition: 'transform 0.15s',
                transform: optionsOpen ? 'rotate(90deg)' : 'none',
                color: c.textMuted,
              }}
            />
            <span>Options</span>
            {activeOptionCount > 0 && (
              <span style={styles.optionsBadge}>{activeOptionCount}</span>
            )}
          </button>
        </div>

        {optionsOpen && (
          <div id="search-options-panel" style={styles.optionsPanel}>
            <div style={styles.optionsGrid}>
              <label style={styles.optFieldGrow}>
                <span style={styles.fieldCaption}>File types</span>
                <input
                  value={extensions}
                  onChange={(e) => setExtensions(e.target.value)}
                  onKeyDown={onQueryKeyDown}
                  placeholder="rs, ts, py"
                  style={styles.input}
                  disabled={loading}
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  title="Extensions only (comma/space). Not globs."
                />
              </label>

              {mode === 'content' && (
                <label style={styles.optFieldNarrow}>
                  <span style={styles.fieldCaption}>Context</span>
                  <input
                    type="number"
                    min={0}
                    max={MAX_CONTEXT}
                    value={contextLines}
                    onChange={(e) => setContextLines(clampContext(Number(e.target.value)))}
                    onKeyDown={onQueryKeyDown}
                    style={styles.input}
                    disabled={loading}
                    title={`Lines of context around each match (0–${MAX_CONTEXT})`}
                  />
                </label>
              )}

              <label style={styles.optFieldNarrow}>
                <span style={styles.fieldCaption}>Max depth</span>
                <input
                  type="number"
                  min={0}
                  max={HARD_MAX_DEPTH}
                  value={maxDepthText}
                  onChange={(e) => setMaxDepthText(e.target.value)}
                  onKeyDown={onQueryKeyDown}
                  placeholder="∞"
                  style={styles.input}
                  disabled={loading}
                  title="Directory layers under the folder (1 = this folder only). Empty = unlimited."
                />
              </label>
            </div>

            <label style={styles.ignoreLabel}>
              <span style={styles.fieldCaption}>Ignore folders</span>
              <input
                value={ignoreText}
                onChange={(e) => setIgnoreText(e.target.value)}
                onKeyDown={onQueryKeyDown}
                placeholder="renv, venv, node_modules"
                style={styles.input}
                disabled={loading}
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                title="Exact folder names only (no paths or globs). Saved per backend."
              />
            </label>

            {(parsedIgnore.dropped > 0 || parsedIgnore.truncated) && (
              <p style={styles.ignoreWarn} role="status">
                {parsedIgnore.truncated
                  ? `Ignore text truncated to ${MAX_IGNORE_RAW_LEN.toLocaleString()} characters. `
                  : null}
                {parsedIgnore.dropped > 0
                  ? `Skipped ${parsedIgnore.dropped} invalid ignore name${parsedIgnore.dropped === 1 ? '' : 's'}.`
                  : null}
              </p>
            )}
          </div>
        )}

        <div
          style={{
            ...styles.planPreview,
            ...(planExpression.ready ? null : styles.planPreviewIncomplete),
          }}
          aria-live="polite"
          title="Live preview of the search that will run"
        >
          <span style={styles.planLabel}>Plan</span>
          <div style={styles.planBody}>
            <div style={styles.planPrimary}>{planExpression.modePart}</div>
            <div style={styles.planSecondary}>
              <code style={styles.planCode}>{planExpression.scope}</code>
              {planExpression.constraintParts.map((part) => (
                <span key={part}>
                  <span style={styles.planSep}>·</span>
                  {part}
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>

      {loading && (
        <div style={styles.progressBox}>
          <div style={styles.progressRow}>
            <span style={styles.progressSpin} aria-hidden />
            <span style={styles.progressLabel}>
              {progressText || 'Searching…'}
              {scannedLive != null ? ` · ${scannedLive.toLocaleString()} files` : ''}
            </span>
            <button type="button" onClick={() => void handleCancel()} style={styles.cancelInline}>
              Cancel
            </button>
          </div>
          {slow && (
            <div style={styles.slowNote}>
              Still running — switch views anytime, or Cancel to stop.
            </div>
          )}
        </div>
      )}

      {error && <div style={styles.error}>{error}</div>}

      <div style={styles.resultsPanel}>
        {result && !loading && (
          <div style={styles.resultsToolbar}>
            <div style={styles.meta}>
              <span style={styles.metaStrong}>
                {filteredHits.length === result.hits.length
                  ? `${result.hits.length} hit${result.hits.length === 1 ? '' : 's'}`
                  : `${filteredHits.length} of ${result.hits.length}`}
              </span>
              {result.truncated ? <span style={styles.metaBadge}>truncated</span> : null}
              <span style={styles.metaMuted}>
                · scanned {result.scanned.toLocaleString()}
              </span>
            </div>
            <input
              value={resultFilter}
              onChange={(e) => setResultFilter(e.target.value)}
              placeholder="Filter results…"
              style={styles.filterInput}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              aria-label="Filter search results"
              title="Filters the current result set (does not re-run search)"
            />
          </div>
        )}

        {result && result.hits.length === 0 && !error && !loading && (
          <div style={styles.emptyWrap}>
            <p style={styles.emptyTitle}>No matches</p>
            <p style={styles.emptyHint}>
              {root || '?'}:{normalizeFolderPath(folder)}
            </p>
          </div>
        )}

        {!result && !loading && !error && (
          <div style={styles.emptyWrap}>
            <p style={styles.emptyTitle}>
              {mode === 'find' ? 'Find files' : 'Search content'}
            </p>
            <p style={styles.emptyHint}>
              {enabledRoots.length === 0
                ? 'Add an enabled root before searching.'
                : mode === 'find'
                  ? 'Enter a name fragment and press Search.'
                  : 'Enter a regex pattern and press Search.'}
            </p>
          </div>
        )}

        {showHitList && (
          <div ref={listBoxRef} style={styles.listBox}>
            {filteredHits.length === 0 ? (
              <div style={styles.emptyWrap}>
                <p style={styles.emptyTitle}>No hits match this filter</p>
                <p style={styles.emptyHint}>Clear the filter to see all results.</p>
              </div>
            ) : (
              <VList
                ref={listRef}
                height={listHeight}
                width="100%"
                itemCount={filteredHits.length}
                itemSize={getHitSize}
                itemKey={(index) => {
                  const h = filteredHits[index]!;
                  return `${h.root}:${h.path}:${h.line ?? 0}:${index}`;
                }}
                itemData={{ hits: filteredHits, onOpen: onOpenFile }}
              >
                {VirtualHitRow}
              </VList>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

type HitRowData = {
  hits: SearchHit[];
  onOpen?: (root: string, path: string) => void;
};

/** Module-level so VariableSizeList does not remount rows every parent render. */
function VirtualHitRow({ index, style, data }: ListChildComponentProps<HitRowData>) {
  const hit = data.hits[index]!;
  return (
    <div style={style}>
      <div style={{ ...styles.hit, marginBottom: HIT_GAP }}>
        <HitCardBody hit={hit} onOpen={data.onOpen} />
      </div>
    </div>
  );
}

function ModeButton({
  active,
  onClick,
  label,
  position,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  position: 'start' | 'end';
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        ...styles.modeBtn,
        ...(position === 'start' ? styles.modeBtnStart : styles.modeBtnEnd),
        ...(active
          ? styles.modeBtnActive
          : hovered
            ? styles.modeBtnHover
            : null),
      }}
    >
      {label}
    </button>
  );
}

function parentDir(path: string): string {
  const trimmed = path.endsWith('/') && path.length > 1 ? path.replace(/\/+$/, '') : path;
  const idx = trimmed.lastIndexOf('/');
  if (idx <= 0) return '/';
  return trimmed.slice(0, idx) || '/';
}

function HitCardBody({
  hit,
  onOpen,
}: {
  hit: SearchHit;
  onOpen?: (root: string, path: string) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const context = hit.context ?? [];
  return (
    <>
      <button
        type="button"
        style={{
          ...styles.hitPath,
          ...(hovered ? styles.hitPathHover : null),
        }}
        onClick={() => onOpen?.(hit.root, parentDir(hit.path))}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        title="Open folder in Files"
      >
        <span style={styles.hitRoot}>{hit.root}</span>
        <span style={styles.hitSep}>/</span>
        <span style={styles.hitPathText}>{hit.path.replace(/^\//, '')}</span>
        {hit.line != null && <span style={styles.hitLine}>:{hit.line}</span>}
      </button>
      {context.length > 0 && (
        <pre style={styles.context}>
          {context.map((line, idx) => (
            <div
              key={`${line.line}:${idx}`}
              style={{
                ...styles.contextLine,
                ...(line.is_match ? styles.contextMatch : null),
                height: HIT_LINE_H,
              }}
            >
              <span style={styles.lineNo}>{line.line}</span>
              <span style={styles.contextText}>{line.text}</span>
            </div>
          ))}
        </pre>
      )}
    </>
  );
}

const styles: Record<string, CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    minHeight: 0,
    overflow: 'hidden',
    boxSizing: 'border-box',
    fontFamily: font.sans,
    background: c.bg,
  },
  toolbar: {
    flexShrink: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
    padding: '10px 12px 12px',
    borderBottom: `1px solid ${c.border}`,
    background: c.bg,
  },
  modeSeg: {
    display: 'inline-flex',
    alignSelf: 'flex-start',
    borderRadius: radius.md,
    border: `1px solid ${c.border}`,
    overflow: 'hidden',
    background: c.bgSubtle,
  },
  modeBtn: {
    border: 'none',
    borderRadius: 0,
    padding: '5px 14px',
    fontSize: 12,
    fontWeight: 500,
    fontFamily: font.sans,
    background: 'transparent',
    color: c.textSecondary,
    cursor: 'pointer',
    transition: 'background 0.12s, color 0.12s',
    lineHeight: 1.2,
  },
  modeBtnStart: {
    borderRight: `1px solid ${c.border}`,
  },
  modeBtnEnd: {},
  modeBtnActive: {
    background: c.accentBg,
    color: c.accent,
  },
  modeBtnHover: {
    background: c.bgMuted,
    color: c.text,
  },
  queryRow: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 8,
    alignItems: 'end',
  },
  fieldCaption: {
    fontSize: 12,
    fontWeight: 500,
    color: c.textSecondary,
    lineHeight: 1,
    marginBottom: 5,
    display: 'block',
  },
  fieldRoot: {
    display: 'flex',
    flexDirection: 'column',
    flex: '0 1 130px',
    minWidth: 100,
  },
  fieldFolder: {
    display: 'flex',
    flexDirection: 'column',
    flex: '0 1 140px',
    minWidth: 110,
  },
  fieldQuery: {
    display: 'flex',
    flexDirection: 'column',
    flex: '1 1 280px',
    minWidth: 200,
  },
  queryGroup: {
    display: 'flex',
    alignItems: 'stretch',
    gap: 8,
    minWidth: 0,
  },
  input: {
    height: 32,
    border: `1px solid ${c.border}`,
    borderRadius: radius.md,
    padding: '0 10px',
    fontSize: 13,
    fontFamily: font.mono,
    color: c.text,
    background: c.surface,
    outline: 'none',
    minWidth: 0,
    width: '100%',
    boxSizing: 'border-box',
  },
  inputQuery: {
    height: 32,
    border: `1px solid ${c.border}`,
    borderRadius: radius.md,
    padding: '0 10px',
    fontSize: 13,
    fontFamily: font.mono,
    color: c.text,
    background: c.surface,
    outline: 'none',
    minWidth: 0,
    flex: 1,
    boxSizing: 'border-box',
  },
  select: {
    height: 32,
    border: `1px solid ${c.border}`,
    borderRadius: radius.md,
    padding: '0 8px',
    fontSize: 13,
    fontFamily: font.sans,
    color: c.text,
    background: c.surface,
    width: '100%',
    boxSizing: 'border-box',
  },
  searchBtn: {
    height: 32,
    padding: '0 16px',
    border: 'none',
    borderRadius: radius.md,
    background: c.accent,
    color: c.onAccent,
    fontSize: 13,
    fontWeight: 600,
    fontFamily: font.sans,
    flex: '0 0 auto',
  },
  cancelBtn: {
    height: 32,
    padding: '0 16px',
    border: `1px solid ${c.border}`,
    borderRadius: radius.md,
    background: c.dangerBg,
    color: c.danger,
    fontSize: 13,
    fontWeight: 600,
    fontFamily: font.sans,
    flex: '0 0 auto',
    cursor: 'pointer',
  },
  optionsBar: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    minWidth: 0,
    flexWrap: 'wrap',
  },
  optionsToggle: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    border: 'none',
    background: 'transparent',
    color: c.textSecondary,
    fontSize: 12,
    fontWeight: 500,
    fontFamily: font.sans,
    padding: '2px 0',
    cursor: 'pointer',
    flexShrink: 0,
  },
  optionsBadge: {
    fontSize: 10,
    fontWeight: 600,
    color: c.accent,
    background: c.accentBg,
    borderRadius: radius.pill,
    padding: '1px 6px',
    lineHeight: '14px',
    minWidth: 16,
    textAlign: 'center',
  },
  planPreview: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 10,
    padding: '8px 10px',
    borderRadius: radius.md,
    background: c.bgSubtle,
    border: `1px solid ${c.border}`,
    minWidth: 0,
  },
  planPreviewIncomplete: {
    borderStyle: 'dashed',
    background: c.bg,
  },
  planLabel: {
    flexShrink: 0,
    fontSize: 11,
    fontWeight: 600,
    color: c.textMuted,
    letterSpacing: '0.04em',
    textTransform: 'uppercase' as const,
    lineHeight: '18px',
    paddingTop: 1,
  },
  planBody: {
    flex: 1,
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 3,
  },
  planPrimary: {
    fontSize: 13,
    fontWeight: 500,
    color: c.text,
    lineHeight: 1.35,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  },
  planSecondary: {
    fontSize: 12,
    color: c.textMuted,
    lineHeight: 1.4,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  },
  planCode: {
    fontFamily: font.mono,
    fontSize: 12,
    background: c.bgMuted,
    padding: '1px 5px',
    borderRadius: 4,
    color: c.textSecondary,
  },
  planPlaceholder: {
    color: c.textMuted,
    fontWeight: 400,
    fontStyle: 'italic' as const,
  },
  planSep: {
    margin: '0 6px',
    color: c.textFaint,
  },
  optionsPanel: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    padding: '10px 10px 8px',
    borderRadius: radius.md,
    background: c.bgSubtle,
    border: `1px solid ${c.border}`,
  },
  optionsGrid: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 8,
    alignItems: 'end',
  },
  optFieldGrow: {
    display: 'flex',
    flexDirection: 'column',
    flex: '1 1 180px',
    minWidth: 140,
  },
  optFieldNarrow: {
    display: 'flex',
    flexDirection: 'column',
    flex: '0 0 96px',
    minWidth: 88,
  },
  ignoreLabel: {
    display: 'flex',
    flexDirection: 'column',
    width: '100%',
  },
  ignoreWarn: {
    margin: 0,
    fontSize: 11,
    color: c.warning,
    lineHeight: 1.4,
  },
  progressBox: {
    padding: '10px 12px',
    borderBottom: `1px solid ${c.border}`,
    background: c.accentBg,
    flexShrink: 0,
  },
  progressRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
  },
  progressSpin: {
    width: 14,
    height: 14,
    borderRadius: '50%',
    border: `2px solid ${c.accent}`,
    borderTopColor: 'transparent',
    animation: 'spin 0.8s linear infinite',
    flexShrink: 0,
  },
  progressLabel: {
    flex: 1,
    fontSize: 13,
    color: c.text,
    minWidth: 0,
  },
  cancelInline: {
    border: `1px solid ${c.border}`,
    background: c.surface,
    color: c.danger,
    borderRadius: radius.md,
    padding: '4px 10px',
    fontSize: 12,
    fontFamily: font.sans,
    fontWeight: 500,
    cursor: 'pointer',
    flexShrink: 0,
  },
  slowNote: {
    marginTop: 6,
    fontSize: 12,
    color: c.textSecondary,
    lineHeight: 1.4,
  },
  error: {
    padding: '8px 12px',
    background: c.dangerBg,
    color: c.danger,
    fontSize: 13,
    borderBottom: `1px solid ${c.border}`,
    flexShrink: 0,
  },
  resultsPanel: {
    flex: 1,
    minHeight: 0,
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
  },
  resultsToolbar: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 10,
    flexShrink: 0,
    padding: '8px 12px',
    borderBottom: `1px solid ${c.borderSubtle}`,
    background: c.bg,
  },
  meta: {
    fontSize: 12,
    color: c.textMuted,
    flex: '1 1 auto',
    minWidth: 140,
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    flexWrap: 'wrap',
  },
  metaStrong: {
    color: c.textSecondary,
    fontWeight: 600,
  },
  metaMuted: {
    color: c.textMuted,
  },
  metaBadge: {
    fontSize: 10,
    fontWeight: 600,
    color: c.warning,
    background: c.warningBg,
    borderRadius: radius.pill,
    padding: '1px 6px',
    lineHeight: '14px',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.03em',
  },
  filterInput: {
    height: 28,
    border: `1px solid ${c.border}`,
    borderRadius: radius.md,
    padding: '0 10px',
    fontSize: 12,
    fontFamily: font.sans,
    color: c.text,
    background: c.surface,
    outline: 'none',
    flex: '0 1 200px',
    minWidth: 140,
    boxSizing: 'border-box',
  },
  emptyWrap: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
    textAlign: 'center',
  },
  emptyTitle: {
    margin: 0,
    fontSize: 14,
    fontWeight: 600,
    color: c.text,
  },
  emptyHint: {
    margin: '6px 0 0',
    fontSize: 13,
    color: c.textMuted,
    lineHeight: 1.4,
    maxWidth: 360,
  },
  listBox: {
    flex: 1,
    minHeight: 0,
    overflow: 'hidden',
    padding: '8px 12px 12px',
    boxSizing: 'border-box',
  },
  hit: {
    border: `1px solid ${c.border}`,
    borderRadius: radius.md,
    background: c.surface,
    overflow: 'hidden',
    boxSizing: 'border-box',
  },
  hitPath: {
    display: 'flex',
    alignItems: 'center',
    width: '100%',
    height: HIT_PATH_H,
    boxSizing: 'border-box',
    textAlign: 'left',
    border: 'none',
    borderBottom: `1px solid ${c.borderSubtle}`,
    background: c.bg,
    padding: '0 12px',
    fontSize: 12,
    fontFamily: font.mono,
    color: c.text,
    cursor: 'pointer',
    gap: 0,
    minWidth: 0,
    transition: 'background 0.1s',
  },
  hitPathHover: {
    background: c.bgMuted,
  },
  hitPathText: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    minWidth: 0,
  },
  hitRoot: {
    color: c.accent,
    fontWeight: 600,
    flexShrink: 0,
  },
  hitSep: {
    color: c.textFaint,
    margin: '0 4px',
    flexShrink: 0,
  },
  hitLine: {
    color: c.textMuted,
    flexShrink: 0,
    marginLeft: 2,
  },
  context: {
    margin: 0,
    padding: `${HIT_CTX_PAD_Y / 2}px 0`,
    fontSize: 12,
    fontFamily: font.mono,
    color: c.textSecondary,
    overflow: 'hidden',
    background: c.bgSubtle,
  },
  contextLine: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '0 12px',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    boxSizing: 'border-box',
    borderLeft: '2px solid transparent',
  },
  contextMatch: {
    background: c.accentBg,
    color: c.text,
    borderLeftColor: c.accent,
  },
  contextText: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    minWidth: 0,
  },
  lineNo: {
    width: 36,
    flexShrink: 0,
    textAlign: 'right',
    color: c.textFaint,
    userSelect: 'none',
    fontVariantNumeric: 'tabular-nums',
  },
};
