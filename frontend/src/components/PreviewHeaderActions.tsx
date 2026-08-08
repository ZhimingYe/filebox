import { memo } from 'react';
import { FileDownloadLink } from './FileDownloadLink';
import { IconCheck, IconClipboard, IconRefresh } from './icons';
import { fullServerAddress } from './fullServerAddress';
import { useCopyToClipboard } from '../hooks/useCopyToClipboard';
import { c, radius } from '../theme';
import type { PreviewTab } from '../hooks/usePreviewTabs';
import type { RootInfo } from '../api/client';

interface Props {
  agentId: string;
  tab: PreviewTab;
  roots: RootInfo[];
  onRefresh: (tabId: string) => void;
}

// ── Preview header actions ───────────────────────────────────────────────
// The shared action row of a preview header: manual refresh (remounts the
// preview body so viewers re-fetch), copy file address (full server-side
// path), and download. Used by both the desktop tabbed header
// (PreviewWorkspace) and the mobile single-tab header (App), so behavior
// and "Copied!" feedback stay identical on both layouts. The close button
// stays with each layout (tab strip vs mobile Back bar).
export const PreviewHeaderActions = memo(function PreviewHeaderActions({
  agentId, tab, roots, onRefresh,
}: Props) {
  const { copiedPath, copyToClipboard } = useCopyToClipboard();
  // Label is unique per file so the "Copied!" feedback only lights up on
  // the button that copied it (same convention as search hit rows).
  const copyLabel = `preview-${agentId}:${tab.root}:${tab.path}`;
  const copied = copiedPath === copyLabel;
  return (
    <>
      <button
        type="button"
        onClick={() => onRefresh(tab.id)}
        style={styles.iconBtn}
        title="Refresh preview"
        aria-label={`Refresh preview of ${tab.title}`}
      >
        <IconRefresh style={{ width: 14, height: 14 }} />
      </button>
      <button
        type="button"
        onClick={() => void copyToClipboard(fullServerAddress(roots, tab.root, tab.path), copyLabel)}
        style={styles.iconBtn}
        title={copied ? 'Copied!' : 'Copy file address'}
        aria-label="Copy file address"
      >
        {copied
          ? <IconCheck style={{ width: 14, height: 14, color: c.accent }} />
          : <IconClipboard style={{ width: 14, height: 14 }} />}
      </button>
      <FileDownloadLink
        agentId={agentId}
        root={tab.root}
        path={tab.path}
        style={styles.downloadLink}
      />
    </>
  );
});

const styles: Record<string, React.CSSProperties> = {
  // Icon-only action (refresh / copy): bordered chrome shared with the
  // download link so the header's action row reads as one unit.
  iconBtn: {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    width: 28, height: 28, padding: 0,
    border: `1px solid ${c.border}`, borderRadius: radius.sm,
    background: 'transparent', color: c.textSecondary, cursor: 'pointer',
    transition: 'all 0.15s',
  },
  downloadLink: {
    color: c.textSecondary, fontSize: 12, textDecoration: 'none',
    padding: '4px 10px', borderRadius: radius.sm,
    border: `1px solid ${c.border}`, background: 'transparent',
    transition: 'all 0.15s',
  },
};
