/**
 * Monaco Monarch language for Quarto / R Markdown (.qmd / .rmd / .rmarkdown).
 *
 * Adapted from Monaco Editor's built-in markdown Monarch tokenizer
 * (https://github.com/microsoft/monaco-editor, MIT License).
 * Extensions for YAML front matter, knitr/Quarto fenced chunks
 * (```{r} / ```{.python} / …), #| chunk options (highlighted via the
 * embedded language's comment rules), ::: fenced divs, and inline `r …`.
 *
 * Zero new dependencies — embeds Monaco's built-in languages (r, python,
 * yaml, julia, sql, shell, markdown, …).
 */

/* eslint-disable no-useless-escape -- Monarch regexes mirror monaco-editor markdown.js */

import type { languages as MonacoLanguages } from 'monaco-editor';

/** Minimal Monaco surface needed to register the language (avoids importing the full editor in tests). */
export type MonacoLanguagesApi = {
  languages: {
    getLanguages(): ReadonlyArray<{ id: string }>;
    register(language: MonacoLanguages.ILanguageExtensionPoint): void;
    setLanguageConfiguration(
      languageId: string,
      configuration: MonacoLanguages.LanguageConfiguration,
    ): unknown;
    setMonarchTokensProvider(
      languageId: string,
      languageDef: MonacoLanguages.IMonarchLanguage,
    ): unknown;
  };
};

export const QUARTO_LANGUAGE_ID = 'quarto';

/** Extensions that open in TextPreview with the quarto language. */
export const QUARTO_EXTENSIONS = ['rmd', 'qmd', 'rmarkdown'] as const;

/**
 * Map a fence / chunk engine name to a Monaco language id.
 * Used by the tokenizer (via Monarch cases) and unit tests.
 */
export function resolveQuartoFenceLang(raw: string): string {
  const key = raw.trim().toLowerCase();
  switch (key) {
    case 'r':
      return 'r';
    case 'python':
    case 'py':
      return 'python';
    case 'julia':
    case 'jl':
      return 'julia';
    case 'sql':
      return 'sql';
    case 'bash':
    case 'sh':
    case 'zsh':
    case 'shell':
      return 'shell';
    case 'yaml':
    case 'yml':
      return 'yaml';
    case 'markdown':
    case 'md':
      return 'markdown';
    case 'javascript':
    case 'js':
      return 'javascript';
    case 'typescript':
    case 'ts':
      return 'typescript';
    case 'html':
      return 'html';
    case 'css':
      return 'css';
    case 'json':
      return 'json';
    case 'xml':
      return 'xml';
    case 'cpp':
    case 'c++':
      return 'cpp';
    case 'c':
      return 'c';
    case 'rust':
    case 'rs':
      return 'rust';
    case 'go':
      return 'go';
    case 'java':
      return 'java';
    case 'ruby':
    case 'rb':
      return 'ruby';
    case 'plaintext':
    case 'text':
    case 'txt':
      return 'plaintext';
    default:
      return key || 'plaintext';
  }
}

// Language configuration mirrors Monaco markdown (brackets / comments).
export const quartoLanguageConfiguration: MonacoLanguages.LanguageConfiguration = {
  comments: {
    blockComment: ['<!--', '-->'],
  },
  brackets: [
    ['{', '}'],
    ['[', ']'],
    ['(', ')'],
  ],
  autoClosingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '(', close: ')' },
    { open: '<', close: '>', notIn: ['string'] },
  ],
  surroundingPairs: [
    { open: '(', close: ')' },
    { open: '[', close: ']' },
    { open: '`', close: '`' },
  ],
  folding: {
    markers: {
      start: /^\s*<!--\s*#?region\b.*-->/,
      end: /^\s*<!--\s*#?endregion\b.*-->/,
    },
  },
};

/**
 * Monarch tokenizer. Structure follows Monaco's markdown.js (MIT);
 * Quarto-specific states: frontmatter, curly/dot fence openers, ::: divs,
 * inline `r …`.
 */
