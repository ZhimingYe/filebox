import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { FixedSizeList as VList } from 'react-window';
import * as api from '../api/client';
import { friendlyMessage } from '../api/client';
import { useIsMobile } from '../state/useIsMobile';
import { c, radius, font, fileType, menuList, menuListItemStyle, menuListSubStyle } from '../theme';
import { AddressBar } from './AddressBar';
import { DirectoryTree } from './DirectoryTree';
import { IconPin, IconClose } from './icons';
import {
  DateFilterControl,
  EMPTY_DATE_FILTER,
  isCustomDateRangeInvalid,
  isDateFilterActive,
  matchesDateFilter,
  type DateFilterValue,
} from './DateFilterControl';

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

// ── File-type badge icon ───────────────────────────────────────────────
//
// A single reusable document glyph FILLED with the category color, with a
// folded corner and a short white extension LABEL. Category → color lives in
// theme.fileType; the label is the extension itself. This scales to any
// extension without a bespoke SVG per type: color = category, text = exact
// ext. Files with no extension (README, Makefile, LICENSE) fall back to the
// plain IconFile — a colored badge with no label reads as noise.
//
// The label uses a FIXED font size that steps down by length (never
// textLength/lengthAdjust, which distorts the glyphs), so "R", "PDF" and
// "JSON" stay in their natural proportions and just center within the page.

type FileCat = keyof typeof fileType;

