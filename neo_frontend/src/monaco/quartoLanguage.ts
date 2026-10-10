/**
 * Monaco Monarch language for Quarto / R Markdown (.qmd / .rmd / .rmarkdown).
 *
 * Adapted from Monaco Editor's built-in markdown Monarch tokenizer
 * (https://github.com/microsoft/monaco-editor, MIT License).
 * Behaviour aligned with Posit/Quarto VS Code TextMate grammar
 * (quarto-dev/quarto apps/vscode/syntaxes/quarto.tmLanguage, MIT)
 * for viewing: YAML front matter at document start, knitr/Quarto fenced
 * chunks (```{r} / ```{.python} / ```{=html} / bare ```r), #| options via
 * embedded-language comments, ::: divs, shortcodes, math delimiters, and
 * inline `r` / `python` / `julia`.
 *
 * Zero new dependencies — embeds Monaco's built-in languages (r, python,
 * yaml, julia, sql, shell, markdown, …). Engines without a Monaco built-in
 * (mermaid, stan, …) map to plaintext.
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
 * Engines Quarto/VS Code highlight but Monaco has no built-in grammar for.
 * Fence bodies stay readable as plaintext rather than an unknown language id.
 */
export const QUARTO_PLAINTEXT_ENGINES = [
  'mermaid',
  'mmd',
  'stan',
  'plantuml',
  'dot',
  'typst',
  'typ',
  'matlab',
  'stata',
  'prql',
  'sas',
] as const;

/**
 * Map a fence / chunk engine name to a Monaco language id.
 * Used by the tokenizer (via Monarch cases) and unit tests.
 */
export function resolveQuartoFenceLang(raw: string): string {
  const key = raw.trim().toLowerCase();
  if ((QUARTO_PLAINTEXT_ENGINES as readonly string[]).includes(key)) {
    return 'plaintext';
  }
  switch (key) {
    case 'r':
    case 'rscript':
      return 'r';
    case 'python':
    case 'py':
    case 'py3':
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
    case 'ojs':
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
    case 'cxx':
      return 'cpp';
    case 'c':
      return 'c';
    case 'rust':
    case 'rs':
      return 'rust';
    case 'go':
    case 'golang':
      return 'go';
    case 'java':
      return 'java';
    case 'ruby':
    case 'rb':
      return 'ruby';
    case 'powershell':
    case 'ps1':
      return 'powershell';
    case 'plaintext':
    case 'text':
    case 'txt':
      return 'plaintext';
    default:
      return key || 'plaintext';
  }
}

