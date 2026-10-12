import type { IDockviewPanelProps } from 'dockview-react';
import { c, font } from '../theme';

/** Placeholder for the neo preview panel. Viewers land in later PRs. */
export function PreviewPlaceholder(_props: IDockviewPanelProps) {
  return (
    <div
      style={{
        height: '100%',
        boxSizing: 'border-box',
        padding: 16,
        background: c.bg,
        color: c.textSecondary,
        fontFamily: font.sans,
        fontSize: 13,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <div style={{ fontWeight: 600, color: c.text }}>Preview</div>
      <div style={{ color: c.textMuted, lineHeight: 1.5 }}>
        Empty preview dock. PDF / HTML / Monaco viewers are intentionally out of
        scope for this shell spike.
      </div>
    </div>
  );
}
