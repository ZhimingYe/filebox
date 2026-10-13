/**
 * Desktop neo sidebar: agent picker + chrome nav + classic PinnedFolders.
 * Collapsed = VS Code–style icon activity bar; expanded = icon + label rows.
 */

import {
  useCallback,
  useMemo,
  useState,
  type CSSProperties,
  type FunctionComponent,
  type MouseEvent,
} from 'react';
import { patchRoot } from '@lib/api/client';
import { BackendList } from '@lib/components/BackendList';
import { PinnedFolders } from '@lib/components/PinnedFolders';
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
} from '@lib/components/icons';
import { useHealth } from '@lib/state/health';
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

type NavId = NeoSidebarChrome | 'preview';

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

  const applyNavHover = (el: HTMLButtonElement, enter: boolean) => {
    if (enter) {
      el.style.background = c.bgMuted;
      el.style.color = c.text;
    } else {
      el.style.background = 'transparent';
      el.style.color = c.textSecondary;
    }
  };

  const navItemStyle = (disabled: boolean): CSSProperties => ({
    ...(collapsed ? navBtnCollapsed : navBtnExpanded),
    background: 'transparent',
    color: c.textSecondary,
    ...(disabled ? { opacity: 0.4, cursor: 'not-allowed' } : null),
  });

  const renderNavButton = (
    id: NavId,
    label: string,
    Icon: FunctionComponent<SvgProps>,
    onClick: () => void,
    disabled = false,
  ) => {
    const iconSize = collapsed ? 18 : 16;
    return (
      <button
        key={id}
        type="button"
        disabled={disabled}
        style={navItemStyle(disabled)}
        title={label}
        aria-label={label}
        onClick={() => {
          if (disabled) return;
          onClick();
        }}
        onMouseEnter={(e: MouseEvent<HTMLButtonElement>) => {
          if (!disabled) applyNavHover(e.currentTarget, true);
        }}
        onMouseLeave={(e: MouseEvent<HTMLButtonElement>) => {
          if (!disabled) applyNavHover(e.currentTarget, false);
        }}
      >
        <Icon style={{ width: iconSize, height: iconSize, flexShrink: 0 }} />
        {!collapsed ? <span style={navLabel}>{label}</span> : null}
      </button>
    );
  };

  return (
    <aside
      style={{
        ...asideStyle,
        width,
        minWidth: width,
      }}
    >
      <div style={collapsed ? topRowCollapsed : topRowExpanded}>
        {!collapsed && <span style={brand}>Navigate</span>}
        <button
          type="button"
          style={collapseBtn}
          onClick={toggleCollapsed}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = c.bgMuted;
            e.currentTarget.style.color = c.text;
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'transparent';
            e.currentTarget.style.color = c.textMuted;
          }}
        >
          {collapsed ? (
            <IconChevronRight style={{ width: 16, height: 16 }} />
          ) : (
            <IconChevronLeft style={{ width: 16, height: 16 }} />
          )}
        </button>
      </div>

      <div style={collapsed ? agentsWrapCollapsed : agentsWrapExpanded}>
        {!collapsed && <div style={sectionHeader}>Agents</div>}
        <BackendList
          agents={agents}
          selectedId={agentId}
          onSelect={(id) => emitNeoSelectAgent(id)}
          collapsed={collapsed}
          compact
        />
      </div>

      <nav style={collapsed ? navStyleCollapsed : navStyleExpanded}>
        {renderNavButton('preview', 'Preview', IconPreview, onNewPreview)}
        {NAV.map(({ id, label, Icon }) => {
          const needsAgent = id !== 'audit';
          const disabled = needsAgent && !agent;
          return renderNavButton(id, label, Icon, () => onChrome(id), disabled);
        })}
      </nav>

      {agent && pinnedCount > 0 ? (
        <div style={collapsed ? pinsWrapCollapsed : pinsWrapExpanded}>
          {!collapsed && <div style={sectionHeader}>Pinned</div>}
          <PinnedFolders
            agent={agent}
            collapsed={collapsed}
            onNavigate={(root, path) => {
              emitNeoRevealInBrowser({ root, dirPath: path, agentId: agent.id });
            }}
            onUnpin={handleUnpin}
          />
        </div>
      ) : null}

      <div style={{ flex: 1 }} />

      <div style={collapsed ? footerCollapsed : footerExpanded}>
        {hubVersion ? (
          <button
            type="button"
            style={collapsed ? aboutBtnCollapsed : aboutBtnExpanded}
            onClick={onOpenAbout}
            title={`About filebox (v${hubVersion})`}
            aria-label={`About filebox (v${hubVersion})`}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = c.bgMuted;
              e.currentTarget.style.color = c.text;
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent';
              e.currentTarget.style.color = c.textMuted;
            }}
          >
            <IconBrandMark style={{ width: collapsed ? 18 : 14, height: collapsed ? 18 : 14, flexShrink: 0 }} />
            {!collapsed ? <span style={{ fontFamily: font.mono, fontSize: 11 }}>v{hubVersion}</span> : null}
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

