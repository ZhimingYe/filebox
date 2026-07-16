import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { AgentInfo, SearchHit, SearchMode, WorkspaceSearchResult } from '../api/client';
import { cancelRequest, friendlyMessage, workspaceSearch } from '../api/client';
import { c, radius, font } from '../theme';

interface Props {
  agent: AgentInfo;
  /** Prefer the currently selected Files root when present. */
  initialRoot?: string | null;
  onOpenFile?: (root: string, path: string) => void;
}

const DEFAULT_CONTEXT = 10;
const MAX_CONTEXT = 20;

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

export function WorkspaceSearch({ agent, initialRoot, onOpenFile }: Props) {
  const enabledRoots = (agent.roots ?? []).filter((r) => r.enabled);
  const [mode, setMode] = useState<SearchMode>('content');
  const [root, setRoot] = useState(initialRoot || enabledRoots[0]?.name || '');
  const [folder, setFolder] = useState('/');
  const [query, setQuery] = useState('');
  const [extensions, setExtensions] = useState('');
  const [contextLines, setContextLines] = useState(DEFAULT_CONTEXT);
  const [result, setResult] = useState<WorkspaceSearchResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [slow, setSlow] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const reqIdRef = useRef<string | null>(null);
  const reqGen = useRef(0);

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
    abortRef.current?.abort();
    abortRef.current = null;
    reqIdRef.current = null;
    reqGen.current += 1;
    setResult(null);
    setError(null);
    setLoading(false);
    setSlow(false);
    setQuery('');
    setFolder('/');
  }, [agent.id]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  async function runSearch() {
    if (!root) {
      setError('Select a root first');
      return;
    }
    if (mode === 'content' && !query.trim()) {
      setError('Enter a search pattern');
      return;
    }

    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    const gen = ++reqGen.current;
    reqIdRef.current = null;

    setLoading(true);
    setSlow(false);
    setError(null);

    const slowTimer = window.setTimeout(() => {
      if (reqGen.current === gen) setSlow(true);
    }, 8000);

    const ctx = clampContext(contextLines);

    try {
      // Extensions are matched case-insensitively on the agent; normalize here too.
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
        },
        ac.signal,
      );
      if (gen !== reqGen.current) return;
      if (data.req_id) reqIdRef.current = data.req_id;
      if (data.error) {
        setResult(null);
        setError(searchErrorMessage({ error: data.error, message: data.error }));
      } else {
        setResult(data.result);
      }
    } catch (e: unknown) {
      if (gen !== reqGen.current) return;
      if ((e as { name?: string })?.name === 'AbortError') return;
      setResult(null);
      setError(searchErrorMessage(e));
    } finally {
      window.clearTimeout(slowTimer);
      if (gen === reqGen.current) {
        setLoading(false);
        setSlow(false);
      }
    }
  }

  async function handleCancel() {
    const reqId = reqIdRef.current;
    abortRef.current?.abort();
    reqGen.current += 1;
    setLoading(false);
    setSlow(false);
    setError('Cancelled');
    if (reqId) {
      try {
        await cancelRequest(agent.id, reqId);
      } catch {
        /* best-effort */
      }
    }
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
            aria-describedby="search-ext-hint"
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

        {loading ? (
          <button type="button" onClick={() => void handleCancel()} style={styles.cancelBtn}>
            Cancel
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void runSearch()}
            disabled={!root}
            style={{
              ...styles.searchBtn,
              opacity: !root ? 0.55 : 1,
              cursor: !root ? 'default' : 'pointer',
            }}
          >
            Search
          </button>
        )}
      </div>

      <p id="search-ext-hint" style={styles.fieldHint}>
        File types: leave empty for all files. Use extensions only —{' '}
        <code style={styles.code}>rs, ts, py</code> or{' '}
        <code style={styles.code}>.rs .ts</code>
        . Comma or space separated; case does not matter (
        <code style={styles.code}>RS</code> = <code style={styles.code}>rs</code>
        ). Not full filenames or globs.
      </p>

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
      </div>

      {slow && loading && (
        <div style={styles.slow}>Still searching — large folders can take a while. You can Cancel.</div>
      )}

      {error && <div style={styles.error}>{error}</div>}

      {result && (
        <div style={styles.meta}>
          {result.hits.length} hit{result.hits.length === 1 ? '' : 's'}
          {result.truncated ? ' (truncated)' : ''}
          {' · '}
          scanned {result.scanned}
        </div>
      )}

      {result && result.hits.length === 0 && !error && (
        <p style={styles.empty}>No matches in this folder.</p>
      )}

      <div style={styles.results}>
        {result?.hits.map((hit, i) => (
          <HitCard
            key={`${hit.root}:${hit.path}:${hit.line ?? 0}:${i}`}
            hit={hit}
            onOpen={onOpenFile}
          />
        ))}
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