export const quartoMonarchLanguage: MonacoLanguages.IMonarchLanguage = {
  defaultToken: '',
  tokenPostfix: '.quarto',
  control: /[\\`*_\[\]{}()#+\-\.!]/,
  noncontrol: /[^\\`*_\[\]{}()#+\-\.!]/,
  escapes: /\\(?:@control)/,
  jsescapes: /\\(?:[btnfr\\"']|[0-7][0-7]?|[0-3][0-7]{2})/,
  empty: [
    'area', 'base', 'basefont', 'br', 'col', 'frame', 'hr', 'img',
    'input', 'isindex', 'link', 'meta', 'param',
  ],

  tokenizer: {
    root: [
      // YAML / Quarto front matter (document must start with ---)
      [/^---\s*$/, { token: 'meta.frontmatter', next: '@frontmatter', nextEmbedded: 'yaml' }],

      // Quarto / Pandoc fenced divs: ::: {.callout-note} … :::
      [/^\s*:::{1,}.*$/, 'keyword'],

      // markdown tables
      [/^\s*\|/, '@rematch', '@table_header'],

      // headers (with #)
      [/^(\s{0,3})(#+)((?:[^\\#]|@escapes)+)((?:#+)?)/, ['white', 'keyword', 'keyword', 'keyword']],
      // headers (with = / -)
      [/^\s*(=+|\-+)\s*$/, 'keyword'],
      // thematic break
      [/^\s*((\*[ ]?)+)\s*$/, 'meta.separator'],
      // quote
      [/^\s*>+/, 'comment'],
      // list
      [/^\s*([\*\-+:]|\d+\.)\s/, 'keyword'],
      // indented code block
      [/^(\t|[ ]{4})[^ ].*$/, 'string'],

      // ~~~ fences (plain / with lang)
      [/^\s*~~~\s*((?:\w|[\/\-#])+)?\s*$/, { token: 'string', next: '@codeblock' }],

      // ```{r} / ```{python} / ```{r chunk, echo=TRUE}  → embed engine
      [
        /^\s*```\s*\{\s*([A-Za-z_][\w.]*)\b.*$/,
        {
          cases: {
            '$1==r': { token: 'string', next: '@codeblockgh', nextEmbedded: 'r' },
            '$1==R': { token: 'string', next: '@codeblockgh', nextEmbedded: 'r' },
            '$1==python': { token: 'string', next: '@codeblockgh', nextEmbedded: 'python' },
            '$1==Python': { token: 'string', next: '@codeblockgh', nextEmbedded: 'python' },
            '$1==py': { token: 'string', next: '@codeblockgh', nextEmbedded: 'python' },
            '$1==julia': { token: 'string', next: '@codeblockgh', nextEmbedded: 'julia' },
            '$1==Julia': { token: 'string', next: '@codeblockgh', nextEmbedded: 'julia' },
            '$1==sql': { token: 'string', next: '@codeblockgh', nextEmbedded: 'sql' },
            '$1==SQL': { token: 'string', next: '@codeblockgh', nextEmbedded: 'sql' },
            '$1==bash': { token: 'string', next: '@codeblockgh', nextEmbedded: 'shell' },
            '$1==sh': { token: 'string', next: '@codeblockgh', nextEmbedded: 'shell' },
            '$1==zsh': { token: 'string', next: '@codeblockgh', nextEmbedded: 'shell' },
            '$1==shell': { token: 'string', next: '@codeblockgh', nextEmbedded: 'shell' },
            '$1==yaml': { token: 'string', next: '@codeblockgh', nextEmbedded: 'yaml' },
            '$1==yml': { token: 'string', next: '@codeblockgh', nextEmbedded: 'yaml' },
            '$1==markdown': { token: 'string', next: '@codeblockgh', nextEmbedded: 'markdown' },
            '$1==md': { token: 'string', next: '@codeblockgh', nextEmbedded: 'markdown' },
            '$1==javascript': { token: 'string', next: '@codeblockgh', nextEmbedded: 'javascript' },
            '$1==js': { token: 'string', next: '@codeblockgh', nextEmbedded: 'javascript' },
            '$1==typescript': { token: 'string', next: '@codeblockgh', nextEmbedded: 'typescript' },
            '$1==ts': { token: 'string', next: '@codeblockgh', nextEmbedded: 'typescript' },
            '$1==html': { token: 'string', next: '@codeblockgh', nextEmbedded: 'html' },
            '$1==css': { token: 'string', next: '@codeblockgh', nextEmbedded: 'css' },
            '$1==json': { token: 'string', next: '@codeblockgh', nextEmbedded: 'json' },
            '@default': { token: 'string', next: '@codeblockgh', nextEmbedded: '$1' },
          },
        },
      ],

      // ```{.r} / ```{.python} (Pandoc / Quarto attribute syntax)
      [
        /^\s*```\s*\{\.([A-Za-z_][\w.]*)\b.*$/,
        {
          cases: {
            '$1==r': { token: 'string', next: '@codeblockgh', nextEmbedded: 'r' },
            '$1==python': { token: 'string', next: '@codeblockgh', nextEmbedded: 'python' },
            '$1==py': { token: 'string', next: '@codeblockgh', nextEmbedded: 'python' },
            '$1==julia': { token: 'string', next: '@codeblockgh', nextEmbedded: 'julia' },
            '$1==sql': { token: 'string', next: '@codeblockgh', nextEmbedded: 'sql' },
            '$1==bash': { token: 'string', next: '@codeblockgh', nextEmbedded: 'shell' },
            '$1==sh': { token: 'string', next: '@codeblockgh', nextEmbedded: 'shell' },
            '$1==shell': { token: 'string', next: '@codeblockgh', nextEmbedded: 'shell' },
            '$1==yaml': { token: 'string', next: '@codeblockgh', nextEmbedded: 'yaml' },
            '$1==yml': { token: 'string', next: '@codeblockgh', nextEmbedded: 'yaml' },
            '@default': { token: 'string', next: '@codeblockgh', nextEmbedded: '$1' },
          },
        },
      ],

      // github-style ```lang (no braces)
      [
        /^\s*```\s*((?:\w|[\/\-#])+).*$/,
        {
          cases: {
            '$1==r': { token: 'string', next: '@codeblockgh', nextEmbedded: 'r' },
            '$1==R': { token: 'string', next: '@codeblockgh', nextEmbedded: 'r' },
            '$1==python': { token: 'string', next: '@codeblockgh', nextEmbedded: 'python' },
            '$1==bash': { token: 'string', next: '@codeblockgh', nextEmbedded: 'shell' },
            '$1==sh': { token: 'string', next: '@codeblockgh', nextEmbedded: 'shell' },
            '$1==yaml': { token: 'string', next: '@codeblockgh', nextEmbedded: 'yaml' },
            '$1==yml': { token: 'string', next: '@codeblockgh', nextEmbedded: 'yaml' },
            '@default': { token: 'string', next: '@codeblockgh', nextEmbedded: '$1' },
          },
        },
      ],
      // bare ```
      [/^\s*```\s*$/, { token: 'string', next: '@codeblock' }],

      { include: '@linecontent' },
    ],

    frontmatter: [
      [/^\s*---\s*$/, { token: 'meta.frontmatter', next: '@pop', nextEmbedded: '@pop' }],
      [/^\s*\.\.\.\s*$/, { token: 'meta.frontmatter', next: '@pop', nextEmbedded: '@pop' }],
      [/.*$/, ''],
    ],

    table_header: [
      { include: '@table_common' },
      [/[^\|]+/, 'keyword.table.header'],
    ],
    table_body: [{ include: '@table_common' }, { include: '@linecontent' }],
    table_common: [
      [/\s*[\-:]+\s*/, { token: 'keyword', switchTo: 'table_body' }],
      [/^\s*\|/, 'keyword.table.left'],
      [/^\s*[^\|]/, '@rematch', '@pop'],
      [/^\s*$/, '@rematch', '@pop'],
      [
        /\|/,
        {
          cases: {
            '@eos': 'keyword.table.right',
            '@default': 'keyword.table.middle',
          },
        },
      ],
    ],

    codeblock: [
      [/^\s*~~~\s*$/, { token: 'string', next: '@pop' }],
      [/^\s*```\s*$/, { token: 'string', next: '@pop' }],
      [/.*$/, 'variable.source'],
    ],

    // Embedded fence body (engine language via nextEmbedded).
    // #| chunk-option lines are comments in R/Python/Julia so they stay readable.
    codeblockgh: [
      [/```\s*$/, { token: 'string', next: '@pop', nextEmbedded: '@pop' }],
      [/[^`]+/, 'variable.source'],
    ],

    linecontent: [
      [/&\w+;/, 'string.escape'],
      [/@escapes/, 'escape'],
      [/\b__([^\\_]|@escapes|_(?!_))+__\b/, 'strong'],
      [/\*\*([^\\*]|@escapes|\*(?!\*))+\*\*/, 'strong'],
      [/\b_[^_]+_\b/, 'emphasis'],
      [/\*([^\\*]|@escapes)+\*/, 'emphasis'],
      // knitr / Quarto inline code: `r …` / `python …` (before generic backticks)
      [/`r\s+([^`]+)`/, 'variable.inline'],
      [/`python\s+([^`]+)`/, 'variable.inline'],
      [/`([^\\`]|@escapes)+`/, 'variable'],
      [/\{+[^}]+\}+/, 'string.target'],
      [/(!?\[)((?:[^\]\\]|@escapes)*)(\]\([^\)]+\))/, ['string.link', '', 'string.link']],
      [/(!?\[)((?:[^\]\\]|@escapes)*)(\])/, 'string.link'],
      { include: 'html' },
    ],

    html: [
      [/<(\w+)\/>/, 'tag'],
      [
        /<(\w+)(\-|\w)*/,
        {
          cases: {
            '@empty': { token: 'tag', next: '@tag.$1' },
            '@default': { token: 'tag', next: '@tag.$1' },
          },
        },
      ],
      [/<\/(\w+)(\-|\w)*\s*>/, { token: 'tag' }],
      [/<!--/, 'comment', '@comment'],
    ],

    comment: [
      [/[^<\-]+/, 'comment.content'],
      [/-->/, 'comment', '@pop'],
      [/<!--/, 'comment.content.invalid'],
      [/[<\-]/, 'comment.content'],
    ],

    tag: [
      [/[ \t\r\n]+/, 'white'],
      [
        /(type)(\s*=\s*)(")([^"]+)(")/,
        [
          'attribute.name.html',
          'delimiter.html',
          'string.html',
          { token: 'string.html', switchTo: '@tag.$S2.$4' },
          'string.html',
        ],
      ],
      [
        /(type)(\s*=\s*)(')([^']+)(')/,
        [
          'attribute.name.html',
          'delimiter.html',
          'string.html',
          { token: 'string.html', switchTo: '@tag.$S2.$4' },
          'string.html',
        ],
      ],
      [/(\w+)(\s*=\s*)("[^"]*"|'[^']*')/, ['attribute.name.html', 'delimiter.html', 'string.html']],
      [/\w+/, 'attribute.name.html'],
      [/\/>/, 'tag', '@pop'],
      [
        />/,
        {
          cases: {
            '$S2==style': {
              token: 'tag',
              switchTo: 'embeddedStyle',
              nextEmbedded: 'text/css',
            },
            '$S2==script': {
              cases: {
                $S3: {
                  token: 'tag',
                  switchTo: 'embeddedScript',
                  nextEmbedded: '$S3',
                },
                '@default': {
                  token: 'tag',
                  switchTo: 'embeddedScript',
                  nextEmbedded: 'text/javascript',
                },
              },
            },
            '@default': { token: 'tag', next: '@pop' },
          },
        },
      ],
    ],

    embeddedStyle: [
      [/[^<]+/, ''],
      [/<\/style\s*>/, { token: '@rematch', next: '@pop', nextEmbedded: '@pop' }],
      [/</, ''],
    ],
    embeddedScript: [
      [/[^<]+/, ''],
      [/<\/script\s*>/, { token: '@rematch', next: '@pop', nextEmbedded: '@pop' }],
      [/</, ''],
    ],
  },
};

let registered = false;

/** Idempotent registration of the `quarto` language with Monaco. */
export function registerQuartoLanguage(monaco: MonacoLanguagesApi): void {
  if (registered) return;
  const already = monaco.languages.getLanguages().some((l) => l.id === QUARTO_LANGUAGE_ID);
  if (!already) {
    monaco.languages.register({
      id: QUARTO_LANGUAGE_ID,
      extensions: ['.qmd', '.rmd', '.Rmd', '.rmarkdown'],
      aliases: ['Quarto', 'quarto', 'R Markdown', 'Rmd'],
      mimetypes: ['text/x-quarto', 'text/x-rmarkdown'],
    });
  }
  monaco.languages.setLanguageConfiguration(QUARTO_LANGUAGE_ID, quartoLanguageConfiguration);
  monaco.languages.setMonarchTokensProvider(QUARTO_LANGUAGE_ID, quartoMonarchLanguage);
  registered = true;
}

/** Test helper — reset the module registration guard. */
export function _resetQuartoRegistrationForTests(): void {
  registered = false;
}
