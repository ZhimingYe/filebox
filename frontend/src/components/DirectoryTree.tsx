import { useState, useEffect, useCallback, useRef, useLayoutEffect, memo } from 'react';
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
  /** Close the mobile drawer (header Done / ×). Desktop ignores this. */
  onClose?: () => void;
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
/** Indent per depth level (px). Kept modest so deep trees still fit. */
const DEPTH_STEP = 12;
const ROW_PAD_X = 8;

export function DirectoryTree({
  agentId,
  rootName,
  rootPath,
  currentPath,
  onNavigate,
  overlay = false,
  onClose,
  width,
  refreshNonce = 0,
}: Props) {
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
  // concurrent loads for the SAME path don't duplicate the request.
  const inflightRef = useRef<Set<string>>(new Set());
  const scrollRef = useRef<HTMLDivElement>(null);
  const activeRowRef = useRef<HTMLDivElement | null>(null);

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
  // button (refreshNonce). Retries nodes stuck in the error state.
  const prevRefreshRef = useRef(refreshNonce);
  useEffect(() => {
    if (refreshNonce === prevRefreshRef.current) return;
    prevRefreshRef.current = refreshNonce;
    expandedRef.current.forEach((path) => {
      loadChildren(path);
    });
  }, [refreshNonce, loadChildren]);

  // Keep the active row visible inside the tree scroller (both axes) without
  // scrolling the outer app layout. Only react to path changes; async child
  // loads update `nodes` and must not snap-scroll away from where the user is
  // currently looking.
  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    const el = activeRowRef.current;
    if (!scroll || !el) return;
    const sRect = scroll.getBoundingClientRect();
    const eRect = el.getBoundingClientRect();
    const pad = 6;
    // If already fully visible, leave scroll alone so async loads don't yank the view.
    if (
      eRect.top >= sRect.top + pad
      && eRect.bottom <= sRect.bottom - pad
      && eRect.left >= sRect.left + pad
      && eRect.right <= sRect.right - pad
    ) {
      return;
    }
    // Vertical
    if (eRect.top < sRect.top + pad) {
      scroll.scrollTop -= sRect.top + pad - eRect.top;
    } else if (eRect.bottom > sRect.bottom - pad) {
      scroll.scrollTop += eRect.bottom - (sRect.bottom - pad);
    }
    // Horizontal — long folder names / deep nesting
    if (eRect.left < sRect.left + pad) {
      scroll.scrollLeft -= sRect.left + pad - eRect.left;
    } else if (eRect.right > sRect.right - pad) {
      scroll.scrollLeft += eRect.right - (sRect.right - pad);
    }
  }, [currentPath, overlay]);

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

  const childPath = (parent: string, name: string) =>
    parent === '/' ? `/${name}` : `${parent}/${name}`;

  const renderNode = (path: string, name: string, depth: number, isRoot = false) => {
    const expandedHere = isExpanded(path);
    const state = nodes.get(path) ?? DEFAULT_STATE;
    const active = path === currentPath;

    return (
      <div key={path}>
        {/* Row is a memoized component with its OWN hover state, so moving the
            pointer over a row only re-renders that row — not the entire tree. */}
        <Row
          path={path}
          name={name}
          depth={depth}
          isRoot={isRoot}
          title={isRoot ? `${rootName} — ${rootPath}` : path}
          active={active}
          loading={state.loading}
          expandedHere={expandedHere}
          touch={overlay}
          onNavigate={onNavigate}
          onToggleExpand={toggleExpand}
          rowRef={active ? activeRowRef : undefined}
        />
        {expandedHere && (
          <div>
            {state.error && (
              <div
                style={{
                  ...styles.error,
                  paddingLeft: ROW_PAD_X + 22 + (depth + 1) * DEPTH_STEP,
                }}
              >
                {state.error}
                <span style={styles.errorHint}> — refresh to retry</span>
              </div>
            )}
            {state.items.map((item) =>
              renderNode(childPath(path, item.name), item.name, depth + 1),
            )}
            {state.nextCursor && !state.loading && (
              <button
                type="button"
                onClick={() => loadChildren(path, true)}
                style={{
                  ...styles.loadMore,
                  paddingLeft: ROW_PAD_X + 22 + (depth + 1) * DEPTH_STEP,
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

  // Mobile drawer needs concrete chrome (title + close). Desktop stays
  // title-free so the tree doesn't stack redundant "Folders / root / path".
  const locationLabel =
    currentPath === '/' || !currentPath
      ? 'Root of this workspace'
      : currentPath;

  return (
    <div
      style={{
        ...styles.panel,
        ...(overlay ? styles.panelOverlay : width != null ? { width } : {}),
      }}
      role="navigation"
      aria-label="Directory tree"
    >
      {overlay && (
        <div style={styles.drawerHeader}>
          <div style={styles.drawerHeaderMain}>
            <span style={styles.drawerTitle} title={rootPath}>
              {rootName}
            </span>
            <span style={styles.drawerLocation} title={locationLabel}>
              {locationLabel}
            </span>
          </div>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              style={styles.drawerClose}
              aria-label="Close folder tree"
            >
              Done
            </button>
          )}
        </div>
      )}
      {/*
        Both-axis scroll: inner content uses width:max-content so deep nesting
        and long folder names widen the scroll surface instead of truncating.
      */}
      <div ref={scrollRef} style={styles.scroll}>
        <div style={{ ...styles.treeInner, ...(overlay ? styles.treeInnerTouch : null) }}>
          {renderNode('/', rootName, 0, true)}
        </div>
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
  /** Larger hit targets + type for mobile drawer. */
  touch?: boolean;
  onNavigate: (path: string) => void;
  onToggleExpand: (path: string) => void;
  /** Attached only on the active row so the parent can scroll it into view. */
  rowRef?: React.Ref<HTMLDivElement>;
}

const Row = memo(function Row({
  path,
  name,
  depth,
  isRoot,
  title,
  active,
  loading,
  expandedHere,
  touch = false,
  onNavigate,
  onToggleExpand,
  rowRef,
}: RowProps) {
  const [hovered, setHovered] = useState(false);
  return (
    <div
      ref={rowRef}
      role="treeitem"
      aria-expanded={expandedHere}
      aria-selected={active}
      style={{
        ...styles.row,
        ...(touch ? styles.rowTouch : null),
        paddingLeft: ROW_PAD_X + depth * (touch ? 14 : DEPTH_STEP),
        ...(active ? styles.rowActive : hovered ? styles.rowHover : {}),
      }}
      onClick={() => onNavigate(path)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {active && <span style={styles.activeBar} aria-hidden />}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onToggleExpand(path);
        }}
        style={{
          ...styles.chevronBtn,
          ...(touch ? styles.chevronBtnTouch : null),
          ...(hovered || active ? styles.chevronBtnLit : null),
        }}
        aria-label={expandedHere ? 'Collapse' : 'Expand'}
        title={expandedHere ? 'Collapse' : 'Expand'}
      >
        {loading ? (
          <span style={styles.spinner} />
        ) : (
          <ChevronIcon open={expandedHere} />
        )}
      </button>
      <span style={{ ...styles.icon, ...(touch ? styles.iconTouch : null) }} aria-hidden>
        <FolderIcon open={expandedHere} active={active} />
      </span>
      <span
        style={{
          ...styles.label,
          ...(touch ? styles.labelTouch : null),
          ...(isRoot ? styles.rootLabel : null),
          ...(active && !isRoot ? styles.labelActive : null),
        }}
        title={title}
      >
        {name}
      </span>
    </div>
  );
});

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      style={{
        display: 'block',
        width: 12,
        height: 12,
        transition: 'transform 0.12s ease',
        transform: open ? 'rotate(90deg)' : 'none',
      }}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden
    >
      <path
        d="M6 4l4 4-4 4"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function FolderIcon({ open, active }: { open: boolean; active: boolean }) {
  const stroke = active ? c.accent : c.textMuted;
  const fill = active ? c.accentBg : open ? c.bgMuted : c.bgSubtle;
  return (
    <svg
      style={{ display: 'block', width: 15, height: 15 }}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden
    >
      <path
        d="M2 4.5C2 3.67 2.67 3 3.5 3H6.2c.3 0 .58.12.79.33L8 4.3h4.5c.83 0 1.5.67 1.5 1.5v5.7c0 .83-.67 1.5-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5v-7Z"
        fill={fill}
        stroke={stroke}
        strokeWidth="1.1"
      />
    </svg>
  );
}

const styles: Record<string, React.CSSProperties> = {
  panel: {
    display: 'flex',
    flexDirection: 'column',
    width: 240,
    flexShrink: 0,
    background: c.bg,
    borderRight: `1px solid ${c.border}`,
    overflow: 'hidden',
    minWidth: 0,
    minHeight: 0,
  },
  // Mobile drawer: fixed side sheet, deliberately modest so it does not
  // swallow the viewport. ~70% width (capped 260) leaves a clear strip of the
  // file list as a close affordance; full height keeps deep trees scrollable.
  // position:fixed (not absolute inside contentWrap) so it escapes the file
  // panel stacking context and sits below the date-filter modal (320/330).
  // Parent mutual-excludes tree vs date filter so they never stack.
  panelOverlay: {
    position: 'fixed',
    top: 0,
    left: 0,
    bottom: 0,
    width: 'min(70vw, 260px)',
    maxWidth: 260,
    zIndex: 310,
    flexShrink: 1,
    borderRight: 'none',
    boxShadow: shadow.lg,
    background: c.bg,
  },

  // Compact chrome — root name + path only, no "Folder tree" billboard.
  drawerHeader: {
    flexShrink: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    padding: '8px 8px 8px 12px',
    borderBottom: `1px solid ${c.border}`,
    background: c.bg,
  },
  drawerHeaderMain: {
    minWidth: 0,
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    gap: 1,
  },
  drawerTitle: {
    fontSize: 13,
    fontWeight: 600,
    color: c.text,
    letterSpacing: '-0.01em',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  drawerLocation: {
    fontSize: 11,
    fontFamily: font.mono,
    color: c.textMuted,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  drawerClose: {
    flexShrink: 0,
    padding: '5px 10px',
    borderRadius: radius.md,
    border: 'none',
    background: c.accent,
    color: c.onAccent,
    fontSize: 12,
    fontWeight: 500,
    fontFamily: font.sans,
    cursor: 'pointer',
  },

  // Both axes scroll. Inner tree uses max-content width so the scroll surface
  // grows with deep nesting / long names instead of clipping labels.
  scroll: {
    flex: 1,
    minHeight: 0,
    minWidth: 0,
    overflowX: 'auto',
    overflowY: 'auto',
    background: c.bg,
  },
  treeInner: {
    display: 'inline-block',
    minWidth: '100%',
    width: 'max-content',
    padding: '6px 0 8px',
    boxSizing: 'border-box',
    verticalAlign: 'top',
  },
  treeInnerTouch: {
    padding: '2px 0 12px',
  },

  // Whole row navigates; chevron stops propagation to expand/collapse.
  // Labels stay nowrap (no ellipsis) so horizontal scroll can reveal them.
  row: {
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    gap: 3,
    paddingTop: 0,
    paddingBottom: 0,
    paddingRight: 10,
    minHeight: 26,
    cursor: 'pointer',
    transition: 'background 0.08s',
    boxSizing: 'border-box',
    width: 'max-content',
    minWidth: '100%',
  },
  // Mobile: still tappable, but not a full 44px "app list" density — the
  // drawer is narrow; oversized rows make the tree feel huge and sparse.
  rowTouch: {
    minHeight: 34,
    gap: 4,
    paddingRight: 10,
  },
  rowHover: {
    background: c.bgMuted,
  },
  rowActive: {
    background: c.accentBg,
  },
  activeBar: {
    position: 'absolute',
    left: 0,
    top: 3,
    bottom: 3,
    width: 2,
    borderRadius: 1,
    background: c.accent,
  },
  chevronBtn: {
    width: 18,
    height: 18,
    padding: 0,
    border: 'none',
    background: 'transparent',
    color: c.textFaint,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    borderRadius: radius.sm,
  },
  chevronBtnTouch: {
    width: 24,
    height: 24,
  },
  chevronBtnLit: {
    color: c.textSecondary,
  },
  icon: {
    flexShrink: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 15,
  },
  iconTouch: {
    width: 16,
  },
  label: {
    flexShrink: 0,
    whiteSpace: 'nowrap',
    fontSize: 12.5,
    fontFamily: font.sans,
    color: c.text,
    userSelect: 'none',
    lineHeight: 1.25,
    paddingRight: 4,
  },
  labelTouch: {
    fontSize: 13,
    lineHeight: 1.25,
  },
  rootLabel: {
    fontWeight: 600,
    color: c.text,
  },
  labelActive: {
    fontWeight: 500,
    color: c.accentHover,
  },
  error: {
    fontSize: 11,
    color: c.danger,
    padding: '2px 10px 3px 0',
    whiteSpace: 'nowrap',
  },
  errorHint: {
    color: c.textMuted,
  },
  loadMore: {
    display: 'block',
    margin: '0',
    padding: '3px 10px',
    border: 'none',
    background: 'transparent',
    color: c.accent,
    fontSize: 11.5,
    fontWeight: 500,
    cursor: 'pointer',
    textAlign: 'left',
    borderRadius: radius.sm,
    fontFamily: font.sans,
    whiteSpace: 'nowrap',
  },
  spinner: {
    width: 9,
    height: 9,
    border: `1.5px solid ${c.border}`,
    borderTopColor: c.accent,
    borderRadius: '50%',
    animation: 'spin 0.6s linear infinite',
    boxSizing: 'border-box',
  },
};
