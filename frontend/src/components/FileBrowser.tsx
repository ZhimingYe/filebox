import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { FixedSizeList as VList } from 'react-window';
import * as api from '../api/client';
import { friendlyMessage } from '../api/client';
import { useIsMobile } from '../state/useIsMobile';
import { c, radius, font } from '../theme';

// ── Inline SVG Icons (16x16) ───────────────────────────────────────────

const iconStyle: React.CSSProperties = { display: 'block', width: 16, height: 16 };

function IconFolder() {
  return (
    <svg style={iconStyle} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M2 4.5C2 3.67 2.67 3 3.5 3H6.29a1 1 0 0 1 .7.29L8 4.5h4.5c.83 0 1.5.67 1.5 1.5v5.5c0 .83-.67 1.5-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5v-7Z" fill="#94a3b8"/>
      <path d="M2 6h12v5.5c0 .83-.67 1.5-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5V6Z" fill="#cbd5e1"/>
    </svg>
  );
}

function IconFile() {
  return (
    <svg style={iconStyle} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M4 2h5.59a1 1 0 0 1 .7.29l2.71 2.71a1 1 0 0 1 .29.7V13a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1Z" fill="#e2e8f0"/>
      <path d="M10 2.5V5a.5.5 0 0 0 .5.5h2.5" stroke="#94a3b8" strokeWidth="1" strokeLinecap="round"/>
      <line x1="5" y1="8" x2="11" y2="8" stroke="#cbd5e1" strokeWidth="1" strokeLinecap="round"/>
      <line x1="5" y1="10.5" x2="9" y2="10.5" stroke="#cbd5e1" strokeWidth="1" strokeLinecap="round"/>
    </svg>
  );
}

