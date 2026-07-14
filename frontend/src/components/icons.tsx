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
      <line x1="2" y1="4" x2="14" y2="4" />
      <circle cx="10.5" cy="4" r="1.7" fill="currentColor" stroke="none" />
      <line x1="2" y1="8" x2="14" y2="8" />
      <circle cx="5.5" cy="8" r="1.7" fill="currentColor" stroke="none" />
      <line x1="2" y1="12" x2="14" y2="12" />
      <circle cx="11" cy="12" r="1.7" fill="currentColor" stroke="none" />
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

/// A pushpin tilted 45° (📌), drawn to match the toolbar's visual language:
/// native 16×16 viewBox, strokeWidth 1.3, pure outline, NO fill — exactly
/// like the refresh / align / font / clipboard icons it sits next to.
/// Rotated so the head is upper-left and the needle points lower-right,
/// the same orientation as the 📌 emoji.
///
/// The pinned/unpinned distinction is carried by the *button container*
/// (accent border + accentBg in the toolbar; muted color when missing in the
/// sidebar), NOT by the glyph itself — a fill made the pin visually heavier
/// than its outlined neighbors.
export function IconPin({ style }: SvgProps) {
  return (
    <svg
      style={{ display: 'block', width: 16, height: 16, ...style }}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.3}
      strokeLinecap="round"
      strokeLinejoin="round"
      xmlns="http://www.w3.org/2000/svg"
    >
      {/* Tilt 45° about the icon center: head → upper-left, needle → lower-right. */}
      <g transform="rotate(45 8 8)">
        {/* Pin head — a small rounded cap at the top. */}
        <path d="M5.5 2.5h5" />
        <path d="M6.5 2.6c-.4 1.2-1.3 1.8-2.4 2.2-.7.3-1.1.9-1.1 1.6v.3h10v-.3c0-.7-.4-1.3-1.1-1.6-1.1-.4-2-1-2.4-2.2" />
        {/* The needle pointing down to a sharp tip. */}
        <path d="M8 7.2v6.3" />
      </g>
    </svg>
  );
}

/// A thin outlined × (close / remove). Used by the sidebar Pinned-Folders
/// unpin affordance. Stroke-based with currentColor so it inherits the row's
/// muted color and matches the outlined visual language of the other nav
/// icons — intentionally NOT a heavy filled glyph.
export function IconClose({ style }: SvgProps) {
  return (
    <svg
      style={{ display: 'block', width: 16, height: 16, ...style }}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M4 4l8 8" />
      <path d="M12 4l-8 8" />
    </svg>
  );
}

/// Hamburger for the mobile top bar / drawer open control. Three equal bars
/// (not a unicode glyph) so it matches the rest of the stroke icon set at
/// the same optical weight.
export function IconMenu({ style }: SvgProps) {
  return (
    <Svg style={style}>
      <line x1="2.5" y1="4" x2="13.5" y2="4" />
      <line x1="2.5" y1="8" x2="13.5" y2="8" />
      <line x1="2.5" y1="12" x2="13.5" y2="12" />
    </Svg>
  );
}

/// Product mark: accent-filled tile + white tray glyph. Matches the existing
/// indigo brand language (not monochrome industrial chrome).
export function IconBrandMark({ style }: SvgProps) {
  return (
    <svg
      style={{ display: 'block', width: 20, height: 20, ...style }}
      viewBox="0 0 20 20"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
    >
      <rect x="1" y="1" width="18" height="18" rx="5" fill="currentColor" />
      <path
        d="M5.5 7.2h3.1c.35 0 .68.14.92.38l.7.72H14a.8.8 0 0 1 .8.8v4.1a.8.8 0 0 1-.8.8H5.5a.8.8 0 0 1-.8-.8V8a.8.8 0 0 1 .8-.8z"
        fill="#ffffff"
        fillOpacity="0.95"
      />
      <path
        d="M5.5 9.4h9.3"
        stroke="#ffffff"
        strokeOpacity="0.55"
        strokeWidth="1.1"
        strokeLinecap="round"
      />
    </svg>
  );
}
