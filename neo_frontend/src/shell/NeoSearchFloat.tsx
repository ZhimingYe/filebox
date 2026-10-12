/**
 * Thin neo search float — WorkspaceSearch without classic SearchFloatWindow's
 * window chrome (title bar + heavy frame), which felt double-framed over dockview.
 * Keeps drag / resize / Esc / persist; slim drag strip + close only.
 */

import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import type { AgentInfo } from '@classic/api/client';
import { WorkspaceSearch } from '@classic/components/WorkspaceSearch';
import { IconClose } from '@classic/components/icons';
import { c, font, radius, shadow } from '../theme';

const STORAGE_KEY = 'filebox.neo.searchFloat';
const DEFAULT_W = 560;
const DEFAULT_H = 560;
const MIN_W = 340;
const MIN_H = 240;
const EDGE = 8;
const MIN_VISIBLE = 48;
const HEADER_H = 28;

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function clampRect(r: Rect, vw: number, vh: number): Rect {
  const w = Math.min(Math.max(r.w, MIN_W), Math.max(MIN_W, vw - EDGE * 2));
  const h = Math.min(Math.max(r.h, MIN_H), Math.max(MIN_H, vh - EDGE * 2));
  const loX = EDGE - w + MIN_VISIBLE;
  const hiX = vw - EDGE - MIN_VISIBLE;
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
    y: 56,
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
    /* ignore */
  }
  return fallback;
}

export interface NeoSearchFloatProps {
  open: boolean;
  agent: AgentInfo;
  initialRoot?: string | null;
  onOpenFile?: (root: string, path: string) => void;
  onPreviewFile?: (root: string, path: string) => void;
  onClose: () => void;
}

export function NeoSearchFloat({
  open,
  agent,
  initialRoot,
  onOpenFile,
  onPreviewFile,
  onClose,
}: NeoSearchFloatProps) {
  const [rect, setRect] = useState<Rect>(loadRect);
  const rectRef = useRef(rect);
  rectRef.current = rect;
  const rootRef = useRef<HTMLDivElement>(null);

  const persist = useCallback(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(rectRef.current));
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    const onResize = () => {
      setRect((r) => clampRect(r, window.innerWidth, window.innerHeight));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Esc closes when open (classic App also binds this).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, onClose]);

  const onHeaderPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const start = { px: e.clientX, py: e.clientY, x: rectRef.current.x, y: rectRef.current.y };
    document.body.style.userSelect = 'none';
    const onMove = (ev: PointerEvent) => {
      const next = clampRect(
        {
          ...rectRef.current,
          x: start.x + ev.clientX - start.px,
          y: start.y + ev.clientY - start.py,
        },
        window.innerWidth,
        window.innerHeight,
      );
      rectRef.current = next;
      const node = rootRef.current;
      if (node) {
        node.style.left = `${next.x}px`;
        node.style.top = `${next.y}px`;
      }
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
      setRect(rectRef.current);
      persist();
    };
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
  };

  const onResizePointerDown = (dir: 'e' | 's' | 'se') => (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const start = {
      px: e.clientX,
      py: e.clientY,
      w: rectRef.current.w,
      h: rectRef.current.h,
      x: rectRef.current.x,
    };
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
        lastH = Math.min(Math.max(start.h + ev.clientY - start.py, MIN_H), Math.max(MIN_H, vh - EDGE * 2));
      }
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
        ...shell,
        left: rect.x,
        top: rect.y,
        width: rect.w,
        height: rect.h,
        display: open ? 'flex' : 'none',
      }}
    >
      <div onPointerDown={onHeaderPointerDown} style={header} title="Drag to move">
        <span style={headerLabel}>Search</span>
        <button
          type="button"
          onClick={onClose}
          onPointerDown={(e) => e.stopPropagation()}
          style={closeBtn}
          title="Close search (Esc)"
          aria-label="Close search"
        >
          <IconClose style={{ width: 12, height: 12 }} />
        </button>
      </div>
      <div style={body}>
        <WorkspaceSearch
          agent={agent}
          initialRoot={initialRoot}
          onOpenFile={onOpenFile}
          onPreviewFile={onPreviewFile}
        />
      </div>
      <div onPointerDown={onResizePointerDown('e')} style={handleE} title="Resize width" />
      <div onPointerDown={onResizePointerDown('s')} style={handleS} title="Resize height" />
      <div onPointerDown={onResizePointerDown('se')} style={handleSE} title="Resize" />
    </div>
  );
}

const shell: CSSProperties = {
  position: 'fixed',
  zIndex: 200,
  flexDirection: 'column',
  overflow: 'hidden',
  boxSizing: 'border-box',
  background: c.bg,
  border: `1px solid ${c.border}`,
  borderRadius: radius.md,
  boxShadow: shadow.md,
  minWidth: MIN_W,
  minHeight: MIN_H,
};

const header: CSSProperties = {
  flexShrink: 0,
  height: HEADER_H,
  boxSizing: 'border-box',
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '0 6px 0 10px',
  background: c.bgSubtle,
  borderBottom: `1px solid ${c.border}`,
  cursor: 'grab',
  touchAction: 'none',
};

const headerLabel: CSSProperties = {
  flex: 1,
  minWidth: 0,
  fontSize: 11,
  fontWeight: 600,
  color: c.textMuted,
  letterSpacing: 0.3,
  textTransform: 'uppercase',
  fontFamily: font.sans,
};

const closeBtn: CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: c.textMuted,
  cursor: 'pointer',
  padding: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  borderRadius: radius.sm,
  width: 22,
  height: 22,
  flexShrink: 0,
};

const body: CSSProperties = {
  flex: 1,
  minHeight: 0,
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
};

const handleE: CSSProperties = {
  position: 'absolute',
  top: HEADER_H,
  right: 0,
  bottom: 0,
  width: 8,
  cursor: 'ew-resize',
  touchAction: 'none',
};

const handleS: CSSProperties = {
  position: 'absolute',
  left: 0,
  right: 0,
  bottom: 0,
  height: 8,
  cursor: 'ns-resize',
  touchAction: 'none',
};

const handleSE: CSSProperties = {
  position: 'absolute',
  right: 0,
  bottom: 0,
  width: 14,
  height: 14,
  cursor: 'nwse-resize',
  touchAction: 'none',
};
