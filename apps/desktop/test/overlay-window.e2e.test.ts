import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { ExternalMpv } from '@cocine/player'
import { RoomClient } from '@cocine/client'
import { SignallingServer } from '../../server/src/server.js'

/**
 * The fullscreen chat overlay, against a real X server.
 *
 * Everything that makes this feature work happens outside the page: the window
 * is reparented into the main window, raised above the video surface, and then
 * cut down with the X SHAPE extension to exactly the message bubbles. None of
 * that is observable from the renderer, so this asks X itself what the window
 * ended up being -- whose child it is, and which rectangles of it exist.
 *
 * It needs real windows, so unlike the rest of the suite it does not run under
 * COCINE_HEADLESS and is opt-in (`npm run test:app`). It puts a window on the
 * display for as long as it runs.
 */

const SHAPE_BOUNDING = 0

interface Win { url: string; wid: number; width: number; height: number; visible: boolean }

let server: SignallingServer
let app: ElectronApplication
let page: Page
let guest: RoomClient
let guestPlayer: ExternalMpv
let x: {
  rectangles: (wid: number) => Promise<Array<[number, number, number, number]>>
  parentOf: (wid: number) => Promise<number>
  close: () => void
} | null = null

/** A small X client of its own, so the assertions do not go through the app. */
async function xClient (): Promise<NonNullable<typeof x>> {
  const x11 = await import('x11')
  const display = await new Promise<{ client: Record<string, unknown> }>((resolve, reject) => {
    ;(x11 as unknown as { createClient: (cb: (e: unknown, d: never) => void) => void })
      .createClient((e, d) => e ? reject(e) : resolve(d))
  })
  const client = display.client as unknown as {
    require: (n: string, cb: (e: unknown, ext: unknown) => void) => void
    QueryTree: (wid: number, cb: (e: unknown, tree: { parent: number }) => void) => void
    terminate?: () => void
  }
  const shape = await new Promise<{
    GetRectangles: (wid: number, kind: number, cb: (e: unknown, r: { rectangles: Array<[number, number, number, number]> }) => void) => void
  }>((resolve, reject) => {
    client.require('shape', (e, ext) => e ? reject(e) : resolve(ext as never))
  })
  return {
    rectangles: async wid => await new Promise((resolve, reject) => {
      shape.GetRectangles(wid, SHAPE_BOUNDING, (e, r) => e ? reject(e) : resolve(r.rectangles))
    }),
    parentOf: async wid => await new Promise((resolve, reject) => {
      client.QueryTree(wid, (e, t) => e ? reject(e) : resolve(t.parent))
    }),
    close: () => client.terminate?.()
  }
}

const windows = async (): Promise<Win[]> =>
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(w => {
    const h = w.getNativeWindowHandle()
    const b = w.getBounds()
    return {
      // Not the title: Electron takes the window title from the page, and both
      // windows load the same document, so both are called coCine.
      url: w.webContents.getURL(),
      wid: h.length >= 8 ? Number(h.readBigUInt64LE(0)) : h.readUInt32LE(0),
      width: b.width,
      height: b.height,
      visible: w.isVisible()
    }
  }))

const isOverlay = (w: Win): boolean => w.url.includes('index.html') && w.url.includes('overlay')
const isMain = (w: Win): boolean => w.url.includes('index.html') && !w.url.includes('overlay')

const find = async (which: 'main' | 'overlay'): Promise<Win> => {
  const all = await windows()
  const hit = all.find(which === 'main' ? isMain : isOverlay)
  if (!hit) throw new Error(`no ${which} window; saw ${all.map(w => w.url).join(', ')}`)
  return hit
}

const area = (rects: Array<[number, number, number, number]>): number =>
  rects.reduce((a, r) => a + r[2] * r[3], 0)

