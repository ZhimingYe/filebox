import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { WorkspaceSearch } from './WorkspaceSearch';
import { IconClose, IconSearch } from './icons';
import type { SearchPanelProps } from './searchPanel';
import { c, radius, shadow, font } from '../theme';

/** Persisted window geometry (desktop only). */
const STORAGE_KEY = 'filebox.searchWindow';
const DEFAULT_W = 560;
const DEFAULT_H = 600;
const MIN_W = 340;
const MIN_H = 240;
/** Minimum margin between the window and viewport edges. */
const EDGE = 8;
/** Keep at least this much of the window reachable on screen when dragging. */
const MIN_VISIBLE = 48;
const HEADER_H = 40;

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Clamp geometry so the window never leaves the viewport (header stays reachable). */
function clampRect(r: Rect, vw: number, vh: number): Rect {
  const w = Math.min(Math.max(r.w, MIN_W), Math.max(MIN_W, vw - EDGE * 2));
  const h = Math.min(Math.max(r.h, MIN_H), Math.max(MIN_H, vh - EDGE * 2));
  const loX = EDGE - w + MIN_VISIBLE;
  const hiX = vw - EDGE - MIN_VISIBLE;
  // The header (the only drag handle, HEADER_H tall) sits at the window's
  // top. Horizontally, a MIN_VISIBLE sliver of the window always contains
  // header, so it stays grabbable. That symmetry breaks vertically: dragged
  // far up, the on-screen sliver is the window's BOTTOM (body only) and the
  // header — the only thing you can grab — flies fully off-screen with no
  // way back. Pin the window's top to the viewport top instead.
  const loY = EDGE;
  const hiY = vh - EDGE - MIN_VISIBLE;
  return {
    x: Math.min(Math.max(r.x, Math.min(loX, hiX)), Math.max(loX, hiX)),
    y: Math.min(Math.max(r.y, Math.min(loY, hiY)), Math.max(loY, hiY)),
    w,
    h,
  };
}

function loadRect(): Rect {
  const fallback: Rect = {
    x: Math.max(EDGE, window.innerWidth - DEFAULT_W - EDGE),
    y: 72,
    w: DEFAULT_W,
    h: DEFAULT_H,
  };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<Rect>;
      if (
        typeof p.x === 'number' && Number.isFinite(p.x)
        && typeof p.y === 'number' && Number.isFinite(p.y)
        && typeof p.w === 'number' && Number.isFinite(p.w)
        && typeof p.h === 'number' && Number.isFinite(p.h)
      ) {
        return clampRect(
          { x: p.x, y: p.y, w: p.w, h: p.h },
          window.innerWidth,
          window.innerHeight,
        );
      }
    }
  } catch {
    /* private mode / corrupt storage */
  }
  return fallback;
}

/**
 * Desktop floating Search window: draggable by its header, resizable via the
 * right / bottom edges and the bottom-right corner grip. Geometry persists in
 * localStorage. The mobile counterpart is `SearchBottomSheet`.
 *
 * Drag mutates a CSS transform directly (no React re-renders per frame);
 * resize mutates width/height directly so the search result list re-measures
 * via its own ResizeObserver. Both commit to state on pointerup.
 */
