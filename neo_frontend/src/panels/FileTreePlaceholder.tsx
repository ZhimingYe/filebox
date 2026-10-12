import type { IDockviewPanelProps } from 'dockview-react';
import { c, font } from '../theme';

/** Placeholder for the neo file-tree panel. Real tree lands in a later PR. */
export function FileTreePlaceholder(_props: IDockviewPanelProps) {
  return (
    <div
      style={{
        height: '100%',
        boxSizing: 'border-box',
        padding: 16,
        background: c.bgSubtle,
        color: c.textSecondary,
        fontFamily: font.sans,
        fontSize: 13,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <div style={{ fontWeight: 600, color: c.text }}>File tree</div>
      <div style={{ color: c.textMuted, lineHeight: 1.5 }}>
        Placeholder panel. Classic <code style={{ fontFamily: font.mono }}>DirectoryTree</code>{' '}
        / explorer wiring will land in a follow-up PR.
      </div>
    </div>
  );
}
