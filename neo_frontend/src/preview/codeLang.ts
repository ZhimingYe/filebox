/**
 * Code/text extensions previewed in Monaco (read-only). Mirrors the classic
 * frontend's `extToLang` so both UIs agree on language ids; Quarto / R
 * Markdown use the shared `quarto` Monarch language.
 */
export const extToLang: Record<string, string> = {
  rs: 'rust', py: 'python',
  js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
  go: 'go', java: 'java',
  c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cc: 'cpp', cxx: 'cpp',
  cs: 'csharp',
  css: 'css', scss: 'scss', sass: 'scss', less: 'less',
  sh: 'shell', bash: 'shell', zsh: 'shell', fish: 'shell',
  json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'ini', xml: 'xml',
  sql: 'sql', rb: 'ruby', php: 'php',
  swift: 'swift', kt: 'kotlin', kts: 'kotlin', scala: 'scala',
  r: 'r',
  rmd: 'quarto', qmd: 'quarto', rmarkdown: 'quarto',
  rprofile: 'r', renviron: 'r',
  lua: 'lua', pl: 'perl', pm: 'perl',
  erl: 'plaintext', ex: 'elixir', exs: 'elixir',
  hs: 'plaintext', ml: 'plaintext', mli: 'plaintext',
  clj: 'clojure', lisp: 'plaintext', el: 'plaintext',
  dockerfile: 'dockerfile', makefile: 'plaintext', cmake: 'plaintext',
  ini: 'ini', cfg: 'ini', conf: 'ini',
  diff: 'plaintext', patch: 'plaintext',
  txt: 'plaintext', log: 'plaintext', env: 'plaintext',
}

/** Monaco handles large files better than remark, but keep the same budget as Markdown. */
export const CODE_PREVIEW_MAX_BYTES = 256 * 1024

export function isCodeExt(ext: string): boolean {
  return ext.toLowerCase() in extToLang
}

export function langForExt(ext: string): string {
  return extToLang[ext.toLowerCase()] ?? 'plaintext'
}

/** Extension key used for routing: last dot segment, lowercased (dotfiles keep basename). */
export function previewExt(path: string): string {
  const base = path.split('/').pop() ?? path
  return base.split('.').pop()?.toLowerCase() ?? ''
}
