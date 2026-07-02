import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { useSession } from './state/session';
import { useHealth } from './state/health';
import { useSse } from './state/events';
import { useIsMobile } from './state/useIsMobile';
import { Login } from './components/Login';
import { BackendList } from './components/BackendList';
import { FileBrowser } from './components/FileBrowser';
import { PreviewPane } from './components/PreviewPane';
import { AgentSettings } from './components/AgentSettings';
import { HealthPanel } from './components/HealthPanel';
import { SystemStats } from './components/SystemStats';
import { PinnedFolders } from './components/PinnedFolders';
import {
  IconChevronLeft,
  IconChevronRight,
  IconFolder,
  IconSettings,
  IconHealth,
  IconStats,
  IconLogout,
} from './components/icons';
import type { FsEntry } from './api/client';
import { fileRawUrl } from './api/client';
import * as api from './api/client';
import { c, radius, shadow, font } from './theme';

const VERSION_TOAST_DISMISS_KEY = 'filebox.newVersionDismissed';

function getDismissedVersion(): string | null {
  try {
    return sessionStorage.getItem(VERSION_TOAST_DISMISS_KEY);
  } catch {
    return null;
  }
}

function setDismissedVersion(v: string) {
  try {
    sessionStorage.setItem(VERSION_TOAST_DISMISS_KEY, v);
  } catch {
    /* ignore */
  }
}

type View = 'files' | 'settings' | 'health' | 'stats';

interface ProgressEvent {
  req_id: string;
  phase: string;
  processed: number;
  total: number | null;
  message: string | null;
}

