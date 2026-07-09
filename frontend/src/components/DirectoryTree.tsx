import { useState, useEffect, useCallback, useRef, memo } from 'react';
import * as api from '../api/client';
import { c, radius, font, shadow } from '../theme';

interface Props {
  agentId: string;
  rootName: string;
  rootPath: string;
  currentPath: string;
  onNavigate: (path: string) => void;
  /** When true (mobile), the panel renders as an absolute overlay drawer
   *  instead of an inline flex child. The parent supplies a backdrop. */
  overlay?: boolean;
  /** Desktop (inline) panel width in px. Ignored in overlay mode, which keeps
   *  its own responsive drawer width. The parent owns this value (persisted +
   *  driven by the resize splitter). */
  width?: number;
  /** Bumped by the toolbar Refresh button to ask the tree to reload its
   *  expanded nodes. This is the retry path for a node whose load errored and
   *  got stuck (loaded:true + error) — without it there'd be no way back short
   *  of switching roots. */
  refreshNonce?: number;
}

interface NodeState {
  items: api.FsEntry[];
  nextCursor: string | null;
  loading: boolean;
  loaded: boolean;
  error: string | null;
}

const DEFAULT_STATE: NodeState = {
  items: [],
  nextCursor: null,
  loading: false,
  loaded: false,
  error: null,
};

const PAGE_LIMIT = 200;

