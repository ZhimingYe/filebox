import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-pdf', () => ({
  Document: () => null,
  Page: () => null,
  pdfjs: { GlobalWorkerOptions: {} },
}));

import { readPdfZoomPref, writePdfZoomPref } from './PdfPreview';

beforeEach(() => sessionStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe('PDF zoom persistence', () => {
  it('defaults to adaptive zoom when unset', () => {
    expect(readPdfZoomPref()).toBe('fit');
  });

  it.each(['', 'junk', 'NaN', 'Infinity', '0', '-1', '1.1', '3'])(
    'falls back for unsupported stored zoom %j',
    raw => {
      sessionStorage.setItem('filebox.pdfZoom', raw);
      expect(readPdfZoomPref()).toBe('fit');
    },
  );

  it.each(['fit', 0.5, 0.75, 1, 1.25, 1.5, 2] as const)(
    'round-trips supported zoom %s in session storage',
    mode => {
      writePdfZoomPref(mode);
      expect(readPdfZoomPref()).toBe(mode);
      expect(localStorage.getItem('filebox.pdfZoom')).toBeNull();
    },
  );

  it('tolerates unavailable session storage for both reads and writes', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    expect(readPdfZoomPref()).toBe('fit');
    expect(() => writePdfZoomPref(1.5)).not.toThrow();
  });
});
