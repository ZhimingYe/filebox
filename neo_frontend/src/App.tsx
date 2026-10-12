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
import { CollectionPicker } from '@classic/components/CollectionPicker';
import { Login } from '@classic/components/Login';
import { SearchFloatWindow } from '@classic/components/SearchFloatWindow';
import { useHealth } from '@classic/state/health';
import { useSession } from '@classic/state/session';
import { fetchHubHealth, type HubHealth } from './api/health';
import {
  emitNeoOpenFile,
  emitNeoRevealInBrowser,
  onNeoAgentSelected,
  onNeoCollectionPicker,
  onNeoOpenFile,
  type NeoCollectionPickerDetail,
} from './events/openFile';
import {
  AuditPanel,
  CollectionsPanel,
  ExplorerPanel,
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
import { ChromeToasts } from './shell/ChromeToasts';
import {
  bindDockLayoutPersistence,
  tryRestoreDockLayout,
} from './shell/layoutPersistence';
import { NeoSidebar, type NeoSidebarChrome } from './shell/NeoSidebar';
import { ensureChromePanel } from './shell/openChromePanel';
import {
  bumpTempRefreshNonce,
  setUploadRequest,
} from './shell/uploadHandoff';
import { c, font } from './theme';

const components: Record<string, FunctionComponent<IDockviewPanelProps>> = {
  fileTree: FilesPanel,
  preview: PreviewPanel,
  explorer: ExplorerPanel,
  collections: CollectionsPanel,
  transfer: TransferPanel,
  terminal: TerminalPanel,
  settings: SettingsPanel,
  stats: StatsPanel,
  audit: AuditPanel,
};

type ChromeKind = 'explorer' | 'collections' | 'transfer' | 'terminal' | 'settings' | 'stats' | 'audit';

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
  const [collectionPicker, setCollectionPicker] = useState<NeoCollectionPickerDetail | null>(null);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [dragOverWindow, setDragOverWindow] = useState(false);
  const dragDepthRef = useRef(0);

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

    const restored = tryRestoreDockLayout(event.api);
    if (restored) {
      const preview = event.api.panels.find((p) => p.api.component === PREVIEW_COMPONENT);
      if (preview) rememberFocusedPreview(preview.id);
      return;
    }

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
    const focusSub = api.onDidActivePanelChange((ev) => {
      if (ev.panel?.api.component === PREVIEW_COMPONENT) {
        rememberFocusedPreview(ev.panel.id);
      }
    });
    const persistDispose = bindDockLayoutPersistence(api);
    return () => {
      focusSub.dispose();
      persistDispose();
    };
  }, [loggedIn, dockReady]);

  const openChromePanel = useCallback((kind: ChromeKind, title: string) => {
    const api = dockApiRef.current;
    if (!api) return;
    ensureChromePanel(api, {
      id: `chrome-${kind}`,
      component: kind,
      title,
      direction: 'below',
    });
  }, []);

  useEffect(() => onNeoCollectionPicker((detail) => {
    setCollectionPicker(detail);
  }), []);

  const onSidebarChrome = useCallback((id: NeoSidebarChrome) => {
    if (id === 'search') {
      setSearchOpen((o) => !o);
      return;
    }
    openChromePanel(id, id[0]!.toUpperCase() + id.slice(1));
  }, [openChromePanel]);

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

  // App-wide drag & drop → Transfer (classic uploadRequest handoff).
  const tempCapable = !!selectedAgent?.capabilities?.temp_upload && !!selectedAgent?.temp_root_name;
  useEffect(() => {
    if (!tempCapable) return;
    const hasFiles = (e: DragEvent) =>
      Array.from(e.dataTransfer?.types ?? []).includes('Files');
    const onDragEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepthRef.current += 1;
      setDragOverWindow(true);
    };
    const onDragOver = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };
    const onDragLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
      if (dragDepthRef.current === 0) setDragOverWindow(false);
    };
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepthRef.current = 0;
      setDragOverWindow(false);
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length === 0) return;
      setUploadRequest({ files, nonce: Date.now() });
      openChromePanel('transfer', 'Transfer');
    };
    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [tempCapable, openChromePanel]);

  const isLikelyDev = useMemo(() => {
    if (typeof window === 'undefined') return false;
    const { hostname, protocol } = window.location;
    const isLoopback = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
    return protocol !== 'https:' && isLoopback;
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
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
          <StatusChip health={hubChip} />
          <button type="button" style={headerBtnStyle} onClick={() => void refresh()} title="Refresh agents/health">
            Refresh
          </button>
          <button type="button" style={headerBtnStyle} onClick={() => void logout()}>
            Log out
          </button>
        </div>
      </header>

      <div style={{ flex: 1, minHeight: 0, display: 'flex', position: 'relative' }}>
        <NeoSidebar
          searchOpen={searchOpen}
          onChrome={onSidebarChrome}
          onOpenAbout={() => setAboutOpen(true)}
          hubVersion={health?.hub.version}
        />
        <div style={{ flex: 1, minWidth: 0, minHeight: 0 }}>
          <DockviewReact
            components={components}
            theme={themeLight}
            popoutUrl={`${import.meta.env.BASE_URL}popout.html`}
            onReady={onReady}
          />
        </div>
      </div>

      {selectedAgent ? (
        <SearchFloatWindow
          open={searchOpen}
          agent={selectedAgent}
          onOpenFile={(root, path) => {
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

      <ChromeToasts
        hubVersion={health?.hub.version}
        selectedAgentId={agentId}
        onHealthRefresh={refresh}
        onTempUpdated={bumpTempRefreshNonce}
      />

      {collectionPicker && selectedAgent ? (
        <CollectionPicker
          agent={selectedAgent}
          target={{ root: collectionPicker.root, path: collectionPicker.path }}
          anchorEl={collectionPicker.anchor}
          onClose={() => setCollectionPicker(null)}
          onChanged={() => { void refresh(); }}
        />
      ) : null}

      {dragOverWindow ? (
        <div style={dropOverlay} aria-hidden>
          <div style={dropCard}>
            <span style={{ color: c.accent, fontSize: 17, fontWeight: 600 }}>Drop files to upload</span>
            <span style={{ color: c.textSecondary, fontSize: 13 }}>
              Opens Transfer and uploads into this agent&apos;s temp folder
            </span>
          </div>
        </div>
      ) : null}
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

const dropOverlay: CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 60,
  background: 'rgba(15, 23, 42, 0.35)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  pointerEvents: 'none',
};

const dropCard: CSSProperties = {
  background: c.surface,
  border: `2px dashed ${c.accent}`,
  borderRadius: 12,
  padding: '28px 36px',
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  alignItems: 'center',
  fontFamily: font.sans,
};
