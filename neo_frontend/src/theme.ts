/** Design tokens mirrored from classic `frontend/src/theme.ts`.
 *  Keep colors/typography in sync when classic tokens change; full shared
 *  package extraction is deferred (see README reuse plan). */

export const c = {
  bg: '#ffffff',
  bgSubtle: '#f8fafc',
  bgMuted: '#f1f5f9',
  surface: '#ffffff',
  border: '#e2e8f0',
  text: '#0f172a',
  textSecondary: '#475569',
  textMuted: '#94a3b8',
  accent: '#6366f1',
  accentBg: '#eef2ff',
} as const;

export const font = {
  sans: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  mono: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
} as const;
