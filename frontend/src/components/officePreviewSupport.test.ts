import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isOfficePreviewExt, readOfficePdfPreviewPref, writeOfficePdfPreviewPref,
} from './officePreviewSupport';

it.each(['DOCX', 'XlSm', 'ods', 'pptm'])('accepts supported Office formats case-insensitively: %s', ext => expect(isOfficePreviewExt(ext)).toBe(true));
it.each(['', '.docx', 'docx.zip', 'pdf', 'csv', 'txt'])('does not convert non-Office extension %j', ext => expect(isOfficePreviewExt(ext)).toBe(false));

describe('Office PDF preference storage', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it('defaults on when no preference is saved', () => {
    expect(readOfficePdfPreviewPref()).toBe(true);
  });

  it.each([
    ['false', false], ['true', true], ['', true], ['FALSE', true],
    ['0', true], ['null', true], ['junk', true],
  ])('only literal false disables conversion: %j', (raw, expected) => {
    localStorage.setItem('filebox.officePdfPreview', raw);
    expect(readOfficePdfPreviewPref()).toBe(expected);
  });

  it('round-trips both toggles without changing unrelated storage', () => {
    localStorage.setItem('other', 'preserved');
    writeOfficePdfPreviewPref(false);
    expect(readOfficePdfPreviewPref()).toBe(false);
    writeOfficePdfPreviewPref(true);
    expect(readOfficePdfPreviewPref()).toBe(true);
    expect(localStorage.getItem('other')).toBe('preserved');
  });

  it('defaults on and does not throw when storage is blocked or full', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    expect(readOfficePdfPreviewPref()).toBe(true);
    expect(() => writeOfficePdfPreviewPref(false)).not.toThrow();
  });
});
