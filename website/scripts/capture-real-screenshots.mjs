/**
 * Capture screenshots from a locally hosted real Hub+Agent (not the Pages demo mock).
 * Prerequisites: Hub on http://localhost:3000, agent online, roots seeded.
 * Usage: node scripts/capture-real-screenshots.mjs
 * Requires puppeteer-core and Playwright (PUPPETEER_PATH / PLAYWRIGHT_PATH
 * may point to external installs). CHROME_PATH selects a local Chrome binary.
 * Then run scripts/capture-tabs.mjs: it re-captures 08d-preview-pdf.png cleanly and adds the
 * multi-tab shots + homepage hero.
 */
import { createRequire } from 'node:module'
import { mkdir, writeFile, unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { waitForLocalRtt } from './capture-rtt.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const outDir = path.resolve(__dirname, '../docs/public/screenshots')
const baseUrl = process.env.FILEBOX_URL || 'http://localhost:3000'

function loadPuppeteer() {
  const require = createRequire(import.meta.url)
  for (const c of [
    process.env.PUPPETEER_PATH,
    '/tmp/shot-tools/node_modules/puppeteer-core',
    path.resolve(__dirname, '../node_modules/puppeteer-core'),
  ]) {
    try { if (c) return require(c) } catch { /* next */ }
  }
  throw new Error('puppeteer-core not found')
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

async function shot(page, file, opts = {}) {
  const rtt = await waitForLocalRtt(page)
  await page.mouse.move(2, 880)
  await page.evaluate(() => document.activeElement?.blur?.())
  await sleep(250)
  const dest = path.join(outDir, file)
  await page.screenshot({ path: dest, type: 'png', fullPage: false, ...opts })
  console.log('saved', file, rtt === null ? '(sign-in)' : `(RTT ${rtt} ms)`)
  return dest
}

async function clickNav(page, label) {
  await page.evaluate((lab) => {
    const buttons = [...document.querySelectorAll('button')]
    const btn = buttons.find((b) => b.getAttribute('title') === lab) || buttons.find((b) => b.textContent?.trim() === lab)
    if (!btn) throw new Error('nav not found: ' + lab)
    btn.click()
  }, label)
  await sleep(600)
}

async function waitReady(page) {
  await page.waitForFunction(() => {
    return !!document.body && document.body.innerText.length > 20
  }, { timeout: 30000 })
}

async function login(page) {
  await page.goto(baseUrl + '/', { waitUntil: 'networkidle2' })
  await page.waitForSelector('#fb-username', { timeout: 30000 })
  // Capture login while PoW may still be solving
  await sleep(400)
  await shot(page, '09-login.png')

  // Wait for Ready
  await page.waitForFunction(() => {
    return [...document.querySelectorAll('button, span, div')].some((el) => el.textContent?.trim() === 'Ready')
  }, { timeout: 60000 })
  await shot(page, '09b-login-pow-ready.png')

  await page.click('#fb-username', { clickCount: 3 })
  await page.type('#fb-username', 'admin', { delay: 20 })
  const pass = await page.$('input[type="password"]')
  await pass.click({ clickCount: 3 })
  await pass.type('dev-password', { delay: 20 })
  await shot(page, '09c-login-filled.png')

  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => b.textContent?.includes('Continue'))
    if (!btn) throw new Error('Continue not found')
    btn.click()
  })
  await page.waitForFunction(() => !document.querySelector('#fb-username'), { timeout: 30000 })
  await sleep(1500)
}

async function openFolder(page, name) {
  await page.evaluate((n) => {
    const el = [...document.querySelectorAll('span[title]')].find((e) =>
      e.textContent?.trim() === n && e.getAttribute('title')?.startsWith('/tmp/fbx_demo'))
    if (!el) throw new Error('entry not found: ' + n)
    el.click()
  }, name)
  await sleep(900)
}

async function closePreviews(page) {
  while (await page.$('button[title="Close (Esc)"]')) {
    await page.click('button[title="Close (Esc)"]')
    await sleep(150)
  }
}

