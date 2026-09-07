import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { chromium, type Browser, type Page } from 'playwright'
import { createServer, type Server } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { execFileSync } from 'node:child_process'

/**
 * The renderer is an ordinary web page, so it can be driven in headless
 * Chromium with the preload bridge stubbed. No Electron, no window on anyone's
 * screen, and — unlike a DOM emulator — real layout, which is what catches
 * a collapsed video stage.
 */

const ROOT = join(process.cwd(), 'apps/desktop/out/renderer')
const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }

let server: Server
let browser: Browser
let page: Page
let origin: string

const STATE = {
  ready: true,
  connected: true,
  members: [{ id: '1', name: 'anjali', isHost: true, mayControl: true }],
  mediaName: 'dune.mkv', durationSec: 7200,
  positionSec: 12, expectedSec: 12, driftMs: 4,
  paused: true, rate: 1, clockOffsetMs: 3, rttMs: 20, lastAction: 'none',
  fullscreen: false
}

beforeAll(async () => {
  // Always rebuild. Testing a stale bundle is worse than not testing: it fails
  // for a reason that has nothing to do with the code under test.
  execFileSync('npx', ['electron-vite', 'build'], { cwd: join(process.cwd(), 'apps/desktop'), stdio: 'ignore' })
  server = createServer(async (req, res) => {
    const rel = normalize(decodeURIComponent((req.url ?? '/').split('?')[0]!)).replace(/^(\.\.[/\\])+/, '')
    const file = join(ROOT, rel === '/' ? 'index.html' : rel)
    try {
      const body = await readFile(file)
      res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' })
      res.end(body)
    } catch { res.writeHead(404); res.end() }
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const addr = server.address()
  origin = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
  browser = await chromium.launch()
}, 120_000)

afterAll(async () => {
  await browser?.close()
  await new Promise<void>(r => server?.close(() => r()))
})

async function open (viewport = { width: 1100, height: 800 }): Promise<Page> {
  page = await browser.newPage({ viewport })
  // Stand in for the preload bridge. Calls are recorded on window.__calls so a
  // click can be asserted end to end without Electron.
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>
    w.__calls = [] as Array<{ name: string; args: unknown[] }>
    const rec = (name: string) => (...args: unknown[]) => {
      (w.__calls as Array<{ name: string; args: unknown[] }>).push({ name, args })
      return Promise.resolve(null)
    }
    w.cocine = {
      setVideoSlot: rec('setVideoSlot'),
      openFile: rec('openFile'),
      openPath: rec('openPath'),
      pathForFile: () => '/films/stub.mkv',
      connect: rec('connect'),
      disconnect: rec('disconnect'),
      play: rec('play'),
      pause: rec('pause'),
      seek: rec('seek'),
      setFullScreen: rec('setFullScreen'),
      onState: (cb: (s: unknown) => void) => { w.__push = cb; return () => {} }
    }
  })
  await page.goto(origin)
  page.on('console', m => { if (m.type() === 'error') console.error('[page]', m.text()) })
  page.on('pageerror', e => console.error('[page error]', e.message))
  await page.waitForSelector('[data-testid="stage"]', { timeout: 8000 })
  return page
}

const push = async (over: Record<string, unknown> = {}): Promise<void> => {
  await page.evaluate(([base, o]) => {
    const w = window as unknown as Record<string, unknown>
    ;(w.__push as (s: unknown) => void)?.({ ...(base as object), ...(o as object) })
  }, [STATE, over] as const)
  await page.waitForTimeout(60)
}

const calls = async (name: string): Promise<unknown[][]> =>
  await page.evaluate((n) => {
    const w = window as unknown as Record<string, unknown>
    return (w.__calls as Array<{ name: string; args: unknown[] }>).filter(c => c.name === n).map(c => c.args)
  }, name)

describe('renderer layout', () => {
  it('gives the video stage every pixel between the header and the controls', async () => {
    // The regression this exists for: switching .app to four grid rows while the
    // error banner was conditionally rendered pushed the controls into the 1fr
    // row and collapsed the stage to content height.
    await open()
    await push()
    const box = await page.evaluate(() => {
      const r = (t: string) => document.querySelector(`[data-testid="${t}"]`)!.getBoundingClientRect()
      return { stage: r('stage'), header: r('header'), controls: r('controls'), vh: window.innerHeight }
    })
    const expected = box.vh - box.header.height - box.controls.height
    expect(box.stage.height).toBeGreaterThan(expected - 2)
    expect(box.stage.height).toBeLessThan(expected + 2)
    expect(box.stage.height).toBeGreaterThan(400)
    await page.close()
  })

  it('keeps the stage correct when the error banner appears', async () => {
    await open()
    await push()
    const before = await page.evaluate(() => document.querySelector('[data-testid="stage"]')!.getBoundingClientRect().height)
    await page.evaluate(() => {
      const w = window as unknown as Record<string, unknown>
      w.cocine = { ...(w.cocine as object), openFile: () => Promise.reject(new Error('boom')) }
    })
    await page.click('[data-testid="open"]')
    await page.waitForSelector('[data-testid="banner"]')
    const after = await page.evaluate(() => {
      const r = (t: string) => document.querySelector(`[data-testid="${t}"]`)!.getBoundingClientRect()
      return { stage: r('stage').height, banner: r('banner').height, vh: window.innerHeight }
    })
    // The stage should shrink by exactly the banner, not collapse.
    expect(after.stage).toBeCloseTo(before - after.banner, 0)
    expect(after.stage).toBeGreaterThan(300)
    await page.close()
  })

  it('reports a video slot matching the stage so the native surface lands on it', async () => {
    await open()
    await push()
    const [last] = (await calls('setVideoSlot')).slice(-1)
    const stage = await page.evaluate(() => document.querySelector('[data-testid="stage"]')!.getBoundingClientRect())
    const slot = last![0] as { x: number; y: number; width: number; height: number }
    // The renderer rounds to whole pixels on purpose — native window bounds
    // are integers — so allow a pixel of slack rather than exact equality.
    expect(Math.abs(slot.width - stage.width)).toBeLessThanOrEqual(1)
    expect(Math.abs(slot.height - stage.height)).toBeLessThanOrEqual(1)
    expect(Math.abs(slot.y - stage.y)).toBeLessThanOrEqual(1)
    expect(Math.abs(slot.x - stage.x)).toBeLessThanOrEqual(1)
    await page.close()
  })

  it('re-reports the slot when the window is resized', async () => {
    await open()
    await push()
    const before = (await calls('setVideoSlot')).length
    await page.setViewportSize({ width: 900, height: 600 })
    await page.waitForTimeout(150)
    const after = await calls('setVideoSlot')
    expect(after.length).toBeGreaterThan(before)
    const slot = after.at(-1)![0] as { height: number }
    expect(slot.height).toBeLessThan(600)
    expect(slot.height).toBeGreaterThan(300)
    await page.close()
  })
})

