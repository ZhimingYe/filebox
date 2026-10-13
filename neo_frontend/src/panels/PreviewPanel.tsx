/**
 * Neo preview dock panel — hosts classic usePreviewTabs + PreviewWorkspace.
 * No neo path bar: classic PreviewWorkspace owns tabs/path/actions; Pop out
 * lives on the dock group header (see DockBackAction).
 */

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import type { RootInfo } from '@lib/api/client';
import { PreviewWorkspace } from '@lib/components/PreviewWorkspace';
import { tabIdFor, usePreviewTabs } from '@lib/hooks/usePreviewTabs';
import { c, font } from '../theme';
import { emitNeoRevealInBrowser, type NeoOpenFileDetail } from '../events/openFile';
import {
  getPreviewAgentContext,
  subscribePreviewAgentContext,
} from '../preview/agentContext';
import { registerPreviewHost, unregisterPreviewHost } from '../preview/hostRegistry';
import { clearFocusedPreviewIf, rememberFocusedPreview } from '../preview/openInDock';
import type { PersistedPreviewHost } from '../preview/tabPersistence';
import { type PreviewPanelParams } from '../preview/types';
import { notifyPreviewTabsChanged } from '../shell/layoutPersistence';

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
  const { api, params: initialParams } = props;
  const previewTabs = usePreviewTabs();
  const tabsRef = useRef(previewTabs);
  tabsRef.current = previewTabs;
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
    tabsRef.current.openOrActivate(detailToTabInput(detail));
  }, []);

  const restore = useCallback((snap: PersistedPreviewHost) => {
    const hooks = tabsRef.current;
    hooks.closeAll();
    for (const t of snap.tabs) {
      hooks.openOrActivate({
        agentId: t.agentId,
        root: t.root,
        path: t.path,
        entry: t.entry,
      });
    }
    // Pins start false after openOrActivate — toggle once for each pinned tab.
    for (const t of snap.tabs) {
      if (!t.pinned) continue;
      const id = tabIdFor(t);
      hooks.togglePin(id);
    }
    if (snap.activeTabId) hooks.activate(snap.activeTabId);
  }, []);

  useEffect(() => {
    registerPreviewHost({
      panelId: api.id,
      openOrActivate,
      hasTabs: () => tabsRef.current.tabs.length > 0,
      hasFile: (detail) => tabsRef.current.tabs.some((t) => t.id === tabIdFor(detail)),
      belongsToOtherAgent: (agentId) =>
        tabsRef.current.tabs.some((t) => t.agentId !== agentId),
      closeAll: () => tabsRef.current.closeAll(),
      snapshot: () => ({
        tabs: tabsRef.current.tabs.map((t) => ({
          agentId: t.agentId,
          root: t.root,
          path: t.path,
          entry: t.entry,
          title: t.title,
          pinned: t.pinned,
        })),
        activeTabId: tabsRef.current.activeTabId,
      }),
      restore,
    });
    return () => {
      unregisterPreviewHost(api.id);
      clearFocusedPreviewIf(api.id);
    };
  }, [api.id, openOrActivate, restore]);

  // Persist when tab set / pins / active change.
  useEffect(() => {
    notifyPreviewTabsChanged();
  }, [previewTabs.tabs, previewTabs.activeTabId]);

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
  }, [api, openOrActivate, initialParams?.pendingOpen]);

  // Dock tab title stays fixed (set at panel create: Preview / Preview N).
  // Filenames live only on the classic PreviewWorkspace tab bar.

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
          <div style={emptyTitleStyle}>Preview</div>
          <div style={emptyCopyStyle}>
            Select a file in Files or Explorer to open it here.
          </div>
        </div>
      )}
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
  overflow: 'hidden',
};

const emptyStyle: CSSProperties = {
  height: '100%',
  boxSizing: 'border-box',
  padding: 24,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  textAlign: 'center',
  color: c.textSecondary,
};

const emptyTitleStyle: CSSProperties = {
  fontSize: 14,
  fontWeight: 600,
  color: c.text,
  marginBottom: 6,
};

const emptyCopyStyle: CSSProperties = {
  color: c.textMuted,
  fontSize: 13,
  lineHeight: 1.5,
  maxWidth: 280,
};
