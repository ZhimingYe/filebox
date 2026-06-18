// Shared 16×16 SVG icons for the sidebar / nav. Stroke-based with
// `stroke="currentColor"` so the parent's `color` token (e.g. c.accent on
// active nav, c.textSecondary on idle) flows through. Keeps App.tsx lean
// and gives the collapsed rail a single coherent visual language.
//
// File-type icons (IconFolder / IconFile / IconSymlink / IconUpDir) live
// in FileBrowser.tsx — they use fills and belong to the file-row visual
// language, not the nav.

import type { CSSProperties, ReactNode } from 'react';

type SvgProps = { style?: CSSProperties };

function Svg({ style, children }: { style?: CSSProperties; children: ReactNode }) {
  return (
    <svg
      style={{ display: 'block', width: 16, height: 16, ...style }}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      xmlns="http://www.w3.org/2000/svg"
    >
      {children}
    </svg>
  );
}

export function IconChevronLeft({ style }: SvgProps) {
  return <Svg style={style}><polyline points="10 3 5 8 10 13" /></Svg>;
}

export function IconChevronRight({ style }: SvgProps) {
  return <Svg style={style}><polyline points="6 3 11 8 6 13" /></Svg>;
}

export function IconFolder({ style }: SvgProps) {
  return (
    <Svg style={style}>
      <path d="M2 5.5C2 4.7 2.7 4 3.5 4h2.5c.4 0 .78.16 1.06.44L8 5.5h4.5c.8 0 1.5.7 1.5 1.5v5c0 .8-.7 1.5-1.5 1.5h-9C2.7 13.5 2 12.8 2 12V5.5z" />
    </Svg>
  );
}

export function IconSettings({ style }: SvgProps) {
  return (
    <Svg style={style}>
      <circle cx="8" cy="8" r="2.2" />
      <path d="M8 1.5v2M8 12.5v2M14.5 8h-2M3.5 8h-2M12.6 3.4l-1.4 1.4M4.8 11.2l-1.4 1.4M12.6 12.6l-1.4-1.4M4.8 4.8L3.4 3.4" />
    </Svg>
  );
}

export function IconHealth({ style }: SvgProps) {
  return (
    <Svg style={style}>
      <path d="M8 13.5s-5-3.1-5-6.9a2.8 2.8 0 0 1 5-1.74A2.8 2.8 0 0 1 13 6.6c0 3.8-5 6.9-5 6.9z" />
    </Svg>
  );
}

export function IconStats({ style }: SvgProps) {
  return (
    <Svg style={style}>
      <line x1="4" y1="9" x2="4" y2="12" />
      <line x1="8" y1="5" x2="8" y2="12" />
      <line x1="12" y1="7" x2="12" y2="12" />
      <line x1="2.5" y1="13.5" x2="13.5" y2="13.5" />
    </Svg>
  );
}

export function IconLogout({ style }: SvgProps) {
  return (
    <Svg style={style}>
      <path d="M9 3H4a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h5" />
      <line x1="6" y1="8" x2="13" y2="8" />
      <polyline points="10 5 13 8 10 11" />
    </Svg>
  );
}