function HitCard({
  hit,
  onOpen,
}: {
  hit: SearchHit;
  onOpen?: (root: string, path: string) => void;
}) {
  const context = hit.context ?? [];
  return (
    <div style={styles.hit}>
      <button
        type="button"
        style={styles.hitPath}
        onClick={() => onOpen?.(hit.root, parentDir(hit.path))}
        title="Open folder in Files"
      >
        <span style={styles.hitRoot}>{hit.root}</span>
        <span>{hit.path}</span>
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
              }}
            >
              <span style={styles.lineNo}>{line.line}</span>
              <span>{line.text}</span>
            </div>
          ))}
        </pre>
      )}
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    overflow: 'auto',
    padding: '20px 24px 32px',
    boxSizing: 'border-box',
    fontFamily: font.sans,
  },
  header: { marginBottom: 16 },
  title: {
    margin: 0,
    fontSize: 18,
    fontWeight: 600,
    color: c.text,
  },
  subtitle: {
    margin: '6px 0 0',
    fontSize: 13,
    color: c.textMuted,
    maxWidth: 560,
    lineHeight: 1.45,
  },
  code: {
    fontFamily: font.mono,
    fontSize: 12,
    background: c.bgMuted,
    padding: '1px 5px',
    borderRadius: 4,
  },
  modeRow: { display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' },
  modeBtn: {
    border: `1px solid ${c.border}`,
    borderRadius: radius.sm,
    padding: '6px 12px',
    fontSize: 13,
    fontFamily: font.sans,
    background: c.bgSubtle,
  },
  form: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 10,
    alignItems: 'end',
    marginBottom: 8,
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
  fieldHint: {
    margin: '0 0 10px',
    fontSize: 12,
    color: c.textMuted,
    lineHeight: 1.45,
    maxWidth: 720,
  },
  scopeHint: {
    fontSize: 12,
    color: c.textMuted,
    marginBottom: 12,
  },
  slow: {
    padding: '8px 12px',
    borderRadius: radius.sm,
    background: c.warningBg,
    color: c.textSecondary,
    fontSize: 13,
    marginBottom: 12,
  },
  error: {
    padding: '8px 12px',
    borderRadius: radius.sm,
    background: c.dangerBg,
    color: c.danger,
    fontSize: 13,
    marginBottom: 12,
  },
  meta: {
    fontSize: 12,
    color: c.textMuted,
    marginBottom: 10,
  },
  empty: {
    fontSize: 13,
    color: c.textMuted,
  },
  results: {
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
  },
  hit: {
    border: `1px solid ${c.border}`,
    borderRadius: radius.md,
    background: c.surface,
    overflow: 'hidden',
  },
  hitPath: {
    display: 'block',
    width: '100%',
    textAlign: 'left',
    border: 'none',
    background: c.bgSubtle,
    padding: '8px 12px',
    fontSize: 13,
    fontFamily: font.mono,
    color: c.text,
    cursor: 'pointer',
  },
  hitRoot: {
    color: c.accent,
    marginRight: 6,
    fontWeight: 600,
  },
  hitLine: {
    color: c.textMuted,
  },
  context: {
    margin: 0,
    padding: '8px 0',
    fontSize: 12,
    fontFamily: font.mono,
    color: c.textSecondary,
    overflowX: 'auto',
  },
  contextLine: {
    display: 'flex',
    gap: 12,
    padding: '1px 12px',
    whiteSpace: 'pre',
  },
  lineNo: {
    width: 40,
    flexShrink: 0,
    textAlign: 'right',
    color: c.textFaint,
    userSelect: 'none',
  },
};
