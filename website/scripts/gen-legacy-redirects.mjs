/**
 * Generate redirect stubs for legacy docs URLs.
 *
 * Layout history of https://zhimingye.github.io/filebox/ :
 *   1. /filebox/docs/<p>     Chinese (default)   /filebox/docs/en/<p>  English
 *   2. /filebox/<p>          Chinese (default)   /filebox/en/<p>       English
 *   3. /filebox/<p>          English (default)   /filebox/zh/<p>       Chinese   ← current
 *
 * For every page in the built site this writes tiny forwarding pages into the
 * gh-pages checkout (JS keeps ?query and #hash; meta refresh is the no-JS fallback):
 *   Chinese page zh/<p>  →  docs/<p>.html                    (layout 1 zh)
 *   English page <p>     →  docs/en/<p>.html and en/<p>.html  (layout 1 en, layout 2 en)
 * Layout-2 Chinese URLs (/filebox/<p>) now serve the English page directly.
 * GitHub Pages serves /docs/features/preview from docs/features/preview.html,
 * so cleanUrls-style legacy links keep working. Unknown legacy paths are
 * handled by the 404 fallback script in .vitepress/config.mts.
 *
 * Usage (from website/, after `npm run build`):
 *   node scripts/gen-legacy-redirects.mjs docs/.vitepress/dist ../path/to/gh-pages
 *   (writes <gh-pages>/docs/** and <gh-pages>/en/**)
 */
import { readdir, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

const [distDir, outDir] = process.argv.slice(2)
if (!distDir || !outDir) {
  console.error('usage: gen-legacy-redirects.mjs <distDir> <outDir>')
  process.exit(1)
}
const BASE = '/filebox/'
const ORIGIN = 'https://zhimingye.github.io'

async function walk(dir, rel = '') {
  const out = []
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const r = path.posix.join(rel, e.name)
    if (e.isDirectory()) {
      if (['assets', 'screenshots'].includes(r)) continue
      out.push(...(await walk(path.join(dir, e.name), r)))
    } else if (e.name.endsWith('.html') && r !== '404.html') {
      out.push(r)
    }
  }
  return out
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')

function stub(target, lang) {
  const abs = ORIGIN + target
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Moved · filebox docs</title>
<meta name="robots" content="noindex">
<link rel="canonical" href="${esc(abs)}">
<script>location.replace(${JSON.stringify(target)} + location.search + location.hash)</script>
<meta http-equiv="refresh" content="0; url=${esc(target)}">
<style>body{font:15px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;color:#334155;display:grid;place-items:center;min-height:100vh;margin:0}a{color:#4f46e5}</style>
</head>
<body>
<p>${lang.startsWith('zh') ? '页面已迁移到' : 'This page moved to'} <a href="${esc(target)}">${esc(abs)}</a></p>
</body>
</html>
`
}

const pages = await walk(distDir)
let count = 0
async function emit(stubRel, pageRel, lang) {
  let target = BASE + pageRel.replace(/\.html$/, '')
  if (target.endsWith('/index')) target = target.slice(0, -'index'.length)
  const dest = path.join(outDir, stubRel)
  await mkdir(path.dirname(dest), { recursive: true })
  await writeFile(dest, stub(target, lang))
  count++
}
for (const rel of pages) {
  if (rel.startsWith('zh/')) {
    await emit(path.posix.join('docs', rel.slice(3)), rel, 'zh-CN')
  } else {
    await emit(path.posix.join('docs', 'en', rel), rel, 'en')
    await emit(path.posix.join('en', rel), rel, 'en')
  }
}
console.log(`wrote ${count} redirect stubs under ${outDir}/{docs,en}`)
