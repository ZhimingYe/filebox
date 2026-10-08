/**
 * Generate redirect stubs for the old docs location (/filebox/docs/...).
 *
 * The docs used to be published under https://zhimingye.github.io/filebox/docs/
 * and are now the site root. For every page in the built site this writes
 * <outDir>/<same relative path>.html, a tiny page that forwards to the new URL
 * (JS keeps ?query and #hash; meta refresh is the no-JS fallback).
 * GitHub Pages serves /docs/features/preview from docs/features/preview.html,
 * so cleanUrls-style legacy links keep working.
 *
 * Usage (from website/, after `npm run build`):
 *   node scripts/gen-legacy-redirects.mjs docs/.vitepress/dist ../path/to/gh-pages/docs
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
<p>${lang.startsWith('zh') ? '文档已迁移到' : 'The docs moved to'} <a href="${esc(target)}">${esc(abs)}</a></p>
</body>
</html>
`
}

const pages = await walk(distDir)
for (const rel of pages) {
  let target = BASE + rel.replace(/\.html$/, '')
  if (target.endsWith('/index')) target = target.slice(0, -'index'.length)
  const lang = rel.startsWith('en/') ? 'en' : 'zh-CN'
  const dest = path.join(outDir, rel)
  await mkdir(path.dirname(dest), { recursive: true })
  await writeFile(dest, stub(target, lang))
}
console.log(`wrote ${pages.length} redirect stubs to ${outDir}`)
