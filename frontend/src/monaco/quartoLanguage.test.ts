import { describe, expect, it, beforeEach, vi } from 'vitest';
import {
  QUARTO_EXTENSIONS,
  QUARTO_LANGUAGE_ID,
  resolveQuartoFenceLang,
  registerQuartoLanguage,
  _resetQuartoRegistrationForTests,
  quartoMonarchLanguage,
  quartoLanguageConfiguration,
} from './quartoLanguage';
import { extToLang, isTextFile } from '../components/previewShared';

describe('resolveQuartoFenceLang', () => {
  it('maps common Quarto / knitr engines to Monaco ids', () => {
    expect(resolveQuartoFenceLang('r')).toBe('r');
    expect(resolveQuartoFenceLang('R')).toBe('r');
    expect(resolveQuartoFenceLang('python')).toBe('python');
    expect(resolveQuartoFenceLang('py')).toBe('python');
    expect(resolveQuartoFenceLang('julia')).toBe('julia');
    expect(resolveQuartoFenceLang('sql')).toBe('sql');
    expect(resolveQuartoFenceLang('bash')).toBe('shell');
    expect(resolveQuartoFenceLang('sh')).toBe('shell');
    expect(resolveQuartoFenceLang('yaml')).toBe('yaml');
    expect(resolveQuartoFenceLang('yml')).toBe('yaml');
    expect(resolveQuartoFenceLang('markdown')).toBe('markdown');
    expect(resolveQuartoFenceLang('js')).toBe('javascript');
  });

  it('passes through unknown engines lowercased', () => {
    expect(resolveQuartoFenceLang('Mermaid')).toBe('mermaid');
  });
});

describe('extToLang / isTextFile for Quarto', () => {
  it('maps rmd, qmd, rmarkdown to quarto', () => {
    for (const ext of QUARTO_EXTENSIONS) {
      expect(extToLang[ext]).toBe(QUARTO_LANGUAGE_ID);
      expect(isTextFile(ext)).toBe(true);
    }
  });

  it('keeps .md on the markdown highlighter (rendered separately)', () => {
    expect(extToLang.md).toBe('markdown');
    expect(extToLang.md).not.toBe(QUARTO_LANGUAGE_ID);
  });
});

describe('quarto Monarch definition', () => {
  it('includes language configuration for markdown-like comments', () => {
    expect(quartoLanguageConfiguration.comments?.blockComment).toEqual(['<!--', '-->']);
  });

  it('declares front matter, curly fences, and div rules', () => {
    const root = quartoMonarchLanguage.tokenizer.root as unknown[];
    const serialized = JSON.stringify(root);
    expect(serialized).toContain('frontmatter');
    expect(serialized).toContain('nextEmbedded');
    expect(root.some((rule) => Array.isArray(rule) && String(rule[0]).includes('```'))).toBe(true);
    expect(root.some((rule) => Array.isArray(rule) && String(rule[0]).includes(':::'))).toBe(true);
    expect(quartoMonarchLanguage.tokenizer).toHaveProperty('frontmatter');
    expect(quartoMonarchLanguage.tokenizer).toHaveProperty('codeblockgh');
  });
});

describe('registerQuartoLanguage', () => {
  beforeEach(() => {
    _resetQuartoRegistrationForTests();
  });

  it('registers id, configuration, and Monarch provider once', () => {
    const languages: { id: string }[] = [];
    const monaco = {
      languages: {
        getLanguages: () => languages,
        register: vi.fn((desc: { id: string }) => {
          languages.push({ id: desc.id });
        }),
        setLanguageConfiguration: vi.fn(),
        setMonarchTokensProvider: vi.fn(),
      },
    };

    registerQuartoLanguage(monaco);
    registerQuartoLanguage(monaco);

    expect(monaco.languages.register).toHaveBeenCalledTimes(1);
    expect(monaco.languages.register).toHaveBeenCalledWith(
      expect.objectContaining({ id: QUARTO_LANGUAGE_ID }),
    );
    expect(monaco.languages.setLanguageConfiguration).toHaveBeenCalledTimes(1);
    expect(monaco.languages.setMonarchTokensProvider).toHaveBeenCalledTimes(1);
    expect(monaco.languages.setMonarchTokensProvider).toHaveBeenCalledWith(
      QUARTO_LANGUAGE_ID,
      quartoMonarchLanguage,
    );
  });
});
