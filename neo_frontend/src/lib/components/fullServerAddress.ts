import type { RootInfo } from '../api/client';

// ── Full server-side address ─────────────────────────────────────────────
// The root's absolute path_display joined with the root-relative path
// (e.g. "/home/user" + "/reports/2025.md" → "/home/user/reports/2025.md").
// Both halves start with '/'; avoid a "//" when path is the root itself.
// Falls back to "root:path" when the root is unknown (removed/renamed while
// a preview tab stayed open). Same convention as FileBrowser's copy-address
// button and the search hit "Copy full path" action.
export function fullServerAddress(
  roots: Pick<RootInfo, 'name' | 'path_display'>[] | undefined,
  root: string,
  path: string,
): string {
  const display = roots?.find((r) => r.name === root)?.path_display;
  const base = display ? display.replace(/\/+$/, '') : root;
  const rel = path === '/' ? '' : path;
  return base + rel;
}
