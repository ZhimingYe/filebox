// 16×16 map-pin glyph for the preview tab strip: the universal teardrop
// pin (Google-Maps-style) with a hollow center, filled with the accent
// color when the tab is pinned and an outline otherwise. The hole uses the
// evenodd fill rule so it stays transparent in both states (the tab strip
// background shows through) and the whole glyph is a single stroked path
// in the repo's 16×16 stroke-icon language. Kept in its own file — a
// component defined inside PreviewWorkspace.tsx corrupts
// eslint-plugin-react-hooks v7's analysis of the main component (false
// positive refs/setState violations), so every component lives in its own
// module.
export default function PinIcon({ size = 12, filled = false }: { size?: number; filled?: boolean }) {
  return (
    <svg style={{ display: 'block' }} width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        // Teardrop: circle part centered (8, 7.4), point at (8, 15.2).
        // Inner circle r=1.9 becomes a hole via evenodd.
        d="M8 1.8a5.6 5.6 0 0 1 5.6 5.6c0 3.4-4.2 6.8-5.6 7.8-1.4-1-5.6-4.4-5.6-7.8A5.6 5.6 0 0 1 8 1.8ZM8 5.5a1.9 1.9 0 1 0 0 3.8 1.9 1.9 0 0 0 0-3.8Z"
        fill={filled ? 'currentColor' : 'none'}
        fillRule="evenodd"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  );
}
