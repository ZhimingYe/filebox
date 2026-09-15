import { describe, expect, it } from 'vitest';
import {
  filesFromPaste,
  isImageFile,
  isValidUploadName,
  namedPastedImage,
  pasteTargetIsEditable,
} from './tempPaste';

function fakeFile(name: string, type: string, body = 'x'): File {
  return new File([body], name, { type });
}

describe('isImageFile', () => {
  it('accepts image MIME types', () => {
    expect(isImageFile(fakeFile('', 'image/png'))).toBe(true);
    expect(isImageFile(fakeFile('shot.JPG', 'image/jpeg'))).toBe(true);
  });

  it('accepts image extensions when MIME is empty', () => {
    expect(isImageFile(fakeFile('a.webp', ''))).toBe(true);
    expect(isImageFile(fakeFile('notes.txt', ''))).toBe(false);
  });

  it('rejects non-image MIME even with a .png name', () => {
    expect(isImageFile(fakeFile('x.png', 'application/pdf'))).toBe(false);
  });
});

describe('isValidUploadName', () => {
  it('rejects empty, separators, and dot names', () => {
    expect(isValidUploadName('')).toBe(false);
    expect(isValidUploadName('  ')).toBe(false);
    expect(isValidUploadName('../x.png')).toBe(false);
    expect(isValidUploadName('a/b.png')).toBe(false);
    expect(isValidUploadName('a\\b.png')).toBe(false);
    expect(isValidUploadName('.')).toBe(false);
    expect(isValidUploadName('..')).toBe(false);
  });

  it('accepts a single path component', () => {
    expect(isValidUploadName('image.png')).toBe(true);
    expect(isValidUploadName('照片.png')).toBe(true);
  });

  it('enforces the hub limit in UTF-8 bytes', () => {
    expect(isValidUploadName(`${'图'.repeat(83)}.png`)).toBe(true);
    expect(isValidUploadName(`${'图'.repeat(84)}.png`)).toBe(false);
    const file = fakeFile(`${'图'.repeat(84)}.png`, 'image/png');
    expect(namedPastedImage(file, 0, new Date(2026, 8, 15, 14, 3, 7)).name)
      .toBe('pasted-image-20260915-140307.png');
  });
});

describe('namedPastedImage', () => {
  it('keeps a valid clipboard name', () => {
    const file = fakeFile('image.png', 'image/png');
    expect(namedPastedImage(file, 0).name).toBe('image.png');
  });

  it('mints a timestamped name when the clipboard name is empty', () => {
    const file = fakeFile('', 'image/png');
    const named = namedPastedImage(file, 0, new Date(2026, 8, 15, 14, 3, 7));
    expect(named.name).toBe('pasted-image-20260915-140307.png');
    expect(named.type).toBe('image/png');
  });

  it('suffixes a second unnamed image in the same paste', () => {
    const file = fakeFile('  ', 'image/jpeg');
    const named = namedPastedImage(file, 1, new Date(2026, 8, 15, 14, 3, 7));
    expect(named.name).toBe('pasted-image-2-20260915-140307.jpg');
  });
});

function mockClipboard(files: File[]): DataTransfer {
  const items = files.map((file) => ({
    kind: 'file' as const,
    type: file.type,
    getAsFile: () => file,
  }));
  return { items, files } as unknown as DataTransfer;
}

describe('filesFromPaste', () => {
  it('returns an empty list when the clipboard has no image', () => {
    expect(filesFromPaste(mockClipboard([]))).toEqual([]);
    expect(filesFromPaste(null)).toEqual([]);
  });

  it('collects image files and skips non-images', () => {
    const png = fakeFile('shot.png', 'image/png', 'png-bytes');
    const txt = fakeFile('notes.txt', 'text/plain', 'nope');
    const out = filesFromPaste(mockClipboard([png, txt]));
    expect(out.map((f) => f.name)).toEqual(['shot.png']);
  });
});

describe('pasteTargetIsEditable', () => {
  it('treats inputs as editable', () => {
    const input = document.createElement('input');
    expect(pasteTargetIsEditable(input)).toBe(true);
    const div = document.createElement('div');
    expect(pasteTargetIsEditable(div)).toBe(false);
  });
});