beforeAll(async () => {
  execFileSync('npx', ['electron-vite', 'build'], { cwd: join(process.cwd(), 'apps/desktop'), stdio: 'ignore' })
  server = new SignallingServer({ startLeadMs: 200 })
  const port = await server.listen()

  // Deliberately not COCINE_HEADLESS: this test is about the native windows.
  app = await electron.launch({ args: [join(process.cwd(), 'apps/desktop')] })
  // firstWindow() is whichever window Chromium reports first, and that is
  // usually the video surface -- a bare data: URL with no interface in it.
  const deadline = Date.now() + 30_000
  for (;;) {
    const hit = app.windows().find(w => w.url().includes('index.html') && !w.url().includes('#overlay'))
    if (hit) { page = hit; break }
    if (Date.now() > deadline) throw new Error('the main window never appeared')
    await new Promise(r => setTimeout(r, 250))
  }
  await page.waitForSelector('[data-testid="stage"]', { timeout: 30_000 })

  await page.fill('[data-testid="server"]', `ws://127.0.0.1:${port}`)
  await page.fill('[data-testid="name"]', 'anjali')
  await page.click('[data-testid="create"]')
  await page.waitForSelector('[data-testid="code"]', { timeout: 30_000 })
  const code = (await page.textContent('[data-testid="code"]'))!.replace(/[^A-Z0-9]/g, '').replace(/COPY|COPIED/, '')

  guestPlayer = new ExternalMpv({ headless: true })
  await guestPlayer.start()
  guest = new RoomClient({ url: `ws://127.0.0.1:${port}`, code, name: 'dev', player: guestPlayer })
  await guest.connect()

  await page.click('[data-testid="fullscreen"]')
  // expect.poll only works inside a test, so this waits by hand.
  const shown = Date.now() + 20_000
  for (;;) {
    if ((await windows()).some(w => isOverlay(w) && w.visible)) break
    if (Date.now() > shown) throw new Error('the chat overlay never appeared in fullscreen')
    await new Promise(r => setTimeout(r, 250))
  }
  x = await xClient()
}, 300_000)

afterAll(async () => {
  x?.close()
  await Promise.race([app?.close(), new Promise(r => setTimeout(r, 15_000))])
  await guest?.close()
  await guestPlayer?.close()
  await server?.close()
}, 60_000)

describe('the chat overlay as X sees it', () => {
  it('is a child of the main window, so the application is one window', async () => {
    // The regression this exists for: a top-level override-redirect child
    // belongs to no workspace, so i3 leaves it painted over whatever you
    // switch to.
    const main = await find('main')
    const chat = await find('overlay')
    expect(await x!.parentOf(chat.wid)).toBe(main.wid)
  })

  it('gives the whole film back once the conversation goes quiet', async () => {
    // Joining the room puts two lines in the log, so this starts with bubbles
    // up and waits for them to age out: an idle overlay must cover nothing.
    await expect.poll(async () => area(await x!.rectangles((await find('overlay')).wid)), {
      timeout: 40_000, interval: 1000
    }).toBe(0)
  }, 60_000)

  it('covers the bubble, and only the bubble, once somebody speaks', async () => {
    guest.sendChat('this bit is good')
    const chat = await find('overlay')
    await expect.poll(async () => area(await x!.rectangles(chat.wid)), { timeout: 20_000 })
      .toBeGreaterThan(0)
    const covered = area(await x!.rectangles(chat.wid))
    // The window is the size of the whole video; a bubble is a small corner of
    // it. Anything approaching the full window means the shape did not take.
    expect(covered).toBeLessThan(chat.width * chat.height * 0.25)
  })

  it('can actually be typed into while fullscreen', async () => {
    // The bug this exists for, and the reason none of the tests above caught
    // it: everything the overlay *shows* worked, and the one thing a person
    // does with it did not. The composer used to be a text field in this
    // window, which is reparented into the main window and therefore never
    // given the keyboard, so it opened and swallowed every keystroke. The
    // field is in the main window now and this only draws it.
    await page.keyboard.press('Enter')
    await page.waitForSelector('[data-testid="fscompose"]', { timeout: 10_000 })
    await page.keyboard.type('typed over the film')
    // What is being typed reaches the window that draws it.
    await expect.poll(async () => area(await x!.rectangles((await find('overlay')).wid)), { timeout: 15_000 })
      .toBeGreaterThan(0)
    await page.keyboard.press('Enter')

    await expect.poll(() => guest.messages.map(m => m.text), { timeout: 20_000 })
      .toContain('typed over the film')
    // And the field goes away rather than eating the shortcuts afterwards.
    expect(await page.locator('[data-testid="fscompose"]').count()).toBe(0)
  }, 60_000)
})
