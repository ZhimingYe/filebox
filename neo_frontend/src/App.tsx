import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FunctionComponent,
} from 'react';
import {
  DockviewReact,
  themeLight,
  type DockviewApi,
  type DockviewReadyEvent,
  type IDockviewPanelProps,
} from 'dockview-react';
import 'dockview-react/dist/styles/dockview.css';
import { ensureCookieSuffix, getCsrfToken, type FsEntry } from '@classic/api/client';
import { AboutDialog } from '@classic/components/AboutDialog';
import { Login } from '@classic/components/Login';
import { SearchFloatWindow } from '@classic/components/SearchFloatWindow';
import { useHealth } from '@classic/state/health';
import { useSession } from '@classic/state/session';
import { fetchHubHealth, type HubHealth } from './api/health';
import {
  emitNeoOpenFile,
  emitNeoRevealInBrowser,
  onNeoAgentSelected,
  onNeoOpenFile,
} from './events/openFile';
import {
  AuditPanel,
  CollectionsPanel,
  SettingsPanel,
  StatsPanel,
  TerminalPanel,
  TransferPanel,
} from './panels/chrome';
import { FilesPanel } from './panels/FilesPanel';
import { PreviewPanel } from './panels/PreviewPanel';
import { setPreviewAgentContext, useNeoAgent } from './preview/agentContext';
import {
  addEmptyPreviewPanel,
  closePreviewsForOtherAgents,
  findPreviewPanels,
  openFileInDock,
  popoutPreviewPanel,
  rememberFocusedPreview,
} from './preview/openInDock';
import { PREVIEW_COMPONENT } from './preview/types';
import { ensureChromePanel } from './shell/openChromePanel';
import { c, font } from './theme';

const components: Record<string, FunctionComponent<IDockviewPanelProps>> = {
  fileTree: FilesPanel,
  preview: PreviewPanel,
  collections: CollectionsPanel,
  transfer: TransferPanel,
  terminal: TerminalPanel,
  settings: SettingsPanel,
  stats: StatsPanel,
  audit: AuditPanel,
};

type ChromeKind = 'collections' | 'transfer' | 'terminal' | 'settings' | 'stats' | 'audit';

const CHROME: { kind: ChromeKind; title: string; direction?: 'below' | 'right' }[] = [
  { kind: 'collections', title: 'Collections', direction: 'below' },
  { kind: 'transfer', title: 'Transfer', direction: 'below' },
  { kind: 'terminal', title: 'Terminal', direction: 'below' },
  { kind: 'settings', title: 'Settings', direction: 'below' },
  { kind: 'stats', title: 'Stats', direction: 'below' },
  { kind: 'audit', title: 'Audit', direction: 'below' },
];

function StatusChip({ health }: { health: HubHealth | null }) {
  if (!health) {
    return <span style={chipStyle(c.textMuted)}>hub: …</span>;
  }
  if (health.ok) {
    const csrf = health.hasCsrf ? ' · csrf ok' : '';
    const suffix = health.cookieSuffix ? ` · ${health.cookieSuffix}` : '';
    return <span style={chipStyle(c.accent)}>hub ok{suffix}{csrf}</span>;
  }
  return (
    <span style={chipStyle('#ef4444')}>
      hub unreachable{health.error ? `: ${health.error}` : ''}
    </span>
  );
}

function chipStyle(color: string): CSSProperties {
  return {
    fontFamily: font.mono,
    fontSize: 11,
    color,
    background: c.bgMuted,
    border: `1px solid ${c.border}`,
    borderRadius: 9999,
    padding: '2px 8px',
    whiteSpace: 'nowrap',
  };
}

