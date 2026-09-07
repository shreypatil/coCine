import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { chromium, type Browser, type Page } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import { readFileSync, existsSync } from 'node:fs'
import { join, extname } from 'node:path'
import { execFileSync } from 'node:child_process'

/**
 * The fullscreen chat overlay, rendered in a real browser against the built
 * bundle. It is a second entry point into the same file, reached by #overlay,
 * so this also guards that routing.
 */

const OUT = join(process.cwd(), 'apps/desktop/out/renderer')
const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }

let server: Server
let browser: Browser
let page: Page
let origin: string

const STATE = {
  ready: true, connected: true, fullscreen: true,
  members: [], memberId: 'me', code: 'BCDFGHJK', isHost: true, mayControl: true,
  mediaName: 'dune.mkv', durationSec: 7200, positionSec: 0, expectedSec: 0, driftMs: 0,
  paused: true, rate: 1, clockOffsetMs: 0, rttMs: 0, lastAction: 'none',
  voiceIce: [], mode: 'p2p', originAvailable: false, startupError: null,
  transfers: [], receiving: null, phase: 'playing', waitForLatecomers: true,
  transferStatus: null,
  messages: [
    { id: '1', kind: 'joined', memberId: null, name: 'dev', text: 'joined', atServerMs: Date.now() },
    { id: '2', kind: 'said', memberId: 'd', name: 'dev', text: 'this bit is good', atServerMs: Date.now() }
  ]
}

beforeAll(async () => {
  execFileSync('npx', ['electron-vite', 'build'], { cwd: join(process.cwd(), 'apps/desktop'), stdio: 'ignore' })
  server = createServer((req, res) => {
    const rel = (req.url ?? '/').split('?')[0]!.split('#')[0]!
    const file = join(OUT, rel === '/' ? 'index.html' : rel)
    if (!existsSync(file)) { res.writeHead(404); res.end(); return }
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' })
    res.end(readFileSync(file))
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const addr = server.address()
  origin = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
  browser = await chromium.launch()
}, 180_000)

afterAll(async () => {
  await browser?.close()
  await new Promise<void>(r => server?.close(() => r()))
})

async function openOverlay (): Promise<Page> {
  page = await browser.newPage({ viewport: { width: 380, height: 300 } })
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>
    w.__calls = [] as Array<{ name: string; args: unknown[] }>
    const rec = (name: string) => (...args: unknown[]) => {
      (w.__calls as Array<{ name: string; args: unknown[] }>).push({ name, args })
      return Promise.resolve(null)
    }
    w.cocine = {
      sendChat: rec('sendChat'),
      releaseChatFocus: rec('releaseChatFocus'),
      onFocusChat: (cb: () => void) => { w.__focusChat = cb; return () => {} },
      onState: (cb: (s: unknown) => void) => { w.__push = cb; return () => {} }
    }
  })
  await page.goto(`${origin}/index.html#overlay`)
  await page.waitForSelector('[data-testid="overlay"]', { timeout: 8000 })
  return page
}

const push = async (over: Record<string, unknown> = {}): Promise<void> => {
  await page.evaluate(([base, o]) => {
    const w = window as unknown as Record<string, unknown>
    ;(w.__push as (s: unknown) => void)?.({ ...(base as object), ...(o as object) })
  }, [STATE, over] as const)
}
const calls = async (name: string): Promise<unknown[][]> =>
  page.evaluate(n => (window as unknown as { __calls: Array<{ name: string; args: unknown[] }> })
    .__calls.filter(c => c.name === n).map(c => c.args), name)

describe('the fullscreen chat overlay', () => {
  it('renders the chat rather than the whole interface', async () => {
    await openOverlay()
    await push()
    // The main interface must not be here: this window is 380px wide and sits
    // over the film.
    expect(await page.locator('[data-testid="controls"]').count()).toBe(0)
    expect(await page.locator('[data-testid="overlaychat"]').count()).toBe(1)
    await page.close()
  })

  it('shows what was said, including the system lines', async () => {
    await openOverlay()
    await push()
    const text = await page.textContent('[data-testid="overlaychat"]')
    expect(text).toContain('this bit is good')
    expect(text).toContain('joined')
    await page.close()
  })

  it('sends a message on Enter and clears the field', async () => {
    await openOverlay()
    await push()
    await page.fill('[data-testid="overlayinput"]', 'nice')
    await page.press('[data-testid="overlayinput"]', 'Enter')
    expect((await calls('sendChat'))[0]).toEqual(['nice'])
    expect(await page.inputValue('[data-testid="overlayinput"]')).toBe('')
    await page.close()
  })

  it('does not send an empty message', async () => {
    await openOverlay()
    await push()
    await page.press('[data-testid="overlayinput"]', 'Enter')
    expect(await calls('sendChat')).toHaveLength(0)
    await page.close()
  })

  it('hands the keyboard back on Escape', async () => {
    // Without this the main window's shortcuts stay dead while the overlay has
    // focus, including the one that leaves fullscreen.
    await openOverlay()
    await push()
    await page.press('[data-testid="overlayinput"]', 'Escape')
    expect(await calls('releaseChatFocus')).toHaveLength(1)
    await page.close()
  })

  it('takes focus when the main window asks it to', async () => {
    await openOverlay()
    await push()
    await page.evaluate(() => (window as unknown as { __focusChat: () => void }).__focusChat())
    expect(await page.evaluate(() =>
      document.activeElement?.getAttribute('data-testid'))).toBe('overlayinput')
    await page.close()
  })

  it('keeps the newest message in view', async () => {
    await openOverlay()
    const many = Array.from({ length: 60 }, (_, i) => ({
      id: `m${i}`, kind: 'said', memberId: 'd', name: 'dev', text: `line ${i}`, atServerMs: Date.now()
    }))
    await push({ messages: many })
    const atBottom = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="overlaychat"]')!
      return el.scrollHeight - el.scrollTop - el.clientHeight < 4
    })
    expect(atBottom).toBe(true)
    await page.close()
  })
})
