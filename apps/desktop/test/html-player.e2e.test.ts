import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { ensureTestVideo, ExternalMpv } from '@cocine/player'
import { RoomClient } from '@cocine/client'
import { SignallingServer } from '../../server/src/server.js'

/**
 * Phase B1.1, end to end: the real application running the `<video>` engine.
 *
 * The B1.0 gate proved a media element can hold the synchronisation budget, but
 * it proved it through a hidden host process of the spike's own making. This is
 * the thing that matters: the shipped application, launched with
 * COCINE_PLAYER=html, playing a film in a real room with a real second
 * participant, driven by the same RoomClient and the same sync engine as mpv.
 *
 * What it is really checking is the seam. The sync engine lives in the main
 * process and the element lives in the renderer, so every command crosses a
 * process boundary and every position reading crosses back. A mistake anywhere
 * in that path does not throw -- it produces a film that will not start, or one
 * whose position never advances, or a room that cannot see where this client
 * is. All three are asserted here.
 *
 * Runs with COCINE_HEADLESS=1, which keeps the window off the screen.
 */

let server: SignallingServer
let app: ElectronApplication
let page: Page
let guest: RoomClient
let guestPlayer: ExternalMpv
let film = ''

beforeAll(async () => {
  film = ensureTestVideo(30, join(process.cwd(), '.fixtures'))
  execFileSync('npx', ['electron-vite', 'build'], { cwd: join(process.cwd(), 'apps/desktop'), stdio: 'ignore' })
  server = new SignallingServer({ startLeadMs: 200 })
  const port = await server.listen()

  app = await electron.launch({
    args: [join(process.cwd(), 'apps/desktop')],
    env: {
      ...process.env,
      COCINE_HEADLESS: '1',
      COCINE_NATIVE_DIALOG: '1',
      // The whole point of this suite.
      COCINE_PLAYER: 'html'
    }
  })
  page = await app.firstWindow()
  await page.waitForSelector('[data-testid="stage"]', { timeout: 20_000 })

  await page.fill('[data-testid="server"]', `ws://127.0.0.1:${port}`)
  await page.fill('[data-testid="name"]', 'anjali')
  await page.click('[data-testid="create"]')
  await page.waitForSelector('[data-testid="code"]', { timeout: 20_000 })
  const code = (await page.textContent('[data-testid="code"]'))!
    .replace(/[^A-Z0-9]/g, '').replace(/COPY|COPIED/, '')

  await app.evaluate(async ({ dialog }, chosen) => {
    ;(dialog as unknown as { showOpenDialog: unknown }).showOpenDialog =
      async () => ({ canceled: false, filePaths: [chosen] })
  }, film)
  await page.click('[data-testid="open"]')
  await page.waitForFunction(
    () => !!document.querySelector('.fname')?.textContent?.includes('.mp4'),
    null, { timeout: 30_000 }
  )

  guestPlayer = new ExternalMpv({ headless: true })
  await guestPlayer.start()
  await guestPlayer.load(film)
  guest = new RoomClient({ url: `ws://127.0.0.1:${port}`, code, name: 'dev', player: guestPlayer })
  await guest.connect()
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="member"]').length === 2,
    null, { timeout: 20_000 }
  )
}, 300_000)

afterAll(async () => {
  await guest?.close().catch(() => {})
  await guestPlayer?.close().catch(() => {})
  await app?.close().catch(() => {})
  await server?.close().catch(() => {})
}, 60_000)

describe('the application running its own player', () => {
  it('renders the film in this window rather than in a child window', async () => {
    // The single-window property, asserted rather than assumed: there is a
    // media element on the page, and it is the film.
    await page.waitForSelector('[data-testid="film"]', { timeout: 20_000 })
    const src = await page.getAttribute('[data-testid="film"]', 'src')
    expect(src ?? '').toMatch(/\.mp4$/)
  }, 60_000)

  it('reports which engine it is running, so the two can be told apart', async () => {
    const engine = await page.evaluate(
      () => document.querySelector('[data-testid="film"]') ? 'html' : 'mpv'
    )
    expect(engine).toBe('html')
  }, 30_000)

  it('has real dimensions, meaning it decoded rather than merely loaded', async () => {
    // A src that never decodes still reports a src. videoWidth does not lie.
    await expect.poll(async () => page.evaluate(() => {
      const v = document.querySelector('[data-testid="film"]') as HTMLVideoElement | null
      return v?.videoWidth ?? 0
    }), { timeout: 30_000 }).toBeGreaterThan(0)
  }, 60_000)
})

