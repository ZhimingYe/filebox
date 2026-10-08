import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import {
  QUARTO_EXTENSIONS,
  QUARTO_LANGUAGE_ID,
  QUARTO_PLAINTEXT_ENGINES,
  resolveQuartoFenceLang,
  registerQuartoLanguage,
  _resetQuartoRegistrationForTests,
  quartoMonarchLanguage,
  quartoLanguageConfiguration,
} from './quartoLanguage';
import { extToLang, isTextFile } from '../components/previewShared';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

function ruleSources(rules: unknown[]): string[] {
  return rules
    .filter((rule): rule is [RegExp, ...unknown[]] => Array.isArray(rule) && rule[0] instanceof RegExp)
    .map((rule) => rule[0].source);
}

function serializeTokenizer(): string {
  return JSON.stringify(quartoMonarchLanguage.tokenizer, (_k, v) =>
    v instanceof RegExp ? v.source : v,
  );
}

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
    expect(resolveQuartoFenceLang('ojs')).toBe('javascript');
    expect(resolveQuartoFenceLang('cpp')).toBe('cpp');
    expect(resolveQuartoFenceLang('c++')).toBe('cpp');
  });

  it('maps engines without Monaco grammars to plaintext', () => {
    expect(resolveQuartoFenceLang('Mermaid')).toBe('plaintext');
    expect(resolveQuartoFenceLang('stan')).toBe('plaintext');
    expect(resolveQuartoFenceLang('plantuml')).toBe('plaintext');
    expect(resolveQuartoFenceLang('dot')).toBe('plaintext');
    expect(resolveQuartoFenceLang('typst')).toBe('plaintext');
    for (const eng of QUARTO_PLAINTEXT_ENGINES) {
      expect(resolveQuartoFenceLang(eng)).toBe('plaintext');
    }
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

describe('quarto Monarch definition — official-grammar checklist', () => {
  const body = () => quartoMonarchLanguage.tokenizer.body as unknown[];
  const line = () => quartoMonarchLanguage.tokenizer.linecontent as unknown[];
  const serialized = () => serializeTokenizer();

  it('includes language configuration for markdown-like comments', () => {
    expect(quartoLanguageConfiguration.comments?.blockComment).toEqual(['<!--', '-->']);
  });

  it('starts in document state so front matter is document-start only', () => {
    expect(quartoMonarchLanguage.start).toBe('document');
    expect(quartoMonarchLanguage.tokenizer).toHaveProperty('document');
    expect(quartoMonarchLanguage.tokenizer).toHaveProperty('body');
    expect(quartoMonarchLanguage.tokenizer).not.toHaveProperty('root');
    expect(serialized()).toContain('frontmatter');
    expect(serialized()).toContain('nextEmbedded');
  });

  it('front matter closes on --- or ... and returns to body', () => {
    const sources = ruleSources(quartoMonarchLanguage.tokenizer.frontmatter as unknown[]);
    expect(sources.some((s) => s.includes('-{3,}'))).toBe(true);
    expect(sources.some((s) => s.includes('\\.\\.\\.') || s.includes('...'))).toBe(true);
    expect(JSON.stringify(quartoMonarchLanguage.tokenizer.frontmatter)).toContain('@body');
  });

  it('recognizes curly, dot, raw=, engine=, and bare fences', () => {
    const sources = ruleSources(body());
    expect(sources.some((s) => s.includes('(?:=|.)?') || s.includes('(?:=|\\.)?'))).toBe(true);
    expect(sources.some((s) => s.includes('engine'))).toBe(true);
    expect(sources.some((s) => s.includes('`{3,}'))).toBe(true);
    expect(serialized()).toContain('codeblockgh');
  });

  it('highlights ::: divs / callouts', () => {
    expect(ruleSources(body()).some((s) => s.includes(':{3,}'))).toBe(true);
  });

  it('highlights Quarto shortcodes', () => {
    expect(ruleSources(line()).some((s) => s.includes('{{<') || s.includes('\\{\\{<'))).toBe(true);
  });

  it('highlights display and inline math delimiters', () => {
    expect(quartoMonarchLanguage.tokenizer).toHaveProperty('mathblock');
    expect(ruleSources(body()).some((s) => s.includes('$$') || s.includes('\\$\\$'))).toBe(true);
    expect(ruleSources(line()).some((s) => s.startsWith('\\$') || (s.startsWith('$') && !s.startsWith('$$')))).toBe(true);
  });

  it('recognizes inline r / python / julia', () => {
    const sources = ruleSources(line());
    expect(sources.some((s) => s.startsWith('`r'))).toBe(true);
    expect(sources.some((s) => s.startsWith('`python'))).toBe(true);
    expect(sources.some((s) => s.startsWith('`julia'))).toBe(true);
  });

  it('maps mermaid/stan fence cases to plaintext embedded', () => {
    expect(serialized()).toContain('$1==mermaid');
    expect(serialized()).toContain('$1==stan');
    expect(serialized()).toContain('"nextEmbedded":"plaintext"');
  });

  it('closes embedded fences on 3+ backticks', () => {
    const gh = ruleSources(quartoMonarchLanguage.tokenizer.codeblockgh as unknown[]);
    expect(gh.some((s) => s.includes('`{3,}'))).toBe(true);
  });
});

describe('audit fixtures cover official patterns', () => {
  const qmd = readFileSync(join(fixturesDir, 'audit-checklist.qmd'), 'utf8');
  const rmd = readFileSync(join(fixturesDir, 'audit-checklist.Rmd'), 'utf8');

  it('qmd fixture includes front matter, chunks, divs, shortcodes, math', () => {
    expect(qmd.startsWith('---\n')).toBe(true);
    expect(qmd).toContain('```{r}');
    expect(qmd).toContain('```{python}');
    expect(qmd).toContain('```{.r}');
    expect(qmd).toContain('```{r chunk-label, echo=FALSE');
    expect(qmd).toContain('#| label:');
    expect(qmd).toContain("```{engine='python'}");
    expect(qmd).toContain('```{=html}');
    expect(qmd).toContain('```r\n');
    expect(qmd).toContain('::: {.callout-note}');
    expect(qmd).toContain('{{< var foo >}}');
    expect(qmd).toContain('$$\n');
    expect(qmd).toContain('`r mean(x)`');
    expect(qmd).toContain('```{mermaid}');
    expect(qmd).toContain('```{stan}');
    expect(qmd).toContain('```{yaml}');
    expect(qmd).toMatch(/thematic break[\s\S]*?\n---\n/);
    expect(qmd).toContain('```{r\n');
    expect(qmd).toContain('````markdown');
  });

  it('Rmd fixture is a minimal twin', () => {
    expect(rmd.startsWith('---\n')).toBe(true);
    expect(rmd).toContain('```{r setup');
    expect(rmd).toContain('`r 1+1`');
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
