import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { VariableSizeList as VList, type ListChildComponentProps } from 'react-window';
import type { AgentInfo, SearchHit, SearchMode, WorkspaceSearchResult } from '../api/client';
import { cancelRequest, friendlyMessage, workspaceSearch } from '../api/client';
import { useSse } from '../state/events';
import { c, radius, font } from '../theme';

/** Path header + border; context lines are fixed-pitch for VariableSizeList. */
const HIT_PATH_H = 34;
const HIT_LINE_H = 17;
const HIT_CTX_PAD_Y = 16;
const HIT_GAP = 8;
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
const IGNORE_STORAGE_KEY = 'filebox.search.ignore';
const DEPTH_STORAGE_KEY = 'filebox.search.maxDepth';
/** Soft UI cap; hub clamps to 256. Empty / 0 = unlimited. */
const HARD_MAX_DEPTH = 256;

function loadStoredIgnore(): string {
  try {
    const raw = localStorage.getItem(IGNORE_STORAGE_KEY);
    if (raw != null) return raw;
  } catch {
    /* private mode / blocked storage */
  }
  return DEFAULT_SEARCH_IGNORE.join(', ');
}

function loadStoredMaxDepth(): string {
  try {
    const raw = localStorage.getItem(DEPTH_STORAGE_KEY);
    if (raw != null) return raw;
  } catch {
    /* ignore */
  }
  return '';
}

