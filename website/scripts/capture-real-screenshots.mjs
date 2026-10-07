/**
 * Capture screenshots from a locally hosted real Hub+Agent (not the Pages demo mock).
 * Prerequisites: Hub on http://localhost:3000, agent online, roots seeded.
 * Usage: node scripts/capture-real-screenshots.mjs
 */
import { createRequire } from 'node:module'
import { mkdir, writeFile, unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHmac, createHash } from 'node:crypto'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const outDir = path.resolve(__dirname, '../docs/public/screenshots')
const baseUrl = process.env.FILEBOX_URL || 'http://localhost:3000'
const totpSecret = (process.env.FILEBOX_TOTP_SECRET || '').trim()

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

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

function base32Decode(s) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits = ''
  const clean = s.replace(/=+$/, '').toUpperCase()
  for (const ch of clean) {
    const val = alphabet.indexOf(ch)
    if (val < 0) continue
    bits += val.toString(2).padStart(5, '0')
  }
  const bytes = []
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2))
  }
  return Buffer.from(bytes)
}

function totp(secret, step = 30) {
  const key = base32Decode(secret)
  const counter = Math.floor(Date.now() / 1000 / step)
  const buf = Buffer.alloc(8)
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0)
  buf.writeUInt32BE(counter & 0xffffffff, 4)
  const h = createHmac('sha1', key).update(buf).digest()
  const o = h[h.length - 1] & 0xf
  const code = ((h[o] & 0x7f) << 24 | h[o + 1] << 16 | h[o + 2] << 8 | h[o + 3]) % 1_000_000
  return String(code).padStart(6, '0')
}

async function shot(page, file, opts = {}) {
  const dest = path.join(outDir, file)
  await page.screenshot({ path: dest, type: 'png', fullPage: false, ...opts })
  console.log('saved', file)
  return dest
}

async function clickNav(page, label) {
  await page.evaluate((lab) => {
    const buttons = [...document.querySelectorAll('button')]
    const btn = buttons.find((b) => (b.getAttribute('title') === lab) || b.textContent?.trim() === lab)
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
    const rows = [...document.querySelectorAll('[role="row"], button, div, span, a')]
    // Prefer exact name text nodes that look like file rows
    const el = [...document.querySelectorAll('*')].find((e) => {
      if (e.children.length > 3) return false
      const t = e.textContent?.trim()
      return t === n
    })
    if (!el) throw new Error('entry not found: ' + n)
    el.click()
  }, name)
  await sleep(900)
}

