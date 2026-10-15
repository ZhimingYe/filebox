import type { Terminal } from '@xterm/xterm';

/** xterm 6's custom viewport handles wheels, but not finger scrolling.
 * Keep gesture bookkeeping outside React; at most one scroll per paint.
 */
export function installTerminalTouchScroll(host: HTMLElement, term: Terminal) {
  let finger: number | null = null;
  let startX = 0;
  let startY = 0;
  let lastY = 0;
  let lastTime = 0;
  let lineHeight = 16;
  let dragging = false;
  let pending = 0;
  let velocity = 0;
  let frame: number | null = null;
  let coastUntil = 0;
  let previousFrame = 0;
  let target: HTMLElement = host;
  let local = true;
  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)');

  const stop = () => {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null; finger = null; dragging = false;
    pending = 0; velocity = 0; coastUntil = 0;
  };
  const flush = (now: number) => {
    frame = null;
    // Never let momentum from shell history turn into input to a new TUI.
    if (local && term.buffer.active.type !== 'normal') { stop(); return; }
    if (finger === null && coastUntil > now) {
      const dt = Math.min(32, now - previousFrame);
      pending += velocity * dt;
      velocity *= Math.pow(0.9, dt / 16);
    }
    previousFrame = now;
    if (local) {
      const lines = Math.trunc(pending / lineHeight);
      if (lines) {
        pending -= lines * lineHeight;
        const before = term.buffer.active.viewportY;
        term.scrollLines(lines);
        if (finger === null && before === term.buffer.active.viewportY) coastUntil = 0;
      }
    } else if (pending) {
      // Delegate TUI/mouse modes to xterm's existing wheel semantics. No
      // inertia for remote input; lifting a finger stops sending immediately.
      target.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true,
        deltaY: Math.max(-5 * lineHeight, Math.min(5 * lineHeight, pending)),
        clientX: startX, clientY: startY }));
      pending = 0;
    }
    if (finger === null && coastUntil > now && Math.abs(velocity) > 0.03) {
      frame = requestAnimationFrame(flush);
    }
  };
  const schedule = () => { if (frame === null) frame = requestAnimationFrame(flush); };
  const start = (event: TouchEvent) => {
    stop();
    if (event.touches.length !== 1) return; // Leave pinch zoom to the browser.
    const touch = event.touches[0];
    finger = touch.identifier;
    startX = touch.clientX; startY = lastY = touch.clientY;
    lastTime = performance.now();
    target = host.querySelector<HTMLElement>('.xterm-screen') ?? host;
    lineHeight = Math.max(1, target.getBoundingClientRect().height / Math.max(1, term.rows));
    local = term.buffer.active.type === 'normal' && term.modes.mouseTrackingMode === 'none';
  };
  const move = (event: TouchEvent) => {
    if (event.touches.length !== 1) { stop(); return; }
    const touch = event.touches[0];
    if (finger !== touch.identifier) return;
    if (!dragging) {
      const dy = touch.clientY - startY;
      if (Math.abs(dy) < 6) return; // Taps / long press retain native behavior.
      if (Math.abs(touch.clientX - startX) > Math.abs(dy)) { stop(); return; }
      dragging = true;
    }
    if (event.cancelable) event.preventDefault();
    const now = performance.now();
    const delta = lastY - touch.clientY;
    pending += delta;
    velocity = Math.max(-2, Math.min(2, delta / Math.max(1, now - lastTime)));
    lastY = touch.clientY; lastTime = now;
    schedule();
  };
  const end = () => {
    if (finger === null) return;
    finger = null;
    if (!dragging) return;
    const now = performance.now();
    if (local && !reducedMotion?.matches && now - lastTime < 80) {
      coastUntil = now + 600;
      previousFrame = now;
      schedule();
    } else if (!local) {
      stop();
    }
  };
  const visibility = () => { if (document.hidden) stop(); };
  host.addEventListener('touchstart', start, { passive: true });
  host.addEventListener('touchmove', move, { passive: false });
  host.addEventListener('touchend', end, { passive: true });
  host.addEventListener('touchcancel', stop, { passive: true });
  // Explicit keyboard / Latest actions should immediately stop momentum.
  host.addEventListener('keydown', stop);
  window.addEventListener('blur', stop);
  document.addEventListener('visibilitychange', visibility);
  return {
    stop,
    dispose() {
      stop();
      host.removeEventListener('touchstart', start);
      host.removeEventListener('touchmove', move);
      host.removeEventListener('touchend', end);
      host.removeEventListener('touchcancel', stop);
      host.removeEventListener('keydown', stop);
      window.removeEventListener('blur', stop);
      document.removeEventListener('visibilitychange', visibility);
    },
  };
}
