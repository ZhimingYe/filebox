import type { CSSProperties, HTMLAttributes, RefObject } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { FsEntry } from '../api/client';
import { c, radius, font, fileType } from '../theme';

// ── Inline SVG Icons (16x16) — shared by FileBrowser and Collections ────────

export const iconStyle: CSSProperties = { display: 'block', width: 16, height: 16 };

export function IconFolder() {
  return (
    <svg style={iconStyle} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M2 4.5C2 3.67 2.67 3 3.5 3H6.29a1 1 0 0 1 .7.29L8 4.5h4.5c.83 0 1.5.67 1.5 1.5v5.5c0 .83-.67 1.5-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5v-7Z" fill="#94a3b8"/>
      <path d="M2 6h12v5.5c0 .83-.67 1.5-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5V6Z" fill="#cbd5e1"/>
    </svg>
  );
}

export function IconFile() {
  return (
    <svg style={iconStyle} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M4 2h5.59a1 1 0 0 1 .7.29l2.71 2.71a1 1 0 0 1 .29.7V13a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1Z" fill="#e2e8f0"/>
      <path d="M10 2.5V5a.5.5 0 0 0 .5.5h2.5" stroke="#94a3b8" strokeWidth="1" strokeLinecap="round"/>
      <line x1="5" y1="8" x2="11" y2="8" stroke="#cbd5e1" strokeWidth="1" strokeLinecap="round"/>
      <line x1="5" y1="10.5" x2="9" y2="10.5" stroke="#cbd5e1" strokeWidth="1" strokeLinecap="round"/>
    </svg>
  );
}

