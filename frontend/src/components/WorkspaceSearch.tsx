import { useEffect, useState, type CSSProperties } from 'react';
import type { AgentInfo, SearchHit, SearchMode, WorkspaceSearchResult } from '../api/client';
import { friendlyMessage, workspaceSearch } from '../api/client';
import { c, radius, font } from '../theme';

interface Props {
  agent: AgentInfo;
  onOpenFile?: (root: string, path: string) => void;
}

export function WorkspaceSearch({ agent, onOpenFile }: Props) {
  const enabledRoots = (agent.roots ?? []).filter((r) => r.enabled);
  const [mode, setMode] = useState<SearchMode>('content');
  const [root, setRoot] = useState(enabledRoots[0]?.name ?? '');
  const [query, setQuery] = useState('');
  const [extensions, setExtensions] = useState('');
  const [result, setResult] = useState<WorkspaceSearchResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const roots = (agent.roots ?? []).filter((r) => r.enabled);
    if (!roots.some((r) => r.name === root)) {
      setRoot(roots[0]?.name ?? '');
    }
  }, [agent.id, agent.roots, root]);

  async function runSearch() {
    if (!root) {
      setError('Select a root first');
      return;
    }
    if (mode === 'content' && !query.trim()) {
      setError('Enter a search pattern');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const exts = extensions
        .split(/[,\s]+/)
        .map((e) => e.trim().replace(/^\./, ''))
        .filter(Boolean);
      const data = await workspaceSearch(agent.id, {
        mode,
        root,
        path: '/',
        query: query.trim(),
        extensions: exts,
        max_results: mode === 'find' ? 200 : 80,
        context: 10,
      });
      if (data.error) {
        setResult(null);
        setError(friendlyMessage({ error: data.error, message: data.error }));
      } else {
        setResult(data.result);
      }
    } catch (e: unknown) {
      setResult(null);
      setError(friendlyMessage(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <h2 style={styles.title}>Search</h2>
        <p style={styles.subtitle}>
          Find files by name (fd) or search file contents (rg). Runs on the agent — no system fd/rg required.
        </p>
      </div>

      <div style={styles.modeRow}>
        <ModeButton active={mode === 'content'} onClick={() => setMode('content')} label="Content (rg)" />
        <ModeButton active={mode === 'find'} onClick={() => setMode('find')} label="Files (fd)" />
      </div>

      <div style={styles.form}>
        <label style={styles.label}>
          Root
          <select
            value={root}
            onChange={(e) => setRoot(e.target.value)}
            style={styles.select}
            disabled={enabledRoots.length === 0}
          >
            {enabledRoots.length === 0 && <option value="">No roots</option>}
            {enabledRoots.map((r) => (
              <option key={r.name} value={r.name}>{r.name}</option>
            ))}
          </select>
        </label>

        <label style={styles.label}>
          {mode === 'find' ? 'Name contains' : 'Pattern (regex)'}
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void runSearch(); }}
            placeholder={mode === 'find' ? 'e.g. config' : 'e.g. TODO|FIXME'}
            style={styles.input}
          />
        </label>

        <label style={styles.label}>
          Extensions
          <input
            value={extensions}
            onChange={(e) => setExtensions(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void runSearch(); }}
            placeholder="rs, ts, py (optional)"
            style={styles.input}
          />
        </label>

        <button
          type="button"
          onClick={() => void runSearch()}
          disabled={loading || !root}
          style={{
            ...styles.searchBtn,
            opacity: loading || !root ? 0.55 : 1,
            cursor: loading || !root ? 'default' : 'pointer',
          }}
        >
          {loading ? 'Searching…' : 'Search'}
        </button>
      </div>

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
        <p style={styles.empty}>No matches.</p>
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
      {hit.context.length > 0 && (
        <pre style={styles.context}>
          {hit.context.map((line) => (
            <div
              key={line.line}
              style={{
                ...styles.contextLine,
                background: line.is_match ? c.accentBg : 'transparent',
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
    maxWidth: 520,
    lineHeight: 1.45,
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
    marginBottom: 14,
  },
  label: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    fontSize: 12,
    color: c.textSecondary,
    minWidth: 140,
    flex: '1 1 140px',
  },
  input: {
    height: 34,
    border: `1px solid ${c.border}`,
    borderRadius: radius.sm,
    padding: '0 10px',
    fontSize: 13,
    fontFamily: font.sans,
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