export function DirectoryTree({ agentId, rootName, rootPath, currentPath, onNavigate, overlay = false, width, refreshNonce = 0 }: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['/']));
  const [nodes, setNodes] = useState<Map<string, NodeState>>(new Map());

  // nodesRef mirrors `nodes` so async loaders can read the latest state without
  // being re-created on every state change (which would re-trigger effects).
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  // expandedRef lets the refresh effect read the current expanded set without
  // depending on `expanded` (which would make it fire on every toggle).
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  // mountedRef lets in-flight requests no-op after unmount.
  const mountedRef = useRef(true);
  // inflightRef tracks which paths currently have a load in progress, so two
  // concurrent loads for the SAME path (e.g. mount effect + expanded effect
  // both firing in the same commit) don't duplicate the request. This is a
  // synchronous ref, unlike the `nodes.loading` flag which only propagates
  // after a re-render — that gap is exactly where duplicate calls slipped in.
  const inflightRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const loadChildren = useCallback(async (path: string, append = false) => {
    // For non-append loads, skip if a load for this path is already in flight.
    // Append (load-more) is gated by the disabled button, so it can't double up.
    if (!append && inflightRef.current.has(path)) return;
    inflightRef.current.add(path);

    const cur = nodesRef.current.get(path);
    const cursor = append && cur?.nextCursor ? cur.nextCursor : undefined;

    setNodes((prev) => {
      const next = new Map(prev);
      next.set(path, { ...(prev.get(path) ?? DEFAULT_STATE), loading: true, error: null });
      return next;
    });

    try {
      const data = await api.fsList(agentId, rootName, path, PAGE_LIMIT, cursor, true);
      if (!mountedRef.current) return;

      if (data.error) {
        setNodes((prev) => {
          const next = new Map(prev);
          next.set(path, {
            ...(prev.get(path) ?? DEFAULT_STATE),
            loading: false, loaded: true, error: data.error ?? null,
          });
          return next;
        });
        return;
      }

      const dirs = data.items.filter((e) => e.entry_type === 'directory' && !e.denied);
      setNodes((prev) => {
        const next = new Map(prev);
        const existing = prev.get(path) ?? DEFAULT_STATE;
        next.set(path, {
          items: append ? [...existing.items, ...dirs] : dirs,
          nextCursor: data.next_cursor ?? null,
          loading: false,
          loaded: true,
          error: null,
        });
        return next;
      });
    } catch (e: unknown) {
      if (!mountedRef.current) return;
      const message = e instanceof Error ? e.message : 'Failed to load';
      setNodes((prev) => {
        const next = new Map(prev);
        next.set(path, {
          ...(prev.get(path) ?? DEFAULT_STATE),
          loading: false, loaded: true, error: message,
        });
        return next;
      });
    } finally {
      inflightRef.current.delete(path);
    }
  }, [agentId, rootName]);

  // Load root on mount. The component is remounted via `key` when the agent or
  // root changes, so this covers both initial load and root switches.
  useEffect(() => {
    loadChildren('/');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Expand every ancestor of the current path so the user's location is visible.
  useEffect(() => {
    setExpanded((prev) => {
      const next = new Set(prev);
      const parts = currentPath.split('/').filter(Boolean);
      let acc = '';
      for (const part of parts) {
        acc = acc ? `${acc}/${part}` : `/${part}`;
        next.add(acc);
      }
      // We only ever add, so equal size means identical contents.
      return prev.size === next.size ? prev : next;
    });
  }, [currentPath]);

  // Lazy-load children of any expanded node that hasn't been loaded yet.
  useEffect(() => {
    expanded.forEach((path) => {
      const state = nodesRef.current.get(path) ?? DEFAULT_STATE;
      if (!state.loaded && !state.loading) {
        loadChildren(path);
      }
    });
  }, [expanded, loadChildren]);

  // Refresh: reload every expanded node. Triggered by the toolbar Refresh
  // button (refreshNonce). Retries nodes stuck in the error state (loaded:true
  // + error — the lazy effect above won't touch them) and lets live nodes pick
  // up new subdirectories. Only depends on refreshNonce + loadChildren so it
  // fires solely on an explicit refresh, not on every expand toggle.
  const prevRefreshRef = useRef(refreshNonce);
  useEffect(() => {
    if (refreshNonce === prevRefreshRef.current) return;
    prevRefreshRef.current = refreshNonce;
    expandedRef.current.forEach((path) => {
      loadChildren(path);
    });
  }, [refreshNonce, loadChildren]);

  const toggleExpand = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  const isExpanded = (path: string) => expanded.has(path);

  const childPath = (parent: string, name: string) => parent === '/' ? `/${name}` : `${parent}/${name}`;

  const renderNode = (path: string, name: string, depth: number, isRoot = false) => {
    const expandedHere = isExpanded(path);
    const state = nodes.get(path) ?? DEFAULT_STATE;

    return (
      <div key={path}>
        {/* Row is a memoized component with its OWN hover state, so moving the
            pointer over a row only re-renders that row — not the entire tree.
            Its callbacks (onNavigate/onToggleExpand) are referentially stable
            from the parent, which is what lets memo actually skip work. */}
        <Row
          path={path}
          name={name}
          depth={depth}
          isRoot={isRoot}
          title={isRoot ? `${rootName} — ${rootPath}` : name}
          active={path === currentPath}
          loading={state.loading}
          expandedHere={expandedHere}
          onNavigate={onNavigate}
          onToggleExpand={toggleExpand}
        />
        {expandedHere && (
          <div>
            {state.error && (
              <div style={{ ...styles.error, paddingLeft: 4 + (depth + 1) * 14 }}>
                {state.error}
                <span style={styles.errorHint}> — 点工具栏刷新重试</span>
              </div>
            )}
            {state.items.map((item) => renderNode(childPath(path, item.name), item.name, depth + 1))}
            {state.nextCursor && !state.loading && (
              <button
                type="button"
                onClick={() => loadChildren(path, true)}
                style={{
                  ...styles.loadMore,
                  paddingLeft: 4 + (depth + 1) * 14,
                }}
              >
                Load more…
              </button>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div style={{ ...styles.panel, ...(overlay ? styles.panelOverlay : (width != null ? { width } : {})) }}>
      <div style={styles.scroll}>
        {renderNode('/', rootName, 0, true)}
      </div>
    </div>
  );
}

// ── Memoized row ────────────────────────────────────────────────────────────
// Extracted to module scope (must NOT be defined inside DirectoryTree, or it'd
// be a fresh component type each render → React remounts every row → loses
// local state + memo is meaningless). Hover lives in local state here, so
// hovering a row re-renders ONLY this row, not its siblings or the whole tree.

interface RowProps {
  path: string;
  name: string;
  depth: number;
  isRoot: boolean;
  title: string;
  active: boolean;
  loading: boolean;
  expandedHere: boolean;
  onNavigate: (path: string) => void;
  onToggleExpand: (path: string) => void;
}

const Row = memo(function Row({ path, name, depth, isRoot, title, active, loading, expandedHere, onNavigate, onToggleExpand }: RowProps) {
  const [hovered, setHovered] = useState(false);
  return (
    <div
      style={{
        ...styles.row,
        paddingLeft: 4 + depth * 14,
        ...(active ? styles.rowActive : hovered ? styles.rowHover : {}),
      }}
      onClick={() => onNavigate(path)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onToggleExpand(path);
        }}
        style={styles.chevronBtn}
        aria-label={expandedHere ? 'Collapse' : 'Expand'}
        title={expandedHere ? 'Collapse' : 'Expand'}
      >
        {loading ? (
          <span style={styles.spinner} />
        ) : (
          <ChevronIcon direction={expandedHere ? 'down' : 'right'} />
        )}
      </button>
      <span style={styles.icon}>
        <FolderIcon />
      </span>
      <span
        style={{
          ...styles.label,
          ...(isRoot ? styles.rootLabel : {}),
        }}
        title={title}
      >
        {name}
      </span>
    </div>
  );
});

function ChevronIcon({ direction }: { direction: 'right' | 'down' }) {
  return (
    <svg
      style={{
        display: 'block',
        width: 12,
        height: 12,
        transition: 'transform 0.12s',
        transform: direction === 'down' ? 'rotate(90deg)' : 'none',
      }}
      viewBox="0 0 16 16"
      fill="none"
    >
      <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg style={{ display: 'block', width: 15, height: 15 }} viewBox="0 0 16 16" fill="none">
      <path d="M2 4.5C2 3.67 2.67 3 3.5 3H6.29a1 1 0 0 1 .7.29L8 4.5h4.5c.83 0 1.5.67 1.5 1.5v5.5c0 .83-.67 1.5-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5v-7Z" fill="#94a3b8" />
      <path d="M2 6h12v5.5c0 .83-.67 1.5-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5V6Z" fill="#cbd5e1" />
    </svg>
  );
}

const styles: Record<string, React.CSSProperties> = {
  panel: {
    display: 'flex',
    flexDirection: 'column',
    width: 240,
    flexShrink: 0,
    background: c.surface,
    borderRight: `1px solid ${c.border}`,
    overflow: 'hidden',
  },
  // Mobile drawer mode: absolute-positioned over the file list, full height,
  // ~85% width (capped 320px) so a sliver of the list stays visible as a
  // close affordance hint. Shadow replaces the border (no neighbor to divide).
  panelOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    bottom: 0,
    width: '85%',
    maxWidth: 320,
    zIndex: 60,
    flexShrink: 1,
    borderRight: 'none',
    boxShadow: shadow.lg,
  },
  scroll: {
    flex: 1,
    overflowY: 'auto',
    overflowX: 'hidden',
    padding: '4px 0',
  },
  // The whole row is clickable (navigates into the folder). The chevron button
  // inside stops propagation so it toggles expand/collapse instead. Generous
  // min-height + padding makes the hit target comfortable; the hover background
  // confirms what's clickable (the original version had no hover affordance,
  // which made it feel unresponsive).
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: 2,
    padding: '0 6px',
    minHeight: 30,
    cursor: 'pointer',
    transition: 'background 0.08s',
    borderRadius: radius.sm,
    margin: '1px 4px',
  },
  rowHover: {
    background: c.bgMuted,
  },
  rowActive: {
    background: c.accentBg,
  },
  chevronBtn: {
    width: 22,
    height: 22,
    padding: 0,
    border: 'none',
    background: 'transparent',
    color: c.textMuted,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    borderRadius: radius.sm,
  },
  icon: {
    flexShrink: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: {
    flex: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: 12,
    fontFamily: font.sans,
    color: c.text,
    userSelect: 'none',
  },
  rootLabel: {
    fontWeight: 600,
    color: c.accent,
  },
  error: {
    fontSize: 11,
    color: c.danger,
    padding: '2px 8px 2px 0',
    margin: '0 4px',
  },
  errorHint: {
    color: c.textMuted,
  },
  loadMore: {
    display: 'block',
    width: 'calc(100% - 8px)',
    margin: '2px 4px',
    padding: '4px 8px',
    border: 'none',
    background: 'transparent',
    color: c.accent,
    fontSize: 11,
    cursor: 'pointer',
    textAlign: 'left',
    borderRadius: radius.sm,
    fontFamily: font.sans,
  },
  spinner: {
    width: 10,
    height: 10,
    border: `2px solid ${c.border}`,
    borderTopColor: c.accent,
    borderRadius: '50%',
    animation: 'spin 0.6s linear infinite',
  },
};
