/**
 * Parent directory of a root-relative path (`/a/b/c.txt` → `/a/b`, `/a.txt` → `/`).
 * Trailing slashes on the input are ignored so directory-looking paths still work.
 */
export function parentDir(path: string): string {
  const trimmed = path.endsWith('/') && path.length > 1 ? path.replace(/\/+$/, '') : path;
  const idx = trimmed.lastIndexOf('/');
  if (idx <= 0) return '/';
  return trimmed.slice(0, idx) || '/';
}