async function main() {
  await mkdir(outDir, { recursive: true })
  // Remove known mock shots first
  for (const f of [
    '00-sidebar-overview.png','01-files-browse.png','02-search.png','03-collections.png',
    '04-transfer.png','05-terminal.png','06-stats.png','07-health.png','08-preview-stream.png',
  ]) {
    const p = path.join(outDir, f)
    if (existsSync(p)) await unlink(p).catch(() => {})
  }

  const puppeteer = loadPuppeteer()
  const browser = await puppeteer.launch({
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
    // go to root via breadcrumb or address - click demo root listing again
    await page.evaluate(() => {
      // Click first breadcrumb-ish or navigate by clicking parent
      const crumbs = [...document.querySelectorAll('button, a, span')].filter((e) => e.textContent?.trim() === 'demo' || e.textContent?.trim() === '/')
      if (crumbs[0]) crumbs[0].click()
    })
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
    await page.evaluate(() => {
      const crumbs = [...document.querySelectorAll('button, a, span')].filter((e) => e.textContent?.trim() === 'demo')
      if (crumbs[0]) crumbs[0].click()
    })
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
    await page.evaluate(() => {
      const crumbs = [...document.querySelectorAll('button, a, span')].filter((e) => e.textContent?.trim() === 'demo')
      if (crumbs[0]) crumbs[0].click()
    })
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
    await page.evaluate(() => {
      const crumbs = [...document.querySelectorAll('button, a, span')].filter((e) => e.textContent?.trim() === 'demo')
      if (crumbs[0]) crumbs[0].click()
    })
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
    await page.waitForSelector('[aria-label="Filename contains"], [aria-label="Content regex pattern"]', { timeout: 5000 })
    const input = await page.$('[aria-label="Filename contains"], [aria-label="Content regex pattern"]')
    if (input) {
      await input.click({ clickCount: 3 })
      await input.type('REWIND', { delay: 30 })
      await page.evaluate(() => {
        const btn = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Search')
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
    const cinput = await page.$('[aria-label="Content regex pattern"]')
    if (cinput) {
      await cinput.click({ clickCount: 3 })
      await cinput.type('TODO|FIXME', { delay: 20 })
      await page.evaluate(() => {
        const btn = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Search')
        btn?.click()
      })
      await sleep(2500)
      await shot(page, '02c-search-content.png')
    }
  } catch (e) {
    console.warn('search interact', e.message)
  }
  // close search
  await clickNav(page, 'Search')
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
  // upload a small file via the file chooser if present
  try {
    const [fileChooser] = await Promise.all([
      page.waitForFileChooser({ timeout: 3000 }).catch(() => null),
      page.evaluate(() => {
        const zone = [...document.querySelectorAll('[title],div,button')].find((e) =>
          (e.getAttribute('title') || '').includes('Choose files') ||
          (e.textContent || '').includes('Drop files here'))
        zone?.click()
      }),
    ])
    if (fileChooser) {
      const tmp = '/tmp/fbx_demo/notes/plain.txt'
      await fileChooser.accept([tmp])
      await sleep(2000)
      await shot(page, '04b-transfer-uploaded.png')
    }
  } catch (e) {
    console.warn('transfer upload', e.message)
  }

  // Terminal (2FA gate)
  await clickNav(page, 'Terminal')
  await sleep(1000)
  await shot(page, '05-terminal.png')
  if (totpSecret) {
    try {
      const code = totp(totpSecret)
      console.log('totp', code)
      const codeInput = await page.$('input[placeholder="6-digit code"], input[autocomplete="one-time-code"]')
      if (codeInput) {
        await codeInput.click({ clickCount: 3 })
        await codeInput.type(code, { delay: 40 })
        await shot(page, '05b-terminal-code.png')
        await page.evaluate(() => {
          const btn = [...document.querySelectorAll('button')].find((b) =>
            /Open terminal|Resume/.test(b.textContent || ''))
          btn?.click()
        })
        await sleep(2500)
        await shot(page, '05c-terminal-open.png')
        // type a command
        await page.keyboard.type('echo hello-from-filebox && pwd && ls /tmp/fbx_demo | head', { delay: 25 })
        await page.keyboard.press('Enter')
        await sleep(1500)
        await shot(page, '05d-terminal-session.png')
      }
    } catch (e) {
      console.warn('terminal open', e.message)
    }
  }

  // Stats
  await clickNav(page, 'System')
  await sleep(1500)
  await shot(page, '06-stats.png')

  // Settings
  await clickNav(page, 'Settings')
  await sleep(1000)
  await shot(page, '11-settings.png')
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
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Done' || b.getAttribute('aria-label') === 'Close')
    btn?.click()
  })
  await sleep(300)

  // Mobile / narrow
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 })
  await clickNav(page, 'Files')
  await sleep(800)
  await shot(page, '13-mobile-files.png')
  // open drawer
  try {
    await page.click('button[aria-label="Open menu"]')
    await sleep(700)
    await shot(page, '13b-mobile-drawer.png')
  } catch (e) {
    console.warn('mobile drawer', e.message)
  }

  // Office preview if possible (desktop again)
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 })
  await sleep(500)
  await clickNav(page, 'Files')
  await sleep(600)
  try {
    await page.evaluate(() => {
      const crumbs = [...document.querySelectorAll('button, a, span')].filter((e) => e.textContent?.trim() === 'demo')
      if (crumbs[0]) crumbs[0].click()
    })
    await sleep(500)
    await openFolder(page, 'reports')
    await sleep(600)
    await openFolder(page, 'complex-e2e.pptx')
    await sleep(8000) // conversion can take a bit
    await shot(page, '08f-preview-office.png')
  } catch (e) {
    console.warn('office preview', e.message)
  }

  // Manifest
  const { readdir, stat } = await import('node:fs/promises')
  const files = (await readdir(outDir)).filter((f) => f.endsWith('.png')).sort()
  const lines = ['# Real Hub+Agent screenshots', '', `Source: ${baseUrl} (FILEBOX_DEV_MODE local)`, '', '| File | Bytes |', '|------|------|']
  for (const f of files) {
    const st = await stat(path.join(outDir, f))
    lines.push(`| ${f} | ${st.size} |`)
  }
  await writeFile(path.join(outDir, 'MANIFEST.md'), lines.join('\n') + '\n')
  console.log('done', files.length, 'pngs')
  await browser.close()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
