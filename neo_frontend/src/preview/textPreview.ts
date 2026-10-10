/**
 * Markdown is parsed synchronously on the main thread and its cost grows
 * faster than linearly (remark): ~1.2 s at 200 KB, ~15 s at 800 KB, minutes
 * at 5 MB. Cap Markdown reads well below the generic 5 MB text cap so a huge
 * .md cannot freeze the tab.
 */
export const MD_PREVIEW_MAX_BYTES = 256 * 1024

/** Drop a trailing partial line so a byte-cut prefix never ends mid-block. */
export function trimToLastLine(text: string): string {
  const i = text.lastIndexOf('\n')
  return i > 0 ? text.slice(0, i + 1) : text
}

export function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  if (n >= 1024) return `${Math.round(n / 1024)} KB`
  return `${n} B`
}
