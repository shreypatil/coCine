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
      setOverlayShape: rec('setOverlayShape'),
      onFocusChat: (cb: () => void) => { w.__focusChat = cb; return () => {} },
      onOverlayLayout: (cb: (l: string) => void) => { w.__layout = cb; return () => {} },
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

/** Open the composer the way the main window does, with a real focus event. */
const openComposer = async (): Promise<void> => {
  await page.evaluate(() => (window as unknown as { __focusChat: () => void }).__focusChat())
  await page.waitForSelector('[data-testid="overlayinput"]')
}

const setLayout = async (layout: 'floating' | 'panel'): Promise<void> => {
  await page.evaluate(l => (window as unknown as { __layout: (x: string) => void }).__layout(l), layout)
}

/** The rectangles the window was last cut down to. */
const lastShape = async (): Promise<Array<{ x: number; y: number; width: number; height: number }>> => {
  const all = await calls('setOverlayShape')
  return (all.at(-1)?.[0] ?? []) as Array<{ x: number; y: number; width: number; height: number }>
}

describe('the fullscreen chat overlay', () => {
  it('renders the chat rather than the whole interface', async () => {
    await openOverlay()
    await push()
    // The main interface must not be here: this window sits over the film.
    expect(await page.locator('[data-testid="controls"]').count()).toBe(0)
    expect(await page.locator('[data-testid="overlaychat"]').count()).toBe(1)
    await page.close()
  })

  it('shows what was said, including the system lines', async () => {
    // The bug this exists for: the main process pushed state to the main window
    // only, so this window rendered an empty conversation for ever.
    await openOverlay()
    await push()
    const text = await page.textContent('[data-testid="overlaychat"]')
    expect(text).toContain('this bit is good')
    expect(text).toContain('joined')
    await page.close()
  })

  it('says nothing at all when there is nothing recent to say', async () => {
    // No panel, no placeholder, no "nothing said yet" -- an idle overlay must
    // not cover a single pixel of the film.
    await openOverlay()
    await push({ messages: [] })
    expect(await page.locator('[data-testid="overlaymsg"]').count()).toBe(0)
    expect(await page.textContent('[data-testid="overlay"]')).toBe('')
    await expect.poll(async () => (await lastShape()).length).toBe(0)
    await page.close()
  })

  it('drops a line once it has been up long enough', async () => {
    await openOverlay()
    await push({
      messages: [{ id: 'old', kind: 'said', memberId: 'd', name: 'dev', text: 'said this ages ago', atServerMs: Date.now() - 10 * 60_000 }]
    })
    expect(await page.locator('[data-testid="overlaymsg"]').count()).toBe(0)
    await page.close()
  })

  it('covers only the bubbles, never the whole window', async () => {
    // This is the whole point of the window: the film shows through everywhere
    // the conversation is not.
    await openOverlay()
    await push()
    await expect.poll(async () => (await lastShape()).length).toBeGreaterThan(0)
    const rects = await lastShape()
    const view = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }))
    const covered = rects.reduce((a, r) => a + r.width * r.height, 0)
    expect(covered).toBeLessThan(view.w * view.h * 0.5)
    for (const r of rects) {
      expect(r.x).toBeGreaterThanOrEqual(0)
      expect(r.y).toBeGreaterThanOrEqual(0)
      expect(r.x + r.width).toBeLessThanOrEqual(view.w + 1)
      expect(r.y + r.height).toBeLessThanOrEqual(view.h + 1)
    }
    await page.close()
  })

  it('has no composer until the main window asks for one', async () => {
    await openOverlay()
    await push()
    expect(await page.locator('[data-testid="overlayinput"]').count()).toBe(0)
    await openComposer()
    // Focus lands a frame after the field is rendered; there is nothing to
    // focus before that.
    await expect.poll(async () => await page.evaluate(() =>
      document.activeElement?.getAttribute('data-testid'))).toBe('overlayinput')
    await page.close()
  })

  it('sends a message on Enter and clears the field', async () => {
    await openOverlay()
    await push()
    await openComposer()
    await page.fill('[data-testid="overlayinput"]', 'nice')
    await page.press('[data-testid="overlayinput"]', 'Enter')
    expect((await calls('sendChat'))[0]).toEqual(['nice'])
    expect(await page.inputValue('[data-testid="overlayinput"]')).toBe('')
    await page.close()
  })

  it('does not send an empty message', async () => {
    await openOverlay()
    await push()
    await openComposer()
    await page.press('[data-testid="overlayinput"]', 'Enter')
    expect(await calls('sendChat')).toHaveLength(0)
    await page.close()
  })

  it('hands the keyboard back on Escape and closes the composer', async () => {
    // Without this the main window's shortcuts stay dead while the overlay has
    // focus, including the one that leaves fullscreen.
    await openOverlay()
    await push()
    await openComposer()
    await page.press('[data-testid="overlayinput"]', 'Escape')
    expect(await calls('releaseChatFocus')).toHaveLength(1)
    expect(await page.locator('[data-testid="overlayinput"]').count()).toBe(0)
    await page.close()
  })

  it('keeps older lines up while the composer is open', async () => {
    // Replying to something you can no longer see is worse than covering a
    // little more of the film for as long as someone is typing.
    await openOverlay()
    await push({
      messages: [{ id: 'old', kind: 'said', memberId: 'd', name: 'dev', text: 'said this ages ago', atServerMs: Date.now() - 10 * 60_000 }]
    })
    expect(await page.locator('[data-testid="overlaymsg"]').count()).toBe(0)
    await openComposer()
    expect(await page.locator('[data-testid="overlaymsg"]').count()).toBe(1)
    await page.close()
  })

  it('falls back to a scrolling panel where the window cannot be shaped', async () => {
    await openOverlay()
    await setLayout('panel')
    const many = Array.from({ length: 60 }, (_, i) => ({
      id: `m${i}`, kind: 'said', memberId: 'd', name: 'dev', text: `line ${i}`, atServerMs: Date.now()
    }))
    await push({ messages: many })
    // The composer is always there in the panel, and the newest line is in view.
    await page.waitForSelector('[data-testid="overlayinput"]')
    const atBottom = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="overlaychat"]')!
      return el.scrollHeight - el.scrollTop - el.clientHeight < 4
    })
    expect(atBottom).toBe(true)
    await page.close()
  })
})