export function IconSymlink() {
  return (
    <svg style={iconStyle} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M4 2h5.59a1 1 0 0 1 .7.29l2.71 2.71a1 1 0 0 1 .29.7V13a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1Z" fill="#e2e8f0"/>
      <path d="M10 2.5V5a.5.5 0 0 0 .5.5h2.5" stroke="#94a3b8" strokeWidth="1" strokeLinecap="round"/>
      <path d="M5 11L10 6" stroke="#6366f1" strokeWidth="1.3" strokeLinecap="round"/>
      <path d="M7 6h3v3" stroke="#6366f1" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

export function IconUpDir() {
  return (
    <svg style={iconStyle} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M8 3v9M5 6l3-3 3 3" stroke="#94a3b8" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M3 11a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v1a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-1Z" fill="#e2e8f0"/>
    </svg>
  );
}

type FileCat = keyof typeof fileType;

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

const EXT_LABEL: Record<string, string> = {
  jpeg: 'JPG', tiff: 'TIF', markdown: 'MD', text: 'TXT', tgz: 'GZ', lzma: 'LZ',
  ipynb: 'NB', pyw: 'PY', pyi: 'PY', cpp: 'C++', cc: 'C++', cxx: 'C++', hpp: 'H',
  htm: 'HTML', yaml: 'YML', yml: 'YML', mjs: 'JS', cjs: 'JS', rdata: 'RDA', rds: 'RDS',
};

export function fileExt(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return '';
  return name.slice(dot + 1).toLowerCase();
}

export function FileTypeIcon({ name }: { name: string }) {
  const ext = fileExt(name);
  if (!ext) return <IconFile />;
  const cat = EXT_CAT[ext];
  const color = cat ? fileType[cat] : fileType.neutral;
  const label = EXT_LABEL[ext] ?? ext.toUpperCase().slice(0, 4);
  const fontSize = label.length <= 1 ? 6.4 : label.length === 2 ? 5.3 : label.length === 3 ? 4.3 : 3.5;
  return (
    <svg style={iconStyle} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M4 2h5.59a1 1 0 0 1 .7.29l2.71 2.71a1 1 0 0 1 .29.7V13a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1Z" fill={color}/>
      <path d="M9.7 2.2 13 5.5H10.2a.5.5 0 0 1-.5-.5V2.2Z" fill="#ffffff" fillOpacity="0.4"/>
      <text
        x="8" y="11.8"
        fontFamily={font.sans} fontSize={fontSize} fontWeight={700}
        fill="#ffffff" textAnchor="middle"
      >{label}</text>
    </svg>
  );
}

export function getEntryIcon(entry: FsEntry) {
  switch (entry.entry_type) {
    case 'directory': return <IconFolder />;
    case 'symlink': return <IconSymlink />;
    default: return <FileTypeIcon name={entry.name} />;
  }
}

/** Synthetic FsEntry for collection rows before stat returns. */
export function entryFromBasename(name: string): FsEntry {
  return {
    name,
    entry_type: 'file',
    size: null,
    modified: null,
    denied: false,
  };
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

// Current year omits the year; post-2000 years use 2 digits (25 not 2025).
export function formatDate(iso: string): string {
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

/** Desktop/mobile row heights — must match FileBrowser. */
export const FILE_LIST_ROW_HEIGHT_DESKTOP = 32;
export const FILE_LIST_ROW_HEIGHT_MOBILE = 44;
export const FILE_LIST_COL_HEADER_HEIGHT = 28;

export const NEW_ENTRY_MS = 15 * 60 * 1000;

export function isRecentlyModified(modified: string | null | undefined, nowMs: number): boolean {
  if (!modified) return false;
  const t = Date.parse(modified);
  if (Number.isNaN(t)) return false;
  const age = nowMs - t;
  return age <= NEW_ENTRY_MS && age >= -60_000;
}

export function formatDateShort(iso: string): string {
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

export type FileListSortKey = 'name' | 'modified' | 'size' | 'root';

export function sortFileListRows<T extends { entry: FsEntry; rootLabel?: string }>(
  rows: T[],
  sortBy: FileListSortKey,
  sortAsc: boolean,
): T[] {
  const sorted = [...rows];
  sorted.sort((a, b) => {
    let cmp = 0;
    if (sortBy === 'name') {
      cmp = a.entry.name.localeCompare(b.entry.name, undefined, { sensitivity: 'base' });
    } else if (sortBy === 'modified') {
      const da = a.entry.modified ? new Date(a.entry.modified).getTime() : 0;
      const db = b.entry.modified ? new Date(b.entry.modified).getTime() : 0;
      cmp = da - db;
    } else if (sortBy === 'size') {
      cmp = (a.entry.size ?? 0) - (b.entry.size ?? 0);
    } else if (sortBy === 'root') {
      cmp = (a.rootLabel ?? '').localeCompare(b.rootLabel ?? '', undefined, { sensitivity: 'base' });
    }
    return sortAsc ? cmp : -cmp;
  });
  return sorted;
}

/** Longest desktop label: pre-2000 is "1999-12-31 23:59" (16 chars). */
const DATE_LABEL_MAX_DESKTOP = 16;
/** Longest mobile label: current-year with time "12-31 23:59" (11 chars). */
const DATE_LABEL_MAX_MOBILE = 11;
/** Root labels truncate beyond this; full value stays in `title`. */
const ROOT_LABEL_MAX = 24;
/** Column header floors include sort arrow (" ↑"). */
const SORT_SUFFIX_LEN = 2;
const ROOT_HEADER_MIN = 4 + SORT_SUFFIX_LEN;
const DATE_HEADER_MIN = 8 + SORT_SUFFIX_LEN;
const SIZE_HEADER_MIN = 4 + SORT_SUFFIX_LEN;
/** Rough px-per-ch for budget math (mono labels). */
const CH_PX = 7.2;
/** Reference font for meta column width — must match measureMetaChPx. */
const META_GRID_FONT_SIZE = 12;
const LIST_ICON_PX = 20;
const LIST_H_PAD_PX = 24;
const LIST_COL_GAP_PX = 8;

const metaChPxCache = new Map<number, number>();

/** Convert ch → px with a fixed reference font so header and rows resolve identically. */
export function measureMetaChPx(ch: number): number {
  const key = Math.round(ch * 1000) / 1000;
  const hit = metaChPxCache.get(key);
  if (hit != null) return hit;

  let px: number;
  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.font = `${META_GRID_FONT_SIZE}px ${font.mono}`;
      const sample = '0'.repeat(Math.max(1, Math.ceil(ch)));
      px = (ctx.measureText(sample).width / sample.length) * ch;
    } else {
      px = ch * CH_PX;
    }
  } else {
    px = ch * CH_PX;
  }

  metaChPxCache.set(key, px);
  return px;
}

function metaColTrack(ch: number): string {
  return `minmax(0, ${Math.round(measureMetaChPx(ch))}px)`;
}

function parseChWidth(width: string): number {
  const m = /^(\d+(?:\.\d+)?)ch$/.exec(width);
  return m ? parseFloat(m[1]) : 0;
}

interface MetaColumnSpec {
  key: 'root' | 'date' | 'size';
  idealCh: number;
  minCh: number;
  /** Lower = shrink first when the panel is too narrow. */
  shrinkPriority: number;
}

function allocateMetaColumnWidths(
  listWidth: number,
  nameMinPx: number,
  cols: MetaColumnSpec[],
): Record<'root' | 'date' | 'size', number> {
  const out: Record<'root' | 'date' | 'size', number> = { root: 0, date: 0, size: 0 };
  for (const col of cols) out[col.key] = col.idealCh;

  if (listWidth <= 0 || cols.length === 0) return out;

  const gapCount = cols.length + 1;
  const budgetPx = listWidth - nameMinPx - LIST_ICON_PX - LIST_H_PAD_PX - LIST_COL_GAP_PX * gapCount;
  const budgetCh = Math.max(0, budgetPx / CH_PX);
  const totalIdeal = cols.reduce((sum, c) => sum + c.idealCh, 0);
  if (totalIdeal <= budgetCh) return out;

  let deficit = totalIdeal - budgetCh;
  const order = [...cols].sort((a, b) => a.shrinkPriority - b.shrinkPriority);
  for (const col of order) {
    if (deficit <= 0) break;
    const canLose = Math.max(0, out[col.key] - col.minCh);
    const lose = Math.min(deficit, canLose);
    out[col.key] -= lose;
    deficit -= lose;
  }
  return out;
}

/** Size the date column to the longest rendered date string in `rows`. */
export function dateColWidthForRows(
  rows: { modified?: string | null; entry?: FsEntry }[],
  isMobile = false,
): string {
  let maxChars = 0;
  for (const row of rows) {
    const modified = row.modified ?? row.entry?.modified;
    if (!modified) continue;
    const d = new Date(modified);
    if (Number.isNaN(d.getTime())) continue;
    const label = isMobile ? formatDateShort(modified) : formatDate(modified);
    maxChars = Math.max(maxChars, label.length);
  }
  const contentFloor = isMobile ? DATE_LABEL_MAX_MOBILE : DATE_LABEL_MAX_DESKTOP;
  const floor = Math.max(contentFloor, DATE_HEADER_MIN);
  return `${Math.max(floor, maxChars)}ch`;
}

/** Size the root column; long labels truncate with ellipsis (see ROOT_LABEL_MAX). */
export function rootColWidthForRows(
  rows: { rootLabel?: string }[],
  listWidth = 0,
): string {
  let maxChars = ROOT_HEADER_MIN;
  for (const row of rows) {
    if (row.rootLabel) maxChars = Math.max(maxChars, row.rootLabel.length);
  }
  maxChars = Math.min(maxChars, ROOT_LABEL_MAX);
  if (listWidth > 0) {
    const panelCap = Math.max(ROOT_HEADER_MIN, Math.floor(listWidth * 0.22 / CH_PX));
    maxChars = Math.min(maxChars, panelCap);
  }
  return `${maxChars}ch`;
}

/** Size the size column to the longest formatted size string in `rows`. */
export function sizeColWidthForRows(rows: { entry?: FsEntry }[]): string {
  let maxChars = SIZE_HEADER_MIN;
  for (const row of rows) {
    const size = row.entry?.size;
    if (size != null) maxChars = Math.max(maxChars, formatSize(size).length);
  }
  return `${maxChars}ch`;
}

/** Shared CSS grid template for list header + rows (keeps columns aligned). */
export function fileListGridColumns(opts: {
  showRootColumn: boolean;
  isMobile: boolean;
  rootColWidth: string;
  dateColWidth: string;
  sizeColWidth: string;
  /** Measured list container width; 0 before first layout. */
  listWidth: number;
}): string {
  const {
    showRootColumn, isMobile, rootColWidth, dateColWidth, sizeColWidth, listWidth: w,
  } = opts;

  // Name owns leftover space; floor scales with panel width so narrow splits stay readable.
  const nameMin = w > 0 ? Math.max(56, Math.floor(w * 0.36)) : 96;
  const tight = w > 0 && w < 300;

  const metaCols: MetaColumnSpec[] = [];
  if (showRootColumn) {
    metaCols.push({
      key: 'root',
      idealCh: parseChWidth(rootColWidth),
      minCh: tight ? 4 : ROOT_HEADER_MIN,
      shrinkPriority: 1,
    });
  }
  metaCols.push({
    key: 'date',
    idealCh: parseChWidth(dateColWidth),
    minCh: tight ? 8 : DATE_HEADER_MIN,
    shrinkPriority: 3,
  });
  if (!isMobile) {
    metaCols.push({
      key: 'size',
      idealCh: parseChWidth(sizeColWidth),
      minCh: tight ? 4 : SIZE_HEADER_MIN,
      shrinkPriority: 2,
    });
  }

  const allocated = allocateMetaColumnWidths(w, nameMin, metaCols);

  const parts: string[] = ['20px', `minmax(${nameMin}px, 1fr)`];
  if (showRootColumn) {
    parts.push(metaColTrack(allocated.root));
  }
  parts.push(metaColTrack(allocated.date));
  if (!isMobile) {
    parts.push(metaColTrack(allocated.size));
  }

  return parts.join(' ');
}

/** Padding for filename when hover action overlay is visible (24px per icon button). */
export function fileListHoverNamePad(extraActionCount: number): number {
  return 24 * (1 + extraActionCount);
}

export interface FileListLayoutRow {
  rootLabel?: string;
  modified?: string | null;
  entry?: FsEntry;
}

/** Measure list size, scrollbar gutter, and adaptive column template together. */
export function useFileListLayout(
  widthRef: RefObject<HTMLDivElement | null>,
  opts: {
    showRootColumn: boolean;
    isMobile: boolean;
    rows: FileListLayoutRow[];
    hasRows: boolean;
    /** Extra hover icon buttons besides copy (Collections: 2). */
    extraHoverActions: number;
  },
  /** When set, height is measured here (header is a sibling above this node). */
  bodyRef?: RefObject<HTMLDivElement | null>,
) {
  const [listWidth, setListWidth] = useState(0);
  const [listHeight, setListHeight] = useState(400);
  const [scrollClientWidth, setScrollClientWidth] = useState(0);
  const outerRef = useRef<HTMLDivElement>(null);
  const [scrollPad, setScrollPad] = useState(0);
  const headerInsidePanel = bodyRef == null;

  useEffect(() => {
    const widthEl = (bodyRef ?? widthRef).current;
    const heightEl = (bodyRef ?? widthRef).current;
    if (!widthEl || !heightEl) return;
    let raf = 0;
    const obs = new ResizeObserver((entries) => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        for (const entry of entries) {
          if (entry.target === widthEl) {
            const { width } = entry.contentRect;
            setListWidth((prev) => (Math.abs(prev - width) < 1 ? prev : width));
          }
          if (entry.target === heightEl) {
            const { height } = entry.contentRect;
            setListHeight((prev) => (Math.abs(prev - height) < 1 ? prev : height));
          }
        }
      });
    });
    obs.observe(widthEl);
    if (heightEl !== widthEl) obs.observe(heightEl);
    return () => {
      cancelAnimationFrame(raf);
      obs.disconnect();
    };
  }, [widthRef, bodyRef]);

  useEffect(() => {
    if (!opts.hasRows) {
      setScrollPad(0);
      setScrollClientWidth(0);
      return;
    }
    let ro: ResizeObserver | null = null;
    let raf = 0;
    let cancelled = false;

    const attach = () => {
      const el = outerRef.current;
      if (!el) return false;
      const update = () => {
        if (!cancelled) {
          setScrollPad(Math.max(0, el.offsetWidth - el.clientWidth));
          setScrollClientWidth(el.clientWidth);
        }
      };
      update();
      ro = new ResizeObserver(update);
      ro.observe(el);
      return true;
    };

    if (!attach()) {
      raf = requestAnimationFrame(() => { attach(); });
    }

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      ro?.disconnect();
    };
  }, [opts.hasRows, opts.rows.length, listHeight]);

  // Row grid lives inside the scroll body; budget columns on that width.
  const layoutWidth = useMemo(() => {
    if (scrollClientWidth > 0) return scrollClientWidth;
    if (listWidth <= 0) return 0;
    return scrollPad > 0 ? Math.max(0, listWidth - scrollPad) : listWidth;
  }, [scrollClientWidth, listWidth, scrollPad]);

  const rootColWidth = useMemo(
    () => (opts.showRootColumn ? rootColWidthForRows(opts.rows, layoutWidth) : '0px'),
    [opts.rows, opts.showRootColumn, layoutWidth],
  );
  const dateColWidth = useMemo(
    () => dateColWidthForRows(opts.rows, opts.isMobile),
    [opts.rows, opts.isMobile],
  );
  const sizeColWidth = useMemo(
    () => (!opts.isMobile ? sizeColWidthForRows(opts.rows) : '0px'),
    [opts.rows, opts.isMobile],
  );
  const gridTemplateColumns = useMemo(
    () => fileListGridColumns({
      showRootColumn: opts.showRootColumn,
      isMobile: opts.isMobile,
      rootColWidth,
      dateColWidth,
      sizeColWidth,
      listWidth: layoutWidth,
    }),
    [opts.showRootColumn, opts.isMobile, rootColWidth, dateColWidth, sizeColWidth, layoutWidth],
  );

  const outerElementType = useMemo(() => {
    const Outer = ({ style, ...rest }: HTMLAttributes<HTMLDivElement>) => (
      <div
        {...rest}
        ref={outerRef}
        style={{ ...style, scrollbarGutter: 'stable' }}
      />
    );
    return Outer;
  }, []);

  const bodyHeight = headerInsidePanel
    ? Math.max(0, listHeight - FILE_LIST_COL_HEADER_HEIGHT)
    : Math.max(0, listHeight);
  const hoverNamePad = fileListHoverNamePad(opts.extraHoverActions);

  return {
    gridTemplateColumns,
    bodyHeight,
    padRight: scrollPad,
    outerElementType,
    hoverNamePad,
    listWidth: layoutWidth,
  };
}

