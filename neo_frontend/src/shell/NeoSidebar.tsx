/**
 * Desktop neo sidebar: agent picker + chrome nav + classic PinnedFolders.
 */

import { useCallback, useMemo, useState, type CSSProperties, type FunctionComponent } from 'react';
import { patchRoot } from '@classic/api/client';
import { BackendList } from '@classic/components/BackendList';
import { PinnedFolders } from '@classic/components/PinnedFolders';
import {
  IconAudit,
  IconBrandMark,
  IconChevronLeft,
  IconChevronRight,
  IconCollection,
  IconExplorer,
  IconPreview,
  IconSearch,
  IconSettings,
  IconStats,
  IconTerminal,
  IconUpload,
} from '@classic/components/icons';
import { useHealth } from '@classic/state/health';
import { emitNeoRevealInBrowser, emitNeoSelectAgent } from '../events/openFile';
import { useNeoAgent } from '../preview/agentContext';
import { c, font } from '../theme';

export type NeoSidebarChrome =
  | 'search'
  | 'explorer'
  | 'collections'
  | 'transfer'
  | 'terminal'
  | 'settings'
  | 'stats'
  | 'audit';

type SvgProps = { style?: CSSProperties };

const NAV: {
  id: NeoSidebarChrome;
  label: string;
  Icon: FunctionComponent<SvgProps>;
}[] = [
  { id: 'search', label: 'Search', Icon: IconSearch },
  { id: 'explorer', label: 'Explorer', Icon: IconExplorer },
  { id: 'collections', label: 'Collections', Icon: IconCollection },
  { id: 'transfer', label: 'Transfer', Icon: IconUpload },
  { id: 'terminal', label: 'Terminal', Icon: IconTerminal },
  { id: 'settings', label: 'Settings', Icon: IconSettings },
  { id: 'stats', label: 'Stats', Icon: IconStats },
  { id: 'audit', label: 'Audit', Icon: IconAudit },
];

const W_EXPANDED = 200;
const W_COLLAPSED = 48;

interface Props {
  onChrome: (id: NeoSidebarChrome) => void;
  onNewPreview: () => void;
  onOpenAbout: () => void;
  hubVersion?: string | null;
}

export function NeoSidebar({ onChrome, onNewPreview, onOpenAbout, hubVersion }: Props) {
  const { agent, agentId } = useNeoAgent();
  const { agents, refresh } = useHealth(true);
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
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {collapsed ? (
            <IconChevronRight style={{ width: 14, height: 14 }} />
          ) : (
            <IconChevronLeft style={{ width: 14, height: 14 }} />
          )}
        </button>
      </div>

      <div style={agentsWrap}>
        {!collapsed && <div style={sectionHeader}>Agents</div>}
        <BackendList
          agents={agents}
          selectedId={agentId}
          onSelect={(id) => emitNeoSelectAgent(id)}
          collapsed={collapsed}
          compact
        />
      </div>

      <nav style={navStyle}>
        <button
          type="button"
          style={{
            ...navBtn,
            ...(collapsed ? navBtnCollapsed : null),
          }}
          title="Preview"
          aria-label="Preview"
          onClick={onNewPreview}
        >
          {collapsed ? (
            <IconPreview style={{ width: 16, height: 16, margin: '0 auto' }} />
          ) : (
            <>
              <IconPreview style={{ width: 14, height: 14, flexShrink: 0 }} />
              <span>Preview</span>
            </>
          )}
        </button>
        {NAV.map(({ id, label, Icon }) => {
          const needsAgent = id !== 'audit';
          const disabled = needsAgent && !agent;
          return (
            <button
              key={id}
              type="button"
              disabled={disabled}
              style={{
                ...navBtn,
                ...(collapsed ? navBtnCollapsed : null),
                ...(disabled ? { opacity: 0.45, cursor: 'not-allowed' } : null),
              }}
              title={label}
              aria-label={label}
              onClick={() => onChrome(id)}
            >
              {collapsed ? (
                <Icon style={{ width: 16, height: 16, margin: '0 auto' }} />
              ) : (
                <>
                  <Icon style={{ width: 14, height: 14, flexShrink: 0 }} />
                  <span>{label}</span>
                </>
              )}
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
          <button
            type="button"
            style={iconBtn}
            onClick={onOpenAbout}
            title={`About filebox (v${hubVersion})`}
            aria-label={`About filebox (v${hubVersion})`}
          >
            <IconBrandMark style={{ width: 14, height: 14 }} />
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

const agentsWrap: CSSProperties = {
  padding: '4px 6px 8px',
  borderBottom: `1px solid ${c.border}`,
  maxHeight: 160,
  overflow: 'auto',
  minHeight: 0,
};

const navStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  padding: '4px 6px',
};

const navBtn: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
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
  justifyContent: 'center',
  textAlign: 'center',
  padding: '8px 0',
  gap: 0,
  fontWeight: 600,
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
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontFamily: font.sans,
  fontSize: 12,
  padding: '4px 6px',
  borderRadius: 4,
  border: `1px solid ${c.border}`,
  background: c.surface,
  color: c.textSecondary,
  cursor: 'pointer',
};
