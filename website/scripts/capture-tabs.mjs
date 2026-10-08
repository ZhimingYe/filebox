/**
 * Capture multi-tab preview screenshots (and the docs homepage hero) from a
 * locally hosted real Hub+Agent.
 *
 * Prerequisites (same as capture-real-screenshots.mjs):
 *   - Hub on http://localhost:3000 with FILEBOX_DEV_MODE=1 (admin / dev-password)
 *   - Agent "lab-server" online with root "demo" -> /tmp/fbx_demo, soffice configured
 *   - /tmp/pdfvenv/bin/python scripts/gen-demo-report-pdf.py   (PDF + figures/*.png)
 *   - python3 scripts/gen-demo-extras.py                       (code / csv / markdown)
 *
 * Usage (from website/):  node scripts/capture-tabs.mjs
 *
 * Output (docs/public/screenshots/):
 *   08d-preview-pdf.png          single PDF preview (1440x900 @2x)
 *   14-tabs-pdf.png              6 tabs (figure pinned), active = PDF on the heatmap + QC table page (hero source)
 *   14b-tabs-code.png            same tabs, active = Python script (Monaco)
 *   14c-tabs-image.png           same tabs, active = figure PNG
 *   14d-tabs-context-menu.png    right-click tab menu (Pin / Close / left / right / all) over CSV tab
 *   14e-tabs-picker.png          "Open previews" jump list (pinned tab marked with a pin)
 *   hero-tabs-pdf-{1600,2400}.webp        homepage hero, desktop (from 14-tabs-pdf.png)
 *   hero-tabs-pdf-mobile-{800,1200}.webp  homepage hero, mobile art direction (preview-pane crop)
 *   (WebP conversion needs python3 + Pillow.)
 * Tab shots use a 1600x1000 viewport @2x so six tabs fit without scrolling.
 */
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const outDir = path.resolve(__dirname, '../docs/public/screenshots')
const baseUrl = process.env.FILEBOX_URL || 'http://localhost:3000'
const DPR = 2
const DIVIDER_X = Number(process.env.HERO_DIVIDER_X || 600)