export default function App() {
  const { loggedIn, login, logout } = useSession();
  const [hubChip, setHubChip] = useState<HubHealth | null>(null);
  const dockApiRef = useRef<DockviewApi | null>(null);
  const [dockReady, setDockReady] = useState(0);
  const [searchOpen, setSearchOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);

  const { health, agents, error: healthError, refresh } = useHealth(loggedIn === true);
  const { agent: selectedAgent, agentId } = useNeoAgent();

  useEffect(() => {
    const ac = new AbortController();
    void (async () => {
      await ensureCookieSuffix(ac.signal);
      const h = await fetchHubHealth(ac.signal);
      if (!ac.signal.aborted) {
        setHubChip({ ...h, hasCsrf: !!getCsrfToken() });
      }
    })();
    return () => ac.abort();
  }, [loggedIn]);

  // Keep agent context fresh when health refresh updates the same agent id.
  useEffect(() => {
    if (!agentId) return;
    const live = agents.find((a) => a.id === agentId);
    if (live) {
      setPreviewAgentContext({
        agentId: live.id,
        agent: live,
        roots: live.roots,
        officeCapable: !!live.capabilities?.office_pdf_preview,
      });
    }
  }, [agents, agentId]);

  useEffect(() => {
    return onNeoOpenFile((detail) => {
      if (detail.roots || detail.officeCapable !== undefined) {
        setPreviewAgentContext({
          agentId: detail.agentId,
          roots: detail.roots,
          officeCapable: detail.officeCapable,
        });
      }
      const api = dockApiRef.current;
      if (!api) return;
      openFileInDock(api, detail);
    });
  }, []);

  useEffect(() => {
    return onNeoAgentSelected((detail) => {
      setPreviewAgentContext({
        agentId: detail.agentId,
        agent: detail.agent ?? null,
        roots: detail.roots,
        officeCapable: detail.officeCapable,
      });
      const api = dockApiRef.current;
      if (!api) return;
      if (!detail.agentId) {
        for (const p of findPreviewPanels(api)) p.api.close();
        rememberFocusedPreview(null);
        return;
      }
      closePreviewsForOtherAgents(api, detail.agentId);
    });
  }, []);

  const onReady = useCallback((event: DockviewReadyEvent) => {
    dockApiRef.current = event.api;
    setDockReady((n) => n + 1);
    if (event.api.panels.length > 0) return;
    event.api.addPanel({
      id: 'file-tree',
      component: 'fileTree',
      title: 'Files',
      initialWidth: 420,
    });
    event.api.addPanel({
      id: 'preview',
      component: 'preview',
      title: 'Preview',
      position: { referencePanel: 'file-tree', direction: 'right' },
    });
    rememberFocusedPreview('preview');
  }, []);

  useEffect(() => {
    if (!loggedIn || dockReady === 0) return;
    const api = dockApiRef.current;
    if (!api) return;
    const sub = api.onDidActivePanelChange((ev) => {
      if (ev.panel?.api.component === PREVIEW_COMPONENT) {
        rememberFocusedPreview(ev.panel.id);
      }
    });
    return () => sub.dispose();
  }, [loggedIn, dockReady]);

  const openChrome = useCallback((kind: ChromeKind, title: string, direction?: 'below' | 'right') => {
    const api = dockApiRef.current;
    if (!api) return;
    ensureChromePanel(api, {
      id: `chrome-${kind}`,
      component: kind,
      title,
      direction,
    });
  }, []);

  const onPreviewFromSearch = useCallback((root: string, path: string) => {
    if (!selectedAgent) return;
    const name = path.split('/').filter(Boolean).pop() ?? path;
    const entry: FsEntry = {
      name,
      entry_type: 'file',
      size: null,
      modified: null,
      denied: false,
    };
    emitNeoOpenFile({
      agentId: selectedAgent.id,
      root,
      path,
      entry,
      roots: selectedAgent.roots,
      officeCapable: !!selectedAgent.capabilities?.office_pdf_preview,
      refresh: true,
    });
  }, [selectedAgent]);

  const isLikelyDev = useMemo(() => {
    if (typeof window === 'undefined') return false;
    const { hostname, port } = window.location;
    return hostname === 'localhost' || hostname === '127.0.0.1' || port === '5174';
  }, []);

  if (loggedIn === null) {
    return (
      <div style={bootStyle}>
        <span style={{ color: c.textMuted, fontFamily: font.sans, fontSize: 13 }}>
          Checking session…
        </span>
      </div>
    );
  }

  if (!loggedIn) {
    return <Login onLogin={login} />;
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: '100%',
        height: '100%',
        background: c.bg,
        color: c.text,
        fontFamily: font.sans,
      }}
    >
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          height: 40,
          padding: '0 12px',
          borderBottom: `1px solid ${c.border}`,
          background: c.surface,
          flexShrink: 0,
        }}
      >
        <strong style={{ fontSize: 13, letterSpacing: 0.2 }}>filebox neo</strong>
        <span style={{ color: c.textMuted, fontSize: 12, marginRight: 4 }}>
          {selectedAgent ? (selectedAgent.name || selectedAgent.id) : 'no agent'}
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
          <button
            type="button"
            style={headerBtnStyle}
            disabled={!selectedAgent}
            onClick={() => setSearchOpen((o) => !o)}
            title="Workspace search (classic floating window)"
          >
            Search
          </button>
          {CHROME.map(({ kind, title, direction }) => (
            <button
              key={kind}
              type="button"
              style={headerBtnStyle}
              disabled={kind !== 'audit' && !selectedAgent}
              onClick={() => openChrome(kind, title, direction)}
              title={`Open ${title} dock panel`}
            >
              {title}
            </button>
          ))}
          <button
            type="button"
            style={headerBtnStyle}
            onClick={() => {
              const api = dockApiRef.current;
              if (api) addEmptyPreviewPanel(api);
            }}
            title="Add an empty preview dock panel"
          >
            New Preview
          </button>
          <button
            type="button"
            style={headerBtnStyle}
            onClick={() => {
              const api = dockApiRef.current;
              if (api) void popoutPreviewPanel(api);
            }}
            title="Pop out the focused preview panel"
          >
            Pop out
          </button>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
          <StatusChip health={hubChip} />
          {health?.hub.version ? (
            <button
              type="button"
              style={headerBtnStyle}
              onClick={() => setAboutOpen(true)}
              title="About filebox"
            >
              v{health.hub.version}
            </button>
          ) : null}
          <button type="button" style={headerBtnStyle} onClick={() => void refresh()} title="Refresh agents/health">
            Refresh
          </button>
          <button type="button" style={headerBtnStyle} onClick={() => void logout()}>
            Log out
          </button>
        </div>
      </header>
      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        <DockviewReact
          components={components}
          theme={themeLight}
          popoutUrl={`${import.meta.env.BASE_URL}popout.html`}
          onReady={onReady}
        />
      </div>

      {selectedAgent ? (
        <SearchFloatWindow
          open={searchOpen}
          agent={selectedAgent}
          onOpenFile={(root, path) => {
            // WorkspaceSearch already parentDir()'s for folder open.
            emitNeoRevealInBrowser({ root, dirPath: path });
          }}
          onPreviewFile={onPreviewFromSearch}
          onClose={() => setSearchOpen(false)}
        />
      ) : null}

      <AboutDialog
        open={aboutOpen}
        health={health}
        agents={agents}
        healthError={healthError}
        isLikelyDev={isLikelyDev}
        onClose={() => setAboutOpen(false)}
      />
    </div>
  );
}

const bootStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: '100%',
  height: '100%',
  background: c.bg,
};

const headerBtnStyle: CSSProperties = {
  fontFamily: font.sans,
  fontSize: 11,
  padding: '2px 8px',
  borderRadius: 6,
  border: `1px solid ${c.border}`,
  background: c.bgMuted,
  color: c.textSecondary,
  cursor: 'pointer',
};