async function captureAiAgents(browser, page) {
  const require = createRequire(import.meta.url)
  const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright')
  const client = await chromium.connectOverCDP(browser.wsEndpoint())
  const aiPage = client.contexts()[0].pages().find((p) => p.url() === page.url())
  // Dev mode has no review provider. Change only the displayed review state,
  // never send a prompt or bypass the live Hub's actual review policy.
  await aiPage.route('**/api/agents/*/ai-agents', async (route) => {
    const response = await route.fetch()
    const body = await response.json()
    if (route.request().postDataJSON()?.op === 'status') {
      body.prompt_review = { state: 'on', model: 'deepseek-flash' }
    }
    await route.fulfill({ response, json: body })
  })
  await aiPage.locator('button[title="AI Agents"]').click()
  await aiPage.getByRole('button', { name: 'assay-analysis', exact: false }).first().click()
  await aiPage.getByLabel('Output from assay-analysis', { exact: true }).waitFor()
  await aiPage.getByText('Reviewed by deepseek-flash', { exact: true }).waitFor()
  await aiPage.getByLabel('Prompt for assay-analysis', { exact: true }).fill('Summarize the borderline batches and suggest a repeat-measurement plan.')
  await sleep(1200)
  await shot(page, '15-ai-agents.png')
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 })
  const closeMenu = aiPage.getByRole('button', { name: 'Close menu', exact: true })
  if (await closeMenu.isVisible()) await closeMenu.click()
  await aiPage.getByRole('dialog', { name: 'Navigation', exact: true }).waitFor({ state: 'hidden' })
  await sleep(1200)
  await shot(page, '15c-ai-agents-mobile.png')
  await aiPage.unroute('**/api/agents/*/ai-agents')
  await client.close()
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 })
}

