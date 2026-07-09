/** shadcn/Linear-inspired design tokens */

export const c = {
  // Backgrounds
  bg: '#ffffff',
  bgSubtle: '#f8fafc',
  bgMuted: '#f1f5f9',
  bgOverlay: 'rgba(15,23,42,0.4)',
  surface: '#ffffff',

  // Borders
  border: '#e2e8f0',
  borderSubtle: '#f1f5f9',

  // Text
  text: '#0f172a',
  textSecondary: '#475569',
  textMuted: '#94a3b8',
  textFaint: '#cbd5e1',

  // Accent (indigo)
  accent: '#6366f1',
  accentHover: '#4f46e5',
  accentBg: '#eef2ff',

  // Semantic
  danger: '#ef4444',
  dangerBg: '#fef2f2',
  warning: '#f59e0b',
  warningBg: '#fffbeb',
  success: '#10b981',
  successBg: '#ecfdf5',
} as const;

// File-type badge colors — part of the file-row visual language (see
// FileBrowser's FileTypeIcon), NOT nav/surface tokens. White label text sits
// on each chip, so every color here must stay dark/saturated enough to keep
// that text legible on top. Category-level (not per-extension): the chip
// LABEL carries the exact extension, the color carries the category.
export const fileType = {
  pdf: '#e5484d',      // documents / PDF — red
  doc: '#2563eb',      // word-processor docs — blue
  sheet: '#16a34a',    // spreadsheets / csv — green
  slide: '#ea580c',    // presentations — orange
  image: '#7c3aed',    // raster/vector images — violet
  video: '#db2777',    // video — pink
  audio: '#0d9488',    // audio — teal
  archive: '#b45309',  // zip/tar/… — amber-brown
  r: '#276dc3',        // R / Rmd — official R blue
  python: '#2b6cb0',   // python — blue
  js: '#a16207',       // js/ts family — dark yellow (readable under white)
  data: '#0e7490',     // json/yaml/toml/xml — cyan
  markdown: '#475569', // md — slate
  text: '#64748b',     // txt/log — gray
  code: '#475569',     // other source code — slate
  neutral: '#64748b',  // known extension, uncategorized — gray
} as const;

export const radius = {
  sm: 6,
  md: 8,
  lg: 12,
  pill: 9999,
} as const;

export const shadow = {
  xs: '0 1px 2px rgba(0,0,0,0.05)',
  sm: '0 1px 3px rgba(0,0,0,0.1), 0 1px 2px rgba(0,0,0,0.06)',
  md: '0 4px 6px -1px rgba(0,0,0,0.1), 0 2px 4px -2px rgba(0,0,0,0.1)',
  lg: '0 10px 15px -3px rgba(0,0,0,0.1), 0 4px 6px -4px rgba(0,0,0,0.1)',
} as const;

export const font = {
  sans: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  mono: '"JetBrains Mono", "SF Mono", "Fira Code", monospace',
  // Screen-optimized serif stack: Georgia ships everywhere (Win/macOS/Linux);
  // Iowan Old Style (macOS), Palatino Linotype / Book Antiqua (Win) as
  // fallbacks. Used only as an optional toggle for filenames.
  serif: 'Georgia, "Iowan Old Style", "Palatino Linotype", "Book Antiqua", serif',
} as const;
