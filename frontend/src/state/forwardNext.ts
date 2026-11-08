function unsafeCharacters(value: string, rejectSpace = false) {
  return [...value].some(character => character === '\\' || character.charCodeAt(0) < (rejectSpace ? 33 : 32) || character.charCodeAt(0) === 127);
}

export function forwardNext(search: string, origin: string): string | null {
  const values = new URLSearchParams(search).getAll('next');
  if (values.length !== 1) return null;
  const next = values[0];
  if (!next.startsWith('/_fwd/') || unsafeCharacters(next, true)) return null;
  const path = next.split(/[?#]/, 1)[0];
  if (/%(?:2f|5c|25)/i.test(path)) return null;
  try {
    const decoded = decodeURIComponent(path);
    if (unsafeCharacters(decoded) || decoded.split('/').some(part => part === '.' || part === '..')) return null;
    const target = new URL(next, origin);
    if (target.origin !== origin || target.pathname !== path) return null;
    return target.pathname + target.search + target.hash;
  } catch {
    return null;
  }
}