export function SearchFloatWindow({
  open,
  agent,
  initialRoot,
  onOpenFile,
  onPreviewFile,
  onClose,
}: SearchPanelProps) {
  const [rect, setRect] = useState<Rect>(loadRect);
  const rectRef = useRef(rect);
  rectRef.current = rect;
  const rootRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);

  const persist = useCallback(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(rectRef.current));
    } catch {
      /* ignore */
    }
  }, []);

  // Keep the window on screen when the viewport shrinks (window resize).
  useEffect(() => {
    const onResize = () => {
      setRect((r) => clampRect(r, window.innerWidth, window.innerHeight));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const onHeaderPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget;
    const root = rootRef.current;
    if (!root) return;
    const start = {
      px: e.clientX,
      py: e.clientY,
      x: rectRef.current.x,
      y: rectRef.current.y,
      w: rectRef.current.w,
      h: rectRef.current.h,
    };
    setDragging(true);
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    document.body.style.userSelect = 'none';
    let lastDx = 0;
    let lastDy = 0;
    const onMove = (ev: PointerEvent) => {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const loX = EDGE - start.w + MIN_VISIBLE - start.x;
      const hiX = vw - EDGE - MIN_VISIBLE - start.x;
      // Mirrors clampRect: dragging up must stop with the header still on
      // screen — a visible sliver of body is not grabbable.
      const loY = EDGE - start.y;
      const hiY = vh - EDGE - MIN_VISIBLE - start.y;
      lastDx = Math.min(Math.max(ev.clientX - start.px, Math.min(loX, hiX)), Math.max(loX, hiX));
      lastDy = Math.min(Math.max(ev.clientY - start.py, Math.min(loY, hiY)), Math.max(loY, hiY));
      root.style.transform = `translate(${lastDx}px, ${lastDy}px)`;
    };
    const onUp = () => {
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
      try {
        if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      root.style.transform = '';
      document.body.style.userSelect = '';
      setDragging(false);
      if (lastDx !== 0 || lastDy !== 0) {
        const next = { ...rectRef.current, x: start.x + lastDx, y: start.y + lastDy };
        rectRef.current = next;
        setRect(next);
        persist();
      }
    };
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    // A cancelled pointer (touch gesture, OS pointer grab) must finalize
    // like a pointerup, or the translate transform stays stuck on the window.
    el.addEventListener('pointercancel', onUp);
  };

  const onResizePointerDown = (dir: 'e' | 's' | 'se') => (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget;
    const root = rootRef.current;
    if (!root) return;
    const start = {
      px: e.clientX,
      py: e.clientY,
      x: rectRef.current.x,
      y: rectRef.current.y,
      w: rectRef.current.w,
      h: rectRef.current.h,
    };
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    document.body.style.userSelect = 'none';
    let lastW = start.w;
    let lastH = start.h;
    const onMove = (ev: PointerEvent) => {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      if (dir === 'e' || dir === 'se') {
        lastW = Math.min(Math.max(start.w + ev.clientX - start.px, MIN_W), Math.max(MIN_W, vw - EDGE - start.x));
      }
      if (dir === 's' || dir === 'se') {
        lastH = Math.min(Math.max(start.h + ev.clientY - start.py, MIN_H), Math.max(MIN_H, vh - EDGE - start.y));
      }
      // State-driven (like WorkspaceSplit's splitter): the result list
      // re-measures via its own ResizeObserver, and React stays the single
      // owner of width/height — direct style mutation would desync it.
      const next = { ...rectRef.current, w: lastW, h: lastH };
      rectRef.current = next;
      setRect(next);
    };
    const onUp = () => {
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
      try {
        if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      document.body.style.userSelect = '';
      const next = clampRect(
        { ...rectRef.current, w: lastW, h: lastH },
        window.innerWidth,
        window.innerHeight,
      );
      rectRef.current = next;
      setRect(next);
      persist();
    };
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
  };

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-label="Search"
      style={{
        ...styles.window,
        left: rect.x,
        top: rect.y,
        width: rect.w,
        height: rect.h,
        display: open ? 'flex' : 'none',
        ...(dragging ? styles.dragging : null),
      }}
    >
      <div
        onPointerDown={onHeaderPointerDown}
        style={styles.header}
        title="Drag to move"
      >
        <span style={styles.headerIcon}>
          <IconSearch style={{ width: 15, height: 15 }} />
        </span>
        <span style={styles.headerTitle}>Search</span>
        <button
          type="button"
          onClick={onClose}
          onPointerDown={(e) => e.stopPropagation()}
          style={styles.closeBtn}
          title="Close search (Esc)"
          aria-label="Close search"
        >
          <IconClose style={{ width: 14, height: 14 }} />
        </button>
      </div>

      <div style={styles.body}>
        <WorkspaceSearch
          agent={agent}
          initialRoot={initialRoot}
          onOpenFile={onOpenFile}
          onPreviewFile={onPreviewFile}
        />
      </div>

      {/* Resize hit areas: right / bottom edges + corner grip. Invisible except
          the corner hint; the window stays mounted while closed so a running
          scan is never killed by closing the window. */}
      <div
        onPointerDown={onResizePointerDown('e')}
        style={styles.handleE}
        title="Resize width"
      />
      <div
        onPointerDown={onResizePointerDown('s')}
        style={styles.handleS}
        title="Resize height"
      />
      <div
        onPointerDown={onResizePointerDown('se')}
        style={styles.handleSE}
        title="Resize"
      >
        <span style={styles.cornerGrip} aria-hidden />
      </div>
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  window: {
    position: 'absolute',
    // All in-pane preview loading overlays use z-index: 100. Keep this
    // app-level floating window above them so an active search stays usable
    // while any preview type is rendering.
    zIndex: 200,
    flexDirection: 'column',
    overflow: 'hidden',
    boxSizing: 'border-box',
    background: c.bg,
    border: `1px solid ${c.border}`,
    borderRadius: radius.lg,
    boxShadow: shadow.lg,
    minWidth: MIN_W,
    minHeight: MIN_H,
  },
  dragging: {
    willChange: 'transform',
    userSelect: 'none',
  },
  header: {
    flexShrink: 0,
    height: HEADER_H,
    boxSizing: 'border-box',
    display: 'flex',
    alignItems: 'center',
    gap: 7,
    padding: '0 8px 0 12px',
    background: c.bgSubtle,
    borderBottom: `1px solid ${c.border}`,
    cursor: 'grab',
    touchAction: 'none',
  },
  headerIcon: {
    color: c.accent,
    display: 'flex',
    flexShrink: 0,
  },
  headerTitle: {
    flex: 1,
    minWidth: 0,
    fontSize: 13,
    fontWeight: 600,
    color: c.text,
    letterSpacing: '-0.01em',
    fontFamily: font.sans,
  },
  closeBtn: {
    background: 'transparent',
    border: 'none',
    color: c.textMuted,
    cursor: 'pointer',
    padding: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.sm,
    width: 26,
    height: 26,
    flexShrink: 0,
    transition: 'background 0.12s, color 0.12s',
  },
  body: {
    flex: 1,
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  },
  handleE: {
    position: 'absolute',
    top: HEADER_H,
    right: 0,
    bottom: 0,
    width: 8,
    cursor: 'ew-resize',
    touchAction: 'none',
  },
  handleS: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: 8,
    cursor: 'ns-resize',
    touchAction: 'none',
  },
  handleSE: {
    position: 'absolute',
    right: 0,
    bottom: 0,
    width: 16,
    height: 16,
    cursor: 'nwse-resize',
    touchAction: 'none',
  },
  cornerGrip: {
    position: 'absolute',
    right: 3,
    bottom: 3,
    width: 8,
    height: 8,
    backgroundImage: 'linear-gradient(135deg, transparent 50%, rgba(148, 163, 184, 0.55) 50%)',
  },
};