async function main() {
  await mkdir(outDir, { recursive: true })
  // Remove known mock shots first
  for (const f of [
    '00-sidebar-overview.png','01-files-browse.png','02-search.png','03-collections.png',
    '04-transfer.png','06-stats.png','07-health.png','08-preview-stream.png',
  ]) {
    const p = path.join(outDir, f)
    if (existsSync(p)) await unlink(p).catch(() => {})
  }

  const puppeteer = loadPuppeteer()
  const browser = process.env.CDP_URL ? await puppeteer.connect({ browserURL: process.env.CDP_URL,
    defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 2 } }) : await puppeteer.launch({
    executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--window-size=1440,900', '--disable-dev-shm-usage'],
    defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 2 },
  })
  const page = await browser.newPage()
  page.setDefaultTimeout(60000)

  // --- Login ---
  await login(page)
  await waitReady(page)
  await sleep(1000)

  // Select agent (required before Workspace nav appears)
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find((b) =>
      (b.textContent || '').includes('lab-server') || (b.getAttribute('title') || '').startsWith('lab-server'))
    if (!btn) throw new Error('agent button not found')
    btn.click()
  })
  await sleep(1200)
  // Wait until Files nav exists
  await page.waitForFunction(() =>
    [...document.querySelectorAll('button')].some((b) => b.getAttribute('title') === 'Files'),
    { timeout: 20000 },
  )

  // Sidebar overview / Files root
  await clickNav(page, 'Files')
  await page.click('span[title="Go to root"]')
  await sleep(800)
  await shot(page, '00-sidebar-overview.png')
  await shot(page, '01-files-browse.png')

  // Enter figures and preview image
  try {
    await openFolder(page, 'figures')
    await sleep(700)
    await shot(page, '01b-files-figures.png')
    await openFolder(page, 'plot.png')
    await sleep(1200)
    await shot(page, '08-preview-image.png')
  } catch (e) {
    console.warn('image preview failed', e.message)
  }

  // Navigate to notes for text/markdown preview
  await clickNav(page, 'Files')
  await sleep(400)
  try {
    await closePreviews(page)
    // go to root via breadcrumb or address - click demo root listing again
    await page.click('span[title="Go to root"]')
    await sleep(600)
    await openFolder(page, 'notes')
    await sleep(500)
    await openFolder(page, 'lab-log.md')
    await sleep(1000)
    await shot(page, '08b-preview-markdown.png')
  } catch (e) {
    console.warn('md preview failed', e.message)
  }

  // Code preview
  try {
    await closePreviews(page)
    await page.click('span[title="Go to root"]')
    await sleep(500)
    await openFolder(page, 'code')
    await sleep(500)
    await openFolder(page, 'hello.py')
    await sleep(1200)
    await shot(page, '08c-preview-code.png')
  } catch (e) {
    console.warn('code preview failed', e.message)
  }

  // PDF preview
  try {
    await closePreviews(page)
    await page.click('span[title="Go to root"]')
    await sleep(500)
    await openFolder(page, 'reports')
    await sleep(600)
    await shot(page, '01c-files-reports.png')
    await openFolder(page, 'demo-report.pdf')
    await sleep(1500)
    await shot(page, '08d-preview-pdf.png')
  } catch (e) {
    console.warn('pdf preview failed', e.message)
  }

  // CSV
  try {
    await closePreviews(page)
    await page.click('span[title="Go to root"]')
    await sleep(500)
    await openFolder(page, 'datasets')
    await sleep(500)
    await openFolder(page, 'metrics.csv')
    await sleep(1000)
    await shot(page, '08e-preview-csv.png')
  } catch (e) {
    console.warn('csv preview failed', e.message)
  }

  // Keep a generic preview-stream name pointing at a rich preview for old refs
  // by copying image preview if present
  try {
    const { copyFile } = await import('node:fs/promises')
    const src = path.join(outDir, '08-preview-image.png')
    if (existsSync(src)) await copyFile(src, path.join(outDir, '08-preview-stream.png'))
  } catch { /* ignore */ }

  // Explorer
  await closePreviews(page)
  await clickNav(page, 'Explorer')
  await sleep(1200)
  await shot(page, '10-explorer.png')
  // try expand tree
  try {
    await page.evaluate(() => {
      const t = [...document.querySelectorAll('*')].find((e) => e.textContent?.trim() === 'demo' && e.children.length < 3)
      if (t) t.click()
    })
    await sleep(800)
    await shot(page, '10b-explorer-expanded.png')
  } catch (e) {
    console.warn('explorer expand', e.message)
  }

  // Search float
  await clickNav(page, 'Search')
  await sleep(800)
  await shot(page, '02-search.png')
  try {
    await page.waitForSelector('[role="dialog"] [aria-label="Filename contains"], [role="dialog"] [aria-label="Content regex pattern"]', { timeout: 5000 })
    const input = await page.$('[role="dialog"] [aria-label="Filename contains"], [role="dialog"] [aria-label="Content regex pattern"]')
    if (input) {
      await input.click({ clickCount: 3 })
      await input.type('REWIND', { delay: 30 })
      await page.evaluate(() => {
        const btn = [...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent?.trim() === 'Search')
        btn?.click()
      })
      await sleep(2000)
      await shot(page, '02b-search-results.png')
    }
    // Content mode
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Content')
      btn?.click()
    })
    await sleep(400)
    const cinput = await page.$('[role="dialog"] [aria-label="Content regex pattern"]')
    if (cinput) {
      await cinput.click({ clickCount: 3 })
      await page.keyboard.down('Control')
      await page.keyboard.press('a')
      await page.keyboard.up('Control')
      await cinput.type('TODO|FIXME', { delay: 20 })
      await page.evaluate(() => {
        const btn = [...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent?.trim() === 'Search')
        btn?.click()
      })
      await sleep(2500)
      await shot(page, '02c-search-content.png')
    }
  } catch (e) {
    console.warn('search interact', e.message)
  }
  // close search
  await page.click('[role="dialog"] button[aria-label="Close search"]')
  await sleep(400)

  // Collections
  await clickNav(page, 'Collections')
  await sleep(1000)
  await shot(page, '03-collections.png')
  try {
    await page.evaluate(() => {
      const el = [...document.querySelectorAll('*')].find((e) => e.textContent?.trim() === 'watchlist' && e.children.length < 4)
      el?.click()
    })
    await sleep(1000)
    await shot(page, '03b-collections-watchlist.png')
  } catch (e) {
    console.warn('collections select', e.message)
  }

  // Transfer
  await clickNav(page, 'Transfer')
  await sleep(1000)
  await shot(page, '04-transfer.png')
  await page.waitForSelector('input[type="file"]')
  const upload = await page.$('input[type="file"]')
  await upload.uploadFile('/tmp/fbx_demo/notes/plain.txt')
  await page.waitForFunction(() => document.body.innerText.includes('plain.txt'))
  await sleep(1500)
  await shot(page, '04b-transfer-uploaded.png')

  // Stats
  await clickNav(page, 'System')
  await sleep(1500)
  await shot(page, '06-stats.png')

  // Settings
  await clickNav(page, 'Settings')
  await sleep(1000)
  await shot(page, '11-settings.png')
  await page.evaluate(() => [...document.querySelectorAll('h3')].find((e) => e.textContent === 'Coding agents')?.scrollIntoView({ block: 'center' }))
  await sleep(400)
  await shot(page, '15b-ai-agents-settings.png')
  // scroll to Add root
  await page.evaluate(() => {
    const t = [...document.querySelectorAll('h4,h3')].find((e) => e.textContent?.includes('Add root'))
    t?.scrollIntoView({ block: 'center' })
  })
  await sleep(400)
  await shot(page, '11b-settings-add-root.png')

  // Audit
  await clickNav(page, 'Audit')
  await sleep(1000)
  await shot(page, '12-audit.png')

  // Health via About (version click)
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find((b) =>
      /v\d+\.\d+/.test(b.textContent || '') || (b.getAttribute('title') || '').startsWith('About'))
    btn?.click()
  })
  await sleep(800)
  await shot(page, '07-health.png')
  await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent === 'Open source licenses').click())
  await page.waitForSelector('[aria-label="Filter licenses"]')
  await page.waitForFunction(() => [...document.querySelectorAll('button[aria-expanded="false"]')].some((b) => b.textContent?.includes('filebox')))
  await page.evaluate(() => [...document.querySelectorAll('button[aria-expanded="false"]')].find((b) => b.textContent?.includes('filebox')).click())
  await sleep(600)
  await shot(page, '07b-about-licenses.png')
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Done' || b.getAttribute('aria-label') === 'Close')
    btn?.click()
  })
  await sleep(300)

  // Mobile / narrow
  await clickNav(page, 'Files')
  await closePreviews(page)
  await page.click('span[title="Go to root"]')
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 })
  await sleep(800)
  await page.evaluate(() => document.querySelector('button[aria-label="Close menu"]')?.click())
  await sleep(400)
  await shot(page, '13-mobile-files.png')
  // open drawer
  try {
    await page.click('button[aria-label="Open menu"]')
    await sleep(700)
    await shot(page, '13b-mobile-drawer.png')
    await page.click('button[aria-label="Close menu"]')
  } catch (e) {
    console.warn('mobile drawer', e.message)
  }

  // Office preview if possible (desktop again)
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 })
  await sleep(500)
  await page.evaluate(() => document.querySelector('button[aria-label="Close menu"]')?.click())
  await clickNav(page, 'Files')
  await sleep(600)
  try {
    await page.click('span[title="Go to root"]')
    await sleep(500)
    await openFolder(page, 'reports')
    await sleep(600)
    await openFolder(page, 'complex-e2e.pptx')
    await sleep(8000) // conversion can take a bit
    await shot(page, '08f-preview-office.png')
  } catch (e) {
    console.warn('office preview', e.message)
  }

  for (const [folder, name, file] of [
    ['notes', 'qc-methods.qmd', '08g-preview-quarto.png'],
    ['notes', 'qc-recovery.ipynb', '08h-preview-ipynb.png'],
    ['reports', 'quarto-user.html', '08i-preview-html.png'],
    ['notes', 'recovery-math.md', '08j-preview-math.png'],
  ]) {
    await closePreviews(page)
    await page.click('span[title="Go to root"]')
    await sleep(500)
    await openFolder(page, folder)
    await openFolder(page, name)
    await sleep(2000)
    if (name.endsWith('.md')) await page.waitForSelector('.katex-display')
    await shot(page, file)
  }
  await captureAiAgents(browser, page)

  // Manifest
  const { readdir, stat } = await import('node:fs/promises')
  const files = (await readdir(outDir)).filter((f) => f.endsWith('.png') || f.endsWith('.webp')).sort()
  const lines = ['# Real Hub+Agent screenshots / 真实 Hub + Agent 截图', '',
    `Source / 来源: ${baseUrl} (v3.1.5, FILEBOX_DEV_MODE local).`,
    'AI Agents uses synthetic Herdr CLI output; shots 15/15c override only the displayed review state to on / deepseek-flash. / AI Agents 使用合成 CLI 输出；15/15c 仅覆盖显示的审核状态。',
    '', '| File / 文件 | Bytes / 字节 |', '|------|------|']
  for (const f of files) {
    const st = await stat(path.join(outDir, f))
    lines.push(`| ${f} | ${st.size} |`)
  }
  // Outside docs/public so VitePress doesn't publish/search-index it as a page.
  await writeFile(path.resolve(__dirname, '../SCREENSHOT_MANIFEST.md'), lines.join('\n') + '\n')
  console.log('done', files.length, 'assets')
  if (process.env.CDP_URL) await browser.disconnect()
  else await browser.close()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
