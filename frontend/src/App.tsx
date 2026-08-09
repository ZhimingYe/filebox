import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { useSession } from './state/session';
import { useHealth } from './state/health';
import { useSse } from './state/events';
import { useIsMobile } from './state/useIsMobile';
import {
  VIEW_STORAGE,
  LAST_AGENT_STORAGE,
  loadNavPosMap,
  loadPathMemoryMap,
  persistNavState,
  findNearestExistingDir,
  memKey,
} from './state/navPersistence';
import { Login } from './components/Login';
import { BackendList } from './components/BackendList';
import { FileBrowser } from './components/FileBrowser';
import { ExplorerView } from './components/ExplorerView';
import { PreviewPane } from './components/PreviewPane';
import { PreviewErrorBoundary } from './components/PreviewErrorBoundary';
import { PreviewWorkspace } from './components/PreviewWorkspace';
import { PreviewHeaderActions } from './components/PreviewHeaderActions';
import { usePreviewTabs } from './hooks/usePreviewTabs';
import { AgentSettings } from './components/AgentSettings';
import { AboutDialog } from './components/AboutDialog';
import { SystemStats } from './components/SystemStats';
import { SearchFloatWindow } from './components/SearchFloatWindow';
import { SearchBottomSheet } from './components/SearchBottomSheet';
import { PinnedFolders } from './components/PinnedFolders';
import { CollectionsView } from './components/CollectionsView';
import { WorkspaceSplit } from './components/WorkspaceSplit';
import { CollectionPicker } from './components/CollectionPicker';
import { NoAgentSelected } from './components/NoAgentSelected';
import {
  IconChevronLeft,
  IconFolder,
  IconExplorer,
  IconCollection,
  IconSearch,
  IconSettings,
  IconStats,
  IconLogout,
  IconMenu,
  IconClose,
  IconBrandMark,
} from './components/icons';
import type { FsEntry } from './api/client';
import * as api from './api/client';
import { c, radius, shadow, font } from './theme';

const VERSION_TOAST_DISMISS_KEY = 'filebox.newVersionDismissed';

/** Desktop rail widths (px). Keep in sync with `styles.sidebarPanel` targets. */
const SIDEBAR_W_EXPANDED = 180;
const SIDEBAR_W_COLLAPSED = 48;
/** Must match `transition` duration on the desktop sidebar panel. */
const SIDEBAR_WIDTH_MS = 180;

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

