/**
 * Desktop neo sidebar: chrome nav + classic PinnedFolders.
 * Collapsed rail is a simple width toggle (no classic spacer animation).
 */

import { useCallback, useMemo, useState, type CSSProperties } from 'react';
import { patchRoot } from '@classic/api/client';
import { PinnedFolders } from '@classic/components/PinnedFolders';
import { useHealth } from '@classic/state/health';
import { emitNeoRevealInBrowser } from '../events/openFile';
import { useNeoAgent } from '../preview/agentContext';
import { c, font } from '../theme';

export type NeoSidebarChrome =
  | 'search'
  | 'collections'
  | 'transfer'
  | 'terminal'
  | 'settings'
  | 'stats'
  | 'audit';

const NAV: { id: NeoSidebarChrome; label: string }[] = [
  { id: 'search', label: 'Search' },
  { id: 'collections', label: 'Collections' },
  { id: 'transfer', label: 'Transfer' },
  { id: 'terminal', label: 'Terminal' },
  { id: 'settings', label: 'Settings' },
  { id: 'stats', label: 'Stats' },
  { id: 'audit', label: 'Audit' },
];

const W_EXPANDED = 180;
const W_COLLAPSED = 48;

interface Props {
  searchOpen: boolean;
  onChrome: (id: NeoSidebarChrome) => void;
  onOpenAbout: () => void;
  hubVersion?: string | null;
}

export function NeoSidebar({ searchOpen, onChrome, onOpenAbout, hubVersion }: Props) {
  const { agent } = useNeoAgent();
  const { refresh } = useHealth(true);
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem('filebox.neo.sidebarCollapsed') === '1';
    } catch {
      return false;
    }
  });

  const toggleCollapsed = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem('filebox.neo.sidebarCollapsed', next ? '1' : '0');
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  const pinnedCount = useMemo(() => {
    if (!agent) return 0;
    return agent.roots.reduce(
      (n, r) => (r.enabled ? n + r.pinned_folders.length : n),
      0,
    );
  }, [agent]);

  const handleUnpin = useCallback(
    async (root: string, path: string): Promise<boolean> => {
      if (!agent) return false;
      try {
        await patchRoot(agent.id, root, { pin_remove: path });
        refresh();
        return true;
      } catch {
        return false;
      }
    },
    [agent, refresh],
  );

  const width = collapsed ? W_COLLAPSED : W_EXPANDED;

  return (
    <aside
      style={{
        ...asideStyle,
        width,
        minWidth: width,
      }}
    >
      <div style={topRow}>
        {!collapsed && <span style={brand}>Navigate</span>}
        <button
          type="button"
          style={iconBtn}
          onClick={toggleCollapsed}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {collapsed ? '»' : '«'}
        </button>
      </div>

      <nav style={navStyle}>
        {NAV.map(({ id, label }) => {
          const needsAgent = id !== 'audit' && id !== 'search';
          const disabled = needsAgent && !agent;
          // Search can open without agent? Classic requires agent for SearchFloatWindow.
          const searchDisabled = id === 'search' && !agent;
          const isDisabled = disabled || searchDisabled;
          const active = id === 'search' && searchOpen;
          return (
            <button
              key={id}
              type="button"
              disabled={isDisabled}
              style={{
                ...navBtn,
                ...(collapsed ? navBtnCollapsed : null),
                ...(active ? navBtnActive : null),
                ...(isDisabled ? { opacity: 0.45, cursor: 'not-allowed' } : null),
              }}
              title={label}
              onClick={() => onChrome(id)}
            >
              {collapsed ? label.slice(0, 1) : label}
            </button>
          );
        })}
      </nav>

      {agent && pinnedCount > 0 ? (
        <div style={pinsWrap}>
          {!collapsed && <div style={sectionHeader}>Pinned</div>}
          <PinnedFolders
            agent={agent}
            collapsed={collapsed}
            onNavigate={(root, path) => {
              emitNeoRevealInBrowser({ root, dirPath: path });
            }}
            onUnpin={handleUnpin}
          />
        </div>
      ) : null}

      <div style={{ flex: 1 }} />

      <div style={footer}>
        {hubVersion && !collapsed ? (
          <button type="button" style={aboutBtn} onClick={onOpenAbout} title="About filebox">
            v{hubVersion}
          </button>
        ) : hubVersion && collapsed ? (
          <button type="button" style={iconBtn} onClick={onOpenAbout} title={`v${hubVersion}`}>
            i
          </button>
        ) : null}
      </div>
    </aside>
  );
}

const asideStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  borderRight: `1px solid ${c.border}`,
  background: c.bgSubtle,
  fontFamily: font.sans,
  fontSize: 12,
  flexShrink: 0,
  height: '100%',
  overflow: 'hidden',
  transition: 'width 120ms ease',
};

const topRow: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '8px 8px 4px',
  gap: 4,
};

const brand: CSSProperties = {
  fontWeight: 600,
  color: c.textSecondary,
  fontSize: 11,
  textTransform: 'uppercase',
  letterSpacing: 0.4,
};

const navStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  padding: '4px 6px',
};

const navBtn: CSSProperties = {
  textAlign: 'left',
  fontFamily: font.sans,
  fontSize: 12,
  padding: '6px 8px',
  borderRadius: 6,
  border: 'none',
  background: 'transparent',
  color: c.text,
  cursor: 'pointer',
};

const navBtnCollapsed: CSSProperties = {
  textAlign: 'center',
  padding: '8px 0',
  fontWeight: 600,
};

const navBtnActive: CSSProperties = {
  background: c.accentBg,
  color: c.accent,
};

const pinsWrap: CSSProperties = {
  padding: '8px 6px',
  borderTop: `1px solid ${c.border}`,
  overflow: 'auto',
  minHeight: 0,
};

const sectionHeader: CSSProperties = {
  fontSize: 10,
  fontWeight: 600,
  color: c.textMuted,
  textTransform: 'uppercase',
  letterSpacing: 0.4,
  margin: '0 4px 6px',
};

const footer: CSSProperties = {
  padding: 8,
  borderTop: `1px solid ${c.border}`,
};

const aboutBtn: CSSProperties = {
  ...navBtn,
  color: c.textMuted,
  fontFamily: font.mono,
  fontSize: 11,
};

const iconBtn: CSSProperties = {
  fontFamily: font.sans,
  fontSize: 12,
  padding: '2px 6px',
  borderRadius: 4,
  border: `1px solid ${c.border}`,
  background: c.surface,
  color: c.textSecondary,
  cursor: 'pointer',
};
