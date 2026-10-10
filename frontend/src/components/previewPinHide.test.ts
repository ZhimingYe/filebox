import { describe, expect, it } from 'vitest';
import { pinnedPaneHiddenHtmlStyle, pinnedPaneHiddenStyle } from './previewShared';
import { keepAliveParkStyle } from './previewKeepAlive';

// Pin-hide contract regression: parked panes must stay unpainted by design
// (offscreen + opacity 0). visibility:hidden was retired — a descendant
// with visibility:visible can no longer punch through into the active slot.

describe('pinned pane hide styles (unified keep-alive park)', () => {
  it('ordinary and HTML aliases share the offscreen park contract', () => {
    for (const style of [pinnedPaneHiddenStyle, pinnedPaneHiddenHtmlStyle, keepAliveParkStyle]) {
      expect(style.opacity).toBe(0);
      expect(style.pointerEvents).toBe('none');
      expect(style.display).not.toBe('none');
      expect(style.position).toBe('absolute');
      expect(style.left).toBe(-10000);
      expect(style.visibility).toBeUndefined();
    }
  });
});
