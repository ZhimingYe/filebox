import { describe, expect, it } from 'vitest';
import { fileCategoryForName, fileExt } from './fileListShared';

describe('file list icons for Quarto / Rmd', () => {
  it('extracts extensions case-insensitively', () => {
    expect(fileExt('analysis.qmd')).toBe('qmd');
    expect(fileExt('report.Rmd')).toBe('rmd');
    expect(fileExt('notes.rmarkdown')).toBe('rmarkdown');
  });

  it('maps qmd / rmd / rmarkdown to the R colour category', () => {
    expect(fileCategoryForName('analysis.qmd')).toBe('r');
    expect(fileCategoryForName('report.Rmd')).toBe('r');
    expect(fileCategoryForName('notes.rmarkdown')).toBe('r');
  });
});