const topRowExpanded: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '8px 8px 6px',
  gap: 4,
  minHeight: 36,
};

const topRowCollapsed: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '8px 0 6px',
  minHeight: 36,
};

const brand: CSSProperties = {
  fontWeight: 600,
  color: c.textMuted,
  fontSize: 10,
  textTransform: 'uppercase',
  letterSpacing: 0.5,
  paddingLeft: 4,
};

const collapseBtn: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 28,
  height: 28,
  padding: 0,
  borderRadius: 6,
  border: 'none',
  background: 'transparent',
  color: c.textMuted,
  cursor: 'pointer',
  flexShrink: 0,
  transition: 'background-color 120ms ease, color 120ms ease',
};

const agentsWrapExpanded: CSSProperties = {
  padding: '4px 6px 8px',
  borderBottom: `1px solid ${c.border}`,
  maxHeight: 160,
  overflow: 'auto',
  minHeight: 0,
};

const agentsWrapCollapsed: CSSProperties = {
  padding: '4px 0 8px',
  borderBottom: `1px solid ${c.border}`,
  maxHeight: 160,
  overflow: 'auto',
  minHeight: 0,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
};

const navStyleExpanded: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 1,
  padding: '6px 6px',
};

const navStyleCollapsed: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 0,
  padding: '4px 0',
};

const navBtnExpanded: CSSProperties = {
  position: 'relative',
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  width: '100%',
  textAlign: 'left',
  fontFamily: font.sans,
  fontSize: 12,
  fontWeight: 500,
  padding: '6px 8px 6px 10px',
  borderRadius: 6,
  border: 'none',
  cursor: 'pointer',
  transition: 'background-color 120ms ease, color 120ms ease',
  boxSizing: 'border-box',
  minHeight: 30,
};

const navBtnCollapsed: CSSProperties = {
  position: 'relative',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: '100%',
  height: 40,
  padding: 0,
  borderRadius: 0,
  border: 'none',
  cursor: 'pointer',
  transition: 'background-color 120ms ease, color 120ms ease',
  flexShrink: 0,
};

const navLabel: CSSProperties = {
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  lineHeight: 1.2,
};


const pinsWrapExpanded: CSSProperties = {
  padding: '8px 6px',
  borderTop: `1px solid ${c.border}`,
  overflow: 'auto',
  minHeight: 0,
};

const pinsWrapCollapsed: CSSProperties = {
  padding: '8px 0',
  borderTop: `1px solid ${c.border}`,
  overflow: 'auto',
  minHeight: 0,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
};

const sectionHeader: CSSProperties = {
  fontSize: 10,
  fontWeight: 600,
  color: c.textMuted,
  textTransform: 'uppercase',
  letterSpacing: 0.5,
  margin: '0 4px 6px',
  opacity: 0.85,
};

const footerExpanded: CSSProperties = {
  padding: '6px 6px 8px',
  borderTop: `1px solid ${c.border}`,
};

const footerCollapsed: CSSProperties = {
  padding: '4px 0 6px',
  borderTop: `1px solid ${c.border}`,
};

const aboutBtnExpanded: CSSProperties = {
  position: 'relative',
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  width: '100%',
  textAlign: 'left',
  fontFamily: font.sans,
  fontSize: 12,
  padding: '6px 8px 6px 10px',
  borderRadius: 6,
  border: 'none',
  background: 'transparent',
  color: c.textMuted,
  cursor: 'pointer',
  transition: 'background-color 120ms ease, color 120ms ease',
  boxSizing: 'border-box',
};

const aboutBtnCollapsed: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: '100%',
  height: 40,
  padding: 0,
  borderRadius: 0,
  border: 'none',
  background: 'transparent',
  color: c.textMuted,
  cursor: 'pointer',
  transition: 'background-color 120ms ease, color 120ms ease',
};