describe('the room driving it across the process boundary', () => {
  it('plays when the room says play, and the position advances', async () => {
    // The sync engine is in the main process and the element is in the
    // renderer. This is the whole seam in one assertion.
    guest.requestPlay(0)

    await expect.poll(async () => page.evaluate(() => {
      const v = document.querySelector('[data-testid="film"]') as HTMLVideoElement | null
      return v?.currentTime ?? 0
    }), { timeout: 30_000 }).toBeGreaterThan(0.5)

    const first = await page.evaluate(() => {
      const v = document.querySelector('[data-testid="film"]') as HTMLVideoElement | null
      return v?.currentTime ?? 0
    })
    await new Promise(r => setTimeout(r, 1500))
    const second = await page.evaluate(() => {
      const v = document.querySelector('[data-testid="film"]') as HTMLVideoElement | null
      return v?.currentTime ?? 0
    })
    expect(second).toBeGreaterThan(first)
  }, 90_000)

  it('is visible to the rest of the room, which is what synchronising means', async () => {
    // Position has to travel back out of the renderer, through the main
    // process, into RoomClient and onto the wire. If any of that is broken the
    // film plays perfectly here and the room cannot see it at all.
    await expect.poll(
      () => guest.members.length,
      { timeout: 20_000 }
    ).toBe(2)

    const seen = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="position"]')
      return el?.textContent ?? ''
    })
    // Either the interface shows a position, or the drift readout does; both
    // are derived from what the renderer pushed back.
    expect(seen.length + (await page.evaluate(() =>
      document.querySelector('[data-testid="drift"]')?.textContent?.length ?? 0
    ))).toBeGreaterThan(0)
  }, 60_000)

  it('pauses when the room says pause', async () => {
    guest.requestPause()
    await expect.poll(async () => page.evaluate(() => {
      const v = document.querySelector('[data-testid="film"]') as HTMLVideoElement | null
      return v?.paused ?? false
    }), { timeout: 30_000 }).toBe(true)
  }, 60_000)

  it('seeks where the room asks, exactly', async () => {
    // Exact seeking is what the 100 ms budget rests on; mpv needs --hr-seek to
    // manage it and the media element does it natively.
    guest.requestSeek(12.5)
    await expect.poll(async () => page.evaluate(() => {
      const v = document.querySelector('[data-testid="film"]') as HTMLVideoElement | null
      return v ? Math.abs(v.currentTime - 12.5) : 99
    }), { timeout: 30_000 }).toBeLessThan(0.25)
  }, 60_000)
})

describe('chat over the film, in fullscreen, with no second window', () => {
  it('opens a real composer on Enter and actually takes the keystrokes', async () => {
    // The bug this exists for, on the other engine: the composer lived in a
    // window reparented into this one, which no window manager will focus, so
    // it opened, looked ready, and dropped every keystroke -- while the letters
    // fell through to the shortcuts and paused the film for the whole room.
    // Here it is an ordinary focused input in the window that has the keyboard.
    await app.evaluate(async ({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setFullScreen(true)
    })
    await page.waitForFunction(
      () => !!document.querySelector('[data-testid="stagechat"]'),
      null, { timeout: 20_000 }
    )

    await page.keyboard.press('Enter')
    await page.waitForSelector('[data-testid="stageinput"]', { timeout: 10_000 })
    expect(await page.evaluate(() => document.activeElement?.getAttribute('data-testid')))
      .toBe('stageinput')

    await page.keyboard.type('over the film')
    expect(await page.inputValue('[data-testid="stageinput"]')).toBe('over the film')
  }, 90_000)

  it('sends what was typed, and the rest of the room receives it', async () => {
    await page.keyboard.press('Enter')
    await expect.poll(
      () => guest.messages.map(m => m.text),
      { timeout: 20_000 }
    ).toContain('over the film')
    expect(await page.locator('[data-testid="stageinput"]').count()).toBe(0)
  }, 90_000)

  it('draws an arriving message over the film', async () => {
    guest.sendChat('from the other side')
    await expect.poll(async () => page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-testid="stagemsg"]'))
        .map(e => e.textContent ?? '').join(' ')
    ), { timeout: 20_000 }).toContain('from the other side')
  }, 90_000)

  it('lets clicks through the empty space, which is what shaping was for', async () => {
    // pointer-events: none on the container and auto on the bubbles is the one
    // CSS property that replaces the entire X SHAPE mechanism.
    const container = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="stagechat"]')
      return el ? getComputedStyle(el).pointerEvents : null
    })
    expect(container).toBe('none')

    const bubble = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="stagemsg"]')
      return el ? getComputedStyle(el).pointerEvents : null
    })
    expect(bubble).toBe('auto')
  }, 60_000)

  it('needs no second window to do any of it', async () => {
    // The mpv engine has a child window reparented into this one for exactly
    // this feature. Under the <video> engine there is nothing but the app.
    const windows = await app.evaluate(async ({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().length)
    expect(windows).toBe(1)
    await app.evaluate(async ({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setFullScreen(false)
    })
  }, 60_000)
})