describe('fullscreen', () => {
  it('gives the stage the entire window and hides the chrome', async () => {
    await open()
    await push({ fullscreen: true })
    const box = await page.evaluate(() => {
      const q = (t: string) => document.querySelector(`[data-testid="${t}"]`)
      const stage = q('stage')!.getBoundingClientRect()
      const vis = (t: string) => {
        const el = q(t)
        return el ? getComputedStyle(el).display !== 'none' : false
      }
      return { stage, vh: window.innerHeight, vw: window.innerWidth, header: vis('header'), controls: vis('controls') }
    })
    expect(box.header).toBe(false)
    expect(box.controls).toBe(false)
    expect(box.stage.height).toBeCloseTo(box.vh, 0)
    expect(box.stage.width).toBeCloseTo(box.vw, 0)
    await page.close()
  })

  it('reports the full-window slot so the video surface covers everything', async () => {
    await open()
    await push({ fullscreen: true })
    const slot = (await calls('setVideoSlot')).at(-1)![0] as { x: number; y: number; width: number; height: number }
    const view = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }))
    expect(slot.x).toBe(0)
    expect(slot.y).toBe(0)
    expect(Math.abs(slot.width - view.w)).toBeLessThanOrEqual(1)
    expect(Math.abs(slot.height - view.h)).toBeLessThanOrEqual(1)
    await page.close()
  })

  it('restores the windowed layout when fullscreen ends', async () => {
    await open()
    await push({ fullscreen: true })
    await push({ fullscreen: false })
    const box = await page.evaluate(() => {
      const r = (t: string) => document.querySelector(`[data-testid="${t}"]`)!.getBoundingClientRect()
      return { stage: r('stage'), header: r('header'), controls: r('controls'), vh: window.innerHeight }
    })
    expect(box.stage.height).toBeCloseTo(box.vh - box.header.height - box.controls.height, 0)
    await page.close()
  })

  it('toggles from the control bar and from the F key', async () => {
    await open()
    await push()
    await page.click('[data-testid="fullscreen"]')
    expect(await calls('setFullScreen')).toHaveLength(1)
    await page.keyboard.press('f')
    expect(await calls('setFullScreen')).toHaveLength(2)
    await page.close()
  })
})

describe('keyboard', () => {
  it('space toggles playback, arrows seek by ten seconds', async () => {
    await open()
    await push({ paused: true, positionSec: 100 })
    await page.keyboard.press('Space')
    expect(await calls('play')).toHaveLength(1)
    await page.keyboard.press('ArrowRight')
    expect((await calls('seek'))[0]).toEqual([110])
    await page.keyboard.press('ArrowLeft')
    expect((await calls('seek'))[1]).toEqual([90])
    await page.close()
  })

  it('ignores shortcuts while typing in a field', async () => {
    await open()
    await push({ connected: false })
    await page.click('.join input')
    await page.keyboard.press('Space')
    await page.keyboard.press('f')
    expect(await calls('play')).toHaveLength(0)
    expect(await calls('setFullScreen')).toHaveLength(0)
    await page.close()
  })
})

describe('renderer behaviour', () => {
  it('clicking Open film reaches the bridge', async () => {
    await open()
    await push()
    await page.click('[data-testid="open"]')
    expect(await calls('openFile')).toHaveLength(1)
    await page.close()
  })

  it('disables Open film until the player is ready', async () => {
    await open()
    await push({ ready: false })
    expect(await page.isDisabled('[data-testid="open"]')).toBe(true)
    await push({ ready: true })
    expect(await page.isDisabled('[data-testid="open"]')).toBe(false)
    await page.close()
  })

  it('disables play until a film is open, then plays', async () => {
    await open()
    await push({ mediaName: null })
    expect(await page.isDisabled('[data-testid="playpause"]')).toBe(true)
    await push({ mediaName: 'dune.mkv', paused: true })
    await page.click('[data-testid="playpause"]')
    expect(await calls('play')).toHaveLength(1)
    await page.close()
  })

  it('shows a dismissible banner when a call fails', async () => {
    await open()
    await push()
    await page.evaluate(() => {
      const w = window as unknown as Record<string, unknown>
      w.cocine = { ...(w.cocine as object), openFile: () => Promise.reject(new Error('unsupported codec')) }
    })
    await page.click('[data-testid="open"]')
    await expect.poll(async () => await page.textContent('[data-testid="banner"]')).toContain('unsupported codec')
    await page.click('[data-testid="banner"] button')
    expect(await page.locator('[data-testid="banner"]').count()).toBe(0)
    await page.close()
  })
})
