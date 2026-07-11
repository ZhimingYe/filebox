import { memo, useEffect, useState } from 'react';
import { PreviewPane } from './PreviewPane';
import { PreviewErrorBoundary } from './PreviewErrorBoundary';
import { fileRawUrl } from '../api/client';
import { c, radius, font, shadow } from '../theme';
import type { PreviewTab } from '../hooks/usePreviewTabs';

// ── Desktop preview panel ─────────────────────────────────────────────────
//
// Renders the desktop preview area: an optional tab strip (shown once more
// than one tab is open), the active tab's header (path + download + close),
// and exactly ONE PreviewPane for the active tab. Inactive tabs are pure
// metadata held by the parent's usePreviewTabs hook — they never mount a
// preview body, so PDF/Image/HTML/syntax-highlighter resources are only
// alive for the visible tab.
//
// Switching tabs remounts PreviewPane internals via the `key` prop (the
// stable tab id). V1 deliberately does not preserve scroll / zoom / page
// position across tab switches.
//
// PreviewPane stays memoized on primitive props, so dragging the file/preview
// splitter (which re-renders App and this component) does NOT re-render the
// preview subtree — only a real change to the active tab's primitives does.

interface Props {
  agentId: string;
  tabs: PreviewTab[];
  activeTab: PreviewTab | null;
  activeTabId: string | null;
  onActivate: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onCloseAll: () => void;
  onCloseLeft: (tabId: string) => void;
  onCloseRight: (tabId: string) => void;
}

// Memoized: every prop is either a primitive (agentId, activeTabId) or a
// stable reference from usePreviewTabs (tabs, activeTab, onActivate,
// onClose). So during a splitter drag — which re-renders App and the parent
// split layout every animation frame — this component skips re-rendering
// entirely, and the memoized PreviewPane inside does too. It only re-renders
// when the tab set or active tab genuinely changes.
export const PreviewWorkspace = memo(function PreviewWorkspace({
  agentId, tabs, activeTab, activeTabId,
  onActivate, onClose, onCloseAll, onCloseLeft, onCloseRight,
}: Props) {
  const [menu, setMenu] = useState<{ tabId: string; x: number; y: number } | null>(null);
  const [hoveredMenuItem, setHoveredMenuItem] = useState<string | null>(null);

  useEffect(() => {
    if (!menu) return;
    const dismiss = () => setMenu(null);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        dismiss();
      }
    };
    window.addEventListener('pointerdown', dismiss);
    window.addEventListener('blur', dismiss);
    window.addEventListener('resize', dismiss);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('pointerdown', dismiss);
      window.removeEventListener('blur', dismiss);
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [menu]);

  const menuIndex = menu ? tabs.findIndex((tab) => tab.id === menu.tabId) : -1;
  const runMenuAction = (action: () => void) => {
    setMenu(null);
    setHoveredMenuItem(null);
    action();
  };
  const menuItemStyle = (id: string, disabled = false) => ({
    ...styles.menuItem,
    ...(disabled ? styles.menuItemDisabled : hoveredMenuItem === id ? styles.menuItemHover : {}),
  });

  return (
    <div style={styles.panel}>
      {tabs.length > 1 && (
        <div style={styles.tabBar} role="tablist" aria-label="Open previews">
          {tabs.map((tab) => {
            const active = tab.id === activeTabId;
            return (
              <div
                key={tab.id}
                role="tab"
                aria-selected={active}
                onClick={() => onActivate(tab.id)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  setHoveredMenuItem(null);
                  const menuWidth = 190;
                  const menuHeight = 150;
                  setMenu({
                    tabId: tab.id,
                    x: Math.max(8, Math.min(event.clientX, window.innerWidth - menuWidth - 8)),
                    y: Math.max(8, Math.min(event.clientY, window.innerHeight - menuHeight - 8)),
                  });
                }}
                // Full root + path as the tooltip; the visible label is just
                // the basename so the strip stays compact.
                title={`${tab.root}${tab.path}`}
                style={{ ...styles.tab, ...(active ? styles.tabActive : {}) }}
              >
                <span style={styles.tabTitle}>{tab.title}</span>
                <button
                  onClick={(e) => { e.stopPropagation(); onClose(tab.id); }}
                  title="Close tab"
                  aria-label={`Close ${tab.title}`}
                  style={styles.tabClose}
                >
                  &times;
                </button>
              </div>
            );
          })}
        </div>
      )}
      {activeTab && (
        <>
          <div style={styles.header}>
            <span style={styles.path}>{activeTab.path}</span>
            <div style={styles.actions}>
              <a
                href={fileRawUrl(agentId, activeTab.root, activeTab.path)}
                download
                style={styles.downloadLink}
                title="Download"
              >
                Download
              </a>
              <button
                onClick={() => onClose(activeTab.id)}
                style={styles.closeBtn}
                title="Close (Esc)"
              >
                &times;
              </button>
            </div>
          </div>
          {/* Body wrapper gives PreviewPane a definite flex height so its own
              height:100% container resolves and internal scrolling works. */}
          <div style={styles.body}>
            <PreviewErrorBoundary key={activeTab.id}>
              <PreviewPane
                agentId={agentId}
                root={activeTab.root}
                path={activeTab.path}
                entryType={activeTab.entry.entry_type}
                denied={activeTab.entry.denied}
              />
            </PreviewErrorBoundary>
          </div>
        </>
      )}
      {menu && menuIndex !== -1 && (
        <div
          role="menu"
          aria-label="Tab actions"
          onPointerDown={(event) => event.stopPropagation()}
          style={{ ...styles.contextMenu, left: menu.x, top: menu.y }}
        >
          <button
            role="menuitem"
            style={menuItemStyle('close')}
            onMouseEnter={() => setHoveredMenuItem('close')}
            onMouseLeave={() => setHoveredMenuItem(null)}
            onClick={() => runMenuAction(() => onClose(menu.tabId))}
          >
            Close tab
          </button>
          <div style={styles.menuDivider} />
          <button
            role="menuitem"
            disabled={menuIndex === 0}
            style={menuItemStyle('left', menuIndex === 0)}
            onMouseEnter={() => { if (menuIndex !== 0) setHoveredMenuItem('left'); }}
            onMouseLeave={() => setHoveredMenuItem(null)}
            onClick={() => runMenuAction(() => onCloseLeft(menu.tabId))}
          >
            Close tabs to the left
          </button>
          <button
            role="menuitem"
            disabled={menuIndex === tabs.length - 1}
            style={menuItemStyle('right', menuIndex === tabs.length - 1)}
            onMouseEnter={() => { if (menuIndex !== tabs.length - 1) setHoveredMenuItem('right'); }}
            onMouseLeave={() => setHoveredMenuItem(null)}
            onClick={() => runMenuAction(() => onCloseRight(menu.tabId))}
          >
            Close tabs to the right
          </button>
          <button
            role="menuitem"
            style={menuItemStyle('all')}
            onMouseEnter={() => setHoveredMenuItem('all')}
            onMouseLeave={() => setHoveredMenuItem(null)}
            onClick={() => runMenuAction(onCloseAll)}
          >
            Close all tabs
          </button>
        </div>
      )}
    </div>
  );
});

