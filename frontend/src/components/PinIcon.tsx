// 16×16 pushpin glyph for the preview tab strip: a filled head when the tab
// is pinned, an outline otherwise. Kept in its own file — a component
// defined inside PreviewWorkspace.tsx corrupts eslint-plugin-react-hooks
// v7's analysis of the main component (false positive refs/setState
// violations), so every component lives in its own module.
export default function PinIcon({ size = 12, filled = false }: { size?: number; filled?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle
        cx="8" cy="3.4" r="2"
        fill={filled ? 'currentColor' : 'none'}
        stroke="currentColor" strokeWidth="1.5"
      />
      <path
        d="M8 5.4v5.2M5.4 10.6L8 13.6l2.6-3"
        stroke="currentColor" strokeWidth="1.5"
        strokeLinecap="round" strokeLinejoin="round"
      />
    </svg>
  );
}
