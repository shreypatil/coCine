import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, copyFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { ensureTestVideo } from '@cocine/player'
import { startServer, createRoom, waitForPlayer } from './support/room.js'
import type { SignallingServer } from '../../server/src/server.js'

/**
 * Is there actually a picture?
 *
 * Every other test can pass while the film plays with sound and a black
 * rectangle where the video should be: the position advances, the interface is
 * correct, mpv is happy, and the native surface is simply not on screen. That
 * failure has happened twice — once when the surface was hidden until a film
 * opened and mpv loaded into a window that was not mapped, and once when the
 * picker suspended the surface and nothing put it back.
 *
 * So this one looks at the pixels. It needs real windows and a real X server,
 * so it is opt-in (`npm run test:app`) and puts a window on the display while it
 * runs.
 */

/** X's own view of a window, which is what a person actually sees. */
const MAP_STATE = ['Unmapped', 'Unviewable', 'Viewable'] as const

async function xClient (): Promise<{ mapStateOf: (wid: number) => Promise<string>; close: () => void }> {
  const x11 = await import('x11')
  const display = await new Promise<{ client: Record<string, unknown> }>((resolve, reject) => {
    ;(x11 as unknown as { createClient: (cb: (e: unknown, d: never) => void) => void })
      .createClient((e, d) => e ? reject(e) : resolve(d))
  })
  const client = display.client as unknown as {
    GetWindowAttributes: (wid: number, cb: (e: unknown, a: { mapState: number }) => void) => void
    terminate?: () => void
  }
  return {
    mapStateOf: async wid => await new Promise(resolve => {
      client.GetWindowAttributes(wid, (e, a) => resolve(e ? 'error' : (MAP_STATE[a.mapState] ?? String(a.mapState))))
    }),
    close: () => client.terminate?.()
  }
}

const have = (cmd: string): boolean => {
  try { execFileSync('which', [cmd], { stdio: 'ignore' }); return true } catch { return false }
}
/** ImageMagick is what reads the pixels back; without it there is no test. */
const canGrab = have('import') && have('magick') && !!process.env.DISPLAY

let app: ElectronApplication
let page: Page
let home: string
let film: string
let server: SignallingServer

interface Win { url: string; visible: boolean; wid: number }

const windows = async (): Promise<Win[]> =>
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(w => {
    const h = w.getNativeWindowHandle()
    return {
      url: w.webContents.getURL(),
      visible: w.isVisible(),
      wid: h.length >= 8 ? Number(h.readBigUInt64LE(0)) : h.readUInt32LE(0)
    }
  }))

/** The mpv surface is the one window whose page is the placeholder data URL. */
const videoWindow = async (): Promise<Win | undefined> =>
  (await windows()).find(w => w.url.startsWith('data:'))

/**
 * How varied the surface's pixels are. A black rectangle reads as 0; anything
 * actually decoding reads far above the threshold below.
 */
const spread = (wid: number): number => {
  const file = join(tmpdir(), `cocine-video-${wid}.png`)
  execFileSync('import', ['-window', String(wid), file])
  const out = execFileSync('magick', [file, '-format', '%[fx:standard_deviation]', 'info:']).toString()
  rmSync(file, { force: true })
  return Number(out.trim())
}

beforeAll(async () => {
  if (!canGrab) return
  const fixture = ensureTestVideo(60, join(process.cwd(), '.fixtures'))
  home = mkdtempSync(join(tmpdir(), 'cocine-home-'))
  mkdirSync(join(home, 'Videos'))
  film = join(home, 'Videos', basename(fixture))
  copyFileSync(fixture, film)

  execFileSync('npx', ['electron-vite', 'build'], { cwd: join(process.cwd(), 'apps/desktop'), stdio: 'ignore' })
  // Real windows on purpose: COCINE_HEADLESS would remove the very thing under test.
  app = await electron.launch({ args: [join(process.cwd(), 'apps/desktop')], env: { ...process.env, HOME: home } })

  const deadline = Date.now() + 30_000
  for (;;) {
    const hit = app.windows().find(w => w.url().includes('index.html') && !w.url().includes('overlay'))
    if (hit) { page = hit; break }
    if (Date.now() > deadline) throw new Error('the main window never appeared')
    await new Promise(r => setTimeout(r, 200))
  }
  await page.waitForSelector('[data-testid="stage"]', { timeout: 30_000 })
  // A film lives in a room now, so one has to exist before it can be opened.
  const started = await startServer()
  server = started.server
  await createRoom(page, started.port)
  await waitForPlayer(page)
}, 240_000)