function loadPuppeteer() {
  const require = createRequire(import.meta.url)
  for (const c of [
    '/tmp/shot-tools/node_modules/puppeteer-core',
    path.resolve(__dirname, '../node_modules/puppeteer-core'),
  ]) {
    try { return require(c) } catch { /* next */ }
  }
  throw new Error('puppeteer-core not found')
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// hero-* PNGs are intermediates (converted to responsive WebP at the end).
const out = (f) => (f.startsWith('hero-') ? path.join(os.tmpdir(), f) : path.join(outDir, f))

async function shot(page, file, opts = {}) {
  await page.mouse.move(2, (page.viewport()?.height || 900) - 2) // park pointer (no hover chrome)
  await page.evaluate(() => document.activeElement?.blur?.()) // no focus rings
  await sleep(250)
  await page.screenshot({ path: out(file), type: 'png', ...opts })
  console.log('saved', file)
}

/** Click a file-list entry by exact name (never a tab chip with the same title). */
async function openEntry(page, name, wait = 1100) {
  await page.evaluate((n) => {
    const el = [...document.querySelectorAll('*')].find((e) =>
      e.children.length <= 3 && e.textContent?.trim() === n && !e.closest('[role="tablist"]') && !e.closest('[role="listbox"]'))
    if (!el) throw new Error('entry not found: ' + n)
    el.click()
  }, name)
  await sleep(wait)
}

async function activateTab(page, title, wait = 1500) {
  await page.evaluate((t) => {
    const tab = [...document.querySelectorAll('[role="tab"]')].find((e) => e.textContent?.trim().startsWith(t))
    if (!tab) throw new Error('tab not found: ' + t)
    tab.click()
  }, title)
  await sleep(wait)
}

async function tabCenter(page, title) {
  return page.evaluate((t) => {
    const tab = [...document.querySelectorAll('[role="tab"]')].find((e) => e.textContent?.trim().startsWith(t))
    const r = tab.getBoundingClientRect()
    return { x: r.x + r.width * 0.35, y: r.y + r.height / 2 }
  }, title)
}

async function dragDivider(page, toX, y) {
  const from = await page.evaluate((yy) => {
    for (let x = 300; x < window.innerWidth - 100; x++) {
      const e = document.elementFromPoint(x, yy)
      if (e && getComputedStyle(e).cursor === 'col-resize') return x + 1
    }
    return null
  }, y)
  if (!from) { console.warn('divider not found'); return }
  await page.mouse.move(from, y)
  await page.mouse.down()
  await page.mouse.move((from + toX) / 2, y, { steps: 8 })
  await page.mouse.move(toX, y, { steps: 8 })
  await page.mouse.up()
  await sleep(2500)
}

/** Scroll the active PDF viewer so page `pageNo` (1-based) is framed `frac` into the page. */
async function scrollPdf(page, pageNo, frac) {
  await page.waitForFunction((n) => {
    const vis = [...document.querySelectorAll('canvas.react-pdf__Page__canvas')].filter((c) => c.offsetParent && getComputedStyle(c).visibility !== 'hidden')
    return vis.length >= Math.min(n, 3)
  }, { timeout: 30000 }, pageNo)
  const pane = await page.evaluate((n, f) => {
    const canvases = [...document.querySelectorAll('canvas.react-pdf__Page__canvas')]
      .filter((c) => getComputedStyle(c).visibility !== 'hidden' && c.getBoundingClientRect().width > 0)
    let sc = canvases[0].parentElement
    while (sc && !(sc.scrollHeight > sc.clientHeight + 10 && /auto|scroll/.test(getComputedStyle(sc).overflowY))) sc = sc.parentElement
    const first = canvases[0].getBoundingClientRect()
    const gap = canvases[1] ? canvases[1].getBoundingClientRect().top - first.top : first.height + 12
    const sr = sc.getBoundingClientRect()
    sc.scrollTop += (first.top - sr.top) + gap * (n - 1) + first.height * f
    return { x: sr.x, y: sr.y, w: sr.width, h: sr.height, canvasW: first.width, canvasX: first.x }
  }, pageNo, frac)
  await sleep(2500) // virtualized pages render after scroll
  return pane
}

async function login(page) {
  await page.goto(baseUrl + '/', { waitUntil: 'networkidle2' })
  await page.waitForSelector('#fb-username')
  await page.waitForFunction(
    () => [...document.querySelectorAll('button, span, div')].some((el) => el.textContent?.trim() === 'Ready'),
    { timeout: 90000 },
  )
  await page.type('#fb-username', 'admin')
  await page.type('input[type="password"]', 'dev-password')
  await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent?.includes('Continue')).click())
  await page.waitForFunction(() => !document.querySelector('#fb-username'), { timeout: 30000 })
  await sleep(1500)
  await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => (b.textContent || '').includes('lab-server')).click())
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => b.getAttribute('title') === 'Files'))
  await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.getAttribute('title') === 'Files').click())
  await sleep(1200)
}

