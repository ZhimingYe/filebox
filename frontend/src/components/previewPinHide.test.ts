import { describe, expect, it } from 'vitest';
import { pinnedPaneHiddenHtmlStyle, pinnedPaneHiddenStyle } from './previewShared';

// Pin-hide contract regression: a pinned inactive pane must stay unpainted
// even if a viewer (historically PdfPreview) sets visibility:visible on a
// descendant. opacity:0 is the property children cannot override.

describe('pinned pane hide styles', () => {
  it('ordinary hide uses opacity 0 so visibility:visible children cannot paint through', () => {
    expect(pinnedPaneHiddenStyle.opacity).toBe(0);
    expect(pinnedPaneHiddenStyle.visibility).toBe('hidden');
    expect(pinnedPaneHiddenStyle.pointerEvents).toBe('none');
    expect(pinnedPaneHiddenStyle.display).not.toBe('none');
    expect(pinnedPaneHiddenStyle.position).toBe('absolute');
  });

  it('HTML offscreen hide also keeps opacity 0 and never uses display:none', () => {
    expect(pinnedPaneHiddenHtmlStyle.opacity).toBe(0);
    expect(pinnedPaneHiddenHtmlStyle.pointerEvents).toBe('none');
    expect(pinnedPaneHiddenHtmlStyle.display).not.toBe('none');
    expect(pinnedPaneHiddenHtmlStyle.position).toBe('absolute');
    expect(pinnedPaneHiddenHtmlStyle.left).toBe(-10000);
  });
});
