import {
  useCallback,
  useEffect,
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
import { ensureCookieSuffix, getCsrfToken } from '@classic/api/client';
import { Login } from '@classic/components/Login';
import { useSession } from '@classic/state/session';
import { fetchHubHealth, type HubHealth } from './api/health';
import { onNeoAgentSelected, onNeoOpenFile } from './events/openFile';
import { FilesPanel } from './panels/FilesPanel';
import { PreviewPanel } from './panels/PreviewPanel';
import {
  addEmptyPreviewPanel,
  closePreviewsForOtherAgents,
  findPreviewPanels,
  openFileInDock,
  popoutPreviewPanel,
  rememberFocusedPreview,
} from './preview/openInDock';
import { PREVIEW_COMPONENT } from './preview/types';
import { c, font } from './theme';

const components: Record<string, FunctionComponent<IDockviewPanelProps>> = {
  fileTree: FilesPanel,
  preview: PreviewPanel,
};

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
  const [health, setHealth] = useState<HubHealth | null>(null);
  const dockApiRef = useRef<DockviewApi | null>(null);
  const [dockReady, setDockReady] = useState(0);

  useEffect(() => {
    const ac = new AbortController();
    void (async () => {
      // Same cookie-suffix + CSRF path as classic before any credentialed call.
      await ensureCookieSuffix(ac.signal);
      const h = await fetchHubHealth(ac.signal);
      if (!ac.signal.aborted) {
        setHealth({ ...h, hasCsrf: !!getCsrfToken() });
      }
    })();
    return () => ac.abort();
  }, [loggedIn]);

  // FilesPanel emits open-file; Preview track routes into dock panels.
  useEffect(() => {
    return onNeoOpenFile((detail) => {
      const api = dockApiRef.current;
      if (!api) return;
      openFileInDock(api, detail);
    });
  }, []);

  // Agent switch: close preview tabs for other agents (or all if cleared).
  useEffect(() => {
    return onNeoAgentSelected((agentId) => {
      const api = dockApiRef.current;
      if (!api) return;
      if (!agentId) {
        for (const p of findPreviewPanels(api)) p.api.close();
        rememberFocusedPreview(null);
        return;
      }
      closePreviewsForOtherAgents(api, agentId);
    });
  }, []);

  const onReady = useCallback((event: DockviewReadyEvent) => {
    dockApiRef.current = event.api;
    setDockReady((n) => n + 1);
    // React StrictMode remounts in dev; skip if panels already exist.
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

  // Keep last-focused preview id when the user clicks back into Files.
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
          gap: 12,
          height: 40,
          padding: '0 12px',
          borderBottom: `1px solid ${c.border}`,
          background: c.surface,
          flexShrink: 0,
        }}
      >
        <strong style={{ fontSize: 13, letterSpacing: 0.2 }}>filebox neo</strong>
        <span style={{ color: c.textMuted, fontSize: 12 }}>Files + classic PreviewPane</span>
        <button
          type="button"
          style={headerBtnStyle}
          onClick={() => {
            const api = dockApiRef.current;
            if (api) addEmptyPreviewPanel(api);
          }}
          title="Add an empty preview tab"
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
          title="Pop out the focused preview panel (same-origin popout.html)"
        >
          Pop out
        </button>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
          <StatusChip health={health} />
          <button type="button" style={headerBtnStyle} onClick={() => void logout()}>
            Log out
          </button>
        </div>
      </header>
      <div style={{ flex: 1, minHeight: 0 }}>
        <DockviewReact
          components={components}
          theme={themeLight}
          popoutUrl={`${import.meta.env.BASE_URL}popout.html`}
          onReady={onReady}
        />
      </div>
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