type View = 'files' | 'explorer' | 'collections' | 'settings' | 'stats';

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

  // ── Refresh persistence ──
  // The selected agent and the Files/Explorer mode are restored from
  // localStorage on load (Settings/Stats/Collections stay session-scoped and
  // always start on Files); the browse positions are seeded into the refs
  // below. Restored positions are validated once per (agent, root) pair (see
  // the fsStat effect): a folder that vanished since the last visit falls
  // back to the nearest existing ancestor instead of stranding the user on
  // an error screen.
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(() => {
    try { return localStorage.getItem(LAST_AGENT_STORAGE); } catch { return null; }
  });
  const [view, setView] = useState<View>(() => {
    try { return localStorage.getItem(VIEW_STORAGE) === 'explorer' ? 'explorer' : 'files'; }
    catch { return 'files'; }
  });
  // Floating Search window (desktop + mobile). Toggled by the sidebar nav
  // button and independent of `view`, so Files/Explorer/… stay visible
  // underneath while the window is open. Stays mounted when closed so long
  // scans survive.
  const [searchOpen, setSearchOpen] = useState(false);
  // Desktop multi-tab / mobile single-tab preview state. The hook owns tab
  // lifecycle (open/activate/replace/close/prune); App only orchestrates when
  // those operations happen (file click, agent switch, root invalidation,
  // keyboard nav). Mobile is driven through `replaceAll` so it always has at
  // most one tab, preserving the existing list-or-preview model.
  const previewTabs = usePreviewTabs();
  const activeTab = previewTabs.activeTab;
  const [progressMap, setProgressMap] = useState<Map<string, ProgressEvent>>(new Map());
  const progressTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Imperative navigation request from the sidebar PinnedFolders section into
  // the FileBrowser. Driven by `nonce` so re-clicking the same pin still
  // navigates. Cleared via onNavHandled once the browser has acted on it.
  const [navRequest, setNavRequest] = useState<{ root: string; path: string; nonce: number } | null>(null);
  const [collectionPicker, setCollectionPicker] = useState<{
    root: string;
    path: string;
    anchor: HTMLElement;
  } | null>(null);

  // Persist the browsing mode and the selected agent so a refresh restores
  // them. Storage may be unavailable in hardened/private contexts — never
  // let a persistence failure break the session.
  useEffect(() => {
    try { localStorage.setItem(VIEW_STORAGE, view); } catch { /* ignore */ }
  }, [view]);
  useEffect(() => {
    try {
      if (selectedAgentId) localStorage.setItem(LAST_AGENT_STORAGE, selectedAgentId);
      else localStorage.removeItem(LAST_AGENT_STORAGE);
    } catch { /* ignore */ }
  }, [selectedAgentId]);
  // A restored agent id that no longer exists (backend removed/renamed) must
  // not keep highlighting a ghost in the sidebar — NoAgentSelected takes over.
  useEffect(() => {
    if (!selectedAgentId || agents.length === 0) return;
    if (!agents.some((a) => a.id === selectedAgentId)) setSelectedAgentId(null);
  }, [agents, selectedAgentId]);

  // Locate request for the Explorer tree (search jump while in Explorer
  // mode): the nonce re-arms the "Located the folder." notice even when the
  // target folder is the one already revealed.
  const [explorerLocate, setExplorerLocate] = useState<{ nonce: number } | null>(null);

  // ── File browsing position, owned HERE (not in FileBrowser) ──
  // FileBrowser unmounts when the user leaves the Files view (Settings/
  // Stats), so any state it held was lost on remount — jumping back to the
  // first root. Owning the position here (App never unmounts) makes it survive
  // view switches, and remembering per-(agent,root) lets each combination
  // keep its own place.
  //
  // - filePosByAgent: last viewed {root, path} per agent.
  // - pathMemory: last path per (agent:root) — so switching roots within an
  //   agent restores each root's own position.
  // Seeded once from localStorage (lazy useState initializers) so a refresh
  // restores every agent's last position; from then on the maps live in
  // memory for the session.
  const [filePosSeed] = useState(loadNavPosMap);
  const [pathMemSeed] = useState(loadPathMemoryMap);
  const filePosByAgent = useRef(filePosSeed);
  const pathMemory = useRef(pathMemSeed);
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
  //
  // Performance model (do not "simplify" back to transitioning flex width):
  // - A layout *spacer* owns the main-column flex width. It does NOT animate.
  // - An absolute *panel* animates width (the visible motion).
  // - Expand: spacer stays narrow while the panel grows over the main area;
  //   spacer jumps to full width on transitionend → main reflows once.
  // - Collapse: spacer jumps to the rail width immediately (main reflows once
  //   up front) while the still-wide panel shrinks as an overlay.
  // Animating the spacer/flex width itself reflows PDF/virtual lists every
  // frame and is what stuttered under load.
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem('filebox.sidebarCollapsed') === '1'; }
    catch { return false; }
  });
  const [sidebarSpacerW, setSidebarSpacerW] = useState<number>(() => {
    try {
      return localStorage.getItem('filebox.sidebarCollapsed') === '1'
        ? SIDEBAR_W_COLLAPSED
        : SIDEBAR_W_EXPANDED;
    } catch {
      return SIDEBAR_W_EXPANDED;
    }
  });
  const [sidebarWidthAnimating, setSidebarWidthAnimating] = useState(false);
  const sidebarCollapsedRef = useRef(sidebarCollapsed);
  sidebarCollapsedRef.current = sidebarCollapsed;

  useEffect(() => {
    try { localStorage.setItem('filebox.sidebarCollapsed', sidebarCollapsed ? '1' : '0'); }
    catch { /* ignore */ }
  }, [sidebarCollapsed]);

  // Safety net: if transitionend is skipped (tab backgrounded, reduced-motion
  // race, mid-flight reverse), still commit the spacer so layout can't stick.
  useEffect(() => {
    if (!sidebarWidthAnimating) return;
    const t = window.setTimeout(() => {
      setSidebarSpacerW(
        sidebarCollapsedRef.current ? SIDEBAR_W_COLLAPSED : SIDEBAR_W_EXPANDED,
      );
      setSidebarWidthAnimating(false);
      document.body.classList.remove('sidebar-resizing');
    }, SIDEBAR_WIDTH_MS + 80);
    return () => window.clearTimeout(t);
  }, [sidebarWidthAnimating, sidebarCollapsed]);

  useEffect(() => () => {
    document.body.classList.remove('sidebar-resizing');
  }, []);

  const commitSidebarSpacer = useCallback(() => {
    setSidebarSpacerW(
      sidebarCollapsedRef.current ? SIDEBAR_W_COLLAPSED : SIDEBAR_W_EXPANDED,
    );
    setSidebarWidthAnimating(false);
    document.body.classList.remove('sidebar-resizing');
  }, []);

  const toggleSidebarCollapsed = useCallback(() => {
    const reduceMotion =
      typeof window !== 'undefined'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    setSidebarCollapsed((prev) => {
      const next = !prev;
      if (reduceMotion) {
        setSidebarSpacerW(next ? SIDEBAR_W_COLLAPSED : SIDEBAR_W_EXPANDED);
        setSidebarWidthAnimating(false);
        document.body.classList.remove('sidebar-resizing');
      } else {
        setSidebarWidthAnimating(true);
        document.body.classList.add('sidebar-resizing');
        if (next) {
          // Collapsing: free main width immediately; panel shrinks on top.
          setSidebarSpacerW(SIDEBAR_W_COLLAPSED);
        }
        // Expanding: keep spacer narrow until transitionend (panel overlays).
      }
      return next;
    });
  }, []);

  const onDesktopSidebarTransitionEnd = useCallback(
    (e: React.TransitionEvent<HTMLDivElement>) => {
      if (e.propertyName !== 'width') return;
      if (e.target !== e.currentTarget) return;
      commitSidebarSpacer();
    },
    [commitSidebarSpacer],
  );

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

  // ── Keyboard navigation: cache last reported file list ──
  const fileListRef = useRef<{ root: string; path: string; entries: FsEntry[] } | null>(null);
  const handleEntriesChange = useCallback((info: { root: string; path: string; entries: FsEntry[] }) => {
    fileListRef.current = info;
  }, []);

  // Esc closes the active tab; ← → replace it with the previous/next
  // file in the directory currently shown by FileBrowser.
  // Files and Collections both use preview tabs; Settings/Stats do not.
  useEffect(() => {
    if (
      !activeTab
      || (view !== 'files' && view !== 'explorer' && view !== 'collections')
    ) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return;
      }
      if (e.key === 'Escape') {
        // CollectionPicker handles its own Esc in capture phase.
        if (collectionPicker) return;
        // Floating Search window claims Esc while open, before any preview
        // tab, so Esc means "close the window" there.
        if (searchOpen) {
          setSearchOpen(false);
          return;
        }
        previewTabs.close(activeTab.id);
        return;
      }
      // Arrow prev/next only applies in Files view (directory context).
      if (view !== 'files') return;
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const info = fileListRef.current;
      if (!info || info.root !== activeTab.root) return;
      const previewDir = activeTab.path.replace(/\/[^/]*$/, '') || '/';
      if (info.path !== previewDir) return;
      const files = info.entries.filter((entry) => entry.entry_type === 'file' && !entry.denied);
      const currentName = activeTab.path.split('/').pop() || '';
      const idx = files.findIndex((entry) => entry.name === currentName);
      if (idx === -1) return;
      const nextIdx = e.key === 'ArrowRight'
        ? idx + 1
        : idx - 1;
      if (nextIdx < 0 || nextIdx >= files.length) return;
      e.preventDefault();
      const next = files[nextIdx];
      const nextPath = (previewDir === '/' ? '' : previewDir) + '/' + next.name;
      previewTabs.replaceActive({
        agentId: activeTab.agentId,
        root: activeTab.root,
        path: nextPath,
        entry: next,
      });
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [activeTab, previewTabs, view, collectionPicker, searchOpen]);

  // Esc also closes the floating Search window when no preview tab is open
  // (the handler above early-returns without one).
  useEffect(() => {
    if (!searchOpen) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return;
      }
      if (e.key === 'Escape') setSearchOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [searchOpen]);

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

  // Drop preview tabs whose root can no longer be served: either the agent
  // has no enabled roots at all, or a tab's own root got disabled/removed.
  // Both would otherwise leave a stale preview pointing at an inaccessible
  // file (root_unavailable error on fetch). pruneByRoots removes the affected
  // tabs and re-picks the nearest surviving active tab automatically.
  useEffect(() => {
    if (previewTabs.tabs.length === 0) return;
    const enabled = new Set(enabledRoots.map((r) => r.name));
    if (previewTabs.tabs.some((t) => !enabled.has(t.root))) {
      previewTabs.pruneByRoots(enabled);
    }
  }, [enabledRoots, previewTabs]);

  // Atomically apply a navigation for the current agent: update state + record
  // both the per-agent position and the per-root path memory, then persist so
  // a refresh restores this position.
  const applyNav = useCallback((root: string, path: string) => {
    setSelectedRoot(root);
    setCurrentPath(path);
    if (selectedAgent) {
      filePosByAgent.current.set(selectedAgent.id, { root, path });
      pathMemory.current.set(memKey(selectedAgent.id, root), path);
      persistNavState(filePosByAgent.current, pathMemory.current);
    }
  }, [selectedAgent]);

  // Refresh-restore validation: a restored position may point at a folder
  // that vanished since the last visit. Once per (agent, root) pair per
  // session, stat the restored path and fall back to the nearest existing
  // ancestor. Only a definitive miss (stat:null) walks up; transient
  // failures keep the position and let FileBrowser surface its own error
  // instead. Navigating away while the probe is in flight aborts it so it
  // can't clobber newer user intent. User-driven navigation is never
  // validated — it always went through a successful listing.
  const validatedPairsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!selectedAgent || !selectedRoot) return;
    // The restore commit (reconcile effect) lands one render after the agent
    // itself arrives — until the root actually belongs to this agent, the
    // values are stale leftovers from the previous agent and must not be
    // probed (nor the pair marked validated).
    if (!selectedAgent.roots.some((r) => r.name === selectedRoot)) return;
    const pairKey = memKey(selectedAgent.id, selectedRoot);
    if (validatedPairsRef.current.has(pairKey)) return;
    if (currentPath === '/') {
      // The root itself can't vanish — mark the pair so it isn't re-probed.
      validatedPairsRef.current.add(pairKey);
      return;
    }
    const agentId = selectedAgent.id;
    const root = selectedRoot;
    const path = currentPath;
    const controller = new AbortController();
    (async () => {
      const nearest = await findNearestExistingDir(agentId, root, path, controller.signal);
      if (controller.signal.aborted) return;
      // Marked only after the probe completes, so an abort (navigation away)
      // never burns the pair's validation — a later visit still probes.
      validatedPairsRef.current.add(pairKey);
      if (nearest === null || nearest === path) return;
      applyNav(root, nearest);
    })();
    return () => controller.abort();
  }, [selectedAgent, selectedRoot, currentPath, applyNav]);

  // Explorer ↔ Files directory sync. Explorer reports the directory the user
  // is browsing (expand a folder / open a file), which lands in the same
  // shared browse position FileBrowser is controlled by — so both views point
  // at the same directory. Conversely, `currentDir` below feeds the Files
  // position back into Explorer, which reveals that directory in the tree.
  const handleExplorerDirNav = useCallback((root: string, path: string) => {
    applyNav(root, path);
  }, [applyNav]);

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
  const handleFileSelect = useCallback((
    root: string,
    path: string,
    entry: FsEntry,
    opts?: { refresh?: boolean },
  ) => {
    if (!selectedAgentId) return;
    const input = {
      agentId: selectedAgentId,
      root,
      path,
      entry,
      ...(opts?.refresh ? { refresh: true } : {}),
    };
    // Desktop opens/activates a tab per file; mobile keeps a single active
    // tab (its list-or-preview model replaces the tab list on each open).
    // Depends on selectedAgentId (not the whole selectedAgent object) so the
    // callback stays referentially stable across health refreshes.
    if (isMobile) {
      previewTabs.replaceAll(input);
    } else {
      previewTabs.openOrActivate(input);
    }
  }, [isMobile, selectedAgentId, previewTabs]);

  const selectAgent = useCallback((id: string) => {
    setSelectedAgentId(id);
    setView('files');
    // Agent switch clears all preview tabs, matching the prior single-preview
    // behavior — previews never outlive the agent they belong to.
    previewTabs.closeAll();
    if (isMobile) setSidebarOpen(false);
  }, [isMobile, previewTabs]);

  const navigate = useCallback((v: View) => {
    if (isMobile && v !== view) previewTabs.closeAll();
    setView(v);
    if (isMobile) setSidebarOpen(false);
  }, [isMobile, previewTabs, view]);

  // Auto-refresh health and track progress when SSE events arrive
  useSse(useCallback((evt) => {
    if (
      evt.event === 'agent_connected' ||
      evt.event === 'agent_disconnected' ||
      evt.event === 'resources_updated' ||
      evt.event === 'collections_updated' ||
      evt.event === 'sync_required'
    ) {
      refresh();
    }
    if (evt.event === 'progress') {
      const d = evt.data as unknown as ProgressEvent;
      // Workspace Search owns its own progress panel; skip the global toast
      // so long scans don't flash / steal attention from Files etc.
      if (d.phase === 'search') return;
      // Office conversion owns LoadingOverlay in OfficePreview; hub/agent also used
      // phase steps (0/3) that were wrongly rendered as "0 B / 3 B".
      if (d.req_id.startsWith('office_convert_')) return;
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

  const openCollectionPicker = useCallback((root: string, path: string, anchor: HTMLElement) => {
    setCollectionPicker({ root, path, anchor });
  }, []);
  const closeCollectionPicker = useCallback(() => {
    setCollectionPicker(null);
  }, []);

  const openInFiles = useCallback((root: string, path: string) => {
    // Mobile: the full-screen search sheet would otherwise keep covering the
    // view it just navigated to.
    if (isMobile) setSearchOpen(false);
    // Remember the browsing mode: in Explorer, stay in the tree and let the
    // shared position reveal the folder — the tree expands the ancestors,
    // selects, and scrolls to it, and the locate nonce fires the
    // "Located the folder." notice once the reveal settles. Everywhere else
    // lands in Files as before.
    if (view === 'explorer') {
      if (isMobile) previewTabs.closeAll();
      applyNav(root, path);
      setExplorerLocate((prev) => ({ nonce: (prev?.nonce ?? 0) + 1 }));
      return;
    }
    // Mobile is list-OR-preview: leaving the current file open would bury
    // the jumped-to folder under the full-screen preview, so close it (same
    // rule as Pinned Folders).
    if (isMobile) previewTabs.closeAll();
    setView('files');
    setNavRequest({ root, path, nonce: Date.now() });
  }, [isMobile, view, applyNav, previewTabs]);

  // "Open in preview pane" from a search hit: switch to Files (where the
  // preview pane lives — on mobile that surfaces the full-screen preview)
  // and open the hit as a tab. Search hits are always files, so the entry is
  // synthesized; the preview pane dispatches on the path extension and the
  // viewers fetch content themselves.
  const handlePreviewFromSearch = useCallback((root: string, path: string) => {
    // Mobile: close the full-screen sheet first so the full-screen preview
    // (and the top-bar Back button) is visible. Desktop keeps the float open
    // — the preview opens in the pane behind it.
    if (isMobile) setSearchOpen(false);
    // Remember the browsing mode: in Explorer the preview opens in its own
    // split pane (on mobile that's the full-screen preview with
    // Back → "Back to Explorer"); everywhere else it opens in Files.
    if (view !== 'explorer') setView('files');
    const name = path.split('/').filter(Boolean).pop() ?? path;
    const entry: FsEntry = { name, entry_type: 'file', size: null, modified: null, denied: false };
    // `refresh: true` — a search "view" is an explicit "look again": if the
    // file already has a tab, the preview body must remount and re-fetch
    // instead of silently showing stale content.
    handleFileSelect(root, path, entry, { refresh: true });
  }, [handleFileSelect, isMobile, view]);

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
  const compactSidebar = !isMobile;
  // Search is a floating window on both desktop and mobile; the nav button
  // toggles it instead of switching views.

  const navItems = [
    { v: 'files' as const, label: 'Files', Icon: IconFolder },
    { v: 'explorer' as const, label: 'Explorer', Icon: IconExplorer },
    { v: 'collections' as const, label: 'Collections', Icon: IconCollection },
    { v: 'search' as const, label: 'Search', Icon: IconSearch },
    { v: 'settings' as const, label: 'Settings', Icon: IconSettings },
    { v: 'stats' as const, label: 'System', Icon: IconStats },
  ];

  // Section chrome: spacing + optional hairline — not a border on every block.
  const sectionStyle = collapsed
    ? styles.sidebarSectionCollapsed
    : { ...styles.sidebarSection, ...(isMobile ? styles.sidebarSectionMobile : styles.sidebarSectionCompact) };

  const sidebarContent = (
    <>
      <div
        style={collapsed
          ? styles.sidebarHeaderCollapsed
          : { ...styles.sidebarHeader, ...(isMobile ? styles.sidebarHeaderMobile : styles.sidebarHeaderCompact) }}
      >
        {collapsed ? (
          <button
            type="button"
            onClick={toggleSidebarCollapsed}
            style={styles.collapseToggleCollapsed}
            title="Expand sidebar"
            aria-label="Expand sidebar"
          >
            <span style={styles.brandMark}><IconBrandMark style={{ width: 18, height: 18 }} /></span>
          </button>
        ) : (
          <>
            <div style={styles.brandRow}>
              <span style={styles.brandMark}><IconBrandMark style={{ width: 18, height: 18 }} /></span>
              <span style={styles.logo}>filebox</span>
            </div>
            {isMobile ? (
              <button
                type="button"
                onClick={() => setSidebarOpen(false)}
                style={styles.headerIconBtn}
                title="Close menu"
                aria-label="Close menu"
              >
                <IconClose />
              </button>
            ) : (
              <button
                type="button"
                onClick={toggleSidebarCollapsed}
                style={styles.headerIconBtn}
                title="Collapse sidebar"
                aria-label="Collapse sidebar"
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
        <div style={sectionStyle}>
          {!collapsed && <div style={styles.sectionHeader}>Agents</div>}
          <BackendList
            agents={agents}
            selectedId={selectedAgentId}
            onSelect={selectAgent}
            collapsed={collapsed}
            compact={compactSidebar}
          />
        </div>

        {selectedAgent && (
          <>
            {!collapsed && <div style={styles.sectionRule} aria-hidden />}
            <div style={sectionStyle}>
              {!collapsed && <div style={styles.sectionHeader}>Workspace</div>}
              <div style={collapsed ? styles.navCollapsed : styles.nav}>
                {navItems.map(({ v, label, Icon }) => (
                  <SidebarNavButton
                    key={v}
                    label={label}
                    Icon={Icon}
                    active={v === 'search' ? searchOpen : view === v}
                    collapsed={collapsed}
                    onClick={() => {
                      if (v === 'search') {
                        setSearchOpen((o) => !o);
                        // Mobile: the drawer hosting the nav button closes
                        // too, matching navigate()'s behavior.
                        if (isMobile) setSidebarOpen(false);
                        return;
                      }
                      navigate(v);
                    }}
                  />
                ))}
              </div>
            </div>
          </>
        )}

        {selectedAgent && pinnedCount > 0 && (
          <>
            {!collapsed && <div style={styles.sectionRule} aria-hidden />}
            <div style={sectionStyle}>
              {!collapsed && <div style={styles.sectionHeader}>Pinned</div>}
              <PinnedFolders
                agent={selectedAgent}
                collapsed={collapsed}
                onNavigate={(root, path) => {
                  // Always land in the Files view (even from Settings/Stats).
                  // Desktop keeps preview tabs: side-by-side layout matches tree
                  // and address-bar navigation, so re-clicking the same pin (or
                  // jumping to another folder) must not wipe open previews.
                  // Mobile is list-OR-preview: leave tabs open and the folder
                  // list stays buried under the current file, so close them.
                  if (isMobile) previewTabs.closeAll();
                  navigate('files');
                  setNavRequest({ root, path, nonce: Date.now() });
                }}
                onUnpin={(root, path) => handleUnpin(selectedAgent.id, root, path)}
              />
            </div>
          </>
        )}
        <div style={{ flex: 1 }} />
      </div>

      {/* System strip: version is telemetry; sign-out is utility — not CTAs. */}
      <div style={collapsed ? styles.sidebarFooterCollapsed : styles.sidebarFooter}>
        {!collapsed ? (
          <div style={styles.footerStrip}>
            {health?.hub.version ? (
              <button
                type="button"
                onClick={handleOpenAbout}
                title="About filebox"
                style={styles.aboutEntry}
              >
                <span style={styles.aboutVersion}>v{health.hub.version}</span>
              </button>
            ) : (
              <span />
            )}
            <SidebarLogoutButton collapsed={false} onClick={logout} />
          </div>
        ) : (
          <>
            {health?.hub.version && (
              <button
                type="button"
                onClick={handleOpenAbout}
                title={`About filebox v${health.hub.version}`}
                style={styles.aboutEntryCollapsed}
              >
                <span style={styles.aboutVersionCollapsed}>
                  {health.hub.version.split('.').slice(0, 2).join('.')}
                </span>
              </button>
            )}
            <SidebarLogoutButton collapsed onClick={logout} />
          </>
        )}
      </div>
    </>
  );

  // ── Mobile file view: show list OR preview, not both ──
  const showMobilePreview = isMobile && !!activeTab
    && (view === 'files' || view === 'explorer' || view === 'collections');

  return (
    <div style={styles.app}>
      {/* Mobile overlay */}
      {isMobile && sidebarOpen && (
        <div
          style={styles.overlay}
          onClick={() => setSidebarOpen(false)}
          aria-hidden
        />
      )}

      {/* Sidebar */}
      {isMobile ? (
        <div
          style={{
            ...styles.sidebarExpanded,
            ...styles.sidebarDrawer,
            // translate3d keeps the drawer on the compositor; no main reflow.
            transform: sidebarOpen ? 'translate3d(0,0,0)' : 'translate3d(-100%,0,0)',
            // Hint only while the drawer is on-screen or mid-gesture.
            willChange: sidebarOpen ? 'transform' : 'auto',
          }}
          role="dialog"
          aria-modal="true"
          aria-label="Navigation"
          aria-hidden={!sidebarOpen}
        >
          {sidebarContent}
        </div>
      ) : (
        // Spacer owns flex layout width (no transition). Panel is absolute and
        // animates width — expand overlays main then spacer commits; collapse
        // frees main immediately while the panel shrinks as an overlay.
        <div
          style={{
            ...styles.sidebarSlot,
            width: sidebarSpacerW,
          }}
        >
          <div
            className="filebox-sidebar-panel"
            style={{
              ...styles.sidebarPanel,
              width: collapsed ? SIDEBAR_W_COLLAPSED : SIDEBAR_W_EXPANDED,
              willChange: sidebarWidthAnimating ? 'width' : 'auto',
              ...(sidebarWidthAnimating && !collapsed ? styles.sidebarPanelOverlaying : null),
            }}
            onTransitionEnd={onDesktopSidebarTransitionEnd}
          >
            {sidebarContent}
          </div>
        </div>
      )}

      {/* Main content */}
      <div style={isMobile ? styles.mainMobile : styles.main}>
        {/* Mobile top bar */}
        {isMobile && (
          <div style={styles.mobileTopBar}>
            <button
              type="button"
              onClick={() => setSidebarOpen(true)}
              style={styles.hamburger}
              title="Open menu"
              aria-label="Open menu"
            >
              <IconMenu />
            </button>
            <div style={styles.mobileTitleBlock}>
              <span style={styles.mobileTitle}>{selectedAgent?.name || 'filebox'}</span>
              {selectedAgent && (
                <span style={styles.mobileSubtitle}>
                  <span
                    style={{
                      ...styles.mobileStatusDot,
                      background:
                        selectedAgent.status === 'online' ? c.success
                          : selectedAgent.status === 'slow' ? c.warning
                            : c.textMuted,
                    }}
                  />
                  <span style={styles.mobileTelemetry}>
                    {selectedAgent.status}
                    {selectedAgent.rtt_ms !== null ? ` · ${selectedAgent.rtt_ms} ms` : ''}
                  </span>
                </span>
              )}
            </div>
            {showMobilePreview && (
              <button
                type="button"
                onClick={() => previewTabs.closeAll()}
                style={styles.backBtn}
                title={
                  view === 'collections'
                    ? 'Back to collection'
                    : view === 'explorer'
                      ? 'Back to Explorer'
                      : 'Back to files'
                }
              >
                <IconChevronLeft />
                <span>Back</span>
              </button>
            )}
            {/* Search entry — opens the same bottom sheet as the sidebar
                Search button. Reuses the hamburger's look so the bar reads
                as [menu] [title/status] [back?] [search]. Only shown with an
                agent: search has nothing to search without one. While the
                sheet is open its backdrop covers this bar, so the button is
                an opener only (close via backdrop / × / swipe / Esc). */}
            {selectedAgent && (
              <button
                type="button"
                onClick={() => setSearchOpen(true)}
                style={styles.hamburger}
                title="Search"
                aria-label="Search"
              >
                <IconSearch style={{ width: 17, height: 17 }} />
              </button>
            )}
          </div>
        )}

        {/* Content area */}
        <div style={styles.contentArea}>
          {!selectedAgent ? (
            <NoAgentSelected
              agents={agents}
              isMobile={isMobile}
              onOpenSidebar={isMobile ? () => setSidebarOpen(true) : undefined}
              onSelectAgent={selectAgent}
            />
          ) : (
            <>
              {/* Keep FileBrowser mounted across Files/Settings/Stats and across
                  the mobile breakpoint so filter/sort/tree/scroll state survive.
                  Hidden with visibility:hidden + absolute positioning (not
                  unmounted, and not display:none — see filesViewHidden) when
                  another view is active — same idea as mobile preview toggle. */}
              <div
                style={{
                  ...(isMobile ? styles.mobileFilesLayout : styles.splitViewShell),
                  // Hide the Files shell when another view is active, and on
                  // mobile while the full-screen preview is open. Keeping the
                  // shell as a flex:1 sibling of mobilePreviewWrap would leave
                  // the preview stuck in the right half of contentArea.
                  ...(view !== 'files' || (isMobile && showMobilePreview)
                    ? styles.filesViewHidden
                    : {}),
                }}
              >
                {isMobile ? (
                  <>
                    <div style={styles.mobileFileWrap}>
                      <FileBrowser
                        agentId={selectedAgent.id}
                        roots={selectedAgent.roots}
                        onFileSelect={handleFileSelect}
                        onEntriesChange={handleEntriesChange}
                        onRootsChange={refresh}
                        onAddToCollection={openCollectionPicker}
                        navRequest={navRequest}
                        onNavHandled={() => setNavRequest(null)}
                        selectedRoot={selectedRoot}
                        currentPath={currentPath}
                        onApplyNav={applyNav}
                        onSwitchRoot={switchRoot}
                      />
                    </div>
                  </>
                ) : (
                  <WorkspaceSplit
                    splitRatio={splitRatio}
                    onSplitRatioChange={setSplitRatio}
                    showPreview={view === 'files' && !!activeTab}
                    list={(
                      <FileBrowser
                        agentId={selectedAgent.id}
                        roots={selectedAgent.roots}
                        onFileSelect={handleFileSelect}
                        onEntriesChange={handleEntriesChange}
                        onRootsChange={refresh}
                        onAddToCollection={openCollectionPicker}
                        navRequest={navRequest}
                        onNavHandled={() => setNavRequest(null)}
                        selectedRoot={selectedRoot}
                        currentPath={currentPath}
                        onApplyNav={applyNav}
                        onSwitchRoot={switchRoot}
                      />
                    )}
                    preview={view === 'files' && activeTab ? (
                      <PreviewWorkspace
                        agentId={selectedAgent.id}
                        tabs={previewTabs.tabs}
                        activeTab={activeTab}
                        activeTabId={previewTabs.activeTabId}
                        mountedTabIds={previewTabs.mountedTabIds}
                        onActivate={previewTabs.activate}
                        onClose={previewTabs.close}
                        onCloseAll={previewTabs.closeAll}
                        onCloseLeft={previewTabs.closeLeft}
                        onCloseRight={previewTabs.closeRight}
                        onRefresh={previewTabs.refresh}
                        roots={selectedAgent.roots}
                        officeCapable={!!selectedAgent.capabilities?.office_pdf_preview}
                      />
                    ) : null}
                  />
                )}
              </div>
              <div
                style={{
                  ...(isMobile ? styles.mobileFilesLayout : styles.splitViewShell),
                  ...(view !== 'explorer' || (isMobile && showMobilePreview)
                    ? styles.filesViewHidden
                    : {}),
                }}
              >
                {isMobile ? (
                  <div style={styles.mobileFileWrap}>
                    <ExplorerView
                      agentId={selectedAgent.id}
                      roots={selectedAgent.roots}
                      active={view === 'explorer' && !showMobilePreview}
                      currentDir={selectedRoot ? { root: selectedRoot, path: currentPath } : null}
                      locateRequest={explorerLocate}
                      onNavigateDir={handleExplorerDirNav}
                      onFileSelect={handleFileSelect}
                      onAddToCollection={openCollectionPicker}
                      onRootsChange={refresh}
                    />
                  </div>
                ) : (
                  <WorkspaceSplit
                    splitRatio={splitRatio}
                    onSplitRatioChange={setSplitRatio}
                    showPreview={view === 'explorer' && !!activeTab}
                    list={(
                      <ExplorerView
                        agentId={selectedAgent.id}
                        roots={selectedAgent.roots}
                        active={view === 'explorer'}
                        currentDir={selectedRoot ? { root: selectedRoot, path: currentPath } : null}
                        locateRequest={explorerLocate}
                        onNavigateDir={handleExplorerDirNav}
                        onFileSelect={handleFileSelect}
                        onAddToCollection={openCollectionPicker}
                        onRootsChange={refresh}
                      />
                    )}
                    preview={view === 'explorer' && activeTab ? (
                      <PreviewWorkspace
                        agentId={selectedAgent.id}
                        tabs={previewTabs.tabs}
                        activeTab={activeTab}
                        activeTabId={previewTabs.activeTabId}
                        mountedTabIds={previewTabs.mountedTabIds}
                        onActivate={previewTabs.activate}
                        onClose={previewTabs.close}
                        onCloseAll={previewTabs.closeAll}
                        onCloseLeft={previewTabs.closeLeft}
                        onCloseRight={previewTabs.closeRight}
                        onRefresh={previewTabs.refresh}
                        roots={selectedAgent.roots}
                        officeCapable={!!selectedAgent.capabilities?.office_pdf_preview}
                      />
                    ) : null}
                  />
                )}
              </div>
              {isMobile && showMobilePreview && activeTab
                && (view === 'files' || view === 'explorer' || view === 'collections') && (
                <div style={styles.mobilePreviewWrap}>
                  <div style={styles.previewHeader}>
                    <span style={styles.previewPath}>{activeTab.path}</span>
                    <div style={styles.previewActions}>
                      <PreviewHeaderActions
                        agentId={selectedAgent.id}
                        tab={activeTab}
                        roots={selectedAgent.roots}
                        onRefresh={previewTabs.refresh}
                      />
                    </div>
                  </div>
                  <PreviewErrorBoundary key={`${activeTab.id}:${activeTab.rev}`}>
                    <PreviewPane
                      agentId={selectedAgent.id}
                      root={activeTab.root}
                      path={activeTab.path}
                      entryType={activeTab.entry.entry_type}
                      denied={activeTab.entry.denied}
                      officeCapable={!!selectedAgent.capabilities?.office_pdf_preview}
                    />
                  </PreviewErrorBoundary>
                </div>
              )}
              {view === 'collections' && (
                <div style={{
                  ...styles.secondaryView,
                  ...(isMobile && showMobilePreview ? styles.filesViewHidden : {}),
                }}>
                  <CollectionsView
                    agent={selectedAgent}
                    previewTabs={previewTabs}
                    splitRatio={splitRatio}
                    onSplitRatioChange={setSplitRatio}
                    onOpenInFiles={openInFiles}
                    onRefresh={refresh}
                    hideList={isMobile && showMobilePreview}
                    hidePreview={isMobile}
                  />
                </div>
              )}
              {view === 'settings' && (
                <div style={styles.secondaryView}>
                  <AgentSettings agent={selectedAgent} onRefresh={refresh} />
                </div>
              )}
              {view === 'stats' && (
                <div style={styles.secondaryView}>
                  <SystemStats agentId={selectedAgent.id} />
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* Search panel — stays mounted (hidden while closed) so long scans
          survive closing, same guarantee as the old inline view. Desktop:
          draggable/resizable floating window. Mobile: iOS-style bottom sheet
          sliding up over the lower half of the screen. */}
      {selectedAgent && (
        isMobile ? (
          <SearchBottomSheet
            open={searchOpen}
            agent={selectedAgent}
            initialRoot={selectedRoot}
            onOpenFile={openInFiles}
            onPreviewFile={handlePreviewFromSearch}
            onClose={() => setSearchOpen(false)}
          />
        ) : (
          <SearchFloatWindow
            open={searchOpen}
            agent={selectedAgent}
            initialRoot={selectedRoot}
            onOpenFile={openInFiles}
            onPreviewFile={handlePreviewFromSearch}
            onClose={() => setSearchOpen(false)}
          />
        )
      )}

      {collectionPicker && selectedAgent && (
        <CollectionPicker
          agent={selectedAgent}
          target={{ root: collectionPicker.root, path: collectionPicker.path }}
          anchorEl={collectionPicker.anchor}
          onClose={closeCollectionPicker}
          onChanged={refresh}
        />
      )}

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
      <AboutDialog
        open={aboutOpen}
        health={health}
        agents={agents}
        healthError={healthError}
        isLikelyDev={isLikelyDev}
        onClose={handleCloseAbout}
      />
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Workspace nav — accent selected language (matches rest of Filebox UI). */
function SidebarNavButton({
  label,
  Icon,
  active,
  collapsed,
  onClick,
}: {
  label: string;
  Icon: (p: { style?: React.CSSProperties }) => React.ReactElement;
  active: boolean;
  collapsed: boolean;
  onClick: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const base = collapsed ? styles.navBtnCollapsed : styles.navBtn;
  const state = active
    ? (collapsed ? styles.navBtnCollapsedActive : styles.navBtnActive)
    : hovered
      ? (collapsed ? styles.navBtnCollapsedHover : styles.navBtnHover)
      : null;
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-current={active ? 'page' : undefined}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{ ...base, ...state }}
    >
      {!collapsed && (
        <span
          style={{
            ...styles.navRail,
            background: active ? c.accent : 'transparent',
          }}
        />
      )}
      <span style={{ ...styles.navIcon, ...(active ? styles.navIconActive : null) }}>
        <Icon />
      </span>
      {!collapsed && <span style={styles.navLabel}>{label}</span>}
    </button>
  );
}

function SidebarLogoutButton({
  collapsed,
  onClick,
}: {
  collapsed: boolean;
  onClick: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const base = collapsed ? styles.logoutBtnCollapsed : styles.logoutBtn;
  return (
    <button
      type="button"
      onClick={onClick}
      title="Sign out"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        ...base,
        ...(hovered ? (collapsed ? styles.logoutBtnCollapsedHover : styles.logoutBtnHover) : null),
      }}
    >
      <IconLogout />
      {!collapsed && <span>Sign out</span>}
    </button>
  );
}

const styles: Record<string, React.CSSProperties> = {
  loading: {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    height: '100%', background: c.bg, color: c.textMuted,
    fontFamily: font.sans,
  },
  app: {
    display: 'flex', height: '100%', background: c.bg, color: c.text,
    fontFamily: font.sans, position: 'relative', overflow: 'hidden',
  },
  // ── Sidebar ──
  // Compact desktop rail: 180 / collapsed 48. Keeps indigo + bgSubtle language.
  // Mobile drawer stays wider for touch targets via sidebarDrawer.
  //
  // Desktop layout is split: `sidebarSlot` (flex width, no transition) +
  // `sidebarPanel` (absolute, width transitions). See state comments above.
  // Mobile drawer uses transform only (compositor path).
  sidebarSlot: {
    flexShrink: 0,
    position: 'relative',
    alignSelf: 'stretch',
    // During collapse the panel shrinks inside a still-wide slot; paint the
    // reserved strip so it doesn't flash the main background.
    background: c.bgSubtle,
  },
  sidebarPanel: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    background: c.bgSubtle,
    borderRight: `1px solid ${c.border}`,
    boxSizing: 'border-box',
    // z-index: expand grows over the main column until the spacer commits.
    zIndex: 30,
    transition: `width ${SIDEBAR_WIDTH_MS}ms ease`,
  },
  sidebarPanelOverlaying: {
    boxShadow: shadow.lg,
  },
  // Mobile drawer base (width overridden by sidebarDrawer).
  sidebarExpanded: {
    width: SIDEBAR_W_EXPANDED, borderRight: `1px solid ${c.border}`, display: 'flex',
    flexDirection: 'column', flexShrink: 0, background: c.bgSubtle,
    overflow: 'hidden',
  },
  sidebarDrawer: {
    position: 'absolute', top: 0, left: 0, bottom: 0, zIndex: 200,
    width: 'min(280px, 84vw)', maxWidth: 300,
    transition: 'transform 0.22s ease',
    boxShadow: shadow.lg, background: c.bgSubtle,
  } as React.CSSProperties,
  sidebarHeader: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    gap: 6, borderBottom: `1px solid ${c.border}`,
    background: c.bgSubtle, flexShrink: 0,
  },
  sidebarHeaderCompact: {
    padding: '0 6px 0 10px', height: 44, boxSizing: 'border-box',
  },
  sidebarHeaderMobile: {
    padding: '0 8px 0 12px', height: 48, boxSizing: 'border-box' as const,
  },
  sidebarHeaderCollapsed: {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    height: 44, borderBottom: `1px solid ${c.border}`,
    boxSizing: 'border-box',
  },
  brandRow: {
    display: 'flex', alignItems: 'center', gap: 7, minWidth: 0, flex: 1,
  },
  brandMark: {
    color: c.accent, flexShrink: 0, display: 'flex',
  },
  logo: {
    margin: 0, fontSize: 13.5, color: c.text, fontWeight: 600,
    letterSpacing: '-0.02em', lineHeight: 1,
    fontFamily: font.sans,
  },
  headerIconBtn: {
    background: 'transparent', border: 'none', color: c.textMuted,
    cursor: 'pointer', padding: 0, display: 'flex',
    alignItems: 'center', justifyContent: 'center',
    borderRadius: radius.sm, flexShrink: 0,
    transition: 'background 0.12s, color 0.12s',
    width: 28, height: 28, boxSizing: 'border-box',
  },
  collapseToggleCollapsed: {
    background: 'transparent', border: 'none', color: c.accent, cursor: 'pointer',
    width: 36, height: 32, display: 'flex',
    alignItems: 'center', justifyContent: 'center',
    borderRadius: radius.md, padding: 0,
  },
  // Sections use spacing + a single hairline rule — not a box per block.
  sidebarSection: { padding: '8px 6px 4px' },
  sidebarSectionCompact: { padding: '8px 6px 4px' },
  sidebarSectionMobile: { padding: '10px 8px 6px' },
  sidebarSectionCollapsed: { padding: '8px 4px 4px' },
  sectionRule: {
    height: 1, background: c.border,
    margin: '2px 10px', flexShrink: 0, opacity: 0.65,
  },
  // Scrollable middle of the sidebar (between header and footer). The two
  // non-obvious props: `flex: 1` so it absorbs the space the header/footer
  // don't, and `minHeight: 0` to override the flex default `min-height:auto`,
  // which would otherwise grow this box to fit content and push the footer off
  // a short viewport (the exact bug this fixes). `overflowY:auto` then scrolls.
  sidebarScroll: {
    flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden',
    display: 'flex', flexDirection: 'column',
    padding: '2px 0 6px',
  } as React.CSSProperties,
  sectionHeader: {
    fontSize: 10, textTransform: 'uppercase' as const, color: c.textMuted,
    letterSpacing: '0.05em', marginBottom: 4, fontWeight: 600,
    padding: '0 6px 0 8px',
  },
  nav: { display: 'flex', flexDirection: 'column', gap: 1 },
  navCollapsed: { display: 'flex', flexDirection: 'column', gap: 2, alignItems: 'center' },
  navBtn: {
    position: 'relative' as const,
    padding: '0 6px 0 0', borderRadius: radius.sm, border: 'none',
    color: c.textSecondary, cursor: 'pointer', fontSize: 12.5, textAlign: 'left',
    background: 'transparent', fontWeight: 500, transition: 'background 0.12s, color 0.12s',
    display: 'flex', alignItems: 'center', gap: 0,
    width: '100%', fontFamily: font.sans, boxSizing: 'border-box',
    height: 30,
  },
  navBtnHover: {
    background: c.bgMuted, color: c.text,
  },
  navBtnActive: {
    background: c.accentBg, color: c.accent, fontWeight: 600,
  },
  navBtnCollapsed: {
    padding: 0, borderRadius: radius.sm, border: 'none',
    color: c.textSecondary, cursor: 'pointer',
    background: 'transparent', transition: 'background 0.12s, color 0.12s',
    width: 36, height: 30, display: 'flex',
    alignItems: 'center', justifyContent: 'center',
  },
  navBtnCollapsedHover: {
    background: c.bgMuted, color: c.text,
  },
  navBtnCollapsedActive: {
    background: c.accentBg, color: c.accent,
  },
  navRail: {
    position: 'absolute' as const, left: 0, top: 6, bottom: 6, width: 2,
    borderRadius: radius.pill, transition: 'background 0.12s',
  },
  navIcon: {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    width: 28, flexShrink: 0,
  },
  navIconActive: { color: c.accent },
  navLabel: {
    flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const, letterSpacing: '-0.01em',
  },
  sidebarFooter: {
    padding: '6px 6px 8px', borderTop: `1px solid ${c.border}`,
    flexShrink: 0, background: c.bgSubtle,
  },
  sidebarFooterCollapsed: {
    padding: '6px 0 8px', borderTop: `1px solid ${c.border}`,
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
  },
  footerStrip: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    gap: 4, minHeight: 26,
  },
  logoutBtn: {
    padding: '3px 5px', borderRadius: radius.sm, border: 'none',
    background: 'transparent', color: c.textSecondary, cursor: 'pointer',
    fontSize: 11.5, transition: 'background 0.12s, color 0.12s',
    display: 'inline-flex', alignItems: 'center', gap: 4,
    fontFamily: font.sans, fontWeight: 500, boxSizing: 'border-box',
    height: 26, flexShrink: 0,
  },
  logoutBtnHover: {
    background: c.bgMuted, color: c.text,
  },
  logoutBtnCollapsed: {
    padding: 0, borderRadius: radius.sm, border: 'none',
    background: 'transparent', color: c.textSecondary, cursor: 'pointer',
    width: 36, height: 30, display: 'flex',
    alignItems: 'center', justifyContent: 'center',
    transition: 'background 0.12s, color 0.12s',
  },
  logoutBtnCollapsedHover: {
    background: c.bgMuted, color: c.text,
  },
  aboutEntry: {
    display: 'inline-flex', alignItems: 'center',
    padding: '3px 5px', background: 'transparent', border: 'none',
    cursor: 'pointer', borderRadius: radius.sm,
    transition: 'background 0.12s', minWidth: 0,
  } as React.CSSProperties,
  aboutVersion: {
    fontFamily: font.mono, fontSize: 10.5, color: c.textMuted,
    fontVariantNumeric: 'tabular-nums' as const, letterSpacing: '-0.02em',
  },
  aboutEntryCollapsed: {
    background: 'none', border: 'none', cursor: 'pointer',
    padding: '2px 0', borderRadius: radius.sm, color: c.textMuted,
  },
  aboutVersionCollapsed: {
    fontFamily: font.mono, fontSize: 9, color: c.textMuted,
    letterSpacing: '-0.03em',
  },
  // ── Mobile overlay ──
  overlay: {
    position: 'fixed', inset: 0, zIndex: 150,
    background: c.bgOverlay,
  },
  // ── Mobile top bar ──
  mobileTopBar: {
    display: 'flex', alignItems: 'center', gap: 10,
    padding: '0 12px', borderBottom: `1px solid ${c.border}`,
    flexShrink: 0, background: c.bgSubtle,
    height: 48, boxSizing: 'border-box',
  },
  hamburger: {
    background: c.bgMuted, border: 'none',
    cursor: 'pointer', color: c.text, padding: 0,
    width: 36, height: 36, lineHeight: 1,
    borderRadius: radius.md,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    flexShrink: 0,
  },
  mobileTitleBlock: {
    flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1,
  },
  mobileTitle: {
    fontSize: 14, fontWeight: 600, color: c.text,
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    letterSpacing: '-0.01em', lineHeight: 1.2,
  },
  mobileSubtitle: {
    display: 'flex', alignItems: 'center', gap: 5,
    fontSize: 11, color: c.textMuted, fontWeight: 400,
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  mobileTelemetry: {
    fontSize: 11, letterSpacing: '-0.01em',
  },
  mobileStatusDot: {
    width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
  },
  backBtn: {
    background: 'transparent', border: `1px solid ${c.border}`, borderRadius: radius.md,
    color: c.textSecondary, fontSize: 12.5, padding: '0 10px 0 6px', cursor: 'pointer',
    flexShrink: 0, height: 34,
    display: 'flex', alignItems: 'center', gap: 2, fontFamily: font.sans, fontWeight: 500,
  },
  // ── Main content ──
  main: { flex: 1, display: 'flex', overflow: 'hidden' },
  mainMobile: { flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' },
  // Row flex: Files shell and Settings/Stats are siblings; only one is visible.
  // Absolute-positioned hidden siblings (filesViewHidden shells) anchor to
  // this container; the visible sibling stays a normal flex child filling it.
  contentArea: { flex: 1, display: 'flex', overflow: 'hidden', minWidth: 0, minHeight: 0, position: 'relative' },
  // ── Desktop split ──
  splitViewShell: { display: 'flex', flex: 1, overflow: 'hidden', minWidth: 0, minHeight: 0 },
  // Mobile files shell: column so list (or full-screen preview) fills contentArea.
  mobileFilesLayout: {
    display: 'flex', flex: 1, flexDirection: 'column', overflow: 'hidden', minHeight: 0, minWidth: 0,
  },
  // Keep FileBrowser in the tree while Settings/Stats are shown without it
  // occupying layout space or intercepting pointer/focus. Hidden with
  // visibility:hidden + absolute off-flow positioning — NOT display:none:
  // a display:none shell would unload its preview iframes (HTML tabs come
  // back white, reloaded) and zero the measurements that keep virtualized
  // PDF pages mounted, so switching Files/Explorer/Collections would defeat
  // the preview keep-alive cache. visibility keeps the subtree alive while
  // staying unpainted, unclickable, and unfocusable.
  filesViewHidden: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    visibility: 'hidden', pointerEvents: 'none',
  },
  // Fills contentArea when the Files/Explorer shells are hidden (flex item
  // needs flex:1; height:100% alone is not enough next to an off-flow
  // hidden sibling).
  secondaryView: {
    flex: 1, minWidth: 0, minHeight: 0, overflow: 'hidden',
    display: 'flex', flexDirection: 'column',
  },
  previewHeader: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12,
    padding: '8px 16px', borderBottom: `1px solid ${c.border}`, background: c.bgSubtle,
  },
  previewActions: { display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 },
  previewPath: { color: c.textMuted, fontSize: 12, fontFamily: font.mono, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0 },
  // ── Mobile file/preview ──
  mobileFileWrap: { flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0, minHeight: 0 },
  // Full-bleed sibling of the Files shell inside contentArea (row flex).
  // When open, the Files shell is off-flow hidden (filesViewHidden) so this
  // expands to 100% width.
  mobilePreviewWrap: { flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0, minHeight: 0 },
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
};
