import { useCallback, useEffect, useState, type CSSProperties, type FunctionComponent } from 'react';
import {
  DockviewReact,
  themeLight,
  type DockviewReadyEvent,
  type IDockviewPanelProps,
} from 'dockview-react';
import 'dockview-react/dist/styles/dockview.css';
import { fetchHubHealth, type HubHealth } from './api/health';
import { FileTreePlaceholder } from './panels/FileTreePlaceholder';
import { PreviewPlaceholder } from './panels/PreviewPlaceholder';
import { c, font } from './theme';

const components: Record<string, FunctionComponent<IDockviewPanelProps>> = {
  fileTree: FileTreePlaceholder,
  preview: PreviewPlaceholder,
};

function StatusChip({ health }: { health: HubHealth | null }) {
  if (!health) {
    return <span style={chipStyle(c.textMuted)}>hub: …</span>;
  }
  if (health.ok) {
    const suffix = health.cookieSuffix ? ` · csrf ${health.cookieSuffix}` : '';
    return <span style={chipStyle(c.accent)}>hub ok{suffix}</span>;
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
  const [health, setHealth] = useState<HubHealth | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    void fetchHubHealth(ac.signal).then(setHealth);
    return () => ac.abort();
  }, []);

  const onReady = useCallback((event: DockviewReadyEvent) => {
    // React StrictMode remounts in dev; skip if panels already exist.
    if (event.api.panels.length > 0) return;
    event.api.addPanel({
      id: 'file-tree',
      component: 'fileTree',
      title: 'Files',
      initialWidth: 280,
    });
    event.api.addPanel({
      id: 'preview',
      component: 'preview',
      title: 'Preview',
      position: { referencePanel: 'file-tree', direction: 'right' },
    });
  }, []);

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
        <span style={{ color: c.textMuted, fontSize: 12 }}>dockview shell spike</span>
        <div style={{ marginLeft: 'auto' }}>
          <StatusChip health={health} />
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