export default function App() {
  const { loggedIn, login, logout } = useSession();
  const { health, agents, error: healthError, refresh } = useHealth(loggedIn === true);
  const isMobile = useIsMobile();

  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [view, setView] = useState<View>('files');
  const [preview, setPreview] = useState<{ root: string; path: string; entry: FsEntry } | null>(null);
  const [progressMap, setProgressMap] = useState<Map<string, ProgressEvent>>(new Map());
  const progressTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Imperative navigation request from the sidebar PinnedFolders section into
  // the FileBrowser. Driven by `nonce` so re-clicking the same pin still
  // navigates. Cleared via onNavHandled once the browser has acted on it.
  const [navRequest, setNavRequest] = useState<{ root: string; path: string; nonce: number } | null>(null);

  // ── File browsing position, owned HERE (not in FileBrowser) ──
  // FileBrowser unmounts when the user leaves the Files view (Settings/Health/
  // Stats), so any state it held was lost on remount — jumping back to the
  // first root. Owning the position here (App never unmounts) makes it survive
  // view switches, and remembering per-(agent,root) lets each combination
  // keep its own place.
  //
  // - filePosByAgent: last viewed {root, path} per agent.
  // - pathMemory: last path per (agent:root) — so switching roots within an
  //   agent restores each root's own position.
  const filePosByAgent = useRef<Map<string, { root: string; path: string }>>(new Map());
  const pathMemory = useRef<Map<string, string>>(new Map());
  const memKey = (agentId: string, root: string) => `${agentId}:${root}`;
  // Unpin a single folder via an atomic pin_remove delta (not a whole-array
  // replace), so two tabs or rapid clicks can't clobber each other. Returns
  // true on success so the sidebar can surface a failure banner — the
  // "never freeze silently" rule means a clicked × that silently no-ops on a
  // flaky connection is a bug, not a graceful degradation.
  const handleUnpin = useCallback(
    async (agentId: string, root: string, path: string): Promise<boolean> => {
      try {
        await api.patchRoot(agentId, root, { pin_remove: path });
        refresh();
        return true;
      } catch {
        // Pin stays; the sidebar shows a transient "couldn't unpin" banner.
        return false;
      }
    },
    [refresh],
  );

  // ── Desktop sidebar collapse (icon-only rail) ──
  // Mobile drawer ignores this — `collapsed` below is gated on !isMobile.
  // Persisted to localStorage the same way splitRatio is.
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem('filebox.sidebarCollapsed') === '1'; }
    catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem('filebox.sidebarCollapsed', sidebarCollapsed ? '1' : '0'); }
    catch { /* ignore */ }
  }, [sidebarCollapsed]);

  // ── Version tracking: detect when the running Hub has been upgraded ──
  // First non-empty version seen is the version this bundle shipped with.
  // Subsequent differing values trigger the "new version available" toast.
  const initialVersionRef = useRef<string | null>(null);
  const [newVersion, setNewVersion] = useState<string | null>(null);
  useEffect(() => {
    const v = health?.hub.version;
    if (!v) return;
    if (initialVersionRef.current === null) {
      initialVersionRef.current = v;
      // If user already dismissed this version earlier in the session, respect it.
      if (getDismissedVersion() === v) {
        setNewVersion(null);
      }
      return;
    }
    if (v !== initialVersionRef.current && v !== getDismissedVersion()) {
      setNewVersion(v);
    }
  }, [health?.hub.version]);

  const handleReload = useCallback(() => {
    window.location.reload();
  }, []);

  const handleDismissVersion = useCallback(() => {
    if (newVersion) setDismissedVersion(newVersion);
    setNewVersion(null);
  }, [newVersion]);

  // ── About dialog ──
  // Toggled by clicking the version number in the sidebar footer.
  const [aboutOpen, setAboutOpen] = useState(false);
  const handleOpenAbout = useCallback(() => setAboutOpen(true), []);
  const handleCloseAbout = useCallback(() => setAboutOpen(false), []);

  // Dev-mode heuristic (purely client-side): a production hub binds 0.0.0.0 and
  // is served over HTTPS, whereas a local dev hub binds 127.0.0.1 and runs on
  // plain HTTP from the Vite/dev server. True dev status isn't exposed by the
  // API, so this is a best-effort hint, not a guarantee.
  const isLikelyDev = useMemo(() => {
    if (typeof window === 'undefined') return false;
    const host = window.location.hostname;
    const isLoopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
    return window.location.protocol !== 'https:' && isLoopback;
  }, []);

  // ── Desktop split: persisted file/preview width ratio ──
  const splitContainerRef = useRef<HTMLDivElement>(null);
  const [splitterHover, setSplitterHover] = useState(false);
  const [splitRatio, setSplitRatio] = useState<number>(() => {
    try {
      const stored = localStorage.getItem('filebox.splitRatio');
      const v = stored ? parseFloat(stored) : 0.5;
      if (isNaN(v)) return 0.5;
      return Math.max(0.2, Math.min(0.8, v));
    } catch {
      return 0.5;
    }
  });
  useEffect(() => {
    try { localStorage.setItem('filebox.splitRatio', String(splitRatio)); } catch { /* ignore */ }
  }, [splitRatio]);

  const startSplitDrag = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const container = splitContainerRef.current;
    if (!container) return;
    let rafId: number | null = null;
    let lastClientX = e.clientX;
    const onMove = (ev: MouseEvent) => {
      lastClientX = ev.clientX;
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        const rect = container.getBoundingClientRect();
        const ratio = (lastClientX - rect.left) / rect.width;
        setSplitRatio(Math.max(0.2, Math.min(0.8, ratio)));
      });
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      if (rafId !== null) cancelAnimationFrame(rafId);
      document.body.classList.remove('split-resizing');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    // iframe (HTML preview, PDF) eats mousemove once cursor enters it.
    // Disable pointer events globally during drag so events reach document.
    document.body.classList.add('split-resizing');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, []);

  // ── Keyboard navigation: cache last reported file list ──
  const fileListRef = useRef<{ root: string; path: string; entries: FsEntry[] } | null>(null);
  const handleEntriesChange = useCallback((info: { root: string; path: string; entries: FsEntry[] }) => {
    fileListRef.current = info;
  }, []);

  // Esc closes preview; ← → jump to previous/next file in the same directory
  useEffect(() => {
    if (!preview) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return;
      }
      if (e.key === 'Escape') {
        setPreview(null);
        return;
      }
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const info = fileListRef.current;
      if (!info || info.root !== preview.root) return;
      // preview.path is absolute within root, e.g. /sub/file.txt or /file.txt
      const previewDir = preview.path.replace(/\/[^/]*$/, '') || '/';
      if (info.path !== previewDir) return;
      const files = info.entries.filter((en) => en.entry_type === 'file' && !en.denied);
      const currentName = preview.path.split('/').pop() || '';
      const idx = files.findIndex((en) => en.name === currentName);
      if (idx === -1) return;
      const nextIdx = e.key === 'ArrowRight' ? idx + 1 : idx - 1;
      if (nextIdx < 0 || nextIdx >= files.length) return;
      e.preventDefault();
      const next = files[nextIdx];
      const nextPath = (previewDir === '/' ? '' : previewDir) + '/' + next.name;
      setPreview({ root: preview.root, path: nextPath, entry: next });
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [preview]);

  const selectedAgent = useMemo(() => agents.find((a) => a.id === selectedAgentId) || null, [agents, selectedAgentId]);

  // Count pinned folders across the selected agent's ENABLED roots, so the
  // sidebar Pinned Folders section can be hidden entirely when there are none
  // (avoids rendering an empty section header). Pins on disabled roots still
  // count as "exist" but aren't navigable, so we only surface enabled ones.
  const pinnedCount = useMemo(() => {
    if (!selectedAgent) return 0;
    return selectedAgent.roots.reduce(
      (n, r) => (r.enabled ? n + r.pinned_folders.length : n),
      0,
    );
  }, [selectedAgent]);

  // ── Current browse position (selectedRoot + currentPath) for the selected
  // agent. Owned as state here so FileBrowser (a controlled child) re-renders
  // on navigation, while the *memory* (per-agent, per-root) lives in the refs
  // above so it survives view switches.
  const [selectedRoot, setSelectedRoot] = useState<string | null>(null);
  const [currentPath, setCurrentPath] = useState('/');

  const enabledRoots = useMemo(
    () => (selectedAgent ? selectedAgent.roots.filter((r) => r.enabled) : []),
    [selectedAgent],
  );

  // Reconcile root/path when the agent changes OR the root config changes
  // (root added/removed/renamed/disabled). This is the logic that used to live
  // in FileBrowser's mount effect — moved here so it runs against state that
  // isn't wiped by unmount.
  const prevAgentIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!selectedAgent) {
      setSelectedRoot(null);
      setCurrentPath('/');
      prevAgentIdRef.current = null;
      return;
    }
    const agentId = selectedAgent.id;
    const agentChanged = prevAgentIdRef.current !== agentId;

    if (enabledRoots.length === 0) {
      setSelectedRoot(null);
      prevAgentIdRef.current = agentId;
      return;
    }

    // On agent switch, restore that agent's last position from filePosByAgent.
    if (agentChanged) {
      prevAgentIdRef.current = agentId;
      const saved = filePosByAgent.current.get(agentId);
      const root =
        saved && enabledRoots.some((r) => r.name === saved.root)
          ? saved.root
          : enabledRoots[0].name;
      const path = saved && saved.root === root
        ? saved.path
        : pathMemory.current.get(memKey(agentId, root)) || '/';
      setSelectedRoot(root);
      setCurrentPath(path);
      return;
    }

    // Same agent, but root config may have changed: if current root is no
    // longer valid, fall back to the first enabled root.
    const rootValid = selectedRoot && enabledRoots.some((r) => r.name === selectedRoot);
    if (!rootValid) {
      const fallback = enabledRoots[0].name;
      setSelectedRoot(fallback);
      setCurrentPath(pathMemory.current.get(memKey(agentId, fallback)) || '/');
    }
  }, [selectedAgent, enabledRoots, selectedRoot]);

  // Atomically apply a navigation for the current agent: update state + record
  // both the per-agent position and the per-root path memory.
  const applyNav = useCallback((root: string, path: string) => {
    setSelectedRoot(root);
    setCurrentPath(path);
    if (selectedAgent) {
      filePosByAgent.current.set(selectedAgent.id, { root, path });
      pathMemory.current.set(memKey(selectedAgent.id, root), path);
    }
  }, [selectedAgent]);

  // Switch to a different root within the current agent, restoring that root's
  // remembered path (or '/' if none). Saves the outgoing root's current path
  // first so it's restored on return.
  const switchRoot = useCallback((root: string) => {
    if (!selectedAgent) return;
    if (selectedRoot) {
      pathMemory.current.set(memKey(selectedAgent.id, selectedRoot), currentPath);
    }
    const restored = pathMemory.current.get(memKey(selectedAgent.id, root)) || '/';
    applyNav(root, restored);
  }, [selectedAgent, selectedRoot, currentPath, applyNav]);
  const handleFileSelect = useCallback((root: string, path: string, entry: FsEntry) => {
    setPreview({ root, path, entry });
  }, []);

  const selectAgent = useCallback((id: string) => {
    setSelectedAgentId(id);
    setView('files');
    setPreview(null);
    if (isMobile) setSidebarOpen(false);
  }, [isMobile]);

  const navigate = useCallback((v: View) => {
    setView(v);
    if (isMobile) setSidebarOpen(false);
  }, [isMobile]);

  // Auto-refresh health and track progress when SSE events arrive
  useSse(useCallback((evt) => {
    if (
      evt.event === 'agent_connected' ||
      evt.event === 'agent_disconnected' ||
      evt.event === 'resources_updated' ||
      evt.event === 'sync_required'
    ) {
      refresh();
    }
    if (evt.event === 'progress') {
      const d = evt.data as unknown as ProgressEvent;
      setProgressMap((prev) => {
        const next = new Map(prev);
        next.set(d.req_id, d);
        return next;
      });
      const timers = progressTimers.current;
      if (timers.has(d.req_id)) clearTimeout(timers.get(d.req_id)!);
      timers.set(d.req_id, setTimeout(() => {
        setProgressMap((prev) => {
          const next = new Map(prev);
          next.delete(d.req_id);
          return next;
        });
        timers.delete(d.req_id);
      }, 5000));
    }
  }, [refresh]), loggedIn === true);

  const activeProgress = Array.from(progressMap.values());

  if (loggedIn === null) {
    return <div style={styles.loading}>Loading...</div>;
  }

  if (!loggedIn) {
    return <Login onLogin={login} />;
  }

  // ── Sidebar content (shared between desktop inline & mobile drawer) ──
  // collapsed only applies to the desktop inline sidebar; the mobile drawer
  // forces expanded (text labels + 280px width) regardless of the persisted
  // preference.
  const collapsed = !isMobile && sidebarCollapsed;

  const navItems = [
    { v: 'files' as const, label: 'Files', Icon: IconFolder },
    { v: 'settings' as const, label: 'Settings', Icon: IconSettings },
    { v: 'health' as const, label: 'Health', Icon: IconHealth },
    { v: 'stats' as const, label: 'Stats', Icon: IconStats },
  ];

  const sidebarContent = (
    <>
      <div style={collapsed ? styles.sidebarHeaderCollapsed : styles.sidebarHeader}>
        {collapsed ? (
          <button
            onClick={() => setSidebarCollapsed(false)}
            style={styles.collapseToggleCollapsed}
            title="Expand sidebar"
          >
            <IconChevronRight />
          </button>
        ) : (
          <>
            <h1 style={styles.logo}>filebox</h1>
            {isMobile ? (
              <button onClick={() => setSidebarOpen(false)} style={styles.closeSidebarBtn} title="Close">&times;</button>
            ) : (
              <button
                onClick={() => setSidebarCollapsed(true)}
                style={styles.collapseToggle}
                title="Collapse sidebar"
              >
                <IconChevronLeft />
              </button>
            )}
          </>
        )}
      </div>
      {/* Scrollable middle region. On short viewports the agents / nav / pinned
          sections can't all fit, and without an explicit overflow container the
          footer (logout, version) gets pushed off-screen and becomes
          unreachable. This wrapper scrolls instead; the header above and the
          footer below stay pinned. `flex: 1` + `minHeight: 0` is the standard
          incantation for "take remaining space and allow shrink-to-scroll" in a
          flex column. */}
      <div style={styles.sidebarScroll}>
        <div style={collapsed ? styles.sidebarSectionCollapsed : styles.sidebarSection}>
          {!collapsed && <div style={styles.sectionHeader}>Agents</div>}
          <BackendList
            agents={agents}
            selectedId={selectedAgentId}
            onSelect={selectAgent}
            collapsed={collapsed}
          />
        </div>
        {selectedAgent && (
          <div style={collapsed ? styles.sidebarSectionCollapsed : styles.sidebarSection}>
            {!collapsed && <div style={styles.sectionHeader}>Navigation</div>}
            <div style={collapsed ? styles.navCollapsed : styles.nav}>
              {navItems.map(({ v, label, Icon }) => (
                <button
                  key={v}
                  onClick={() => navigate(v)}
                  title={label}
                  style={{
                    ...(collapsed ? styles.navBtnCollapsed : styles.navBtn),
                    ...(view === v ? (collapsed ? styles.navBtnCollapsedActive : styles.navBtnActive) : {}),
                  }}
                >
                  <Icon />
                  {!collapsed && <span>{label}</span>}
                </button>
              ))}
            </div>
          </div>
        )}
        {selectedAgent && pinnedCount > 0 && (
          <div style={collapsed ? styles.sidebarSectionCollapsed : styles.sidebarSection}>
            {!collapsed && <div style={styles.sectionHeader}>Pinned</div>}
            <PinnedFolders
              agent={selectedAgent}
              collapsed={collapsed}
              onNavigate={(root, path) => {
                // A pin click should always land in the Files view, even if the
                // user is currently on Settings/Health/Stats. On mobile, an open
                // preview would otherwise keep showing on top of the just-navigated
                // file list (showMobilePreview only checks for preview existence),
                // so close it explicitly — the user clicked a folder, they want to
                // SEE that folder, not the file they were previewing before.
                setPreview(null);
                navigate('files');
                setNavRequest({ root, path, nonce: Date.now() });
              }}
              onUnpin={(root, path) => handleUnpin(selectedAgent.id, root, path)}
            />
          </div>
        )}
        <div style={{ flex: 1 }} />
      </div>
      <div style={collapsed ? styles.sidebarFooterCollapsed : styles.sidebarFooter}>
        {!collapsed && health?.hub.version && (
          <button
            onClick={handleOpenAbout}
            title="About filebox"
            style={styles.versionLine}
          >
            v{health.hub.version}
          </button>
        )}
        <button
          onClick={logout}
          title="Logout"
          style={collapsed ? styles.logoutBtnCollapsed : styles.logoutBtn}
        >
          {collapsed ? <IconLogout /> : 'Logout'}
        </button>
      </div>
    </>
  );

  // ── Mobile file view: show list OR preview, not both ──
  const showMobilePreview = isMobile && preview && view === 'files';

  return (
    <div style={styles.app}>
      {/* Mobile overlay */}
      {isMobile && sidebarOpen && (
        <div style={styles.overlay} onClick={() => setSidebarOpen(false)} />
      )}

      {/* Sidebar */}
      {isMobile ? (
        <div style={{ ...styles.sidebarExpanded, ...styles.sidebarDrawer, transform: sidebarOpen ? 'translateX(0)' : 'translateX(-100%)' }}>
          {sidebarContent}
        </div>
      ) : (
        <div style={collapsed ? styles.sidebarCollapsed : styles.sidebarExpanded}>{sidebarContent}</div>
      )}

      {/* Main content */}
      <div style={isMobile ? styles.mainMobile : styles.main}>
        {/* Mobile top bar */}
        {isMobile && (
          <div style={styles.mobileTopBar}>
            <button onClick={() => setSidebarOpen(true)} style={styles.hamburger}>&#9776;</button>
            <span style={styles.mobileTitle}>{selectedAgent?.name || 'filebox'}</span>
            {showMobilePreview && (
              <button onClick={() => setPreview(null)} style={styles.backBtn}>&larr; Back</button>
            )}
          </div>
        )}

        {/* Content area */}
        <div style={styles.contentArea}>
          {!selectedAgent ? (
            <div style={styles.emptyState}>
              <p style={styles.emptyText}>Select an agent from the sidebar</p>
            </div>
          ) : view === 'files' ? (
            isMobile ? (
              // Mobile: FileBrowser stays mounted (just CSS-hidden) while
              // preview is open, so its selectedRoot/currentPath/scroll state
              // survives the round-trip. Unmounting it on every preview toggle
              // was the reason "Back" returned to root instead of the dir the
              // user was browsing.
              <>
                <div style={{
                  ...styles.mobileFileWrap,
                  display: showMobilePreview ? 'none' : 'flex',
                }}>
                  <FileBrowser
                    agentId={selectedAgent.id}
                    roots={selectedAgent.roots}
                    onFileSelect={handleFileSelect}
                    onEntriesChange={handleEntriesChange}
                    onRootsChange={refresh}
                    navRequest={navRequest}
                    onNavHandled={() => setNavRequest(null)}
                    selectedRoot={selectedRoot}
                    currentPath={currentPath}
                    onApplyNav={applyNav}
                    onSwitchRoot={switchRoot}
                  />
                </div>
                {showMobilePreview && (
                  <div style={styles.mobilePreviewWrap}>
                    <div style={styles.previewHeader}>
                      <span style={styles.previewPath}>{preview!.path}</span>
                      <div style={styles.previewActions}>
                        <a
                          href={fileRawUrl(selectedAgent.id, preview!.root, preview!.path)}
                          download
                          style={styles.headerLink}
                          title="Download"
                        >
                          Download
                        </a>
                      </div>
                    </div>
                    <PreviewPane
                      agentId={selectedAgent.id}
                      root={preview!.root}
                      path={preview!.path}
                      entryType={preview!.entry.entry_type}
                      denied={preview!.entry.denied}
                    />
                  </div>
                )}
              </>
            ) : (
              // Desktop: side-by-side split, resizable
              <div ref={splitContainerRef} style={styles.splitView}>
                <div style={{ ...styles.filePanel, flex: preview ? `0 0 ${splitRatio * 100}%` : '1' }}>
                  <FileBrowser
                    agentId={selectedAgent.id}
                    roots={selectedAgent.roots}
                    onFileSelect={handleFileSelect}
                    onEntriesChange={handleEntriesChange}
                    onRootsChange={refresh}
                    navRequest={navRequest}
                    onNavHandled={() => setNavRequest(null)}
                    selectedRoot={selectedRoot}
                    currentPath={currentPath}
                    onApplyNav={applyNav}
                    onSwitchRoot={switchRoot}
                  />
                </div>
                {preview && (
                  <>
                    <div
                      onMouseDown={startSplitDrag}
                      onMouseEnter={() => setSplitterHover(true)}
                      onMouseLeave={() => setSplitterHover(false)}
                      style={{ ...styles.splitter, ...(splitterHover ? styles.splitterHover : {}) }}
                      title="Drag to resize"
                    />
                    <div style={styles.previewPanel}>
                      <div style={styles.previewHeader}>
                        <span style={styles.previewPath}>{preview.path}</span>
                        <div style={styles.previewActions}>
                          <a
                            href={fileRawUrl(selectedAgent.id, preview.root, preview.path)}
                            download
                            style={styles.headerLink}
                            title="Download"
                          >
                            Download
                          </a>
                          <button onClick={() => setPreview(null)} style={styles.closeBtn} title="Close (Esc)">&times;</button>
                        </div>
                      </div>
                      <PreviewPane
                        key={`${preview.root}:${preview.path}`}
                        agentId={selectedAgent.id}
                        root={preview.root}
                        path={preview.path}
                        entryType={preview.entry.entry_type}
                        denied={preview.entry.denied}
                      />
                    </div>
                  </>
                )}
              </div>
            )
          ) : view === 'settings' ? (
            <AgentSettings agent={selectedAgent} onRefresh={refresh} />
          ) : view === 'stats' ? (
            <SystemStats agentId={selectedAgent.id} />
          ) : (
            <HealthPanel health={health} agents={agents} error={healthError} />
          )}
        </div>
      </div>

      {/* Progress toasts */}
      {activeProgress.length > 0 && (
        <div style={styles.progressToast}>
          {activeProgress.map((p) => (
            <div key={p.req_id} style={styles.progressItem}>
              <span style={styles.progressPhase}>{p.phase}</span>
              {p.message && <span style={styles.progressMsg}>{p.message}</span>}
              {p.total !== null && (
                <span style={styles.progressBytes}>
                  {formatBytes(p.processed)} / {formatBytes(p.total)}
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      {/* New version available toast (bottom-left so it doesn't clash with progress).
          Suppressed on mobile while the sidebar drawer is open to avoid overlap. */}
      {newVersion && !(isMobile && sidebarOpen) && (
        <div style={styles.versionToast}>
          <div style={styles.versionToastText}>
            New version available (v{newVersion}). Reload to update.
          </div>
          <div style={styles.versionToastActions}>
            <button onClick={handleReload} style={styles.versionToastReload}>Reload</button>
            <button onClick={handleDismissVersion} style={styles.versionToastDismiss}>Dismiss</button>
          </div>
        </div>
      )}

      {/* About filebox dialog — opened by clicking the version number */}
      {aboutOpen && (
        <div style={styles.aboutOverlay} onClick={handleCloseAbout}>
          <div style={styles.aboutCard} onClick={(e) => e.stopPropagation()}>
            <div style={styles.aboutHeader}>
              <div style={styles.aboutLogo}>filebox</div>
              <button onClick={handleCloseAbout} style={styles.aboutCloseBtn} aria-label="Close">×</button>
            </div>
            <div style={styles.aboutBody}>
              <div style={styles.aboutRow}>
                <span style={styles.aboutLabel}>Version</span>
                <span style={styles.aboutValue}>v{health?.hub.version ?? '—'}</span>
              </div>
              <div style={styles.aboutRow}>
                <span style={styles.aboutLabel}>Mode</span>
                <span style={{ ...styles.aboutValue, color: isLikelyDev ? c.warning : c.success }}>
                  {isLikelyDev ? 'development (local)' : 'production'}
                </span>
              </div>
              <div style={styles.aboutRow}>
                <span style={styles.aboutLabel}>Homepage</span>
                <a
                  href="https://zhimingye.github.io/filebox/"
                  target="_blank"
                  rel="noopener noreferrer"
                  style={styles.aboutLink}
                >
                  zhimingye.github.io/filebox
                </a>
              </div>
            </div>
            <button onClick={handleCloseAbout} style={styles.aboutDoneBtn}>Done</button>
          </div>
        </div>
      )}
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const styles: Record<string, React.CSSProperties> = {
  loading: {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    height: '100vh', background: c.bg, color: c.textMuted,
    fontFamily: font.sans,
  },
  app: {
    display: 'flex', height: '100vh', background: c.bg, color: c.text,
    fontFamily: font.sans, position: 'relative', overflow: 'hidden',
  },
  // ── Sidebar ──
  // Expanded (220px, down from 260) and collapsed (56px icon rail) variants.
  // Mobile drawer overrides width to 280 via sidebarDrawer.
  sidebarExpanded: {
    width: 220, borderRight: `1px solid ${c.border}`, display: 'flex',
    flexDirection: 'column', flexShrink: 0, background: c.bgSubtle,
    transition: 'width 0.18s ease',
  },
  sidebarCollapsed: {
    width: 56, borderRight: `1px solid ${c.border}`, display: 'flex',
    flexDirection: 'column', flexShrink: 0, background: c.bgSubtle,
    transition: 'width 0.18s ease',
  },
  sidebarDrawer: {
    position: 'absolute', top: 0, left: 0, bottom: 0, zIndex: 200,
    width: 280, transition: 'transform 0.25s ease',
    boxShadow: shadow.lg,
  } as React.CSSProperties,
  sidebarHeader: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    padding: '14px 12px', borderBottom: `1px solid ${c.border}`,
  },
  sidebarHeaderCollapsed: {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    padding: '10px 0', borderBottom: `1px solid ${c.border}`,
  },
  logo: { margin: 0, fontSize: 17, color: c.accent, fontWeight: 700, letterSpacing: -0.3 },
  closeSidebarBtn: {
    background: 'none', border: 'none', color: c.textMuted,
    fontSize: 20, cursor: 'pointer', padding: '0 4px', lineHeight: 1,
    borderRadius: radius.sm,
  },
  collapseToggle: {
    background: 'none', border: 'none', color: c.textMuted, cursor: 'pointer',
    padding: 6, display: 'flex', alignItems: 'center', justifyContent: 'center',
    borderRadius: radius.sm,
  },
  collapseToggleCollapsed: {
    background: 'none', border: 'none', color: c.textMuted, cursor: 'pointer',
    width: '100%', padding: '8px 0', display: 'flex',
    alignItems: 'center', justifyContent: 'center',
  },
  sidebarSection: { padding: '12px 12px', borderBottom: `1px solid ${c.border}` },
  sidebarSectionCollapsed: { padding: '10px 6px', borderBottom: `1px solid ${c.border}` },
  // Scrollable middle of the sidebar (between header and footer). The two
  // non-obvious props: `flex: 1` so it absorbs the space the header/footer
  // don't, and `minHeight: 0` to override the flex default `min-height:auto`,
  // which would otherwise grow this box to fit content and push the footer off
  // a short viewport (the exact bug this fixes). `overflowY:auto` then scrolls.
  sidebarScroll: {
    flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden',
    display: 'flex', flexDirection: 'column',
  } as React.CSSProperties,
  sectionHeader: {
    fontSize: 11, textTransform: 'uppercase', color: c.textMuted,
    letterSpacing: 0.8, marginBottom: 6, fontWeight: 500, paddingLeft: 4,
  },
  nav: { display: 'flex', flexDirection: 'column', gap: 1 },
  navCollapsed: { display: 'flex', flexDirection: 'column', gap: 2, alignItems: 'center' },
  navBtn: {
    padding: '7px 10px', borderRadius: radius.md, border: 'none',
    color: c.textSecondary, cursor: 'pointer', fontSize: 13, textAlign: 'left',
    background: 'transparent', fontWeight: 400, transition: 'all 0.15s',
    display: 'flex', alignItems: 'center', gap: 10,
  },
  navBtnActive: {
    background: c.bgMuted, color: c.text, fontWeight: 500,
  },
  navBtnCollapsed: {
    padding: '8px 0', borderRadius: radius.md, border: 'none',
    color: c.textSecondary, cursor: 'pointer',
    background: 'transparent', transition: 'all 0.15s',
    width: 40, height: 36, display: 'flex',
    alignItems: 'center', justifyContent: 'center',
  },
  navBtnCollapsedActive: {
    background: c.accentBg, color: c.accent,
  },
  sidebarFooter: {
    padding: '12px 12px', borderTop: `1px solid ${c.border}`,
  },
  sidebarFooterCollapsed: {
    padding: '10px 0', borderTop: `1px solid ${c.border}`,
    display: 'flex', flexDirection: 'column', alignItems: 'center',
  },
  logoutBtn: {
    padding: '6px 12px', borderRadius: radius.md, border: `1px solid ${c.border}`,
    background: 'transparent', color: c.textSecondary, cursor: 'pointer', fontSize: 12,
    width: '100%', transition: 'all 0.15s',
  },
  logoutBtnCollapsed: {
    padding: '8px 0', borderRadius: radius.md, border: `1px solid ${c.border}`,
    background: 'transparent', color: c.textSecondary, cursor: 'pointer',
    width: 40, height: 36, display: 'flex',
    alignItems: 'center', justifyContent: 'center',
    transition: 'all 0.15s',
  },
  versionLine: {
    fontSize: 11, color: c.textFaint, textAlign: 'center', marginBottom: 6,
    fontFamily: font.mono,
    background: 'none', border: 'none', cursor: 'pointer',
    width: '100%', display: 'block',
    padding: '2px 6px', borderRadius: radius.sm,
    transition: 'color 0.15s',
  } as React.CSSProperties,
  // ── Mobile overlay ──
  overlay: {
    position: 'fixed', inset: 0, zIndex: 150,
    background: c.bgOverlay,
  },
  // ── Mobile top bar ──
  mobileTopBar: {
    display: 'flex', alignItems: 'center', gap: 10,
    padding: '8px 12px', borderBottom: `1px solid ${c.border}`,
    flexShrink: 0, background: c.bgSubtle,
  },
  hamburger: {
    background: 'none', border: 'none', fontSize: 18,
    cursor: 'pointer', color: c.text, padding: '4px 6px', lineHeight: 1,
    borderRadius: radius.sm,
  },
  mobileTitle: {
    flex: 1, fontSize: 14, fontWeight: 600, color: c.text,
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  backBtn: {
    background: 'none', border: `1px solid ${c.border}`, borderRadius: radius.sm,
    color: c.textSecondary, fontSize: 13, padding: '4px 12px', cursor: 'pointer',
    flexShrink: 0,
  },
  // ── Main content ──
  main: { flex: 1, display: 'flex', overflow: 'hidden' },
  mainMobile: { flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' },
  contentArea: { flex: 1, display: 'flex', overflow: 'hidden' },
  emptyState: {
    flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
    padding: 16,
  },
  emptyText: { color: c.textMuted, fontSize: 14, textAlign: 'center' },
  // ── Desktop split ──
  splitView: { display: 'flex', flex: 1, overflow: 'hidden', position: 'relative' },
  filePanel: {
    minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden',
  },
  splitter: {
    width: 4, cursor: 'col-resize', background: c.border,
    flexShrink: 0, transition: 'background 0.15s',
  } as React.CSSProperties,
  splitterHover: {
    background: c.accent,
  } as React.CSSProperties,
  previewPanel: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' },
  previewHeader: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12,
    padding: '8px 16px', borderBottom: `1px solid ${c.border}`, background: c.bgSubtle,
  },
  previewActions: { display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 },
  headerLink: {
    color: c.textSecondary, fontSize: 12, textDecoration: 'none',
    padding: '4px 10px', borderRadius: radius.sm,
    border: `1px solid ${c.border}`, background: 'transparent',
    transition: 'all 0.15s',
  },
  previewPath: { color: c.textMuted, fontSize: 12, fontFamily: font.mono, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0 },
  closeBtn: {
    background: 'none', border: 'none', color: c.textMuted, fontSize: 18,
    cursor: 'pointer', padding: '0 4px', borderRadius: radius.sm,
  },
  // ── Mobile file/preview ──
  mobileFileWrap: { flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' },
  mobilePreviewWrap: { flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' },
  // ── Progress toasts ──
  progressToast: {
    position: 'fixed', bottom: 16, right: 16, zIndex: 1000,
    display: 'flex', flexDirection: 'column', gap: 6,
    maxWidth: 'calc(100vw - 32px)',
  },
  progressItem: {
    padding: '10px 14px', borderRadius: radius.lg,
    background: c.surface, border: `1px solid ${c.border}`,
    boxShadow: shadow.lg,
    display: 'flex', alignItems: 'center', gap: 10,
    fontSize: 12, color: c.textSecondary,
  },
  progressPhase: { color: c.accent, fontWeight: 600 },
  progressMsg: { color: c.text },
  progressBytes: { color: c.textMuted, fontFamily: font.mono },
  // ── Version toast ──
  versionToast: {
    position: 'fixed', bottom: 16, left: 16, zIndex: 1000,
    padding: '12px 16px', borderRadius: radius.lg,
    background: c.surface, border: `1px solid ${c.accent}`,
    boxShadow: shadow.lg,
    display: 'flex', flexDirection: 'column', gap: 10,
    maxWidth: 'calc(100vw - 32px)', minWidth: 240,
  },
  versionToastText: { color: c.text, fontSize: 13, lineHeight: 1.4 },
  versionToastActions: { display: 'flex', gap: 8 },
  versionToastReload: {
    padding: '6px 16px', borderRadius: radius.md, border: 'none',
    background: c.accent, color: '#fff', cursor: 'pointer', fontSize: 12,
    fontWeight: 500, transition: 'background 0.15s',
  },
  versionToastDismiss: {
    padding: '6px 16px', borderRadius: radius.md, border: `1px solid ${c.border}`,
    background: 'transparent', color: c.textSecondary, cursor: 'pointer', fontSize: 12,
    fontWeight: 500, transition: 'all 0.15s',
  },
  // ── About dialog ──
  aboutOverlay: {
    position: 'fixed', inset: 0, zIndex: 2000,
    background: c.bgOverlay,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    padding: 16,
  },
  aboutCard: {
    width: '100%', maxWidth: 380,
    background: c.surface, borderRadius: radius.lg,
    border: `1px solid ${c.border}`, boxShadow: shadow.lg,
    overflow: 'hidden',
    display: 'flex', flexDirection: 'column',
  },
  aboutHeader: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '16px 18px', borderBottom: `1px solid ${c.border}`,
    background: c.bgSubtle,
  },
  aboutLogo: {
    fontSize: 16, fontWeight: 700, color: c.text, fontFamily: font.sans,
    letterSpacing: '-0.01em',
  },
  aboutCloseBtn: {
    background: 'none', border: 'none', fontSize: 22, lineHeight: 1,
    color: c.textMuted, cursor: 'pointer', padding: '0 4px', borderRadius: radius.sm,
    transition: 'color 0.15s',
  },
  aboutBody: {
    padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 12,
  },
  aboutRow: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
  },
  aboutLabel: {
    fontSize: 12, color: c.textMuted, fontWeight: 500,
    textTransform: 'uppercase', letterSpacing: '0.04em',
  },
  aboutValue: {
    fontSize: 13, color: c.text, fontFamily: font.mono, fontWeight: 600,
  },
  aboutLink: {
    fontSize: 13, color: c.accent, textDecoration: 'none', fontWeight: 500,
  },
  aboutDoneBtn: {
    margin: '4px 18px 18px',
    padding: '9px 16px', borderRadius: radius.md, border: 'none',
    background: c.accent, color: '#fff', cursor: 'pointer', fontSize: 13,
    fontWeight: 600, transition: 'background 0.15s',
  },
};