/** Shared Monarch cases: curly/dot/bare fence engine → nextEmbedded language. */
function fenceEmbedCases(embeddedFromGroup = true): Record<string, object> {
  const emb = (lang: string) => ({
    token: 'string',
    next: '@codeblockgh',
    nextEmbedded: lang,
  });
  return {
    '$1==r': emb('r'),
    '$1==R': emb('r'),
    '$1==python': emb('python'),
    '$1==Python': emb('python'),
    '$1==py': emb('python'),
    '$1==julia': emb('julia'),
    '$1==Julia': emb('julia'),
    '$1==jl': emb('julia'),
    '$1==sql': emb('sql'),
    '$1==SQL': emb('sql'),
    '$1==bash': emb('shell'),
    '$1==sh': emb('shell'),
    '$1==zsh': emb('shell'),
    '$1==shell': emb('shell'),
    '$1==yaml': emb('yaml'),
    '$1==yml': emb('yaml'),
    '$1==markdown': emb('markdown'),
    '$1==md': emb('markdown'),
    '$1==javascript': emb('javascript'),
    '$1==js': emb('javascript'),
    '$1==ojs': emb('javascript'),
    '$1==typescript': emb('typescript'),
    '$1==ts': emb('typescript'),
    '$1==html': emb('html'),
    '$1==css': emb('css'),
    '$1==json': emb('json'),
    '$1==xml': emb('xml'),
    '$1==cpp': emb('cpp'),
    '$1==c++': emb('cpp'),
    '$1==c': emb('c'),
    '$1==rust': emb('rust'),
    '$1==go': emb('go'),
    '$1==java': emb('java'),
    '$1==ruby': emb('ruby'),
    '$1==powershell': emb('powershell'),
    // No Monaco grammar — stay out of unknown embedded ids
    '$1==mermaid': emb('plaintext'),
    '$1==stan': emb('plaintext'),
    '$1==plantuml': emb('plaintext'),
    '$1==dot': emb('plaintext'),
    '$1==typst': emb('plaintext'),
    '$1==matlab': emb('plaintext'),
    '$1==stata': emb('plaintext'),
    '@default': {
      token: 'string',
      next: '@codeblockgh',
      nextEmbedded: embeddedFromGroup ? '$1' : 'plaintext',
    },
  };
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
 * Quarto-specific: document-start front matter (official \A), curly/dot/=
 * fence openers, ::: divs, shortcodes, math, inline `r` / `python` / `julia`.
 */
export const quartoMonarchLanguage: MonacoLanguages.IMonarchLanguage = {
  defaultToken: '',
  tokenPostfix: '.quarto',
  // Official quarto.tmLanguage frontMatter uses \A — only at document start.
  start: 'document',
  control: /[\\`*_\[\]{}()#+\-\.!]/,
  noncontrol: /[^\\`*_\[\]{}()#+\-\.!]/,
  escapes: /\\(?:@control)/,
  jsescapes: /\\(?:[btnfr\\"']|[0-7][0-7]?|[0-3][0-7]{2})/,
  empty: [
    'area', 'base', 'basefont', 'br', 'col', 'frame', 'hr', 'img',
    'input', 'isindex', 'link', 'meta', 'param',
  ],

  tokenizer: {
    // Start-only gate so mid-document --- stays a thematic break (not YAML).
    document: [
      [/^(-{3,})\s*$/, { token: 'meta.frontmatter', next: '@frontmatter', nextEmbedded: 'yaml' }],
      [/^/, { token: '@rematch', switchTo: '@body' }],
    ],

    body: [
      // Quarto / Pandoc fenced divs: ::: {.callout-note} … :::
      [/^\s*:{3,}.*$/, 'keyword'],

      // Display math $$ … $$ (official math_block)
      [/^\s*\$\$/, { token: 'keyword', next: '@mathblock' }],

      // markdown tables
      [/^\s*\|/, '@rematch', '@table_header'],

      // headers (with #)
      [/^(\s{0,3})(#+)((?:[^\\#]|@escapes)+)((?:#+)?)/, ['white', 'keyword', 'keyword', 'keyword']],
      // headers (with = / -) — require 3+ to avoid eating YAML-like lines
      [/^\s*(={3,}|-{3,})\s*$/, 'keyword'],
      // thematic break (*, _, or --- already covered above as keyword when 3+)
      [/^\s*((\*[ ]?){3,}|(_[ ]?){3,})\s*$/, 'meta.separator'],
      // quote
      [/^\s*>+/, 'comment'],
      // list
      [/^\s*([\*\-+:]|\d+\.)\s/, 'keyword'],
      // indented code block
      [/^(\t|[ ]{4})[^ ].*$/, 'string'],

      // ~~~ fences (plain / with lang) — allow 3+ tildes like official `{3,}`
      [/^\s*~{3,}\s*((?:\w|[\/\-#])+)?\s*$/, { token: 'string', next: '@codeblock' }],

      // ```{engine='python'} / engine="r" (knitr-style engine option in braces)
      [
        /^\s*`{3,}\s*\{\s*engine\s*=\s*['"]([A-Za-z_][\w.]*)['"].*$/,
        { cases: fenceEmbedCases() },
      ],

      // ```{r} / ```{python} / ```{r chunk, echo=TRUE} / ```{=html} / ```{.r}
      // Optional = or . before engine (official [\{\.=]?).
      [
        /^\s*`{3,}\s*\{\s*(?:=|\.)?\s*([A-Za-z_][\w.]*)\b.*$/,
        { cases: fenceEmbedCases() },
      ],

      // github-style ```lang (no braces) — bare ```r still embeds R
      [
        /^\s*`{3,}\s*((?:\w|[\/\-#])+).*$/,
        { cases: fenceEmbedCases() },
      ],
      // bare ``` / ```` (no lang)
      [/^\s*`{3,}\s*$/, { token: 'string', next: '@codeblock' }],

      { include: '@linecontent' },
    ],

    frontmatter: [
      // Official end: matching dashes or ...
      [/^\s*-{3,}\s*$/, { token: 'meta.frontmatter', next: '@body', nextEmbedded: '@pop' }],
      [/^\s*\.\.\.\s*$/, { token: 'meta.frontmatter', next: '@body', nextEmbedded: '@pop' }],
      [/.*$/, ''],
    ],

    mathblock: [
      [/\$\$/, { token: 'keyword', next: '@pop' }],
      [/.*$/, 'variable.math'],
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
      [/^\s*~{3,}\s*$/, { token: 'string', next: '@pop' }],
      [/^\s*`{3,}\s*$/, { token: 'string', next: '@pop' }],
      [/.*$/, 'variable.source'],
    ],

    // Embedded fence body (engine language via nextEmbedded).
    // #| chunk-option lines are comments in R/Python/Julia so they stay readable.
    // Closing: any run of 3+ backticks (Monaco markdown parity; exact-count match
    // like TextMate `{3,}` capture is not feasible without Monarch state args).
    codeblockgh: [
      [/^\s*`{3,}\s*$/, { token: 'string', next: '@pop', nextEmbedded: '@pop' }],
      [/[^`]+/, 'variable.source'],
    ],

    linecontent: [
      [/&\w+;/, 'string.escape'],
      [/@escapes/, 'escape'],
      // Quarto shortcodes {{< ... >}} (official shortcode match)
      [/\{\{<[\s\S]*?>\}\}/, 'keyword'],
      // Inline math $...$ (official math_inline; avoid $$)
      [/\$[^$\s][^$]*\$/, 'variable.math'],
      [/\b__([^\\_]|@escapes|_(?!_))+__\b/, 'strong'],
      [/\*\*([^\\*]|@escapes|\*(?!\*))+\*\*/, 'strong'],
      [/\b_[^_]+_\b/, 'emphasis'],
      [/\*([^\\*]|@escapes)+\*/, 'emphasis'],
      // knitr / Quarto inline code: `r …` / `python …` / `julia …`
      [/`r\s+([^`]+)`/, 'variable.inline'],
      [/`python\s+([^`]+)`/, 'variable.inline'],
      [/`julia\s+([^`]+)`/, 'variable.inline'],
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