async function main() {
  const puppeteer = loadPuppeteer()
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--hide-scrollbars'],
    defaultViewport: { width: 1440, height: 900, deviceScaleFactor: DPR },
  })
  const page = await browser.newPage()
  page.setDefaultTimeout(60000)
  await login(page)

  // ── Single PDF preview (docs: features/preview) ──
  await openEntry(page, 'reports')
  await openEntry(page, 'demo-report.pdf', 2500)
  await scrollPdf(page, 2, 0.55) // Table 1 at the bottom of page 2 → Figure 1 on page 3
  await shot(page, '08d-preview-pdf.png')

  // ── Multi-tab session (wider viewport so six tabs fit) ──
  await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: DPR })
  await sleep(1200)
  await openEntry(page, '..')
  await openEntry(page, 'figures'); await openEntry(page, 'growth-kinetics.png', 1500); await openEntry(page, '..')
  await openEntry(page, 'code'); await openEntry(page, 'qc_pipeline.py', 2000); await openEntry(page, '..')
  await openEntry(page, 'datasets'); await openEntry(page, 'qc_runs.csv', 1500); await openEntry(page, '..')
  await openEntry(page, 'notes'); await openEntry(page, 'run-log.md', 1500); await openEntry(page, '..')
  await openEntry(page, 'reports'); await openEntry(page, 'complex-e2e.pptx', 1500)
  // Office → PDF conversion runs on the Agent; give it time.
  await page.waitForFunction(() => document.querySelectorAll('canvas.react-pdf__Page__canvas').length > 0, { timeout: 90000 }).catch(() => console.warn('pptx preview not ready'))
  await sleep(1500)

  await dragDivider(page, DIVIDER_X, 500)
  const strip = await page.evaluate(() => {
    const s = document.querySelector('[role="tablist"]')
    return { scrollWidth: s.scrollWidth, clientWidth: s.clientWidth }
  })
  console.log('tab strip', strip, strip.scrollWidth > strip.clientWidth ? '(overflows)' : '(fits)')

  // Pin the figure tab (pin icon turns accent-filled); the PDF stays unpinned.
  await page.evaluate(() => document.querySelector('button[aria-label="Pin growth-kinetics.png"]')?.click())
  await sleep(600)
  // Activate the PDF tab, then frame the heatmap + QC table page.
  await activateTab(page, 'demo-report.pdf', 2500)
  await scrollPdf(page, 4, 0.035)
  await shot(page, '14-tabs-pdf.png')

  // Switch tabs: code + image.
  await activateTab(page, 'qc_pipeline.py', 2500)
  await shot(page, '14b-tabs-code.png')
  await activateTab(page, 'growth-kinetics.png', 2000)
  await shot(page, '14c-tabs-image.png')

  // Right-click tab menu over the CSV tab.
  await activateTab(page, 'qc_runs.csv', 2000)
  const c = await tabCenter(page, 'qc_runs.csv')
  await page.mouse.click(c.x, c.y, { button: 'right' })
  await sleep(500)
  await page.screenshot({ path: out('14d-tabs-context-menu.png'), type: 'png' })
  console.log('saved 14d-tabs-context-menu.png')
  await page.keyboard.press('Escape')
  await sleep(400)

  // Back to the PDF (unpinned → remounts at page 1; re-frame it), then open the jump list.
  await activateTab(page, 'demo-report.pdf', 2500)
  await scrollPdf(page, 4, 0.035)
  await page.evaluate(() => document.querySelector('button[aria-haspopup="listbox"][title="Jump to open preview"]')?.click())
  await sleep(600)
  await page.screenshot({ path: out('14e-tabs-picker.png'), type: 'png' })
  console.log('saved 14e-tabs-picker.png')
  await page.keyboard.press('Escape')
  await sleep(400)

  // ── Mobile hero (art direction) ──
  // A phone can't show the desktop tab strip at a legible size, so frame a
  // narrower desktop window (sidebar collapsed, list at its 20 % minimum) and
  // crop just the preview pane: tab strip + header + PDF page.
  await page.setViewport({ width: 1040, height: 1100, deviceScaleFactor: DPR })
  await sleep(1500)
  await page.evaluate(() => document.querySelector('button[aria-label="Collapse sidebar"]')?.click())
  await sleep(1200)
  await dragDivider(page, 120, 600)
  await activateTab(page, 'demo-report.pdf', 1500)
  const pane = await scrollPdf(page, 4, 0.03)
  const tabsTop = await page.evaluate(() => document.querySelector('[role="tablist"]').getBoundingClientRect().top)
  const vp = page.viewport()
  const clipW = Math.min(pane.w, vp.width - pane.x)
  const clipH = Math.min(Math.round(clipW * 1.04), vp.height - tabsTop)
  await shot(page, 'hero-tabs-pdf-mobile.png', {
    clip: { x: pane.x, y: tabsTop, width: clipW, height: clipH },
    captureBeyondViewport: false,
  })

  await browser.close()

  // Responsive WebP variants for the homepage hero (<picture> in HeroShot.vue).
  const py = `
import sys
from PIL import Image
src_desktop, src_mobile, out = sys.argv[1:4]
for src, base, widths in [(src_desktop, 'hero-tabs-pdf', (1600, 2400)), (src_mobile, 'hero-tabs-pdf-mobile', (800, 1200))]:
    im = Image.open(src).convert('RGB')
    for w in widths:
        r = im.resize((w, round(im.height * w / im.width)), Image.LANCZOS)
        r.save(f'{out}/{base}-{w}.webp', 'WEBP', quality=86, method=6)
        print('saved', f'{base}-{w}.webp', r.size)
`
  const tmpDesktop = path.join(os.tmpdir(), 'hero-tabs-pdf.png')
  await import('node:fs/promises').then((fs) => fs.copyFile(path.join(outDir, '14-tabs-pdf.png'), tmpDesktop))
  console.log(execFileSync(process.env.PYTHON || 'python3', ['-c', py, tmpDesktop, out('hero-tabs-pdf-mobile.png'), outDir]).toString().trim())
}

main().catch((e) => { console.error(e); process.exit(1) })