const styles: Record<string, React.CSSProperties> = {
  panel: {
    flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden',
  },
  // ── Tab strip ──
  // Horizontal, independently scrollable so a long row of tabs clips/scrolls
  // without resizing the preview body below. Only rendered with 2+ tabs so a
  // single open preview looks identical to the pre-tab layout.
  tabBar: {
    display: 'flex', alignItems: 'stretch', flexShrink: 0,
    overflowX: 'auto', overflowY: 'hidden',
    borderBottom: `1px solid ${c.border}`, background: c.bgSubtle,
  },
  tab: {
    display: 'flex', alignItems: 'center', gap: 6,
    padding: '6px 8px 6px 12px', cursor: 'pointer',
    maxWidth: 220, minWidth: 0, flexShrink: 0,
    borderRight: `1px solid ${c.border}`,
    color: c.textSecondary,
    transition: 'background 0.12s, color 0.12s',
    userSelect: 'none',
  },
  tabActive: {
    background: c.bg,
    color: c.text,
    // Thin accent underline marks the active tab without the visual weight of
    // a filled chip.
    boxShadow: `inset 0 2px 0 ${c.accent}`,
  },
  tabTitle: {
    fontSize: 12, fontFamily: font.sans,
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  tabClose: {
    flexShrink: 0, background: 'none', border: 'none',
    color: c.textMuted, fontSize: 16, lineHeight: 1, cursor: 'pointer',
    padding: '0 2px', borderRadius: radius.sm,
  },
  // ── Active tab header ──
  header: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12,
    padding: '8px 16px', borderBottom: `1px solid ${c.border}`, background: c.bgSubtle,
    flexShrink: 0,
  },
  path: {
    color: c.textMuted, fontSize: 12, fontFamily: font.mono,
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    flex: 1, minWidth: 0,
  },
  actions: { display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 },
  downloadLink: {
    color: c.textSecondary, fontSize: 12, textDecoration: 'none',
    padding: '4px 10px', borderRadius: radius.sm,
    border: `1px solid ${c.border}`, background: 'transparent',
    transition: 'all 0.15s',
  },
  closeBtn: {
    background: 'none', border: 'none', color: c.textMuted, fontSize: 18,
    cursor: 'pointer', padding: '0 4px', borderRadius: radius.sm,
  },
  body: {
    flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden',
  },
  contextMenu: {
    position: 'fixed', zIndex: 1000, width: 190,
    padding: 4, border: `1px solid ${c.border}`, borderRadius: radius.md,
    background: c.surface, boxShadow: shadow.lg,
  },
  menuItem: {
    display: 'block', width: '100%', padding: '7px 10px',
    border: 'none', borderRadius: radius.sm, background: 'transparent',
    color: c.text, fontSize: 12, fontFamily: font.sans,
    textAlign: 'left', cursor: 'pointer', whiteSpace: 'nowrap',
  },
  menuItemDisabled: { color: c.textMuted, cursor: 'default' },
  menuItemHover: { background: c.accentBg, color: c.accentHover },
  menuDivider: { height: 1, margin: '3px 6px', background: c.border },
};