// extension → category. Built via `add(cat, [...exts])` then inverted so the
// source reads by category (easy to extend) but lookup is O(1) by extension.
const EXT_CAT: Record<string, FileCat> = {};
const add = (cat: FileCat, exts: string[]) => { for (const e of exts) EXT_CAT[e] = cat; };
add('pdf', ['pdf']);
add('doc', ['doc', 'docx', 'odt', 'rtf', 'pages']);
add('sheet', ['xls', 'xlsx', 'ods', 'csv', 'tsv', 'numbers']);
add('slide', ['ppt', 'pptx', 'odp', 'key']);
add('image', ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg', 'ico', 'tif', 'tiff', 'heic', 'avif', 'psd']);
add('video', ['mp4', 'mov', 'mkv', 'avi', 'webm', 'flv', 'wmv', 'm4v', 'mpg', 'mpeg']);
add('audio', ['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'wma', 'opus', 'aiff']);
add('archive', ['zip', 'tar', 'gz', 'tgz', 'rar', '7z', 'bz2', 'xz', 'zst', 'lz', 'lzma']);
add('r', ['r', 'rmd', 'rds', 'rdata']);
add('python', ['py', 'pyw', 'pyi', 'ipynb']);
add('js', ['js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx']);
add('data', ['json', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'xml', 'parquet', 'arrow', 'feather']);
add('markdown', ['md', 'markdown', 'mdx', 'rst']);
add('text', ['txt', 'text', 'log', 'out', 'err']);
add('code', ['html', 'htm', 'css', 'scss', 'sass', 'less', 'rs', 'go', 'c', 'h', 'cpp', 'cc',
  'cxx', 'hpp', 'java', 'kt', 'kts', 'swift', 'rb', 'php', 'sh', 'bash', 'zsh', 'fish', 'sql',
  'lua', 'vue', 'svelte', 'pl', 'scala', 'clj', 'ex', 'exs', 'dart', 'jl', 'm', 'f90', 'vim']);

// Display label overrides where the raw uppercased extension is wrong or ugly.
const EXT_LABEL: Record<string, string> = {
  jpeg: 'JPG', tiff: 'TIF', markdown: 'MD', text: 'TXT', tgz: 'GZ', lzma: 'LZ',
  ipynb: 'NB', pyw: 'PY', pyi: 'PY', cpp: 'C++', cc: 'C++', cxx: 'C++', hpp: 'H',
  htm: 'HTML', yaml: 'YML', yml: 'YML', mjs: 'JS', cjs: 'JS', rdata: 'RDA', rds: 'RDS',
};

function fileExt(name: string): string {
  const dot = name.lastIndexOf('.');
  // dot at 0 = dotfile (.bashrc) — treat as extensionless; -1 = no dot.
  if (dot <= 0) return '';
  return name.slice(dot + 1).toLowerCase();
}

function FileTypeIcon({ name }: { name: string }) {
  const ext = fileExt(name);
  if (!ext) return <IconFile />;
  const cat = EXT_CAT[ext];
  const color = cat ? fileType[cat] : fileType.neutral;
  const label = EXT_LABEL[ext] ?? ext.toUpperCase().slice(0, 4);
  // Step font size down by length so glyphs keep their natural shape (no
  // horizontal stretching) AND stay inside the page's ~9px inner width — at
  // the previous sizes a 3–4 char label (e.g. "RMD") overflowed the fill edge.
  const fontSize = label.length <= 1 ? 6.4 : label.length === 2 ? 5.3 : label.length === 3 ? 4.3 : 3.5;
  return (
    <svg style={iconStyle} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      {/* Whole document filled with the category color. */}
      <path d="M4 2h5.59a1 1 0 0 1 .7.29l2.71 2.71a1 1 0 0 1 .29.7V13a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1Z" fill={color}/>
      {/* Folded top-right corner as a lighter overlay. */}
      <path d="M9.7 2.2 13 5.5H10.2a.5.5 0 0 1-.5-.5V2.2Z" fill="#ffffff" fillOpacity="0.4"/>
      {/* Extension label, natural proportions, centered on the lower page. */}
      <text
        x="8" y="11.8"
        fontFamily={font.sans} fontSize={fontSize} fontWeight={700}
        fill="#ffffff" textAnchor="middle"
      >{label}</text>
    </svg>
  );
}

function getEntryIcon(entry: api.FsEntry) {
  switch (entry.entry_type) {
    case 'directory': return <IconFolder />;
    case 'symlink': return <IconSymlink />;
    default: return <FileTypeIcon name={entry.name} />;
  }
}

// ── Directory-tree resize splitter (desktop only) ──────────────────────────
// A 6px grab strip sitting to the right of the tree's border. Transparent at
// rest; a thin accent bar appears on hover or while dragging so the affordance
// is discoverable without cluttering the layout. The actual drag math lives in
// the parent (it owns the width + the window listeners); this is purely the
// hit target and its visual state. Double-click bubbles up to reset the width.
function TreeSplitter({ active, onStart, onReset }: {
  active: boolean;
  onStart: () => void;
  onReset: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const lit = active || hovered;
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      title="Drag to resize the directory tree (double-click to reset)"
      style={styles.splitter}
      onMouseDown={(e) => { e.preventDefault(); onStart(); }}
      onDoubleClick={onReset}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div style={{ ...styles.splitterBar, background: lit ? c.accent : 'transparent' }} />
    </div>
  );
}

interface Props {
  agentId: string;
  roots: api.RootInfo[];
  onFileSelect: (root: string, path: string, entry: api.FsEntry) => void;
  // Fired whenever the visible file list changes — used by parent for keyboard navigation
  onEntriesChange?: (info: { root: string; path: string; entries: api.FsEntry[] }) => void;
  // Fired after a root's pinned_folders change so the parent (which owns the
  // agent list + SSE refresh) can refetch and propagate the new pins down.
  onRootsChange?: () => void;
  // Imperative navigation request from the sidebar PinnedFolders section.
  // Bumping `nonce` (even with the same root/path) triggers a fresh navigate.
  navRequest?: { root: string; path: string; nonce: number } | null;
  onNavHandled?: () => void;
  // ── Controlled navigation state ──
  // selectedRoot / currentPath are owned by the PARENT (App.tsx) so they
  // survive view switches (Files → Settings → Files). Previously they lived
  // as local state here, but FileBrowser unmounts when the user leaves the
  // Files view — and remount reset the position to the first root's root,
  // losing the user's place. Lifting the state to the never-unmounting App
  // fixes that. The parent also owns the per-(agent,root) path memory map.
  selectedRoot: string | null;
  currentPath: string;
  // Apply a navigation (set both root + path together, atomically). The parent
  // implements this and also updates its path-memory map. Replaces the old
  // internal handleNavigate / setSelectedRoot / setCurrentPath calls.
  onApplyNav: (root: string, path: string) => void;
  // Switch to a different root, restoring that root's remembered path. The
  // parent owns the path-memory map so only it knows the target path; the
  // root-selector dropdown calls this. Distinct from onApplyNav because the
  // child doesn't (and shouldn't) know the remembered path.
  onSwitchRoot: (root: string) => void;
}

type SortKey = 'name' | 'modified' | 'size';

const PAGE_LIMIT = 200;

export function FileBrowser({ agentId, roots, onFileSelect, onEntriesChange, onRootsChange, navRequest, onNavHandled, selectedRoot, currentPath, onApplyNav, onSwitchRoot }: Props) {
  const isMobile = useIsMobile();
  const ROW_HEIGHT = isMobile ? 44 : 32;

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
  // Hover uses the shared `menuList` tokens (same as the preview tab picker).
  const [rootOpen, setRootOpen] = useState(false);
  const [hoveredRoot, setHoveredRoot] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const [listHeight, setListHeight] = useState(400);
  const [sortBy, setSortBy] = useState<SortKey>('name');
  const [sortAsc, setSortAsc] = useState(true);
  const [filterText, setFilterText] = useState('');
  // Client-side mtime filter (AND with the name filter). Operates on the
  // already-loaded page of entries — same scope as the name filter.
  // UI + range math live in DateFilterControl.
  const [dateFilter, setDateFilter] = useState<DateFilterValue>(EMPTY_DATE_FILTER);
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
  // Tree view toggle: persisted so the user keeps their preferred layout.
  const [treeOpen, setTreeOpen] = useState<boolean>(() => {
    // Desktop may restore open; mobile drawers always start closed so they
    // don't fight the first paint or leftover overlay state.
    try {
      if (typeof window !== 'undefined' && window.innerWidth < 768) return false;
      return localStorage.getItem('filebox.treeOpen') === '1';
    } catch {
      return false;
    }
  });
  useEffect(() => {
    // Only persist desktop dock preference; mobile is ephemeral.
    if (isMobile) return;
    try { localStorage.setItem('filebox.treeOpen', treeOpen ? '1' : '0'); } catch { /* ignore */ }
  }, [treeOpen, isMobile]);
  // Bumped to remount DateFilterControl closed when the tree opens — keeps
  // two full-screen-ish mobile layers from stacking on top of each other.
  const [dateFilterEpoch, setDateFilterEpoch] = useState(0);

  const closeTree = useCallback(() => setTreeOpen(false), []);
  const toggleTree = useCallback(() => {
    setTreeOpen((v) => {
      if (v) return false;
      setDateFilterEpoch((n) => n + 1);
      setRootOpen(false);
      return true;
    });
  }, []);
  // Desktop directory-tree width (px), resizable via the splitter and persisted.
  // Mobile ignores this (the tree is a ~70% / 260px overlay drawer there). Clamped on
  // read so a corrupt/out-of-range stored value can never wedge the layout.
  const TREE_MIN_W = 160;
  const TREE_MAX_W = 560;
  const TREE_DEFAULT_W = 240;
  const clampTreeW = (n: number) => Math.min(TREE_MAX_W, Math.max(TREE_MIN_W, n));
  const [treeWidth, setTreeWidth] = useState<number>(() => {
    try {
      const v = parseInt(localStorage.getItem('filebox.treeWidth') || '', 10);
      return Number.isFinite(v) ? clampTreeW(v) : TREE_DEFAULT_W;
    } catch { return TREE_DEFAULT_W; }
  });
  useEffect(() => {
    try { localStorage.setItem('filebox.treeWidth', String(treeWidth)); } catch { /* ignore */ }
  }, [treeWidth]);
  // True while the splitter is being dragged. A separate effect attaches the
  // window-level move/up listeners only during a drag, so there's no idle global
  // handler and cleanup is guaranteed on mouseup or unmount.
  const [treeDragging, setTreeDragging] = useState(false);
  // contentWrap bounds the tree + main area; its left edge is the origin we
  // measure the pointer against to derive the new width.
  const contentWrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!treeDragging) return;
    const onMove = (e: MouseEvent) => {
      const wrap = contentWrapRef.current;
      if (!wrap) return;
      const left = wrap.getBoundingClientRect().left;
      setTreeWidth(clampTreeW(e.clientX - left));
    };
    const onUp = () => setTreeDragging(false);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    // Force the resize cursor + suppress text selection for the whole drag,
    // regardless of what the pointer is over.
    const prevCursor = document.body.style.cursor;
    const prevSelect = document.body.style.userSelect;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevSelect;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [treeDragging]);
  // Refresh nonce: the toolbar Refresh button bumps this to ask the directory
  // tree to reload its expanded nodes (retries stuck/errored nodes and picks up
  // new subdirectories). Mirrors the pinned-folders navRequest nonce pattern.
  const [treeRefreshNonce, setTreeRefreshNonce] = useState(0);
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

  // ── Pinning ──────────────────────────────────────────────────────────────
  // Normalize a path for membership comparison AND storage: strip trailing
  // slashes except for the root itself, and ensure a leading "/" (root-relative
  // canonical shape, matching the backend's validate_pinned_path). So "/a/" and
  // "/a" compare equal, "/" stays "/", and a bare "foo" becomes "/foo".
  const normalizePinPath = (p: string) => {
    let s = p.length > 1 && p.endsWith('/') ? p.replace(/\/+$/, '') : p;
    if (!s.startsWith('/')) s = '/' + s;
    return s;
  };

  const [pinBusy, setPinBusy] = useState(false);
  const [pinError, setPinError] = useState<string | null>(null);

  // Is the folder currently being viewed already pinned in this root?
  const currentPinned = useMemo(() => {
    if (!activeRootObj) return false;
    const norm = normalizePinPath(currentPath);
    return activeRootObj.pinned_folders.some((p) => normalizePinPath(p) === norm);
  }, [activeRootObj, currentPath]);

  // Toggle pin for the folder currently being viewed. Uses single-item atomic
  // deltas (pin_add / pin_remove) instead of sending the whole array, so rapid
  // clicks or two tabs editing the same root can't clobber each other. The
  // parent's SSE-driven refresh then propagates the updated roots back down.
  // Errors are surfaced inline via pinError rather than throwing to a toast —
  // pinning is a small, local affordance and a transient toast would be jarring.
  const togglePin = useCallback(async () => {
    if (!activeRootObj || pinBusy) return;
    setPinBusy(true);
    setPinError(null);
    try {
      const norm = normalizePinPath(currentPath);
      const patch = currentPinned ? { pin_remove: norm } : { pin_add: norm };
      await api.patchRoot(agentId, activeRootObj.name, patch);
      onRootsChange?.();
    } catch (e: any) {
      setPinError(friendlyMessage(e));
    } finally {
      setPinBusy(false);
    }
  }, [activeRootObj, currentPath, currentPinned, agentId, pinBusy, onRootsChange]);

  // Imperative navigation from the sidebar's Pinned Folders section. We drive
  // this off `nonce` rather than referential identity so clicking the SAME pin
  // twice still navigates (e.g. after navigating away by hand). The parent
  // clears its request via onNavHandled once we've acted on it.
  useEffect(() => {
    if (!navRequest || navRequest.nonce === 0) return;
    handleNavigate(navRequest.root, navRequest.path);
    onNavHandled?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navRequest?.nonce]);

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
    if (!rootOpen) {
      setHoveredRoot(null);
      return;
    }
    const close = () => {
      setRootOpen(false);
      setHoveredRoot(null);
    };
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        close();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [rootOpen]);

  // Clear the local file list when the agent changes — the parent owns which
  // root/path is shown, but the fetched entries (and any stale error) are this
  // component's concern. Keeps a switching agent from flashing the previous
  // agent's files before the new listing loads.
  const prevAgentIdRef = useRef(agentId); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (prevAgentIdRef.current !== agentId) {
      setEntries([]);
      setError(null);
      prevAgentIdRef.current = agentId;
    }
  }, [agentId]);

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
      onApplyNav(selectedRoot!, currentPath + sep + entry.name);
    } else {
      onFileSelect(selectedRoot!, currentPath === '/' ? `/${entry.name}` : `${currentPath}/${entry.name}`, entry);
    }
  };

  const navigateUp = () => {
    const parts = currentPath.split('/').filter(Boolean);
    parts.pop();
    onApplyNav(selectedRoot!, '/' + parts.join('/'));
  };

  // Delegate to the parent's atomic root+path setter (which also maintains the
  // per-(agent,root) path memory). Same-root calls just update the path;
  // cross-root calls restore that root's remembered path via the parent.
  const handleNavigate = useCallback((root: string, path: string) => {
    onApplyNav(root, path);
  }, [onApplyNav]);

  // Stable callback the directory tree calls when a folder is clicked. Kept
  // referentially stable (via useCallback) so the memoized tree rows don't all
  // re-render on every FileBrowser render — without this the inline arrow
  // would be a fresh function each render and bust React.memo on every row.
  const handleTreeNavigate = useCallback((path: string) => {
    if (selectedRoot) handleNavigate(selectedRoot, path);
    if (isMobile) closeTree();
  }, [selectedRoot, handleNavigate, isMobile, closeTree]);

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

  const dateRangeInvalid =
    dateFilter.preset === 'custom' &&
    isCustomDateRangeInvalid(dateFilter.after, dateFilter.before);
  const dateFilterActive = isDateFilterActive(dateFilter);

  // Name filter first (glob / regex). Derive the error flag in the memo — never
  // setState during useMemo (that re-renders mid-render and is a React footgun).
  // On invalid regex keep the unfiltered-by-name list so a bad pattern does
  // not blank the directory.
  const nameFilter = useMemo(() => {
    if (!filterText.trim()) {
      return { entries: sortedEntries, error: false };
    }
    try {
      const pattern = globToRegex(filterText);
      const re = new RegExp(pattern, 'i');
      return {
        entries: sortedEntries.filter((e) => re.test(e.name)),
        error: false,
      };
    } catch {
      return { entries: sortedEntries, error: true };
    }
  }, [sortedEntries, filterText]);

  // Date filter ANDed with name filter. Client-side over the loaded listing.
  // Invalid custom range (From > To): skip date filter so the list does not
  // go blank while the user fixes the bounds; surface an error in the bar.
  const filteredEntries = useMemo(() => {
    let list = nameFilter.entries;
    if (dateFilterActive) {
      list = list.filter((e) => matchesDateFilter(e.modified, dateFilter));
    }
    return list;
  }, [nameFilter.entries, dateFilter, dateFilterActive]);

  const filterError = nameFilter.error;

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
          {isBack ? <IconUpDir /> : getEntryIcon(displayEntry!)}
        </span>
        <div style={styles.entryNameCell}>
          <span
            style={{
              ...styles.entryName,
              fontFamily: fileNameSerif ? font.serif : font.sans,
              ...(!isBack && nameAlignRight ? { direction: 'rtl', textAlign: 'right', flex: '1 1 auto' } : {}),
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
                const sep = currentPath === '/' ? '' : '/';
                copyToClipboard(fullAddress + sep + displayEntry!.name, `name-${index}`);
              }}
              style={styles.copyNameBtn}
              title="Copy full path"
            >
              {copiedPath === `name-${index}` ? (
                <svg style={{ display: 'block' }} width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M3.5 8.5l3 3 6-7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              ) : (
                <svg style={{ display: 'block' }} width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <rect x="3" y="4" width="9" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.3"/>
                  <path d="M5.5 4V3a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
                  <path d="M6 8h4M6 10.5h2.5" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round"/>
                </svg>
              )}
            </button>
          )}
        </div>
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
      <div style={styles.toolbar}>
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
              // Clear hover when the pointer leaves the whole panel (not per
              // row — same rule as the preview tab-jump listbox).
              onMouseLeave={() => setHoveredRoot(null)}
            >
              {enabledRoots.map((r) => {
                const isSel = r.name === selectedRoot;
                const isHovered = hoveredRoot === r.name;
                return (
                  <button
                    key={r.name}
                    type="button"
                    role="option"
                    aria-selected={isSel}
                    style={menuListItemStyle({ selected: isSel, hovered: isHovered })}
                    onMouseEnter={() => setHoveredRoot(r.name)}
                    onClick={() => {
                      // Switching roots: the parent restores the target root's
                      // remembered path (it owns the path-memory map). We just
                      // close the dropdown here.
                      onSwitchRoot(r.name);
                      setRootOpen(false);
                      setHoveredRoot(null);
                    }}
                    title={r.path_display}
                  >
                    <span style={menuList.itemTitle}>{r.name}</span>
                    <span style={menuListSubStyle(isSel)}>{r.path_display}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
        <button
          onClick={() => { loadDir(false); setTreeRefreshNonce((n) => n + 1); }}
          style={styles.refreshBtn}
          title="Refresh"
        >
          {/* Circular-arrow refresh glyph. Drawn as SVG (not the ↻ text char)
              so it renders identically across fonts/platforms. Kept compact
              (radius 4, stroke 1.3) to match the visual weight of the align /
              font / copy toolbar icons. */}
          <svg style={{ display: 'block' }} width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M12 8a4 4 0 1 1-1.2-2.8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
            <path d="M12 3.5v3h-3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>
        {/* Tree view toggle: shows a directory tree for navigating deep paths
            that overflow the horizontal address bar. On desktop it docks left of
            the file list; on mobile it opens as a left drawer overlaying the
            list (side-by-side would be too cramped on a narrow screen). Sits
            beside Refresh so the two navigation controls stay together. */}
        <button
          onClick={toggleTree}
          style={treeOpen ? styles.treeBtnActive : styles.treeBtn}
          title={treeOpen ? 'Hide directory tree' : 'Show directory tree'}
          aria-pressed={treeOpen}
        >
          <svg style={{ display: 'block' }} width="16" height="16" viewBox="0 0 16 16" fill="none">
            <rect x="2" y="2" width="4" height="4" rx="1" stroke="currentColor" strokeWidth="1.3"/>
            <rect x="2" y="10" width="4" height="4" rx="1" stroke="currentColor" strokeWidth="1.3"/>
            <path d="M6 4h8M6 12h4v-8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
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
        {/* Pin / unpin the folder currently being viewed. The pinned set lives
            per-root in agent_state.json (backend-authoritative), so this PATCHes
            a single-item delta (pin_add / pin_remove) — NOT the whole array —
            so rapid clicks or two tabs editing the same root can't clobber each
            other (last-array-wins would). Disabled when no root is selected.
            Active (accent) when the current folder is already pinned. Errors are
            surfaced inline just below the toolbar, not only in the title. */}
        <button
          onClick={togglePin}
          style={{
            ...(currentPinned ? styles.pinBtnActive : styles.pinBtn),
            ...(!activeRootObj || pinBusy ? { opacity: 0.4, cursor: 'not-allowed' } : {}),
          }}
          title={
            pinError
              ? pinError
              : currentPinned
                ? 'Unpin this folder'
                : 'Pin this folder to the sidebar'
          }
          aria-pressed={currentPinned}
          disabled={!activeRootObj || pinBusy}
        >
          <IconPin />
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
      {/* Visible pin error. The pin button also carries the message in its
          title, but a hover-only cue violates "never freeze silently" — a user
          on touch or who never hovers wouldn't see that the pin was rejected
          (e.g. by a legacy agent or a vanished folder). Shown here, just below
          the toolbar, with a dismiss × so it doesn't linger after the user
          reads it. */}
      {pinError && (
        <div style={styles.pinErrorRow} role="alert">
          <span style={styles.pinErrorText}>{pinError}</span>
          <button
            onClick={() => setPinError(null)}
            style={styles.pinErrorDismiss}
            title="Dismiss"
            aria-label="Dismiss pin error"
          >
            <IconClose />
          </button>
        </div>
      )}
      <div style={styles.filterBar}>
        <div style={styles.filterRow}>
          <input
            type="text"
            value={filterText}
            onChange={(e) => setFilterText(e.target.value)}
            placeholder={isMobile ? 'Search…' : 'Search files... (* and ? supported)'}
            style={{ ...styles.filterInput, borderColor: filterError ? c.danger : c.border }}
          />
          {filterText && (
            <button onClick={() => setFilterText('')} style={styles.filterClear} title="Clear name filter">&times;</button>
          )}
          <DateFilterControl
            key={dateFilterEpoch}
            value={dateFilter}
            onChange={setDateFilter}
            isMobile={isMobile}
            matchCount={dateFilterActive ? filteredEntries.length : null}
            onOpenChange={(open) => {
              // Date filter is a full-viewport sheet on mobile — never leave
              // the folder drawer open underneath it.
              if (open && isMobile) closeTree();
            }}
          />
          {dateFilterActive && (
            <button
              onClick={() => setDateFilter(EMPTY_DATE_FILTER)}
              style={styles.filterClear}
              title="Clear date filter"
              aria-label="Clear date filter"
            >
              &times;
            </button>
          )}
          {(filterText || dateFilterActive) && !filterError && !dateRangeInvalid && (
            <span style={styles.filterCount}>
              {filteredEntries.length}{isMobile ? '' : ` match${filteredEntries.length !== 1 ? 'es' : ''}`}
            </span>
          )}
          {filterError && <span style={styles.filterError}>Invalid regex</span>}
          {dateRangeInvalid && (
            <span style={styles.filterError} role="alert">Invalid range</span>
          )}
        </div>
      </div>

      <div ref={contentWrapRef} style={{ ...styles.contentWrap, position: 'relative' }}>
        {treeOpen && selectedRoot && activeRootObj && isMobile && (
          <div style={styles.treeBackdrop} onClick={closeTree} />
        )}
        {treeOpen && selectedRoot && activeRootObj && (
          <DirectoryTree
            key={`${agentId}:${selectedRoot}`}
            agentId={agentId}
            rootName={selectedRoot}
            rootPath={activeRootObj.path_display}
            currentPath={currentPath}
            overlay={isMobile}
            onClose={isMobile ? closeTree : undefined}
            width={treeWidth}
            refreshNonce={treeRefreshNonce}
            onNavigate={handleTreeNavigate}
          />
        )}
        {/* Desktop-only resize splitter between the tree and the file list.
            Double-click resets to the default width so a mis-drag can't wedge
            the tree too narrow/wide. Hidden on mobile (overlay drawer). */}
        {treeOpen && selectedRoot && activeRootObj && !isMobile && (
          <TreeSplitter
            active={treeDragging}
            onStart={() => setTreeDragging(true)}
            onReset={() => setTreeWidth(TREE_DEFAULT_W)}
          />
        )}
        <div style={styles.mainArea}>
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
              // At root, `rows` is exactly the filtered list so this catches
              // "no matches". In a subdirectory the synthetic ".." keeps
              // rows non-empty; the filter bar's "0 matches" covers that case
              // without removing the parent-nav affordance.
              <div style={styles.empty}>
                {filterText.trim() || dateFilterActive ? 'No matches for current filters' : 'Empty directory'}
              </div>
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

// Current year omits the year; post-2000 years use 2 digits (25 not 2025).
function formatDate(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const md = `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.getFullYear() === now.getFullYear()) {
    return `${md} ${hm}`;
  }
  const yr = d.getFullYear() >= 2000
    ? String(d.getFullYear()).slice(-2)
    : String(d.getFullYear());
  return `${yr}-${md} ${hm}`;
}

// Compact form for narrow mobile rows.
function formatDateShort(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const md = `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  if (d.getFullYear() === now.getFullYear()) {
    return `${md} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  const yr = d.getFullYear() >= 2000
    ? String(d.getFullYear()).slice(-2)
    : String(d.getFullYear());
  return `${yr}-${md}`;
}

const styles: Record<string, React.CSSProperties> = {
  container: { display: 'flex', flexDirection: 'column', height: '100%', fontFamily: font.sans },
  toolbar: {
    padding: '8px 12px', borderBottom: `1px solid ${c.border}`,
    display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
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
  // Panel: absolutely positioned under the trigger. Row chrome comes from the
  // shared `menuList` tokens (same as the preview tab-jump picker). Positioning
  // stays local — desktop left-aligned, mobile full-width via inline override.
  rootPanel: {
    ...menuList.panel,
    position: 'absolute', top: 'calc(100% + 4px)', left: 0,
    minWidth: '100%', maxWidth: 360, zIndex: 50,
    maxHeight: 320, overflowY: 'auto',
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
  // Pin toggle button: matches the align/font/copy box model. Idle = neutral
  // outline with a hollow pin; active (pinned) = accent border + accentBg with
  // a filled pin. `:disabled` (no root selected / busy) handled via inline opacity.
  pinBtn: {
    padding: '4px 10px', borderRadius: radius.md, border: `1px solid ${c.border}`,
    background: 'transparent', color: c.textSecondary, cursor: 'pointer',
    fontSize: 16, lineHeight: 1, width: 34, height: 28,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    boxSizing: 'border-box', flexShrink: 0,
    transition: 'all 0.15s',
  },
  pinBtnActive: {
    padding: '4px 10px', borderRadius: radius.md, border: `1px solid ${c.accent}`,
    background: c.accentBg, color: c.accent, cursor: 'pointer',
    fontSize: 16, lineHeight: 1, width: 34, height: 28,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    boxSizing: 'border-box', flexShrink: 0,
    transition: 'all 0.15s',
  },
  // Inline pin error: shown just below the toolbar when a pin/unpin was
  // rejected (legacy agent, vanished folder, etc.). Dismissible so it doesn't
  // outlive the user's attention; role="alert" for screen readers.
  pinErrorRow: {
    display: 'flex', alignItems: 'center', gap: 8,
    padding: '6px 12px', margin: '6px 12px 0',
    borderRadius: radius.md, background: c.dangerBg, border: `1px solid ${c.danger}`,
  },
  pinErrorText: { flex: 1, fontSize: 12, color: c.danger, fontFamily: font.sans },
  pinErrorDismiss: {
    flexShrink: 0, width: 22, height: 22, padding: 0, lineHeight: 1,
    border: 'none', background: 'transparent', cursor: 'pointer',
    color: c.danger, borderRadius: radius.sm,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
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
    padding: '6px 10px', borderBottom: `1px solid ${c.border}`,
    display: 'flex', flexDirection: 'column', gap: 6,
    background: c.bg,
  },
  filterRow: {
    display: 'flex', alignItems: 'center', gap: 6,
    minWidth: 0,
  },
  // NOTE: border longhands (not the shorthand) because the JSX overrides
  // `borderColor` to flag an invalid regex — same React style-diff trap as
  // rootTrigger (shorthand base + longhand override => borderColor gets
  // cleared on next render => falls back to currentColor = black).
  filterInput: {
    flex: 1, minWidth: 0, padding: '6px 10px', borderRadius: radius.md,
    borderWidth: 1, borderStyle: 'solid', borderColor: c.border,
    background: c.surface, color: c.text, fontSize: 13, outline: 'none',
    fontFamily: font.sans, transition: 'border-color 0.15s',
  },
  filterClear: {
    padding: '0 6px', borderRadius: radius.sm, border: 'none',
    background: 'transparent', color: c.textMuted, cursor: 'pointer', fontSize: 16,
    flexShrink: 0,
  },
  filterCount: { color: c.textMuted, fontSize: 12, flexShrink: 0 },
  filterError: { color: c.danger, fontSize: 12, flexShrink: 0 },
  // ── Tree view layout ──
  // The directory tree sits as a fixed-width left panel; the file list + address
  // bar + column headers fill the remaining space. `overflow: hidden` on both
  // axes keeps the layout from blowing out when the address bar or a filename
  // is very long.
  contentWrap: {
    flex: 1, display: 'flex', overflow: 'hidden', minHeight: 0,
  },
  mainArea: {
    flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0,
  },
  // Resize grab strip between the tree and the file list. flexShrink:0 so it
  // keeps its full hit width; the inner bar (splitterBar) is the visible cue.
  splitter: {
    flexShrink: 0,
    width: 6,
    cursor: 'col-resize',
    display: 'flex',
    alignItems: 'stretch',
    background: 'transparent',
    zIndex: 1,
  },
  splitterBar: {
    width: 2,
    borderRadius: 1,
    transition: 'background 0.1s',
  },
  // Mobile-only full-viewport dimmer behind the fixed tree drawer.
  // z-index ladder (mobile overlays):
  //   300 backdrop · 310 tree · 320 date backdrop · 330 date sheet
  // Tree/date are mutual-exclusive in handlers so they never stack.
  treeBackdrop: {
    position: 'fixed',
    inset: 0,
    background: c.bgOverlay,
    zIndex: 300,
  },
  treeBtn: {
    padding: '4px 10px', borderRadius: radius.md, border: `1px solid ${c.border}`,
    background: 'transparent', color: c.textSecondary, cursor: 'pointer',
    fontSize: 16, lineHeight: 1, width: 34, height: 28,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    boxSizing: 'border-box', flexShrink: 0,
  },
  treeBtnActive: {
    padding: '4px 10px', borderRadius: radius.md, border: `1px solid ${c.accent}`,
    background: c.accentBg, color: c.accent, cursor: 'pointer',
    fontSize: 16, lineHeight: 1, width: 34, height: 28,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    boxSizing: 'border-box', flexShrink: 0,
  },
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
  entryNameCell: {
    flex: 1, minWidth: 0, display: 'flex',
    alignItems: 'center', gap: 4, overflow: 'hidden', boxSizing: 'border-box',
  },
  entryName: { color: c.text, fontSize: 14, fontWeight: 500, flex: '0 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  entryDate: {
    color: c.textMuted, fontSize: 12, width: 130, textAlign: 'right',
    flexShrink: 0, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums',
  },
  entryDateMobile: { color: c.textMuted, fontSize: 10, textAlign: 'right', flexShrink: 0, width: 72 },
  entryMeta: { color: c.textFaint, fontSize: 12, width: 80, textAlign: 'right', flexShrink: 0 },
  deniedBadge: {
    color: c.warning, fontSize: 10, fontStyle: 'normal', fontWeight: 500,
    padding: '1px 6px', background: c.warningBg, borderRadius: radius.pill, flexShrink: 0,
  },
  // Consume only the filename cell's spare space. The following date column
  // remains a separate, non-shrinking 130px region, so the button can sit at
  // the visual end of the name column without ever overlapping the date.
  copyNameBtn: {
    padding: 0, borderRadius: radius.sm, border: 'none',
    background: 'transparent', color: c.textMuted, cursor: 'pointer',
    lineHeight: 1, width: 24, height: 24, flexShrink: 0, marginLeft: 'auto',
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
