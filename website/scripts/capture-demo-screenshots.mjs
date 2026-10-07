/**
 * Capture polished UI screenshots from the public Pages demo mock:
 *   https://zhimingye.github.io/filebox/
 *
 * Uses system Google Chrome + puppeteer-core (dev dependency optional).
 * Run from website/:  node scripts/capture-demo-screenshots.mjs
 *
 * These are demo/mock shots (same layout language as the real Hub UI).
 * For Login / Explorer / Settings / Audit, bring up Hub+Agent locally later.
 */
import { createRequire } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const outDir = path.resolve(__dirname, '../docs/public/screenshots')
const demoUrl = process.env.FILEBOX_DEMO_URL || 'https://zhimingye.github.io/filebox/'

// Resolve puppeteer-core from /tmp/shot-tools or local node_modules
function loadPuppeteer() {
  const require = createRequire(import.meta.url)
  const candidates = [
    '/tmp/shot-tools/node_modules/puppeteer-core',
    path.resolve(__dirname, '../node_modules/puppeteer-core'),
  ]
  for (const c of candidates) {
    try {
      return require(c)
    } catch {
      /* try next */
    }
  }
  throw new Error('puppeteer-core not found; npm i puppeteer-core in /tmp/shot-tools or website/')
}

const puppeteer = loadPuppeteer()

const shots = [
  {
    file: '00-sidebar-overview.png',
    view: 'files',
    clip: null, // full app-mock
    note: 'Default Files view with sidebar',
  },
  {
    file: '01-files-browse.png',
    view: 'files',
    note: 'Files browser',
  },
  {
    file: '02-search.png',
    view: 'search',
    note: 'Workspace Search mock panel',
  },
  {
    file: '03-collections.png',
    view: 'collections',
    note: 'Collections mock panel',
  },
  {
    file: '04-transfer.png',
    view: 'transfer',
    note: 'Temp Transfer mock panel',
  },
  {
    file: '05-terminal.png',
    view: 'terminal',
    note: 'Remote Terminal mock panel',
  },
  {
    file: '06-stats.png',
    view: 'stats',
    note: 'System Stats',
  },
  {
    file: '07-health.png',
    view: 'health',
    note: 'Hub Health',
  },
]

async function main() {
  await mkdir(outDir, { recursive: true })
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--window-size=1440,900'],
    defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 2 },
  })
  const page = await browser.newPage()
  page.setDefaultTimeout(60000)
  console.log('open', demoUrl)
  await page.goto(demoUrl, { waitUntil: 'networkidle2' })
  await page.waitForSelector('.app-mock')
  // Let mock data render
  await new Promise((r) => setTimeout(r, 800))

  // Full landing hero+mock optional wide shot
  const mock = await page.$('.app-mock')
  if (!mock) throw new Error('.app-mock not found')

  for (const shot of shots) {
    await page.evaluate((view) => {
      const btn = document.querySelector(`.nav-item[data-view="${view}"]`)
      if (btn) btn.click()
    }, shot.view)
    await new Promise((r) => setTimeout(r, 350))
    const handle = await page.$('.app-mock')
    const dest = path.join(outDir, shot.file)
    await handle.screenshot({ path: dest, type: 'png' })
    console.log('wrote', dest, '—', shot.note)
  }

  // Preview stream strip: open a png in files mock if possible
  await page.evaluate(() => {
    const btn = document.querySelector('.nav-item[data-view="files"]')
    if (btn) btn.click()
  })
  await new Promise((r) => setTimeout(r, 200))
  // Try clicking a .png row in the mock file list
  const clicked = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('.app-mock [class*="file"], .app-mock tr, .app-mock .row, .app-mock button, .app-mock a, .app-mock [role="row"]'))
    // Prefer any element whose text contains .png
    const all = Array.from(document.querySelectorAll('.app-mock *'))
    for (const el of all) {
      const t = (el.textContent || '').trim()
      if (/\.png\b/i.test(t) && t.length < 80 && el.children.length < 4) {
        el.click()
        return t
      }
    }
    return null
  })
  console.log('preview click target:', clicked)
  await new Promise((r) => setTimeout(r, 600))
  const handle2 = await page.$('.app-mock')
  const previewPath = path.join(outDir, '08-preview-stream.png')
  await handle2.screenshot({ path: previewPath, type: 'png' })
  console.log('wrote', previewPath)

  // Also capture a full-page marketing strip of the mock section
  const section = await page.$('.app-mock')
  await writeFile(path.join(outDir, 'SHOT_LIST.md'), `# Screenshot inventory

Generated from ${demoUrl}
Device scale factor 2, viewport 1440×900, crop = .app-mock

| File | View | Notes |
|------|------|-------|
${shots.map((s) => `| ${s.file} | ${s.view} | ${s.note} |`).join('\n')}
| 08-preview-stream.png | files (+open) | Preview / streaming affordance if mock allows |

Missing (need real Hub+Agent): login, explorer, settings/add-root, audit, search float window, office PDF tab, mobile drawer.
`)

  await browser.close()
  console.log('done →', outDir)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
