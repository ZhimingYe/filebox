import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { FixedSizeList as VList } from 'react-window';
import * as api from '../api/client';
import { friendlyMessage } from '../api/client';
import { useIsMobile } from '../state/useIsMobile';
import { c, radius, font, shadow } from '../theme';
import { AddressBar } from './AddressBar';

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
  // Custom root-selector dropdown state. We hand-roll the dropdown instead of
  // using a native <select> so the panel can carry richer content per root
  // (path, status) and the trigger matches the toolbar's inline-style system.
  // `rootOpen` is whether the panel is shown; `rootRef` wraps trigger+panel so
  // the click-outside handler can tell "inside the selector" from "elsewhere".
  const [rootOpen, setRootOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const [listHeight, setListHeight] = useState(400);
  const [sortBy, setSortBy] = useState<SortKey>('name');
  const [sortAsc, setSortAsc] = useState(true);
  const [filterText, setFilterText] = useState('');
  const [filterError, setFilterError] = useState(false);
  // When true, names stick to the right edge and OVERFLOW IS CLIPPED AT THE
  // FRONT (ellipsis on the left) so the suffix of long filenames stays
  // visible. Achieved with direction:rtl on the cell + <bdi dir="ltr"> on the
  // text. Plain text-align:right would still cut the suffix off, which is the
  // exact failure mode this toggle is meant to fix.
  const [nameAlignRight, setNameAlignRight] = useState<boolean>(() => {
    try { return localStorage.getItem('filebox.nameAlignRight') === '1'; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem('filebox.nameAlignRight', nameAlignRight ? '1' : '0'); } catch { /* ignore */ }
  }, [nameAlignRight]);
  // Optional serif rendering for filenames — when tired, a serif face reads
  // more distinctly than the default sans (different letter shapes break up
  // the "wall of similar names" effect). Affects filenames only; dates /
  // sizes stay sans so digits keep their alignment.
  const [fileNameSerif, setFileNameSerif] = useState<boolean>(() => {
    try { return localStorage.getItem('filebox.fileNameSerif') === '1'; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem('filebox.fileNameSerif', fileNameSerif ? '1' : '0'); } catch { /* ignore */ }
  }, [fileNameSerif]);
  const [copiedPath, setCopiedPath] = useState<string | null>(null);
  // Remember last visited path per agent+root (keyed as "agentId:rootName")
  const pathMemory = useRef<Map<string, string>>(new Map());
  const memKey = (root: string) => `${agentId}:${root}`;
  const prevAgentIdRef = useRef(agentId); // eslint-disable-line react-hooks/exhaustive-deps
  const loadSeq = useRef(0); // request versioning — discard stale responses

  const enabledRoots = useMemo(() => roots.filter((r) => r.enabled), [roots]);

  // Resolve the active root object so we can reconstruct the *full* server-side
  // address (path_display + currentPath) for the copy-address button. This
  // mirrors what AddressBar does internally. null until a root is selected.
  const activeRootObj = useMemo(
    () => roots.find((r) => r.name === selectedRoot) || null,
    [roots, selectedRoot],
  );
  // Full address = the root's absolute path_display joined with currentPath.
  // Both halves already start with '/'; we must avoid producing a "//" when
  // currentPath is the root ('/'). e.g. "/home/user" + "/" => "/home/user".
  const fullAddress = useMemo(() => {
    if (!activeRootObj) return '';
    const base = activeRootObj.path_display.replace(/\/+$/, '');
    const rel = currentPath === '/' ? '' : currentPath;
    return base + rel;
  }, [activeRootObj, currentPath]);

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

  // Close the root dropdown when clicking outside it or pressing Escape.
  // The panel is anchored to the trigger via the shared `rootRef` wrapper.
  useEffect(() => {
    if (!rootOpen) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setRootOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setRootOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [rootOpen]);

  // Unified: handles agent switch (restore saved path) and root config changes (pick valid root)
  const prevRootRef = useRef<string | null>(null);
  useEffect(() => {
    const agentChanged = prevAgentIdRef.current !== agentId;
    if (agentChanged) {
      setEntries([]);
      setError(null);
      prevAgentIdRef.current = agentId;
    }

    if (enabledRoots.length === 0) {
      if (prevRootRef.current !== null) {
        setSelectedRoot(null);
        prevRootRef.current = null;
      }
      return;
    }

    const rootValid = selectedRoot && enabledRoots.some((r) => r.name === selectedRoot);
    if (!rootValid) {
      const fallback = enabledRoots[0].name;
      setSelectedRoot(fallback);
      setCurrentPath(pathMemory.current.get(memKey(fallback)) || '/');
      prevRootRef.current = fallback;
    } else if (agentChanged) {
      // Only restore saved path when agent actually changed, not on every re-render
      const savedPath = pathMemory.current.get(memKey(selectedRoot)) || '/';
      setCurrentPath(savedPath);
      prevRootRef.current = selectedRoot;
    }
    // If root is valid and agent didn't change — do nothing (prevents spurious reloads)
  }, [enabledRoots, agentId]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadDir = useCallback(async (append = false) => {
    if (!selectedRoot) return;

    const seq = ++loadSeq.current;

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
      if (seq !== loadSeq.current) return; // stale response — discard
      if (data.error) {
        setError(data.error);
        if (!append) setEntries([]);
      } else {
        setEntries((prev) => append ? [...prev, ...data.items] : data.items);
        setNextCursor(data.next_cursor);
      }
    } catch (e: any) {
      if (seq !== loadSeq.current) return; // stale response — discard
      setError(e.message || 'Failed to list directory');
      if (!append) setEntries([]);
    } finally {
      if (seq === loadSeq.current) {
        setLoading(false);
        setLoadingMore(false);
      }
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

  const handleNavigate = useCallback((root: string, path: string) => {
    if (selectedRoot) {
      pathMemory.current.set(memKey(selectedRoot), currentPath);
    }
    setSelectedRoot(root);
    setCurrentPath(path);
  }, [agentId, selectedRoot, currentPath]); // eslint-disable-line react-hooks/exhaustive-deps

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
          style={{
            ...styles.entryName,
            fontFamily: fileNameSerif ? font.serif : font.sans,
            ...(!isBack && nameAlignRight ? { direction: 'rtl', textAlign: 'right' } : {}),
          }}
          title={isBack ? undefined : displayEntry!.name}
        >
          {isBack ? (
            '..'
          ) : nameAlignRight ? (
            // bidi-isolate the name so characters still render LTR while the
            // cell is RTL: overflow + ellipsis then clip the PREFIX, keeping
            // the filename suffix pinned to the right edge of the cell.
            <bdi dir="ltr">{displayEntry!.name}</bdi>
          ) : (
            displayEntry!.name
          )}
        </span>
        {!isBack && displayEntry!.denied && <span style={styles.deniedBadge}>denied</span>}
        {!isBack && isHovered && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              // Copy the FULL path to this entry (directory + filename), not
              // just the bare name. fullAddress already ends at the current
              // directory (no trailing slash except at root), so we only add a
              // separator when we're deeper than the root.
              const sep = currentPath === '/' ? '' : '/';
              copyToClipboard(fullAddress + sep + displayEntry!.name, `name-${index}`);
            }}
            style={styles.copyNameBtn}
            title="Copy full path"
          >
            {copiedPath === `name-${index}` ? (
              // checkmark — shown for ~2s after a successful copy
              <svg style={{ display: 'block' }} width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M3.5 8.5l3 3 6-7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            ) : (
              // clipboard glyph — matches the toolbar copy-address button
              <svg style={{ display: 'block' }} width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                <rect x="3" y="4" width="9" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.3"/>
                <path d="M5.5 4V3a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
                <path d="M6 8h4M6 10.5h2.5" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round"/>
              </svg>
            )}
          </button>
        )}
        {!isBack && displayEntry!.modified && (
          <span style={isMobile ? styles.entryDateMobile : styles.entryDate}>
            {isMobile ? formatDateShort(displayEntry!.modified) : formatDate(displayEntry!.modified)}
          </span>
        )}
        {!isBack && displayEntry!.size !== null && !isMobile && (
          <span style={styles.entryMeta}>{formatSize(displayEntry!.size)}</span>
        )}
      </div>
    );
  };

  return (
    <div style={styles.container}>
      <div style={{
        ...styles.toolbar,
        // On small screens let the toolbar wrap so the root selector + the
        // four icon buttons don't crowd or overflow. `flexWrap` + `rowGap`
        // keeps a tidy second row when the controls no longer fit on one.
        ...(isMobile ? { flexWrap: 'wrap', rowGap: 8 } : {}),
      }}>
        {/* Root selector — a hand-rolled dropdown instead of native <select>.
            The native control renders an OS-styled popup we can't theme, and
            can't carry per-root extra info. The trigger shows the current root
            + a chevron; the panel lists enabled roots with their server path.
            Behavior matches the old <select>: remember the path of the root
            we're leaving, then swap root and restore that root's last path. */}
        <div ref={rootRef} style={{ ...styles.rootSelect, ...(isMobile ? { flex: '1 1 100%' } : {}) }}>
          <button
            type="button"
            onClick={() => setRootOpen((v) => !v)}
            style={{
              ...styles.rootTrigger,
              ...(rootOpen ? styles.rootTriggerOpen : {}),
              // On mobile the trigger spans the full row width so long root
              // names stay readable; on desktop it caps at 220px to leave room
              // for the icon buttons beside it.
              ...(isMobile ? { width: '100%', maxWidth: 'none' } : {}),
            }}
            aria-haspopup="listbox"
            aria-expanded={rootOpen}
            title={selectedRoot ? `Root: ${selectedRoot}` : 'Select root'}
          >
            <span style={styles.rootTriggerLabel}>
              {selectedRoot || 'Select root…'}
            </span>
            <svg
              style={{ display: 'block', transition: 'transform 0.15s', transform: rootOpen ? 'rotate(180deg)' : 'none' }}
              width="12" height="12" viewBox="0 0 16 16" fill="none"
            >
              <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
          {rootOpen && (
            <div
              style={{
                ...styles.rootPanel,
                // On small screens pin the panel to the wrapper's right edge
                // instead of its left, so a trigger near the viewport's right
                // side can't push the panel off-screen. On desktop keep
                // left-aligned (matches the trigger's left edge).
                ...(isMobile ? { left: 0, right: 0, minWidth: 0 } : {}),
              }}
              role="listbox"
            >
              {enabledRoots.map((r) => {
                const isSel = r.name === selectedRoot;
                return (
                  <button
                    key={r.name}
                    type="button"
                    role="option"
                    aria-selected={isSel}
                    style={{
                      ...styles.rootItem,
                      ...(isSel ? styles.rootItemSelected : {}),
                    }}
                    onClick={() => {
                      const next = r.name;
                      if (selectedRoot) pathMemory.current.set(memKey(selectedRoot), currentPath);
                      setSelectedRoot(next);
                      setCurrentPath(pathMemory.current.get(memKey(next)) || '/');
                      setRootOpen(false);
                    }}
                    title={r.path_display}
                  >
                    <span style={styles.rootItemName}>{r.name}</span>
                    <span style={styles.rootItemPath}>{r.path_display}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
        <button onClick={() => loadDir(false)} style={styles.refreshBtn} title="Refresh">
          {/* Circular-arrow refresh glyph. Drawn as SVG (not the ↻ text char)
              so it renders identically across fonts/platforms. Kept compact
              (radius 4, stroke 1.3) to match the visual weight of the align /
              font / copy toolbar icons. */}
          <svg style={{ display: 'block' }} width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M12 8a4 4 0 1 1-1.2-2.8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
            <path d="M12 3.5v3h-3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>
        <button
          onClick={() => setNameAlignRight((v) => !v)}
          style={nameAlignRight ? styles.alignBtnActive : styles.alignBtn}
          title={nameAlignRight
            ? 'Filenames pinned right (long names show …suffix)'
            : 'Filenames pinned left (long names show prefix…)'}
          aria-pressed={nameAlignRight}
        >
          {/* Align-edge bars: bars hug the LEFT when left-aligned, the RIGHT
              when right-aligned — so the glyph itself shows which edge names
              stick to. The same bar lengths render in both states; only the
              x-offset flips, which reads as "the block moved to the other side". */}
          {nameAlignRight ? (
            <svg style={{ display: 'block' }} width="16" height="16" viewBox="0 0 16 16" fill="none">
              <rect x="1" y="2.5" width="14" height="1.5" rx="0.75" fill="currentColor" />
              <rect x="5" y="7.25" width="10" height="1.5" rx="0.75" fill="currentColor" />
              <rect x="1" y="12" width="14" height="1.5" rx="0.75" fill="currentColor" />
            </svg>
          ) : (
            <svg style={{ display: 'block' }} width="16" height="16" viewBox="0 0 16 16" fill="none">
              <rect x="1" y="2.5" width="14" height="1.5" rx="0.75" fill="currentColor" />
              <rect x="1" y="7.25" width="10" height="1.5" rx="0.75" fill="currentColor" />
              <rect x="1" y="12" width="14" height="1.5" rx="0.75" fill="currentColor" />
            </svg>
          )}
        </button>
        <button
          onClick={() => setFileNameSerif((v) => !v)}
          style={fileNameSerif ? styles.fontBtnActive : styles.fontBtn}
          title={fileNameSerif
            ? 'Filename font: serif (click for sans-serif)'
            : 'Filename font: sans-serif (click for serif)'}
          aria-pressed={fileNameSerif}
        >
          {/* Font glyph: a capital A. In serif mode it carries serifs (the
              little feet/finials); in sans mode it is a plain geometric A.
              The glyph itself signals the current font. */}
          {fileNameSerif ? (
            <svg style={{ display: 'block' }} width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M8 2.5L2.7 13h2l0.85-2h4.9l0.85 2h2L8 2.5z" fill="currentColor" />
              <path d="M6.2 9.3L8 5l1.8 4.3H6.2z" fill="#fff" />
              {/* serifs */}
              <rect x="2" y="12.9" width="4.5" height="0.8" fill="currentColor" />
              <rect x="9.5" y="12.9" width="4.5" height="0.8" fill="currentColor" />
              <rect x="6.7" y="2.6" width="2.6" height="0.7" fill="currentColor" />
            </svg>
          ) : (
            <svg style={{ display: 'block' }} width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M8 2.5L2.7 13h2l0.85-2h4.9l0.85 2h2L8 2.5z" fill="currentColor" />
              <path d="M6.2 9.3L8 5l1.8 4.3H6.2z" fill="#fff" />
            </svg>
          )}
        </button>
        {/* Copy the FULL server-side address of the directory currently being
            viewed (root path_display + currentPath). Disabled when no root is
            selected yet (e.g. agent has no enabled roots). Reuses copyToClipboard
            so the same fallback + transient "Copied" feedback applies. */}
        <button
          onClick={() => copyToClipboard(fullAddress, 'toolbar-path')}
          style={{
            ...(copiedPath === 'toolbar-path' ? styles.copyPathBtnActive : styles.copyPathBtn),
            ...(activeRootObj ? {} : { opacity: 0.4, cursor: 'not-allowed' }),
          }}
          title={copiedPath === 'toolbar-path' ? 'Copied!' : 'Copy full directory address'}
          disabled={!activeRootObj}
        >
          {copiedPath === 'toolbar-path' ? (
            // checkmark glyph shown for ~2s after a successful copy
            <svg style={{ display: 'block' }} width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M3.5 8.5l3 3 6-7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          ) : (
            // clipboard glyph
            <svg style={{ display: 'block' }} width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
              <rect x="3" y="4" width="9" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.3"/>
              <path d="M5.5 4V3a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
              <path d="M6 8h4M6 10.5h2.5" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round"/>
            </svg>
          )}
        </button>
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

      <AddressBar
        selectedRoot={selectedRoot}
        currentPath={currentPath}
        roots={roots}
        entries={entries}
        agentId={agentId}
        onNavigate={handleNavigate}
      />

      {/* Column headers */}
      <div style={styles.colHeader}>
        <span style={styles.colIcon} />
        <span style={{ ...styles.colName, cursor: 'pointer', ...(nameAlignRight ? { textAlign: 'right' } : {}) }} onClick={() => toggleSort('name')}>
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
  // ── Root selector (custom dropdown) ──
  // Wrapper establishes the positioning context for the absolutely-positioned
  // panel. `position: relative` here anchors the panel to the trigger.
  // `minWidth: 0` lets the trigger shrink within a flex row so the toolbar
  // can't be pushed off-screen by a long root name on narrow widths.
  rootSelect: { position: 'relative', flexShrink: 1, minWidth: 0 },
  // Trigger: same height (28) and radius as the toolbar icon buttons so the
  // root selector reads as part of the same control row. Uses a transparent
  // background + the same border/text token as the icon buttons — a filled
  // surface made it visually heavier than its neighbors. Inline-styled only
  // (no CSS) per the project's theme-token rule.
  //
  // IMPORTANT: use the border LONGHANDs (borderWidth/borderStyle/borderColor),
  // NOT the `border` shorthand. The open state overrides `borderColor`; if the
  // base used the shorthand (one `border` key) while the override used the
  // longhand (a separate `borderColor` key), React's style-diff would, on
  // close, re-apply `border` then CLEAR the now-absent `borderColor` key —
  // leaving border-color unset and falling back to currentColor (the text
  // color = near-black). Keeping borderColor as its own key in BOTH states
  // means React never clears it, so the color always has an explicit value.
  rootTrigger: {
    display: 'flex', alignItems: 'center', gap: 6,
    padding: '0 10px', height: 28, minWidth: 0, maxWidth: 220,
    borderRadius: radius.md,
    borderWidth: 1, borderStyle: 'solid', borderColor: c.border,
    background: 'transparent', color: c.text, cursor: 'pointer',
    fontSize: 13, fontFamily: font.sans, fontWeight: 500,
    outline: 'none', transition: 'border-color 0.15s, box-shadow 0.15s',
  },
  rootTriggerOpen: {
    borderColor: c.accent,
    boxShadow: `0 0 0 2px ${c.accentBg}`,
  },
  rootTriggerLabel: {
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    // allow the label to shrink so the chevron stays visible on narrow widths
    flex: '1 1 auto', minWidth: 0,
  },
  // Panel: absolutely positioned under the trigger. z-index sits above the
  // list/column headers but below modal overlays. minWidth keeps short root
  // names from making the panel too narrow; maxWidth truncates long paths.
  // `right: 0` is NOT set here because the panel should align to the trigger's
  // left edge on desktop; the mobile case overrides alignment inline.
  rootPanel: {
    position: 'absolute', top: 'calc(100% + 4px)', left: 0,
    minWidth: '100%', maxWidth: 360, zIndex: 50,
    background: c.surface, border: `1px solid ${c.border}`,
    borderRadius: radius.md, boxShadow: shadow.md,
    padding: 4, maxHeight: 320, overflowY: 'auto',
    display: 'flex', flexDirection: 'column', gap: 2,
  },
  // Each item shows the root name on top + the server path below (muted,
  // smaller). Full-width buttons so the whole row is clickable; left-aligned
  // text to match the rest of the UI.
  rootItem: {
    display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 2,
    padding: '6px 8px', borderRadius: radius.sm, border: 'none',
    background: 'transparent', color: c.text, cursor: 'pointer',
    fontFamily: font.sans, textAlign: 'left', width: '100%',
    transition: 'background 0.1s',
  },
  rootItemSelected: {
    background: c.accentBg, color: c.accent,
  },
  rootItemName: { fontSize: 13, fontWeight: 500 },
  rootItemPath: {
    fontSize: 11, color: c.textMuted, fontWeight: 400,
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    maxWidth: '100%',
  },
  refreshBtn: {
    padding: 0, borderRadius: radius.md, border: `1px solid ${c.border}`,
    background: 'transparent', color: c.textSecondary, cursor: 'pointer',
    fontSize: 16, lineHeight: 1, transition: 'all 0.15s',
    width: 34, height: 28, flexShrink: 0, boxSizing: 'border-box',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  alignBtn: {
    padding: '4px 10px', borderRadius: radius.md, border: `1px solid ${c.border}`,
    background: 'transparent', color: c.textSecondary, cursor: 'pointer',
    fontSize: 16, lineHeight: 1, width: 34, height: 28,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    boxSizing: 'border-box', flexShrink: 0,
  },
  alignBtnActive: {
    padding: '4px 10px', borderRadius: radius.md, border: `1px solid ${c.accent}`,
    background: c.accentBg, color: c.accent, cursor: 'pointer',
    fontSize: 16, lineHeight: 1, width: 34, height: 28,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    boxSizing: 'border-box', flexShrink: 0,
  },
  fontBtn: {
    padding: '4px 10px', borderRadius: radius.md, border: `1px solid ${c.border}`,
    background: 'transparent', color: c.textSecondary, cursor: 'pointer',
    fontSize: 16, lineHeight: 1, width: 34, height: 28,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    boxSizing: 'border-box', flexShrink: 0,
  },
  fontBtnActive: {
    padding: '4px 10px', borderRadius: radius.md, border: `1px solid ${c.accent}`,
    background: c.accentBg, color: c.accent, cursor: 'pointer',
    fontSize: 16, lineHeight: 1, width: 34, height: 28,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    boxSizing: 'border-box', flexShrink: 0,
  },
  // Copy-address button: same box model as the align / font toggle buttons so
  // the four toolbar buttons read as one consistent group. Default = idle
  // outline; the "Active" variant is the transient success state shown right
  // after a copy (green accent + checkmark). `:disabled` (no root selected)
  // is handled via inline opacity — see button style below.
  copyPathBtn: {
    padding: '4px 10px', borderRadius: radius.md, border: `1px solid ${c.border}`,
    background: 'transparent', color: c.textSecondary, cursor: 'pointer',
    fontSize: 16, lineHeight: 1, width: 34, height: 28,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    boxSizing: 'border-box', flexShrink: 0,
    transition: 'all 0.15s',
    // Note: the disabled visual (dimmed + not-allowed) is applied via inline
    // style override in the JSX — React inline styles can't express :disabled.
  },
  copyPathBtnActive: {
    padding: '4px 10px', borderRadius: radius.md, border: `1px solid ${c.success}`,
    background: c.successBg, color: c.success, cursor: 'pointer',
    fontSize: 16, lineHeight: 1, width: 34, height: 28,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    boxSizing: 'border-box', flexShrink: 0,
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
  // NOTE: border longhands (not the shorthand) because the JSX overrides
  // `borderColor` to flag an invalid regex — same React style-diff trap as
  // rootTrigger (shorthand base + longhand override => borderColor gets
  // cleared on next render => falls back to currentColor = black).
  filterInput: {
    flex: 1, padding: '6px 10px', borderRadius: radius.md,
    borderWidth: 1, borderStyle: 'solid', borderColor: c.border,
    background: c.surface, color: c.text, fontSize: 13, outline: 'none',
    fontFamily: font.sans, transition: 'border-color 0.15s',
  },
  filterClear: {
    padding: '0 6px', borderRadius: radius.sm, border: 'none',
    background: 'transparent', color: c.textMuted, cursor: 'pointer', fontSize: 16,
  },
  filterCount: { color: c.textMuted, fontSize: 12, flexShrink: 0 },
  filterError: { color: c.danger, fontSize: 12, flexShrink: 0 },
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
  entryName: { color: c.text, fontSize: 14, fontWeight: 500, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  entryDate: { color: c.textMuted, fontSize: 12, width: 130, textAlign: 'right', flexShrink: 0 },
  entryDateMobile: { color: c.textMuted, fontSize: 10, textAlign: 'right', flexShrink: 0, width: 72 },
  entryMeta: { color: c.textFaint, fontSize: 12, width: 80, textAlign: 'right', flexShrink: 0 },
  deniedBadge: {
    color: c.warning, fontSize: 10, fontStyle: 'normal', fontWeight: 500,
    padding: '1px 6px', background: c.warningBg, borderRadius: radius.pill, flexShrink: 0,
  },
  // Per-row copy button. Square icon-only button (no text) so it visually
  // matches the toolbar copy-address button — same clipboard glyph, same
  // checkmark on success. Kept compact (24×24) to fit inside a 32px-tall row
  // without crowding the date/size columns.
  copyNameBtn: {
    padding: 0, borderRadius: radius.sm, border: 'none',
    background: 'transparent', color: c.textMuted, cursor: 'pointer',
    lineHeight: 1, flexShrink: 0, marginLeft: 4,
    width: 24, height: 24,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    boxSizing: 'border-box', transition: 'color 0.15s',
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