afterAll(async () => {
  if (!canGrab) return
  await Promise.race([app?.close(), new Promise(r => setTimeout(r, 15_000))])
  await server?.close()
  rmSync(home, { recursive: true, force: true })
}, 30_000)

describe.skipIf(!canGrab)('the picture, not just the sound', () => {
  it('leaves no surface on screen before a film is open', async () => {
    // The bug this exists for: reparenting the surface into the main window
    // unmaps it, and mapping it back was done unconditionally -- so a window
    // Electron believed to be hidden sat mapped over the top-left of the
    // interface as a black rectangle, over the launch animation and over the
    // film picker, and nothing ever corrected it because Electron's own idea of
    // the window was "hidden" already.
    const x = await xClient()
    try {
      const v = await videoWindow()
      expect(v, 'the surface exists from launch, ready for a film').toBeDefined()
      expect(v!.visible, 'Electron should consider it hidden').toBe(false)
      expect(await x.mapStateOf(v!.wid), 'and X should agree').toBe('Unmapped')
      // Which is what makes this reachable at all.
      expect(await page.locator('[data-testid="welcome"]').count()).toBe(1)
    } finally { x.close() }
  }, 60_000)


  it('draws the film after opening one through the picker', async () => {
    // Opened immediately, while the launch animation may still be running --
    // the sequence that produced a blurred window with no picker and, after it,
    // a film playing into a surface nobody could see.
    await page.click('[data-testid="open"]')
    await page.waitForSelector('[data-testid="picker"]', { timeout: 15_000 })
    await page.click('[data-testid="pickerplaces"] >> text=Videos')
    await page.waitForSelector(`[data-testid="pickerfile"][data-name="${basename(film)}"]`, { timeout: 15_000 })
    await page.dblclick(`[data-testid="pickerfile"][data-name="${basename(film)}"]`)
    await expect.poll(async () => await page.textContent('aside'), { timeout: 30_000 }).toContain(basename(film))

    await page.click('[data-testid="playpause"]')
    await expect.poll(async () => await page.textContent('[data-testid="position"]'), { timeout: 20_000 })
      .not.toBe('00:00:00')

    const v = await videoWindow()
    expect(v?.visible, 'the video surface should be on screen while a film plays').toBe(true)
    const x = await xClient()
    try {
      expect(await x.mapStateOf(v!.wid), 'and X has to agree, or the picture is not there').toBe('Viewable')
    } finally { x.close() }
    expect(spread(v!.wid), 'a black rectangle means sound with no picture').toBeGreaterThan(0.05)
  }, 90_000)

  it('still draws it after the picker has covered and uncovered the surface', async () => {
    // The picker hides the surface deliberately, because it would otherwise sit
    // above the panel. Putting it back is the part that has broken before.
    await page.click('[data-testid="open"]')
    await page.waitForSelector('[data-testid="picker"]', { timeout: 15_000 })
    await expect.poll(async () => (await videoWindow())?.visible, { timeout: 10_000 }).toBe(false)

    const x = await xClient()
    try {
      expect(await x.mapStateOf((await videoWindow())!.wid), 'hidden means unmapped, or it covers the picker').toBe('Unmapped')
    } finally { x.close() }

    await page.click('[data-testid="pickercancel"]')
    await expect.poll(async () => (await videoWindow())?.visible, { timeout: 10_000 }).toBe(true)
    await new Promise(r => setTimeout(r, 1500))

    const v = await videoWindow()
    expect(spread(v!.wid)).toBeGreaterThan(0.05)
  }, 90_000)
})