function parseIgnoreList(raw: string): string[] {
  const out: string[] = [];
  for (const part of raw.split(/[,\s]+/)) {
    const name = part.trim().replace(/^\/+|\/+$/g, '');
    if (!name || name === '.' || name === '..') continue;
    if (name.includes('/') || name.includes('\\')) continue;
    if (!out.some((x) => x.toLowerCase() === name.toLowerCase())) out.push(name);
  }
  return out;
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
  const [ignoreText, setIgnoreText] = useState(loadStoredIgnore);
  const [maxDepthText, setMaxDepthText] = useState(loadStoredMaxDepth);
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

  const getHitSize = useCallback(
    (index: number) => estimateHitHeight(filteredHits[index]!),
    [filteredHits],
  );

  useEffect(() => {
    listRef.current?.resetAfterIndex(0, true);
  }, [filteredHits]);

  useEffect(() => {
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
    return () => {
      cancelAnimationFrame(raf);
      obs.disconnect();
    };
  }, [result]);

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

    const slowTimer = window.setTimeout(() => {
      if (reqGen.current === gen) setSlow(true);
    }, 8000);

    const ctx = clampContext(contextLines);
    const ignore = parseIgnoreList(ignoreText);
    const maxDepth = parseMaxDepth(maxDepthText);
    try {
      localStorage.setItem(IGNORE_STORAGE_KEY, ignoreText);
      localStorage.setItem(DEPTH_STORAGE_KEY, maxDepthText);
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

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <h2 style={styles.title}>Search</h2>
        <p style={styles.subtitle}>
          Search file contents or find files by name under a root. Runs on the agent —
          no extra tools required on the remote machine.
        </p>
      </div>

      <div style={styles.modeRow}>
        <ModeButton
          active={mode === 'content'}
          onClick={() => setMode('content')}
          label="Content"
        />
        <ModeButton
          active={mode === 'find'}
          onClick={() => setMode('find')}
          label="Files"
        />
      </div>

      <div style={styles.controls}>
        <div style={styles.form}>
          <label style={styles.label}>
            Root
            <select
              value={root}
              onChange={(e) => setRoot(e.target.value)}
              style={styles.select}
              disabled={enabledRoots.length === 0 || loading}
            >
              {enabledRoots.length === 0 && <option value="">No roots</option>}
              {enabledRoots.map((r) => (
                <option key={r.name} value={r.name}>{r.name}</option>
              ))}
            </select>
          </label>

          <label style={{ ...styles.label, flex: '1.2 1 140px' }}>
            Folder
            <input
              value={folder}
              onChange={(e) => setFolder(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !loading) void runSearch(); }}
              placeholder="/ or ./src"
              style={styles.input}
              disabled={loading}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
            />
          </label>

          <label style={{ ...styles.label, flex: '2 1 200px' }}>
            {mode === 'find' ? 'Name contains' : 'Pattern (regex)'}
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !loading) void runSearch(); }}
              placeholder={mode === 'find' ? 'e.g. config' : 'e.g. TODO|FIXME'}
              style={styles.input}
              disabled={loading}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
            />
          </label>

          <label style={{ ...styles.label, flex: '1.4 1 160px' }}>
            File types
            <input
              value={extensions}
              onChange={(e) => setExtensions(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !loading) void runSearch(); }}
              placeholder="e.g. rs, ts, py"
              style={styles.input}
              disabled={loading}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              aria-describedby="search-field-hints"
            />
          </label>

          {mode === 'content' && (
            <label style={{ ...styles.label, flex: '0 0 88px', minWidth: 88 }}>
              Context
              <input
                type="number"
                min={0}
                max={MAX_CONTEXT}
                value={contextLines}
                onChange={(e) => setContextLines(clampContext(Number(e.target.value)))}
                onKeyDown={(e) => { if (e.key === 'Enter' && !loading) void runSearch(); }}
                style={styles.input}
                disabled={loading}
                title={`Lines of context around each match (0–${MAX_CONTEXT})`}
              />
            </label>
          )}

          <label style={{ ...styles.label, flex: '0 0 96px', minWidth: 96 }}>
            Max depth
            <input
              type="number"
              min={0}
              max={HARD_MAX_DEPTH}
              value={maxDepthText}
              onChange={(e) => setMaxDepthText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !loading) void runSearch(); }}
              placeholder="∞"
              style={styles.input}
              disabled={loading}
              title="Max directory layers under the folder (1 = this folder only). Leave empty for unlimited."
              aria-describedby="search-field-hints"
            />
          </label>

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

        <label style={styles.ignoreLabel}>
          Ignore folders
          <input
            value={ignoreText}
            onChange={(e) => setIgnoreText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !loading) void runSearch(); }}
            placeholder="e.g. renv, venv, node_modules"
            style={styles.input}
            disabled={loading}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            aria-describedby="search-field-hints"
          />
        </label>

        <div id="search-field-hints" style={styles.fieldHints}>
          <p style={styles.fieldHint}>
            File types: extensions only — <code style={styles.code}>rs, ts, py</code>
            {' '}(comma/space; case-insensitive). Not globs or full names.
          </p>
          <p style={styles.fieldHint}>
            Ignore: folder names pruned while walking (subtrees are never scanned).
            Defaults cover common package/venv trees. Clear to search everything.
            Saved in this browser.
          </p>
          <p style={styles.fieldHint}>
            Max depth: <code style={styles.code}>1</code> = this folder only,{' '}
            <code style={styles.code}>2</code> = one level of subfolders, empty = unlimited.
          </p>
        </div>

        <div style={styles.scopeHint}>
          Scope: <code style={styles.code}>{root || '?'}:{normalizeFolderPath(folder)}</code>
          {mode === 'content'
            ? ` · content · ±${clampContext(contextLines)} lines`
            : ' · by filename'}
          {(() => {
            const exts = extensions
              .split(/[,\s]+/)
              .map((e) => e.trim().replace(/^\./, '').toLowerCase())
              .filter(Boolean);
            return exts.length
              ? <> · types <code style={styles.code}>{exts.map((e) => `.${e}`).join(' ')}</code></>
              : ' · all types';
          })()}
          {(() => {
            const names = parseIgnoreList(ignoreText);
            return names.length
              ? <> · ignore <code style={styles.code}>{names.slice(0, 6).join(', ')}{names.length > 6 ? '…' : ''}</code></>
              : ' · no ignore';
          })()}
          {(() => {
            const d = parseMaxDepth(maxDepthText);
            return d != null
              ? <> · depth ≤ <code style={styles.code}>{d}</code></>
              : ' · unlimited depth';
          })()}
        </div>
      </div>

      {loading && (
        <div style={styles.progressBox}>
          <div style={styles.progressRow}>
            <span style={styles.progressSpin} aria-hidden />
            <span style={styles.progressLabel}>
              {progressText || 'Searching…'}
              {scannedLive != null ? ` (${scannedLive.toLocaleString()} files)` : ''}
            </span>
            <button type="button" onClick={() => void handleCancel()} style={styles.cancelInline}>
              Cancel
            </button>
          </div>
          {slow && (
            <div style={styles.slowNote}>
              Still running — you can switch to Files or other views; this search keeps going until it finishes or you Cancel.
            </div>
          )}
        </div>
      )}

      {error && <div style={styles.error}>{error}</div>}

      <div style={styles.resultsPanel}>
        {result && !loading && (
          <div style={styles.resultsToolbar}>
            <div style={styles.meta}>
              {filteredHits.length === result.hits.length
                ? `${result.hits.length} hit${result.hits.length === 1 ? '' : 's'}`
                : `${filteredHits.length} of ${result.hits.length} hits`}
              {result.truncated ? ' (truncated)' : ''}
              {' · '}
              scanned {result.scanned}
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
              title="Static filter over path and context lines (does not re-run search)"
            />
          </div>
        )}

        {result && result.hits.length === 0 && !error && !loading && (
          <p style={styles.empty}>No matches in this folder.</p>
        )}

        {result && result.hits.length > 0 && filteredHits.length === 0 && !loading && (
          <p style={styles.empty}>No hits match this filter.</p>
        )}

        {!result && !loading && !error && (
          <p style={styles.empty}>
            Enter a pattern and click Search. Ignored folders are skipped during the walk,
            so package trees do not inflate scanned counts.
          </p>
        )}

        {result && filteredHits.length > 0 && !loading && (
          <div ref={listBoxRef} style={styles.listBox}>
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
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        ...styles.modeBtn,
        background: active ? c.accentBg : c.bgSubtle,
        color: active ? c.accent : c.textSecondary,
        borderColor: active ? c.accent : c.border,
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
  const context = hit.context ?? [];
  return (
    <>
      <button
        type="button"
        style={styles.hitPath}
        onClick={() => onOpen?.(hit.root, parentDir(hit.path))}
        title="Open folder in Files"
      >
        <span style={styles.hitRoot}>{hit.root}</span>
        <span style={styles.hitPathText}>{hit.path}</span>
        {hit.line != null && <span style={styles.hitLine}>:{hit.line}</span>}
      </button>
      {context.length > 0 && (
        <pre style={styles.context}>
          {context.map((line, idx) => (
            <div
              key={`${line.line}:${idx}`}
              style={{
                ...styles.contextLine,
                background: line.is_match ? c.accentBg : 'transparent',
                color: line.is_match ? c.text : c.textSecondary,
                height: HIT_LINE_H,
              }}
            >
              <span style={styles.lineNo}>{line.line}</span>
              <span style={styles.hitPathText}>{line.text}</span>
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
    padding: '16px 24px 20px',
    boxSizing: 'border-box',
    fontFamily: font.sans,
  },
  header: { marginBottom: 10, flexShrink: 0 },
  title: {
    margin: 0,
    fontSize: 18,
    fontWeight: 600,
    color: c.text,
  },
  subtitle: {
    margin: '4px 0 0',
    fontSize: 13,
    color: c.textMuted,
    maxWidth: 560,
    lineHeight: 1.4,
  },
  code: {
    fontFamily: font.mono,
    fontSize: 12,
    background: c.bgMuted,
    padding: '1px 5px',
    borderRadius: 4,
  },
  modeRow: { display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap', flexShrink: 0 },
  modeBtn: {
    border: `1px solid ${c.border}`,
    borderRadius: radius.sm,
    padding: '6px 12px',
    fontSize: 13,
    fontFamily: font.sans,
    background: c.bgSubtle,
  },
  // Form + hints + scope stay content-sized at the top (never flex-grow).
  controls: {
    flexShrink: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    marginBottom: 12,
  },
  form: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 10,
    alignItems: 'end',
  },
  label: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    fontSize: 12,
    color: c.textSecondary,
    minWidth: 120,
    flex: '1 1 120px',
  },
  // Own row under the toolbar — width 100%, height content-only (no flex grow).
  ignoreLabel: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    fontSize: 12,
    color: c.textSecondary,
    width: '100%',
    maxWidth: 720,
  },
  input: {
    height: 34,
    border: `1px solid ${c.border}`,
    borderRadius: radius.sm,
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
  select: {
    height: 34,
    border: `1px solid ${c.border}`,
    borderRadius: radius.sm,
    padding: '0 8px',
    fontSize: 13,
    fontFamily: font.sans,
    color: c.text,
    background: c.surface,
  },
  searchBtn: {
    height: 34,
    padding: '0 16px',
    border: 'none',
    borderRadius: radius.sm,
    background: c.accent,
    color: c.onAccent,
    fontSize: 13,
    fontWeight: 500,
    fontFamily: font.sans,
    flex: '0 0 auto',
  },
  cancelBtn: {
    height: 34,
    padding: '0 16px',
    border: `1px solid ${c.border}`,
    borderRadius: radius.sm,
    background: c.dangerBg,
    color: c.danger,
    fontSize: 13,
    fontWeight: 500,
    fontFamily: font.sans,
    flex: '0 0 auto',
    cursor: 'pointer',
  },
  fieldHints: {
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    maxWidth: 720,
  },
  fieldHint: {
    margin: 0,
    fontSize: 12,
    color: c.textMuted,
    lineHeight: 1.4,
  },
  scopeHint: {
    fontSize: 12,
    color: c.textMuted,
    lineHeight: 1.4,
  },
  progressBox: {
    padding: '10px 12px',
    borderRadius: radius.sm,
    background: c.accentBg,
    marginBottom: 12,
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
    borderRadius: radius.sm,
    padding: '4px 10px',
    fontSize: 12,
    fontFamily: font.sans,
    cursor: 'pointer',
    flexShrink: 0,
  },
  slowNote: {
    marginTop: 8,
    fontSize: 12,
    color: c.textSecondary,
    lineHeight: 1.4,
  },
  error: {
    padding: '8px 12px',
    borderRadius: radius.sm,
    background: c.dangerBg,
    color: c.danger,
    fontSize: 13,
    marginBottom: 12,
    flexShrink: 0,
  },
  // Results: toolbar stays put; listBox fills remaining height for virtualization.
  resultsPanel: {
    flex: 1,
    minHeight: 0,
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  resultsToolbar: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 10,
    flexShrink: 0,
  },
  meta: {
    fontSize: 12,
    color: c.textMuted,
    flex: '1 1 auto',
    minWidth: 140,
  },
  filterInput: {
    height: 30,
    border: `1px solid ${c.border}`,
    borderRadius: radius.sm,
    padding: '0 10px',
    fontSize: 12,
    fontFamily: font.mono,
    color: c.text,
    background: c.surface,
    outline: 'none',
    flex: '0 1 220px',
    minWidth: 140,
    boxSizing: 'border-box',
  },
  empty: {
    margin: 0,
    fontSize: 13,
    color: c.textMuted,
    lineHeight: 1.45,
    maxWidth: 520,
  },
  listBox: {
    flex: 1,
    minHeight: 0,
    overflow: 'hidden',
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
    background: c.bgSubtle,
    padding: '0 12px',
    fontSize: 13,
    fontFamily: font.mono,
    color: c.text,
    cursor: 'pointer',
    gap: 0,
    minWidth: 0,
  },
  hitPathText: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    minWidth: 0,
  },
  hitRoot: {
    color: c.accent,
    marginRight: 6,
    fontWeight: 600,
    flexShrink: 0,
  },
  hitLine: {
    color: c.textMuted,
    flexShrink: 0,
  },
  context: {
    margin: 0,
    padding: `${HIT_CTX_PAD_Y / 2}px 0`,
    fontSize: 12,
    fontFamily: font.mono,
    color: c.textSecondary,
    overflow: 'hidden',
  },
  contextLine: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '0 12px',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    boxSizing: 'border-box',
  },
  lineNo: {
    width: 40,
    flexShrink: 0,
    textAlign: 'right',
    color: c.textFaint,
    userSelect: 'none',
  },
};