function IconSymlink() {
  return (
    <svg style={iconStyle} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M4 2h5.59a1 1 0 0 1 .7.29l2.71 2.71a1 1 0 0 1 .29.7V13a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1Z" fill="#e2e8f0"/>
      <path d="M10 2.5V5a.5.5 0 0 0 .5.5h2.5" stroke="#94a3b8" strokeWidth="1" strokeLinecap="round"/>
      <path d="M5 11L10 6" stroke="#6366f1" strokeWidth="1.3" strokeLinecap="round"/>
      <path d="M7 6h3v3" stroke="#6366f1" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

function IconUpDir() {
  return (
    <svg style={iconStyle} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M8 3v9M5 6l3-3 3 3" stroke="#94a3b8" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M3 11a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v1a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-1Z" fill="#e2e8f0"/>
    </svg>
  );
}

function getEntryIcon(entryType: string) {
  switch (entryType) {
    case 'directory': return <IconFolder />;
    case 'symlink': return <IconSymlink />;
    default: return <IconFile />;
  }
}

interface Props {
  agentId: string;
  roots: { name: string; path_display: string; enabled: boolean }[];
  onFileSelect: (root: string, path: string, entry: api.FsEntry) => void;
  // Fired whenever the visible file list changes — used by parent for keyboard navigation
  onEntriesChange?: (info: { root: string; path: string; entries: api.FsEntry[] }) => void;
}

type SortKey = 'name' | 'modified' | 'size';

const PAGE_LIMIT = 200;

export function FileBrowser({ agentId, roots, onFileSelect, onEntriesChange }: Props) {
  const isMobile = useIsMobile();
  const ROW_HEIGHT = isMobile ? 44 : 32;

  const [selectedRoot, setSelectedRoot] = useState<string | null>(null);
  const [currentPath, setCurrentPath] = useState('/');
  const [entries, setEntries] = useState<api.FsEntry[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [listHeight, setListHeight] = useState(400);
  const [sortBy, setSortBy] = useState<SortKey>('name');
  const [sortAsc, setSortAsc] = useState(true);
  const [filterText, setFilterText] = useState('');
  const [filterError, setFilterError] = useState(false);
  const [copiedPath, setCopiedPath] = useState<string | null>(null);

  const enabledRoots = useMemo(() => roots.filter((r) => r.enabled), [roots]);

  // Copy to clipboard helper
  const copyToClipboard = useCallback(async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedPath(label);
      setTimeout(() => setCopiedPath(null), 2000);
    } catch {
      // Fallback for older browsers
      const textArea = document.createElement('textarea');
      textArea.value = text;
      document.body.appendChild(textArea);
      textArea.select();
      document.execCommand('copy');
      document.body.removeChild(textArea);
      setCopiedPath(label);
      setTimeout(() => setCopiedPath(null), 2000);
    }
  }, []);

  // Build full path for current directory
  const fullPath = useMemo(() => {
    if (!selectedRoot) return '';
    const rootObj = roots.find(r => r.name === selectedRoot);
    const rootPath = rootObj?.path_display || selectedRoot;
    return currentPath === '/' ? rootPath : rootPath + currentPath;
  }, [selectedRoot, currentPath, roots]);

  // Measure container height for virtualized list
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const obs = new ResizeObserver(([entry]) => {
      setListHeight(entry.contentRect.height);
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  useEffect(() => {
    if (enabledRoots.length === 0) {
      setSelectedRoot(null);
      return;
    }
    if (!selectedRoot || !enabledRoots.some((r) => r.name === selectedRoot)) {
      setSelectedRoot(enabledRoots[0].name);
      setCurrentPath('/');
    }
  }, [enabledRoots, selectedRoot]);

  const loadDir = useCallback(async (append = false) => {
    if (!selectedRoot) return;

    if (append) {
      setLoadingMore(true);
    } else {
      setLoading(true);
      setEntries([]);
      setNextCursor(null);
    }
    setError(null);

    try {
      const cursor = append && nextCursor ? nextCursor : undefined;
      const data = await api.fsList(agentId, selectedRoot, currentPath, PAGE_LIMIT, cursor);
      if (data.error) {
        setError(data.error);
        if (!append) setEntries([]);
      } else {
        setEntries((prev) => append ? [...prev, ...data.items] : data.items);
        setNextCursor(data.next_cursor);
      }
    } catch (e: any) {
      setError(e.message || 'Failed to list directory');
      if (!append) setEntries([]);
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [agentId, selectedRoot, currentPath, nextCursor]);

  useEffect(() => {
    loadDir(false);
  }, [agentId, selectedRoot, currentPath]); // eslint-disable-line react-hooks/exhaustive-deps

  const navigateTo = (entry: api.FsEntry) => {
    if (entry.denied) return;
    if (entry.entry_type === 'directory') {
      const sep = currentPath.endsWith('/') ? '' : '/';
      setCurrentPath(currentPath + sep + entry.name);
    } else {
      onFileSelect(selectedRoot!, currentPath === '/' ? `/${entry.name}` : `${currentPath}/${entry.name}`, entry);
    }
  };

  const navigateUp = () => {
    const parts = currentPath.split('/').filter(Boolean);
    parts.pop();
    setCurrentPath('/' + parts.join('/'));
  };

  const breadcrumbs = currentPath.split('/').filter(Boolean);

  const toggleSort = (key: SortKey) => {
    if (sortBy === key) {
      setSortAsc(!sortAsc);
    } else {
      setSortBy(key);
      setSortAsc(true);
    }
  };

  // Sort entries: directories first, then by sort key
  const sortedEntries = useMemo(() => {
    const sorted = [...entries].sort((a, b) => {
      // Directories always first
      if (a.entry_type === 'directory' && b.entry_type !== 'directory') return -1;
      if (a.entry_type !== 'directory' && b.entry_type === 'directory') return 1;

      let cmp = 0;
      if (sortBy === 'name') {
        cmp = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
      } else if (sortBy === 'modified') {
        const da = a.modified ? new Date(a.modified).getTime() : 0;
        const db = b.modified ? new Date(b.modified).getTime() : 0;
        cmp = da - db;
      } else if (sortBy === 'size') {
        cmp = (a.size ?? 0) - (b.size ?? 0);
      }
      return sortAsc ? cmp : -cmp;
    });
    return sorted;
  }, [entries, sortBy, sortAsc]);

  // Apply filter — supports glob (*, ?) and regex
  const filteredEntries = useMemo(() => {
    if (!filterText.trim()) {
      setFilterError(false);
      return sortedEntries;
    }
    try {
      const pattern = globToRegex(filterText);
      const re = new RegExp(pattern, 'i');
      setFilterError(false);
      return sortedEntries.filter((e) => re.test(e.name));
    } catch {
      setFilterError(true);
      return sortedEntries;
    }
  }, [sortedEntries, filterText]);

  // Report current visible entries to parent (for keyboard navigation).
  // Uses a signature ref so we only fire when something actually changed.
  const lastSigRef = useRef('');
  useEffect(() => {
    if (!onEntriesChange || !selectedRoot) return;
    const sig = `${selectedRoot}@${currentPath}|` +
      filteredEntries.map((e) => `${e.entry_type}:${e.name}:${e.denied ? '1' : '0'}`).join(',');
    if (sig === lastSigRef.current) return;
    lastSigRef.current = sig;
    onEntriesChange({ root: selectedRoot, path: currentPath, entries: filteredEntries });
  }, [filteredEntries, selectedRoot, currentPath, onEntriesChange]);

  // Build display rows: ".." + filtered entries
  const showBack = currentPath !== '/';
  const rows: (api.FsEntry | null)[] = showBack ? [null, ...filteredEntries] : [...filteredEntries];

  const sortIndicator = (key: SortKey) => {
    if (sortBy !== key) return '';
    return sortAsc ? ' ↑' : ' ↓';
  };

  const Row = ({ index, style }: { index: number; style: React.CSSProperties }) => {
    const entry = rows[index];
    const isBack = entry === null;
    const displayEntry = isBack ? null : entry as api.FsEntry;
    const isHovered = hoveredIdx === index;

    return (
      <div
        style={{
          ...style,
          ...styles.entry,
          ...(isHovered ? styles.entryHover : {}),
          opacity: displayEntry?.denied ? 0.4 : 1,
          cursor: displayEntry?.denied ? 'not-allowed' : 'pointer',
        }}
        onClick={() => isBack ? navigateUp() : navigateTo(displayEntry!)}
        onMouseEnter={() => setHoveredIdx(index)}
        onMouseLeave={() => setHoveredIdx(null)}
      >
        <span style={styles.icon}>
          {isBack ? <IconUpDir /> : getEntryIcon(displayEntry!.entry_type)}
        </span>
        <span
          style={styles.entryName}
          title={isBack ? undefined : displayEntry!.name}
        >
          {isBack ? '..' : displayEntry!.name}
        </span>
        {!isBack && displayEntry!.modified && (
          <span style={isMobile ? styles.entryDateMobile : styles.entryDate}>
            {isMobile ? formatDateShort(displayEntry!.modified) : formatDate(displayEntry!.modified)}
          </span>
        )}
        {!isBack && displayEntry!.size !== null && !isMobile && (
          <span style={styles.entryMeta}>{formatSize(displayEntry!.size)}</span>
        )}
        {!isBack && displayEntry!.denied && <span style={styles.deniedBadge}>denied</span>}
        {!isBack && isHovered && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              copyToClipboard(displayEntry!.name, `name-${index}`);
            }}
            style={styles.copyNameBtn}
            title="Copy filename"
          >
            {copiedPath === `name-${index}` ? 'Copied' : 'Copy'}
          </button>
        )}
      </div>
    );
  };

  return (
    <div style={styles.container}>
      <div style={styles.toolbar}>
        <select
          value={selectedRoot || ''}
          onChange={(e) => { setSelectedRoot(e.target.value); setCurrentPath('/'); }}
          style={styles.select}
        >
          {enabledRoots.map((r) => (
            <option key={r.name} value={r.name}>{r.name}</option>
          ))}
        </select>
        <button onClick={() => loadDir(false)} style={styles.refreshBtn} title="Refresh">&#x21bb;</button>
        {loading && <span style={styles.spinner} />}
      </div>
      <div style={styles.filterBar}>
        <input
          type="text"
          value={filterText}
          onChange={(e) => setFilterText(e.target.value)}
          placeholder="Search files... (* and ? supported)"
          style={{ ...styles.filterInput, borderColor: filterError ? c.danger : c.border }}
        />
        {filterText && (
          <button onClick={() => setFilterText('')} style={styles.filterClear}>&times;</button>
        )}
        {filterText && !filterError && (
          <span style={styles.filterCount}>{filteredEntries.length} match{filteredEntries.length !== 1 ? 'es' : ''}</span>
        )}
        {filterError && <span style={styles.filterError}>Invalid regex</span>}
      </div>

      <div style={styles.breadcrumb}>
        <span onClick={() => setCurrentPath('/')} style={styles.crumb}>/</span>
        {breadcrumbs.map((part, i) => (
          <span key={i}>
            <span
              onClick={() => setCurrentPath('/' + breadcrumbs.slice(0, i + 1).join('/'))}
              style={styles.crumb}
            >
              {part}
            </span>
            {i < breadcrumbs.length - 1 && <span style={styles.sep}>/</span>}
          </span>
        ))}
        <span style={{ flex: 1 }} />
        <button
          onClick={() => copyToClipboard(fullPath, 'path')}
          style={styles.copyPathBtn}
          title="Copy full path"
        >
          {copiedPath === 'path' ? 'Copied' : 'Copy path'}
        </button>
      </div>

      {/* Column headers */}
      <div style={styles.colHeader}>
        <span style={styles.colIcon} />
        <span style={{ ...styles.colName, cursor: 'pointer' }} onClick={() => toggleSort('name')}>
          Name{sortIndicator('name')}
        </span>
        {isMobile ? (
          <span
            style={{ ...styles.colDate, width: 72, cursor: 'pointer' }}
            onClick={() => toggleSort('modified')}
          >
            Modified{sortIndicator('modified')}
          </span>
        ) : (
          <>
            <span style={{ ...styles.colDate, cursor: 'pointer' }} onClick={() => toggleSort('modified')}>
              Modified{sortIndicator('modified')}
            </span>
            <span style={{ ...styles.colSize, cursor: 'pointer' }} onClick={() => toggleSort('size')}>
              Size{sortIndicator('size')}
            </span>
          </>
        )}
      </div>

      <div ref={containerRef} style={styles.listContainer}>
        {!selectedRoot && enabledRoots.length === 0 ? (
          <div style={styles.emptyState}>
            <p style={styles.emptyText}>No roots configured.</p>
            <p style={styles.emptyHint}>Go to Settings to add a root directory.</p>
          </div>
        ) : error ? (
          <div style={styles.errorContainer}>
            <p style={styles.errorText}>{friendlyMessage({ error })}</p>
            <button onClick={() => loadDir(false)} style={styles.retryBtn}>Retry</button>
          </div>
        ) : rows.length === 0 && !loading ? (
          <div style={styles.empty}>Empty directory</div>
        ) : (
          <>
            <VList
              ref={listRef as any}
              height={listHeight - (nextCursor ? 40 : 0)}
              itemCount={rows.length}
              itemSize={ROW_HEIGHT}
              width="100%"
            >
              {Row}
            </VList>
            {nextCursor && (
              <div style={styles.loadMore}>
                <button
                  onClick={() => loadDir(true)}
                  disabled={loadingMore}
                  style={styles.loadMoreBtn}
                >
                  {loadingMore ? 'Loading...' : 'Load more'}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function globToRegex(glob: string): string {
  // If it contains regex-only chars but no glob chars, treat as raw regex
  const hasGlob = glob.includes('*') || glob.includes('?');
  const hasRegexChars = /[+^${}()|[\]\\]/.test(glob);
  if (!hasGlob && hasRegexChars) return glob;

  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      re += '.*';
    } else if (c === '?') {
      re += '.';
    } else if ('+^${}()|[]\\.'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return re;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Compact form for narrow mobile rows: same year drops the year prefix.
function formatDateShort(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const md = `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  if (d.getFullYear() === now.getFullYear()) {
    return `${md} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  return `${d.getFullYear()}-${md}`;
}

const styles: Record<string, React.CSSProperties> = {
  container: { display: 'flex', flexDirection: 'column', height: '100%', fontFamily: font.sans },
  toolbar: {
    padding: '8px 12px', borderBottom: `1px solid ${c.border}`,
    display: 'flex', alignItems: 'center', gap: 8,
    background: c.bg,
  },
  select: {
    padding: '6px 10px', borderRadius: radius.md, border: `1px solid ${c.border}`,
    background: c.surface, color: c.text, fontSize: 13, fontFamily: font.sans,
    outline: 'none',
  },
  refreshBtn: {
    padding: '4px 10px', borderRadius: radius.md, border: `1px solid ${c.border}`,
    background: 'transparent', color: c.textSecondary, cursor: 'pointer',
    fontSize: 16, lineHeight: 1, transition: 'all 0.15s',
  },
  spinner: {
    width: 14, height: 14, border: `2px solid ${c.border}`,
    borderTopColor: c.accent, borderRadius: '50%',
    animation: 'spin 0.6s linear infinite',
  },
  filterBar: {
    padding: '6px 12px', borderBottom: `1px solid ${c.border}`,
    display: 'flex', alignItems: 'center', gap: 6,
    background: c.bg,
  },
  filterInput: {
    flex: 1, padding: '6px 10px', borderRadius: radius.md, border: `1px solid ${c.border}`,
    background: c.surface, color: c.text, fontSize: 13, outline: 'none',
    fontFamily: font.sans, transition: 'border-color 0.15s',
  },
  filterClear: {
    padding: '0 6px', borderRadius: radius.sm, border: 'none',
    background: 'transparent', color: c.textMuted, cursor: 'pointer', fontSize: 16,
  },
  filterCount: { color: c.textMuted, fontSize: 12, flexShrink: 0 },
  filterError: { color: c.danger, fontSize: 12, flexShrink: 0 },
  breadcrumb: {
    padding: '6px 12px', fontSize: 12, color: c.textMuted,
    borderBottom: `1px solid ${c.border}`, display: 'flex', gap: 2,
    overflowX: 'auto', whiteSpace: 'nowrap', background: c.bgSubtle,
  },
  crumb: { cursor: 'pointer', color: c.accent },
  sep: { color: c.textFaint },
  // ── Column headers ──
  colHeader: {
    display: 'flex', alignItems: 'center', gap: 8,
    padding: '6px 12px', borderBottom: `1px solid ${c.border}`,
    fontSize: 11, color: c.textMuted, textTransform: 'uppercase', letterSpacing: 0.5,
    userSelect: 'none', flexShrink: 0, fontWeight: 500, background: c.bgSubtle,
  },
  colIcon: { width: 20, flexShrink: 0 },
  colName: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  colDate: { width: 130, flexShrink: 0, textAlign: 'right' },
  colSize: { width: 80, flexShrink: 0, textAlign: 'right' },
  // ── List ──
  listContainer: { flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' },
  emptyState: {
    flex: 1, display: 'flex', flexDirection: 'column',
    alignItems: 'center', justifyContent: 'center', gap: 8,
  },
  emptyText: { color: c.textMuted, fontSize: 14, margin: 0 },
  emptyHint: { color: c.textFaint, fontSize: 13, margin: 0 },
  errorContainer: {
    flex: 1, display: 'flex', flexDirection: 'column',
    alignItems: 'center', justifyContent: 'center', gap: 12,
  },
  errorText: { color: c.danger, fontSize: 13 },
  retryBtn: {
    padding: '6px 16px', borderRadius: radius.md, border: `1px solid ${c.border}`,
    background: 'transparent', color: c.textSecondary, cursor: 'pointer', fontSize: 13,
    transition: 'all 0.15s',
  },
  entry: {
    display: 'flex', alignItems: 'center', gap: 8,
    padding: '0 12px', boxSizing: 'border-box',
    minHeight: 32, borderRadius: radius.sm, margin: '0 4px',
    transition: 'background 0.1s',
  },
  entryHover: {
    background: c.bgMuted,
  },
  icon: { fontSize: 14, width: 20, textAlign: 'center', flexShrink: 0 },
  entryName: { color: c.text, fontSize: 13, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  entryDate: { color: c.textMuted, fontSize: 12, width: 130, textAlign: 'right', flexShrink: 0 },
  entryDateMobile: { color: c.textMuted, fontSize: 10, textAlign: 'right', flexShrink: 0, width: 72 },
  entryMeta: { color: c.textFaint, fontSize: 12, width: 80, textAlign: 'right', flexShrink: 0 },
  deniedBadge: {
    color: c.warning, fontSize: 10, fontStyle: 'normal', fontWeight: 500,
    padding: '1px 6px', background: c.warningBg, borderRadius: radius.pill, flexShrink: 0,
  },
  copyPathBtn: {
    padding: '2px 6px', borderRadius: radius.sm, border: 'none',
    background: 'transparent', color: c.textMuted, cursor: 'pointer',
    fontSize: 12, lineHeight: 1, flexShrink: 0,
  },
  copyNameBtn: {
    padding: '2px 4px', borderRadius: radius.sm, border: 'none',
    background: 'transparent', color: c.textMuted, cursor: 'pointer',
    fontSize: 11, lineHeight: 1, flexShrink: 0, marginLeft: 4,
  },
  empty: { padding: 16, color: c.textMuted, fontSize: 13 },
  loadMore: {
    padding: '8px 12px', borderTop: `1px solid ${c.border}`,
    display: 'flex', justifyContent: 'center',
  },
  loadMoreBtn: {
    padding: '6px 24px', borderRadius: radius.md, border: `1px solid ${c.border}`,
    background: 'transparent', color: c.textSecondary, cursor: 'pointer', fontSize: 13,
    transition: 'all 0.15s',
  },
};
