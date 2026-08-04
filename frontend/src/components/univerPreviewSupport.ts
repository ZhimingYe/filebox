import type { IDocumentData, IWorkbookData } from '@univerjs/core';

export type UniverPreviewKind = 'document' | 'spreadsheet';

export const UNIVER_PREVIEW_MAX_BYTES = 64 * 1024 * 1024;

const UNIVER_PREVIEW_EXTS: Record<string, UniverPreviewKind> = {
  docx: 'document',
  xlsx: 'spreadsheet',
};

const UNIVER_PREVIEW_PREF_KEY = 'filebox.univerPreview';
const LEGACY_PREVIEW_PREF_KEY = 'filebox.officePdfPreview';

export function getUniverPreviewKind(ext: string): UniverPreviewKind | null {
  return UNIVER_PREVIEW_EXTS[ext.toLowerCase()] || null;
}

export function isUniverPreviewExt(ext: string): boolean {
  return getUniverPreviewKind(ext) !== null;
}

export function readUniverPreviewPref(): boolean {
  try {
    const current = localStorage.getItem(UNIVER_PREVIEW_PREF_KEY);
    if (current !== null) return current !== 'false';

    // Preserve the user's previous opt-out once, while moving the preference
    // away from the retired LibreOffice terminology.
    return localStorage.getItem(LEGACY_PREVIEW_PREF_KEY) !== 'false';
  } catch {
    return true;
  }
}

export function writeUniverPreviewPref(enabled: boolean): void {
  try {
    localStorage.setItem(UNIVER_PREVIEW_PREF_KEY, enabled ? 'true' : 'false');
  } catch {
    // Browser storage is an optional preference, never a preview dependency.
  }
}

export class UniverPreviewError extends Error {
  readonly code: 'preview_too_large' | 'file_unavailable' | 'request_cancelled';

  constructor(
    code: UniverPreviewError['code'],
    message: string,
  ) {
    super(message);
    this.name = 'UniverPreviewError';
    this.code = code;
  }
}

export interface RawFileLoadProgress {
  loaded: number;
  total: number | null;
}

/**
 * Fetch a protected raw file into the File object required by browser-side
 * Office parsers. The parser needs the complete ZIP container, but the
 * loader still enforces a hard bound before and during buffering.
 */
export async function loadRawFile(
  url: string,
  name: string,
  signal: AbortSignal,
  onProgress?: (progress: RawFileLoadProgress) => void,
): Promise<File> {
  let response: Response;
  try {
    response = await fetch(url, {
      credentials: 'include',
      cache: 'no-store',
      signal,
    });
  } catch (error: unknown) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw error;
    }
    throw new UniverPreviewError(
      'file_unavailable',
      'The source document could not be loaded.',
    );
  }

  if (!response.ok) {
    throw new UniverPreviewError(
      'file_unavailable',
      `The source document could not be loaded (${response.status}).`,
    );
  }

  const contentLength = Number(response.headers.get('content-length'));
  const total = Number.isFinite(contentLength) && contentLength >= 0
    ? contentLength
    : null;
  if (total !== null && total > UNIVER_PREVIEW_MAX_BYTES) {
    throw new UniverPreviewError(
      'preview_too_large',
      `This document is larger than the ${formatBytes(UNIVER_PREVIEW_MAX_BYTES)} browser preview limit.`,
    );
  }

  if (!response.body) {
    const blob = await response.blob();
    if (blob.size > UNIVER_PREVIEW_MAX_BYTES) {
      throw new UniverPreviewError(
        'preview_too_large',
        `This document is larger than the ${formatBytes(UNIVER_PREVIEW_MAX_BYTES)} browser preview limit.`,
      );
    }
    onProgress?.({ loaded: blob.size, total: total ?? blob.size });
    return new File([blob], name, {
      type: response.headers.get('content-type') || 'application/octet-stream',
    });
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      loaded += next.value.byteLength;
      if (loaded > UNIVER_PREVIEW_MAX_BYTES) {
        await reader.cancel();
        throw new UniverPreviewError(
          'preview_too_large',
          `This document is larger than the ${formatBytes(UNIVER_PREVIEW_MAX_BYTES)} browser preview limit.`,
        );
      }
      chunks.push(next.value);
      onProgress?.({ loaded, total });
    }
  } finally {
    reader.releaseLock();
  }

  return new File(chunks as BlobPart[], name, {
    type: response.headers.get('content-type') || 'application/octet-stream',
  });
}

export async function importXlsxSnapshot(file: File): Promise<IWorkbookData> {
  const { LuckyExcel } = await import('@mertdeveci55/univer-import-export');
  return new Promise<IWorkbookData>((resolve, reject) => {
    LuckyExcel.transformExcelToUniver(
      file,
      (snapshot) => resolve(snapshot),
      (error) => reject(error instanceof Error ? error : new Error('XLSX import failed.')),
    );
  });
}

export async function importDocxSnapshot(file: File): Promise<IDocumentData> {
  const mammothModule = await import('mammoth');
  const mammoth = mammothModule.default || mammothModule;
  const result = await mammoth.convertToHtml({
    arrayBuffer: await file.arrayBuffer(),
  });
  return documentSnapshotFromHtml(result.value, file.name);
}

function documentSnapshotFromHtml(html: string, fileName: string): IDocumentData {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  const blocks = Array.from(
    parsed.body.querySelectorAll('h1, h2, h3, h4, h5, h6, p, li, blockquote, pre'),
  );
  const sourceBlocks = blocks.length > 0 ? blocks : [parsed.body];
  const paragraphs: Array<{ startIndex: number }> = [];
  const textRuns: Array<{ st: number; ed: number; ts: Record<string, unknown> }> = [];
  let dataStream = '';

  for (const block of sourceBlocks) {
    const startIndex = dataStream.length;
    const blockText = block.textContent?.replace(/\u00a0/g, ' ') || '';
    dataStream += blockText;
    if (blockText.length > 0) {
      const style = textStyleForBlock(block);
      if (Object.keys(style).length > 0) {
        textRuns.push({
          st: startIndex,
          ed: startIndex + blockText.length,
          ts: style,
        });
      }
    }
    dataStream += '\r';
    paragraphs.push({ startIndex });
  }

  if (!dataStream.endsWith('\n')) dataStream += '\n';

  return {
    id: `filebox-doc-${crypto.randomUUID()}`,
    title: fileName,
    documentStyle: {
      pageSize: { width: 612, height: 792 },
      marginTop: 54,
      marginBottom: 54,
      marginLeft: 54,
      marginRight: 54,
    },
    body: {
      dataStream,
      paragraphs,
      textRuns,
      sectionBreaks: [],
    },
  };
}

function textStyleForBlock(block: Element): Record<string, unknown> {
  const style: Record<string, unknown> = {};
  const tag = block.tagName.toLowerCase();
  if (/^h[1-6]$/.test(tag)) {
    style.bl = 1;
    style.fs = Math.max(12, 22 - Number(tag.slice(1)) * 2);
  }
  if (tag === 'blockquote' || tag === 'pre') style.it = 1;
  if (block.querySelector('strong, b')) style.bl = 1;
  if (block.querySelector('em, i')) style.it = 1;
  if (block.querySelector('u')) {
    style.ul = { s: 1 };
  }
  if (block.querySelector('s, del')) {
    style.st = { s: 1 };
  }
  return style;
}

function formatBytes(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MiB`;
}
