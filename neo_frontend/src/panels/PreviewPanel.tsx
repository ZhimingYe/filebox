/**
 * Neo preview dock panel — hosts classic usePreviewTabs + PreviewWorkspace
 * via `@classic` so #86 pin / DOM keep-alive park / ViewerStateRegistry
 * apply unchanged. Dockview supplies multi-panel splits; classic tab strip
 * + pin affordances live inside each panel.
 */

import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import type { RootInfo } from '@classic/api/client';
import { PreviewWorkspace } from '@classic/components/PreviewWorkspace';
import { tabIdFor, usePreviewTabs } from '@classic/hooks/usePreviewTabs';
import { c, font } from '../theme';
import { emitNeoRevealInBrowser, type NeoOpenFileDetail } from '../events/openFile';
import {
  getPreviewAgentContext,
  subscribePreviewAgentContext,
} from '../preview/agentContext';
import { registerPreviewHost, unregisterPreviewHost } from '../preview/hostRegistry';
import { rememberFocusedPreview } from '../preview/openInDock';
import { type PreviewPanelParams } from '../preview/types';

function detailToTabInput(detail: NeoOpenFileDetail) {
  return {
    agentId: detail.agentId,
    root: detail.root,
    path: detail.path,
    entry: detail.entry,
    refresh: detail.refresh,
  };
}

export function PreviewPanel(props: IDockviewPanelProps<PreviewPanelParams>) {
  const { api, containerApi, params: initialParams } = props;
  const previewTabs = usePreviewTabs();
  const [agentCtx, setAgentCtx] = useState(getPreviewAgentContext);

  useEffect(() => subscribePreviewAgentContext(() => {
    setAgentCtx(getPreviewAgentContext());
  }), []);

  useEffect(() => {
    const d = api.onDidActiveChange((ev) => {
      if (ev.isActive) rememberFocusedPreview(api.id);
    });
    if (api.isActive) rememberFocusedPreview(api.id);
    return () => d.dispose();
  }, [api]);

  const openOrActivate = useCallback((detail: NeoOpenFileDetail) => {
    previewTabs.openOrActivate(detailToTabInput(detail));
  }, [previewTabs]);

  // Register host for openFileInDock routing; drain pending opens.
  useEffect(() => {
    registerPreviewHost({
      panelId: api.id,
      openOrActivate,
      hasTabs: () => previewTabs.tabs.length > 0,
      hasFile: (detail) => previewTabs.tabs.some((t) => t.id === tabIdFor(detail)),
      belongsToOtherAgent: (agentId) =>
        previewTabs.tabs.some((t) => t.agentId !== agentId),
      closeAll: () => previewTabs.closeAll(),
    });
    return () => unregisterPreviewHost(api.id);
  }, [api.id, openOrActivate, previewTabs]);

  // One-shot pendingOpen from dock params (addPanel race).
  useEffect(() => {
    const d = api.onDidParametersChange((next) => {
      const pending = (next as PreviewPanelParams | undefined)?.pendingOpen;
      if (!pending) return;
      openOrActivate(pending);
      api.updateParameters({} satisfies PreviewPanelParams);
    });
    const initial = initialParams?.pendingOpen;
    if (initial) {
      openOrActivate(initial);
      api.updateParameters({} satisfies PreviewPanelParams);
    }
    return () => d.dispose();
    // Only on mount / api identity — openOrActivate is stable enough via previewTabs memo.
  }, [api]);

  // Sync dock tab title with classic active preview tab.
  useEffect(() => {
    const title = previewTabs.activeTab?.title ?? 'Preview';
    if (api.title !== title) api.setTitle(title);
  }, [api, previewTabs.activeTab?.title]);

  const onPopout = useCallback(() => {
    const panel = containerApi.getPanel(api.id);
    if (panel) void containerApi.addPopoutGroup(panel);
  }, [api.id, containerApi]);

  const onRevealInBrowser = useCallback((root: string, dirPath: string) => {
    emitNeoRevealInBrowser({ root, dirPath });
  }, []);

  const agentId =
    previewTabs.activeTab?.agentId
    ?? previewTabs.tabs[0]?.agentId
    ?? agentCtx.agentId
    ?? '';

  const roots: RootInfo[] = agentCtx.roots;
  const officeCapable = agentCtx.officeCapable;
  const hasTabs = previewTabs.tabs.length > 0;

  return (
    <div style={shellStyle}>
      <div style={toolbarStyle}>
        <div style={pathStyle} title={previewTabs.activeTab ? `${previewTabs.activeTab.root}:${previewTabs.activeTab.path}` : undefined}>
          {previewTabs.activeTab ? (
            <>
              <span style={{ color: c.textMuted }}>{previewTabs.activeTab.root}</span>
              <span style={{ color: c.textMuted }}>:</span>
              <span>{previewTabs.activeTab.path}</span>
              {previewTabs.activeTab.pinned ? (
                <span style={{ color: c.accent, marginLeft: 8 }}>pinned</span>
              ) : null}
            </>
          ) : (
            <span style={{ color: c.textMuted }}>No file open</span>
          )}
        </div>
        <button
          type="button"
          style={btnStyle}
          onClick={onPopout}
          title="Pop out to a same-origin window (dockview addPopoutGroup)"
        >
          Pop out
        </button>
      </div>
      <div style={bodyStyle}>
        {hasTabs && agentId ? (
          <PreviewWorkspace
            agentId={agentId}
            tabs={previewTabs.tabs}
            activeTab={previewTabs.activeTab}
            activeTabId={previewTabs.activeTabId}
            onActivate={previewTabs.activate}
            onClose={previewTabs.close}
            onCloseAll={previewTabs.closeAll}
            onCloseLeft={previewTabs.closeLeft}
            onCloseRight={previewTabs.closeRight}
            onRefresh={previewTabs.refresh}
            onTogglePin={previewTabs.togglePin}
            roots={roots}
            officeCapable={officeCapable}
            onRevealInBrowser={onRevealInBrowser}
          />
        ) : (
          <div style={emptyStyle}>
            <div style={{ fontWeight: 600, color: c.text, marginBottom: 6 }}>Preview</div>
            <div style={{ color: c.textMuted, lineHeight: 1.5 }}>
              Select a file in Files to open it here. Classic{' '}
              <code style={{ fontFamily: font.mono }}>PreviewWorkspace</code> provides
              multi-tab, pin, DOM keep-alive (HTML/PDF/Office), and ViewerStateRegistry
              restore (image/Monaco/markdown/CSV) — same #86 contract as desktop classic.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const shellStyle: CSSProperties = {
  height: '100%',
  display: 'flex',
  flexDirection: 'column',
  background: c.bg,
  color: c.text,
  fontFamily: font.sans,
  fontSize: 13,
  minHeight: 0,
};

const toolbarStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '4px 8px',
  borderBottom: `1px solid ${c.border}`,
  background: c.surface,
  flexShrink: 0,
  minHeight: 32,
};

const pathStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  fontFamily: font.mono,
  fontSize: 11,
  color: c.text,
};

const bodyStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  position: 'relative',
  overflow: 'hidden',
  display: 'flex',
  flexDirection: 'column',
};

const emptyStyle: CSSProperties = {
  height: '100%',
  boxSizing: 'border-box',
  padding: 16,
  color: c.textSecondary,
};

const btnStyle: CSSProperties = {
  fontFamily: font.sans,
  fontSize: 11,
  padding: '2px 8px',
  borderRadius: 6,
  border: `1px solid ${c.border}`,
  background: c.bgMuted,
  color: c.textSecondary,
  cursor: 'pointer',
};
