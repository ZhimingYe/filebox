import { useEffect, useState } from 'react';
import { useIsMobile } from './useIsMobile';

/** Keep touch controls on phones in landscape and on tablets. */
export function useTerminalMobile() {
  const narrow = useIsMobile();
  const [touch, setTouch] = useState(() => window.matchMedia?.('(pointer: coarse)').matches ?? false);
  useEffect(() => {
    const query = window.matchMedia?.('(pointer: coarse)');
    if (!query) return;
    const update = () => setTouch(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return narrow || touch;
}

function visibleArea() {
  const viewport = window.visualViewport;
  return {
    top: viewport?.offsetTop ?? 0,
    left: viewport?.offsetLeft ?? 0,
    width: viewport?.width ?? window.innerWidth,
    height: viewport?.height ?? window.innerHeight,
  };
}

/** A focused terminal follows keyboard resize AND Safari viewport panning. */
export function useTerminalViewport(enabled: boolean) {
  const [area, setArea] = useState(visibleArea);
  useEffect(() => {
    if (!enabled) return;
    const viewport = window.visualViewport;
    const update = () => {
      // Let browser pinch zoom magnify the existing layout, not reflow the PTY.
      if (viewport && Math.abs(viewport.scale - 1) > 0.01) return;
      const next = visibleArea();
      setArea(previous => previous.top === next.top && previous.left === next.left &&
        previous.width === next.width && previous.height === next.height ? previous : next);
    };
    update();
    window.addEventListener('resize', update);
    viewport?.addEventListener('resize', update);
    viewport?.addEventListener('scroll', update);
    return () => {
      window.removeEventListener('resize', update);
      viewport?.removeEventListener('resize', update);
      viewport?.removeEventListener('scroll', update);
    };
  }, [enabled]);
  return area;
}
