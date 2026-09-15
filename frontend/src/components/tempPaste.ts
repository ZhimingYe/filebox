/** Clipboard → temp-upload File list. Screenshot pastes often have an empty
 *  or path-like name; the hub rejects those, so we mint a single-component
 *  name when needed. */

const IMAGE_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
  'image/heic': 'heic',
  'image/heif': 'heif',
};

export function isImageFile(file: File): boolean {
  if (file.type) return file.type.toLowerCase().startsWith('image/');
  return /\.(png|jpe?g|gif|webp|bmp|svg|heic|heif)$/i.test(file.name);
}

/** True when the paste should go to a text field, not the temp folder. */
export function pasteTargetIsEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return Boolean(target.isContentEditable);
}

export function isValidUploadName(raw: string): boolean {
  const name = raw.trim();
  if (!name || new TextEncoder().encode(name).length > 255) return false;
  if (name.includes('\0') || name.includes('/') || name.includes('\\')) return false;
  if (name === '.' || name === '..') return false;
  return true;
}

export function namedPastedImage(file: File, index: number, now = new Date()): File {
  if (isValidUploadName(file.name)) return file;
  const ext = IMAGE_EXT[file.type.toLowerCase()] ?? 'png';
  const stamp = formatStamp(now);
  const suffix = index > 0 ? `-${index + 1}` : '';
  const name = `pasted-image${suffix}-${stamp}.${ext}`;
  return new File([file], name, {
    type: file.type || 'image/png',
    lastModified: file.lastModified,
  });
}

export function filesFromPaste(clipboardData: DataTransfer | null, now = new Date()): File[] {
  if (!clipboardData) return [];
  const seen = new Set<File>();
  const raw: File[] = [];
  for (const item of Array.from(clipboardData.items ?? [])) {
    if (item.kind !== 'file') continue;
    const file = item.getAsFile();
    if (file && isImageFile(file) && !seen.has(file)) {
      seen.add(file);
      raw.push(file);
    }
  }
  for (const file of Array.from(clipboardData.files ?? [])) {
    if (isImageFile(file) && !seen.has(file)) {
      seen.add(file);
      raw.push(file);
    }
  }
  return raw.map((file, i) => namedPastedImage(file, i, now));
}

function formatStamp(now: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-` +
    `${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
  );
}
