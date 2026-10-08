/**
 * GitHub Pages serves VitePress cleanUrls as:
 *   /filebox/features/terminal      → features/terminal.html   (200)
 *   /filebox/features/terminal/     → features/terminal/       (404)
 *   /filebox/features/              → features/                (404)
 *
 * After `vitepress build` (and after gen-legacy-redirects), run this on the
 * published tree to emit redirect stubs:
 *   features/terminal/index.html  → /filebox/features/terminal
 *   features/index.html           → /filebox/features/browse
 * so every trailing-slash and section-index URL recovers without a 404 flash
 * that depends solely on the site-wide 404.html fallback.
 *
 * Usage (from website/):
 *   node scripts/fix-clean-url-slashes.mjs <siteRoot>
 *   e.g. node scripts/fix-clean-url-slashes.mjs docs/.vitepress/dist
 *        node scripts/fix-clean-url-slashes.mjs ../filebox   # gh-pages checkout
 */
import { readdir, mkdir, writeFile, access } from 'node:fs/promises'
import path from 'node:path'

const siteRoot = process.argv[2]
if (!siteRoot) {
  console.error('usage: fix-clean-url-slashes.mjs <siteRoot>')
  process.exit(1)
}

const BASE = '/filebox'
const ORIGIN = 'https://zhimingye.github.io'

/** Section directories without an index.md → land on the sidebar's first page. */
const SECTION_INDEX = {
  guide: 'guide/introduction',
  features: 'features/browse',
  ops: 'ops/hub',
  'zh/guide': 'zh/guide/introduction',
  'zh/features': 'zh/features/browse',
  'zh/ops': 'zh/ops/hub',
  // Legacy layout mirrors (stubs live under docs/ and en/)
  'docs/guide': 'zh/guide/introduction',
  'docs/features': 'zh/features/browse',
  'docs/ops': 'zh/ops/hub',
  'docs/en/guide': 'guide/introduction',
  'docs/en/features': 'features/browse',
  'docs/en/ops': 'ops/hub',
  'en/guide': 'guide/introduction',
  'en/features': 'features/browse',
  'en/ops': 'ops/hub',
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')

function stub(targetPath) {
  // targetPath like /filebox/features/terminal (no trailing slash, except locale roots)
  const abs = ORIGIN + targetPath
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Redirect · filebox docs</title>
<meta name="robots" content="noindex">
<link rel="canonical" href="${esc(abs)}">
<script>location.replace(${JSON.stringify(targetPath)} + location.search + location.hash)</script>
<meta http-equiv="refresh" content="0; url=${esc(targetPath)}">
<style>body{font:15px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;color:#334155;display:grid;place-items:center;min-height:100vh;margin:0}a{color:#4f46e5}</style>
</head>
<body>
<p>Redirecting to <a href="${esc(targetPath)}">${esc(abs)}</a></p>
</body>
</html>
`
}

async function exists(p) {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

async function walkHtml(dir, rel = '') {
  const out = []
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const r = path.posix.join(rel, e.name)
    if (e.isDirectory()) {
      if (['assets', 'screenshots'].includes(e.name)) continue
      out.push(...(await walkHtml(path.join(dir, e.name), r)))
    } else if (e.name.endsWith('.html')) {
      out.push(r)
    }
  }
  return out
}

const pages = await walkHtml(siteRoot)
let pageStubs = 0
let sectionStubs = 0

for (const rel of pages) {
  if (rel === '404.html') continue
  if (rel === 'index.html' || rel.endsWith('/index.html')) continue
  // features/terminal.html → features/terminal/index.html → /filebox/features/terminal
  const noExt = rel.replace(/\.html$/, '')
  const destDir = path.join(siteRoot, noExt)
  const dest = path.join(destDir, 'index.html')
  if (await exists(dest)) continue
  const target = `${BASE}/${noExt}`.replace(/\/+/g, '/')
  await mkdir(destDir, { recursive: true })
  await writeFile(dest, stub(target))
  pageStubs++
}

for (const [section, destPage] of Object.entries(SECTION_INDEX)) {
  const dir = path.join(siteRoot, section)
  if (!(await exists(dir))) continue
  const dest = path.join(dir, 'index.html')
  if (await exists(dest)) continue
  const target = `${BASE}/${destPage}`.replace(/\/+/g, '/')
  await writeFile(dest, stub(target))
  sectionStubs++
}

console.log(
  `wrote ${pageStubs} trailing-slash stubs + ${sectionStubs} section index stubs under ${siteRoot}`,
)
