import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { AgentInfo, SearchHit, SearchMode, WorkspaceSearchResult } from '../api/client';
import { cancelRequest, friendlyMessage, workspaceSearch } from '../api/client';
import { c, radius, font } from '../theme';

interface Props {
  agent: AgentInfo;
  /** Prefer the Files browser folder so rg/fd scopes to "here". */
  initialRoot?: string | null;
  initialPath?: string;
  onOpenFile?: (root: string, path: string) => void;
}

function searchErrorMessage(err: unknown): string {
  const mapped = friendlyMessage(err);
  if (mapped !== 'An unexpected error occurred.') return mapped;
  const e = err as { message?: string; error?: string } | null;
  const raw = e?.message || e?.error;
  if (typeof raw === 'string' && raw.trim()) return raw.trim();
  return mapped;
}

function normalizeFolderPath(path: string): string {
  let p = path.trim() || '/';
  if (!p.startsWith('/')) p = `/${p}`;
  if (p.length > 1 && p.endsWith('/')) p = p.replace(/\/+$/, '');
  return p || '/';
}

export function WorkspaceSearch({ agent, initialRoot, initialPath, onOpenFile }: Props) {
  const enabledRoots = (agent.roots ?? []).filter((r) => r.enabled);
  const [mode, setMode] = useState<SearchMode>('content');
  const [root, setRoot] = useState(initialRoot || enabledRoots[0]?.name || '');
  const [folder, setFolder] = useState(normalizeFolderPath(initialPath || '/'));
  const [query, setQuery] = useState('');
  const [extensions, setExtensions] = useState('');
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

  // When entering from Files, adopt that folder as the rg/fd scope.
  useEffect(() => {
    if (initialRoot && enabledRoots.some((r) => r.name === initialRoot)) {
      setRoot(initialRoot);
    }
    if (initialPath) {
      setFolder(normalizeFolderPath(initialPath));
    }
  }, [agent.id, initialRoot, initialPath]);

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
      setError('Enter a pattern to grep for');
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

    try {
      const exts = extensions
        .split(/[,\s]+/)
        .map((e) => e.trim().replace(/^\./, ''))
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
          context: 10,
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
    // Aborting the HTTP wait drops the hub handler, which CancelOnDrop's the
    // agent worker. Also best-effort /api/cancel if we already know req_id.
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
        /* best-effort — abort path is enough */
      }
    }
  }

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <h2 style={styles.title}>rg / fd</h2>
        <p style={styles.subtitle}>
          Grep file contents (<code style={styles.code}>rg</code>) or find filenames (
          <code style={styles.code}>fd</code>) inside a folder under a root. Runs on the agent —
          no system binaries needed.
        </p>
      </div>

      <div style={styles.modeRow}>
        <ModeButton active={mode === 'content'} onClick={() => setMode('content')} label="rg" hint="grep in folder" />
        <ModeButton active={mode === 'find'} onClick={() => setMode('find')} label="fd" hint="find by name" />
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

        <label style={{ ...styles.label, flex: '1.4 1 180px' }}>
          Folder
          <input
            value={folder}
            onChange={(e) => setFolder(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !loading) void runSearch(); }}
            placeholder="/ or /src"
            style={styles.input}
            disabled={loading}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
        </label>

        <label style={{ ...styles.label, flex: '2 1 220px' }}>
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

        <label style={styles.label}>
          Extensions
          <input
            value={extensions}
            onChange={(e) => setExtensions(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !loading) void runSearch(); }}
            placeholder="rs, ts, py"
            style={styles.input}
            disabled={loading}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
        </label>

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
            Run
          </button>
        )}
      </div>

      <div style={styles.scopeHint}>
        Scope: <code style={styles.code}>{root || '?'}:{normalizeFolderPath(folder)}</code>
        {mode === 'content' ? ' · content grep' : ' · filename find'}
      </div>

      {slow && loading && (
        <div style={styles.slow}>Still running — large folders can take a while. You can Cancel.</div>
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
  hint,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  hint: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={hint}
      style={{
        ...styles.modeBtn,
        background: active ? c.accentBg : c.bgSubtle,
        color: active ? c.accent : c.textSecondary,
        borderColor: active ? c.accent : c.border,
      }}
    >
      <span style={styles.modeLabel}>{label}</span>
      {' '}
      <span style={styles.modeHint}>{hint}</span>
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
    fontFamily: font.mono,
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
    fontFamily: font.sans,
    background: c.bgSubtle,
    display: 'flex',
    alignItems: 'baseline',
    gap: 8,
  },
  modeLabel: {
    fontFamily: font.mono,
    fontSize: 13,
    fontWeight: 600,
  },
  modeHint: {
    fontSize: 12,
    opacity: 0.75,
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
