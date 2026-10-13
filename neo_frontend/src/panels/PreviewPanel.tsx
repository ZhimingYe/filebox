/**
 * Neo preview dock panel — one file per panel (knife-cut #1).
 * Hosts classic usePreviewTabs + PreviewWorkspace with ≤1 tab so the inner
 * tab strip stays hidden. Dock tab title = file basename. Closing the dock
 * tab (or the last inner file) disposes this panel.
 */

import { useCallback, useEffect, useMemo, useRef, type CSSProperties } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import type { RootInfo } from '@lib/api/client';
import { PreviewWorkspace } from '@lib/components/PreviewWorkspace';
import { tabIdFor, usePreviewTabs } from '@lib/hooks/usePreviewTabs';
import { useHealth } from '@lib/state/health';
import { c, font } from '../theme';
import { type NeoOpenFileDetail } from '../events/openFile';
import { ensureFilesThenReveal } from '../shell/revealInFiles';
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
  const { api, params: initialParams, containerApi } = props;
  const previewTabs = usePreviewTabs();
  const tabsRef = useRef(previewTabs);
  tabsRef.current = previewTabs;
  const { agents } = useHealth(true);
  /** Skip dispose while applying a restore snapshot. */
  const restoringRef = useRef(false);
  const hadFileRef = useRef(false);

  useEffect(() => {
    const d = api.onDidActiveChange((ev) => {
      if (ev.isActive) rememberFocusedPreview(api.id);
    });
    if (api.isActive) rememberFocusedPreview(api.id);
    return () => d.dispose();
  }, [api]);

  const openOrActivate = useCallback((detail: NeoOpenFileDetail) => {
    // ≤1 file per dock panel: replace rather than append an inner tab.
    // tab.agentId must match the opening agent (sticky ownership / no cross-agent leak).
    if (!detail.agentId) {
      console.warn('[neo] PreviewPanel.openOrActivate: missing agentId', {
        panelId: api.id,
        path: detail.path,
      });
      return;
    }
    tabsRef.current.replaceAll(detailToTabInput(detail));
  }, [api.id]);

  const restore = useCallback((snap: PersistedPreviewHost) => {
    const hooks = tabsRef.current;
    restoringRef.current = true;
    try {
      // Migration / callers may still pass multi-tab; keep only one here.
      // Extra tabs are expanded into sibling dock panels in layoutPersistence.
      const preferred =
        (snap.activeTabId
          ? snap.tabs.find((t) => tabIdFor(t) === snap.activeTabId)
          : undefined)
        ?? snap.tabs[0];
      if (!preferred) {
        hooks.replaceAll(null);
        return;
      }
      hooks.replaceAll({
        agentId: preferred.agentId,
        root: preferred.root,
        path: preferred.path,
        entry: preferred.entry,
      });
      if (preferred.pinned) {
        hooks.togglePin(tabIdFor(preferred));
      }
      api.setTitle(preferred.title || preferred.entry?.name || preferred.path);
      hadFileRef.current = true;
    } finally {
      // Defer clearing so the replaceAll commit does not trip dispose-on-empty.
      void Promise.resolve().then(() => {
        restoringRef.current = false;
      });
    }
  }, [api]);

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
      api.setTitle(pending.entry?.name || pending.path);
      api.updateParameters({} satisfies PreviewPanelParams);
    });
    const initial = initialParams?.pendingOpen;
    if (initial) {
      openOrActivate(initial);
      api.setTitle(initial.entry?.name || initial.path);
      api.updateParameters({} satisfies PreviewPanelParams);
    }
    return () => d.dispose();
  }, [api, openOrActivate, initialParams?.pendingOpen]);

  // Sync dock tab title to the open file; dispose panel when last file closes
  // (empty shells stay only via Sidebar New Preview / default layout).
  useEffect(() => {
    if (restoringRef.current) return;
    if (previewTabs.tabs.length > 0) {
      hadFileRef.current = true;
      const tab = previewTabs.activeTab ?? previewTabs.tabs[0];
      if (tab) api.setTitle(tab.title);
      return;
    }
    if (hadFileRef.current) {
      hadFileRef.current = false;
      api.close();
    }
  }, [previewTabs.tabs, previewTabs.activeTab, api]);

  const onRevealInBrowser = useCallback((root: string, dirPath: string) => {
    const tab = tabsRef.current.activeTab ?? tabsRef.current.tabs[0];
    ensureFilesThenReveal(containerApi, {
      root,
      dirPath,
      ...(tab?.agentId ? { agentId: tab.agentId } : {}),
    });
  }, [containerApi]);

  /** Closing the (only) file disposes the dock panel immediately. */
  const onClose = useCallback((tabId: string) => {
    if (tabsRef.current.tabs.length <= 1) {
      api.close();
      return;
    }
    tabsRef.current.close(tabId);
  }, [api]);

  const onCloseAll = useCallback(() => {
    api.close();
  }, [api]);

  // Knife-cut #3: roots / officeCapable from the tab's agent via health —
  // not the globally selected agentCtx (so A→B keeps A's Preview correct).
  const agentId =
    previewTabs.activeTab?.agentId
    ?? previewTabs.tabs[0]?.agentId
    ?? '';
  const tabAgent = useMemo(
    () => (agentId ? agents.find((a) => a.id === agentId) ?? null : null),
    [agents, agentId],
  );
  const roots: RootInfo[] = tabAgent?.roots ?? [];
  const officeCapable = !!tabAgent?.capabilities?.office_pdf_preview;
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
          onClose={onClose}
          onCloseAll={onCloseAll}
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
