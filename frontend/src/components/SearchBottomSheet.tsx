import { useEffect, useRef, type CSSProperties } from 'react';
import { WorkspaceSearch } from './WorkspaceSearch';
import { IconClose, IconSearch } from './icons';
import type { SearchPanelProps } from './searchPanel';
import { c, radius, shadow, font } from '../theme';

/** Sheet height: the "bottom half" of the screen. */
const SHEET_H = 'clamp(260px, 55vh, 85vh)';
/** Drag distance at which the sheet is dismissed (plus a fast-flick path). */
const DISMISS_PX = 110;
/** A downward flick faster than this (px/ms) dismisses even from a short drag. */
const FLICK_VELOCITY = 0.6;
/** Minimum drag before a flick counts. */
const FLICK_MIN_PX = 40;
/** Slide animation, iOS-sheet-like. */
const SHEET_TRANSITION = 'transform 0.28s cubic-bezier(0.32, 0.72, 0, 1)';

/**
 * iOS-style bottom sheet for mobile Search: slides up from the bottom over
 * the lower half of the screen, rounded top corners, grabber handle, dimmed
 * backdrop. Dismiss by tapping the backdrop, the × button, Esc, or swiping
 * the grabber/header strip downward (past a threshold, or as a fast flick).
 *
 * Only the grabber/header strip is a drag target — the results list inside
 * scrolls normally. The sheet stays mounted while closed so long scans
 * survive, the same guarantee as the desktop floating window.
 */
export function SearchBottomSheet({
  open,
  agent,
  initialRoot,
  onOpenFile,
  onPreviewFile,
  onClose,
}: SearchPanelProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  // Latest `open` for the drag cleanup, which runs from async pointer events
  // and must restore the position React last rendered, not the one from the
  // render that started the gesture.
  const openRef = useRef(open);
  openRef.current = open;
  /** Active gesture's cleanup; null when no gesture is tracked. */
  const cleanupRef = useRef<((dismiss?: boolean) => void) | null>(null);

  // If the component unmounts mid-gesture (agent switch, logout), stop
  // tracking so no stale listener outlives the sheet.
  useEffect(() => () => {
    cleanupRef.current?.();
  }, []);

  // iOS-style swipe-down-to-dismiss. The finger drags the sheet via a direct
  // transform mutation (no re-renders); on release it either snaps back or
  // closes, which triggers the CSS slide-down transition.
  //
  // Robustness (a frozen sheet is a bug, not a failure mode):
  // - pointerup, pointercancel AND lostpointercapture all end the gesture —
  //   browsers fire `pointercancel` instead of `pointerup` whenever the OS
  //   steals the pointer (notification shade, back swipe, …), and skipping
  //   it left the sheet stuck mid-drag with its transition disabled forever.
  // - Listeners attach to `window` and filter by pointerId, so a second
  //   finger scrolling the results list can't drive the sheet.
  // - `finish` is idempotent and re-applies the React-owned transform +
  //   transition explicitly, so React (which only rewrites changed props)
  //   and the direct style mutations can never desync.
  const onChromePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = rootRef.current;
    if (!el) return;
    // Capture now: React nulls `e.currentTarget` after the handler returns,
    // but the pointer listeners fire much later.
    const target = e.currentTarget;
    const pointerId = e.pointerId;
    // A new gesture while the previous one is still tracked (its pointerup
    // was swallowed by the OS): force-clean the stale one first.
    cleanupRef.current?.();
    const startY = e.clientY;
    let dy = 0;
    let velocity = 0;
    let prevTs = e.timeStamp;
    let prevDy = 0;
    let done = false;
    try {
      target.setPointerCapture(pointerId);
    } catch {
      /* ignore */
    }
    // Direct mutation so mid-drag moves are 1:1; restored explicitly in
    // finish (React won't rewrite an unchanged prop).
    el.style.transition = 'none';

    const finish = (dismiss = false) => {
      if (done) return;
      done = true;
      cleanupRef.current = null;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('lostpointercapture', onLostCapture);
      try {
        if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId);
      } catch {
        /* ignore */
      }
      // Re-apply what React last rendered, so a close triggered mid-gesture
      // (Esc, backdrop tap) can't be undone by this cleanup.
      const rest = dismiss || !openRef.current ? 'translateY(105%)' : 'translateY(0)';
      el.style.transform = rest;
      el.style.transition = SHEET_TRANSITION;
      if (dismiss) onClose();
    };
    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId || done) return;
      dy = Math.max(0, ev.clientY - startY);
      const dt = ev.timeStamp - prevTs;
      if (dt > 0) velocity = (dy - prevDy) / dt;
      prevTs = ev.timeStamp;
      prevDy = dy;
      el.style.transform = `translateY(${dy}px)`;
    };
    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      const flick = dy >= FLICK_MIN_PX && velocity >= FLICK_VELOCITY;
      finish(dy >= DISMISS_PX || flick);
    };
    const onCancel = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      // The OS took the gesture over: snap back, never dismiss, never leave
      // the sheet stuck.
      finish(false);
    };
    const onLostCapture = () => {
      // Pointer capture dropped without a pointerup (element removed, another
      // element captured the pointer): same safe cleanup.
      finish(false);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('lostpointercapture', onLostCapture);
    cleanupRef.current = finish;
  };

  return (
    <>
      {/* Dimmed backdrop. Tap to dismiss — the iOS sheet affordance. */}
      <div
        onClick={onClose}
        aria-hidden
        style={{
          ...styles.backdrop,
          opacity: open ? 1 : 0,
          pointerEvents: open ? 'auto' : 'none',
        }}
      />
      <div
        ref={rootRef}
        role="dialog"
        aria-label="Search"
        // Closed = translated off-screen + pointerEvents none, but that only
        // blocks pointers: without `inert` the hidden controls stay Tab-
        // focusable and exposed to screen readers (the desktop float window
        // hides with display:none and never had this hole). `inert` keeps
        // the slide animations intact while removing focus + AT exposure.
        inert={!open}
        style={{
          ...styles.sheet,
          transform: open ? 'translateY(0)' : 'translateY(105%)',
          pointerEvents: open ? 'auto' : 'none',
        }}
      >
        {/* Grabber + header strip: the swipe-down dismiss drag target.
            `touchAction: none` keeps the gesture from scrolling the page. */}
        <div
          onPointerDown={onChromePointerDown}
          style={styles.chrome}
          title="Swipe down to close"
        >
          <div style={styles.grabber} aria-hidden />
          <div style={styles.headerRow}>
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
              <IconClose style={{ width: 16, height: 16 }} />
            </button>
          </div>
        </div>

        <div style={styles.body}>
          <WorkspaceSearch
            agent={agent}
            initialRoot={initialRoot}
            onOpenFile={onOpenFile}
            onPreviewFile={onPreviewFile}
          />
        </div>
      </div>
    </>
  );
}

