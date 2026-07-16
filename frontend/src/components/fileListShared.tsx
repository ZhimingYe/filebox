import type { CSSProperties } from 'react';
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

/** Size the date column to the longest rendered date string in `rows`. */
export function dateColWidthForRows(rows: { modified?: string | null }[]): string {
  let maxChars = 0;
  for (const row of rows) {
    if (!row.modified) continue;
    const d = new Date(row.modified);
    if (Number.isNaN(d.getTime())) continue;
    maxChars = Math.max(maxChars, formatDate(row.modified).length);
  }
  return `${Math.max(11, maxChars)}ch`;
}

/** List row + column chrome shared with FileBrowser. */
export const fileListStyles: Record<string, CSSProperties> = {
  colHeader: {
    display: 'flex', alignItems: 'center', gap: 8,
    padding: '6px 12px', borderBottom: `1px solid ${c.border}`,
    fontSize: 11, color: c.textMuted, textTransform: 'uppercase', letterSpacing: 0.5,
    userSelect: 'none', flexShrink: 0, fontWeight: 500, background: c.bgSubtle,
  },
  colIcon: { width: 20, flexShrink: 0 },
  colName: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  colDate: { flexShrink: 0, textAlign: 'right' },
  colSize: { width: 80, flexShrink: 0, textAlign: 'right' },
  colSource: { width: 200, flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  listContainer: { flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' },
  entry: {
    display: 'flex', alignItems: 'center', gap: 8,
    padding: '0 12px', boxSizing: 'border-box',
    minHeight: 32, borderRadius: radius.sm, margin: '0 4px',
    transition: 'background 0.1s',
  },
  entryActive: {
    background: c.accentBg,
  },
  entryHover: {
    background: c.bgMuted,
  },
  icon: { fontSize: 14, width: 20, textAlign: 'center', flexShrink: 0 },
  entryNameCell: {
    flex: 1, minWidth: 0, display: 'flex',
    alignItems: 'center', gap: 4, overflow: 'hidden', boxSizing: 'border-box',
  },
  entryName: { color: c.text, fontSize: 14, fontWeight: 500, flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  entrySource: {
    color: c.textMuted, fontSize: 11, fontFamily: font.mono,
    flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    width: 200,
  },
  entryDate: {
    color: c.textMuted, fontSize: 12, textAlign: 'right',
    flexShrink: 0, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums',
    letterSpacing: '-0.02em',
    fontFeatureSettings: '"tnum" 1, "kern" 1',
  },
  entryMeta: { color: c.textFaint, fontSize: 12, width: 80, textAlign: 'right', flexShrink: 0 },
  deniedBadge: {
    color: c.warning, fontSize: 10, fontStyle: 'normal', fontWeight: 500,
    padding: '1px 6px', background: c.warningBg, borderRadius: radius.pill, flexShrink: 0,
  },
  missingBadge: {
    color: c.textMuted, fontSize: 10, fontStyle: 'normal', fontWeight: 500,
    padding: '1px 6px', background: c.bgMuted, borderRadius: radius.pill, flexShrink: 0,
  },
  rowActionBtn: {
    padding: 0, borderRadius: radius.sm, border: 'none',
    background: 'transparent', color: c.textMuted, cursor: 'pointer',
    lineHeight: 1, width: 24, height: 24, flexShrink: 0,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    boxSizing: 'border-box', transition: 'color 0.15s',
  },
  empty: { padding: 16, color: c.textMuted, fontSize: 13 },
};
