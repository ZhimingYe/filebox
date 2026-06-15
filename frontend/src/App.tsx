import { useState, useCallback, useRef, useEffect } from 'react';
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
import type { FsEntry } from './api/client';
import { fileRawUrl } from './api/client';
import { c, radius, shadow, font } from './theme';

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
  const { health, error: healthError, refresh } = useHealth(loggedIn === true);
  const isMobile = useIsMobile();

  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [view, setView] = useState<View>('files');
  const [preview, setPreview] = useState<{ root: string; path: string; entry: FsEntry } | null>(null);
  const [progressMap, setProgressMap] = useState<Map<string, ProgressEvent>>(new Map());
  const progressTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const [sidebarOpen, setSidebarOpen] = useState(false);

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
    const onMove = (ev: MouseEvent) => {
      const rect = container.getBoundingClientRect();
      const ratio = (ev.clientX - rect.left) / rect.width;
      setSplitRatio(Math.max(0.2, Math.min(0.8, ratio)));
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
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

  const agents = health?.agents || [];
  const selectedAgent = agents.find((a) => a.id === selectedAgentId) || null;

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
    if (evt.event === 'agent_connected' || evt.event === 'agent_disconnected' || evt.event === 'resources_updated') {
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
  }, [refresh]));

  const activeProgress = Array.from(progressMap.values());

  if (loggedIn === null) {
    return <div style={styles.loading}>Loading...</div>;
  }

  if (!loggedIn) {
    return <Login onLogin={login} />;
  }

  // ── Sidebar content (shared between desktop inline & mobile drawer) ──
  const sidebarContent = (
    <>
      <div style={styles.sidebarHeader}>
        <h1 style={styles.logo}>filebox</h1>
        {isMobile && (
          <button onClick={() => setSidebarOpen(false)} style={styles.closeSidebarBtn}>&times;</button>
        )}
      </div>
      <div style={styles.sidebarSection}>
        <div style={styles.sectionHeader}>Agents</div>
        <BackendList agents={agents} selectedId={selectedAgentId} onSelect={selectAgent} />
      </div>
      {selectedAgent && (
        <div style={styles.sidebarSection}>
          <div style={styles.sectionHeader}>Navigation</div>
          <div style={styles.nav}>
            {(['files', 'settings', 'health', 'stats'] as View[]).map((v) => (
              <button
                key={v}
                onClick={() => navigate(v)}
                style={{
                  ...styles.navBtn,
                  ...(view === v ? styles.navBtnActive : {}),
                }}
              >
                {v === 'files' ? 'Files' : v === 'settings' ? 'Settings' : v === 'health' ? 'Health' : 'Stats'}
              </button>
            ))}
          </div>
        </div>
      )}
      <div style={{ flex: 1 }} />
      <div style={styles.sidebarFooter}>
        <button onClick={logout} style={styles.logoutBtn}>Logout</button>
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
        <div style={{ ...styles.sidebar, ...styles.sidebarDrawer, transform: sidebarOpen ? 'translateX(0)' : 'translateX(-100%)' }}>
          {sidebarContent}
        </div>
      ) : (
        <div style={styles.sidebar}>{sidebarContent}</div>
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
              // Mobile: show file list OR preview
              showMobilePreview ? (
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
              ) : (
                <div style={styles.mobileFileWrap}>
                  <FileBrowser
                    agentId={selectedAgent.id}
                    roots={selectedAgent.roots}
                    onFileSelect={handleFileSelect}
                    onEntriesChange={handleEntriesChange}
                  />
                </div>
              )
            ) : (
              // Desktop: side-by-side split, resizable
              <div ref={splitContainerRef} style={styles.splitView}>
                <div style={{ ...styles.filePanel, flex: preview ? `0 0 ${splitRatio * 100}%` : '1' }}>
                  <FileBrowser
                    agentId={selectedAgent.id}
                    roots={selectedAgent.roots}
                    onFileSelect={handleFileSelect}
                    onEntriesChange={handleEntriesChange}
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
            <HealthPanel health={health} error={healthError} />
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
  sidebar: {
    width: 260, borderRight: `1px solid ${c.border}`, display: 'flex',
    flexDirection: 'column', flexShrink: 0, background: c.bgSubtle,
  },
  sidebarDrawer: {
    position: 'absolute', top: 0, left: 0, bottom: 0, zIndex: 200,
    width: 280, transition: 'transform 0.25s ease',
    boxShadow: shadow.lg,
  },
  sidebarHeader: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    padding: '14px 16px', borderBottom: `1px solid ${c.border}`,
  },
  logo: { margin: 0, fontSize: 17, color: c.accent, fontWeight: 700, letterSpacing: -0.3 },
  closeSidebarBtn: {
    background: 'none', border: 'none', color: c.textMuted,
    fontSize: 20, cursor: 'pointer', padding: '0 4px', lineHeight: 1,
    borderRadius: radius.sm,
  },
  sidebarSection: { padding: '12px 12px', borderBottom: `1px solid ${c.border}` },
  sectionHeader: {
    fontSize: 11, textTransform: 'uppercase', color: c.textMuted,
    letterSpacing: 0.8, marginBottom: 6, fontWeight: 500, paddingLeft: 4,
  },
  nav: { display: 'flex', flexDirection: 'column', gap: 1 },
  navBtn: {
    padding: '7px 10px', borderRadius: radius.md, border: 'none',
    color: c.textSecondary, cursor: 'pointer', fontSize: 13, textAlign: 'left',
    background: 'transparent', fontWeight: 400, transition: 'all 0.15s',
  },
  navBtnActive: {
    background: c.bgMuted, color: c.text, fontWeight: 500,
  },
  sidebarFooter: {
    padding: '12px 12px', borderTop: `1px solid ${c.border}`,
  },
  logoutBtn: {
    padding: '6px 12px', borderRadius: radius.md, border: `1px solid ${c.border}`,
    background: 'transparent', color: c.textSecondary, cursor: 'pointer', fontSize: 12,
    width: '100%', transition: 'all 0.15s',
  },
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
};