const styles: Record<string, CSSProperties> = {
  backdrop: {
    position: 'fixed',
    inset: 0,
    zIndex: 90,
    background: c.bgOverlay,
    transition: 'opacity 0.28s ease',
    // Below the mobile drawer (150/200). While the sheet is open the backdrop
    // covers the top bar, so the drawer can't actually be opened underneath —
    // the ordering is a safety net, not a live path.
  },
  sheet: {
    position: 'fixed',
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 100,
    height: SHEET_H,
    boxSizing: 'border-box',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    background: c.bg,
    // iOS sheets use ~16px top corners (radius.lg + 4).
    borderTopLeftRadius: radius.lg + 4,
    borderTopRightRadius: radius.lg + 4,
    boxShadow: shadow.lg,
    transition: SHEET_TRANSITION,
    // Home-indicator clearance on notched iPhones; 0 elsewhere.
    paddingBottom: 'env(safe-area-inset-bottom)',
  },
  chrome: {
    flexShrink: 0,
    display: 'flex',
    flexDirection: 'column',
    background: c.bgSubtle,
    borderBottom: `1px solid ${c.border}`,
    touchAction: 'none',
    userSelect: 'none',
    WebkitUserSelect: 'none',
  },
  grabber: {
    alignSelf: 'center',
    width: 36,
    height: 5,
    borderRadius: radius.pill,
    background: c.border,
    marginTop: 8,
    marginBottom: 6,
    flexShrink: 0,
  },
  headerRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '0 12px 10px',
  },
  headerIcon: {
    color: c.accent,
    display: 'flex',
    flexShrink: 0,
  },
  headerTitle: {
    flex: 1,
    minWidth: 0,
    fontSize: 14,
    fontWeight: 600,
    color: c.text,
    letterSpacing: '-0.01em',
    fontFamily: font.sans,
  },
  closeBtn: {
    background: c.bgMuted,
    border: 'none',
    color: c.textSecondary,
    cursor: 'pointer',
    padding: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.md,
    width: 36,
    height: 36,
    flexShrink: 0,
  },
  body: {
    flex: 1,
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  },
};