/** @deprecated Use useFileListLayout */
export function useListScrollGutter(active: boolean) {
  const outerRef = useRef<HTMLDivElement>(null);
  const [padRight, setPadRight] = useState(0);

  useEffect(() => {
    if (!active) {
      setPadRight(0);
      return;
    }
    const el = outerRef.current;
    if (!el) return;
    const update = () => {
      setPadRight(Math.max(0, el.offsetWidth - el.clientWidth));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [active]);

  const outerElementType = useMemo(() => {
    const Outer = ({ style, ...rest }: HTMLAttributes<HTMLDivElement>) => (
      <div
        {...rest}
        ref={outerRef}
        style={{ ...style, scrollbarGutter: 'stable' }}
      />
    );
    return Outer;
  }, []);

  return { padRight, outerElementType };
}

/** List row + column chrome shared with FileBrowser. */
export const fileListStyles: Record<string, CSSProperties> = {
  colHeader: {
    display: 'grid', alignItems: 'center', columnGap: 8,
    padding: '6px 12px', borderBottom: `1px solid ${c.border}`,
    fontSize: 11, color: c.textMuted, textTransform: 'uppercase', letterSpacing: 0.5,
    userSelect: 'none', flexShrink: 0, fontWeight: 500, background: c.bgSubtle,
    width: '100%', boxSizing: 'border-box',
  },
  colIcon: { minWidth: 0 },
  colName: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  colDate: { textAlign: 'right', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  colSize: { textAlign: 'right', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  colSource: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  listContainer: { flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' },
  entry: {
    display: 'grid', alignItems: 'center', columnGap: 8,
    padding: '0 12px', boxSizing: 'border-box',
    minHeight: 32, minWidth: 0, borderRadius: radius.sm,
    transition: 'background 0.1s',
  },
  entryHover: {
    background: c.bgMuted,
  },
  icon: { fontSize: 14, width: 20, textAlign: 'center', flexShrink: 0 },
  entryNameCell: {
    position: 'relative', minWidth: 0, display: 'flex',
    alignItems: 'center', gap: 4, overflow: 'hidden', boxSizing: 'border-box',
  },
  entryName: {
    color: c.text, fontSize: 14, fontWeight: 500,
    minWidth: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  /** Hover-only action buttons — overlay on the name cell, no reserved grid column. */
  entryNameHoverActions: {
    position: 'absolute', right: 0, top: '50%', transform: 'translateY(-50%)',
    display: 'flex', alignItems: 'center', gap: 2,
    paddingLeft: 20,
    background: `linear-gradient(to right, transparent, ${c.bgMuted} 55%, ${c.bgMuted})`,
    borderRadius: radius.sm,
  },
  entrySource: {
    color: c.textMuted, fontSize: 11, fontFamily: font.mono,
    minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  entryDate: {
    color: c.textMuted, fontSize: 12, textAlign: 'right',
    minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    fontVariantNumeric: 'tabular-nums',
    letterSpacing: '-0.02em',
    fontFeatureSettings: '"tnum" 1, "kern" 1',
  },
  entryDateMobile: {
    color: c.textMuted, fontSize: 10, textAlign: 'right', minWidth: 0,
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    letterSpacing: '-0.02em', fontVariantNumeric: 'tabular-nums',
  },
  entryDateRecent: {
    color: c.accent, fontWeight: 600, letterSpacing: '-0.03em',
  },
  entryMeta: {
    color: c.textFaint, fontSize: 12, textAlign: 'right', minWidth: 0,
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  deniedBadge: {
    color: c.warning, fontSize: 10, fontStyle: 'normal', fontWeight: 500,
    padding: '1px 6px', background: c.warningBg, borderRadius: radius.pill, flexShrink: 0,
  },
  copyNameBtn: {
    padding: 0, borderRadius: radius.sm, border: 'none',
    background: 'transparent', color: c.textMuted, cursor: 'pointer',
    lineHeight: 1, width: 24, height: 24, flexShrink: 0,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    boxSizing: 'border-box', transition: 'color 0.15s',
  },
  empty: { padding: 16, color: c.textMuted, fontSize: 13 },
};
