import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { writeFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
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
  beforeAll(async () => {
    await app.evaluate(async ({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setFullScreen(true)
    })
    await page.waitForFunction(
      () => !!document.querySelector('[data-testid="stagechat"]'),
      null, { timeout: 20_000 }
    )
  }, 60_000)

  afterAll(async () => {
    await app.evaluate(async ({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setFullScreen(false)
    })
  })

  const barShown = (): Promise<boolean> => page.evaluate(() =>
    document.querySelector('[data-testid="stagebar"]')?.classList.contains('shown') ?? false)

  /**
   * Bring the bar up and put the keyboard in its chat box.
   *
   * Each test does this for itself. Relying on the previous one to have left
   * the bar up is order-dependence, which bit this suite twice already: a click
   * *toggles*, so a test following one that left it up hides it instead.
   */
  const openChat = async (): Promise<void> => {
    if (!await barShown()) await page.click('[data-testid="stage"]', { position: { x: 200, y: 120 } })
    await expect.poll(barShown, { timeout: 10_000 }).toBe(true)
    await page.click('[data-testid="stageinput"]')
    await expect.poll(
      async () => page.evaluate(() => document.activeElement?.getAttribute('data-testid')),
      { timeout: 10_000 }
    ).toBe('stageinput')
    // Emptied, because the box is a permanent part of the bar now: whatever a
    // previous test typed and did not send is still sitting in it.
    await page.locator('[data-testid="stageinput"]').fill('')
  }

  it('has a visible box to type in, rather than only a shortcut', async () => {
    // The bug this replaces: the composer opened on Enter and nothing on screen
    // said so, so in practice there was no way to type in fullscreen at all
    // unless you already knew. It is part of the control bar now.
    await page.click('[data-testid="stage"]', { position: { x: 200, y: 120 } })
    await expect.poll(barShown, { timeout: 10_000 }).toBe(true)
    await page.hover('[data-testid="stagebar"]')
    expect(await page.locator('[data-testid="stageinput"]').count()).toBe(1)
  }, 60_000)

  it('takes the keystrokes, and the bar does not vanish mid-sentence', async () => {
    const line = `typed over the film ${Date.now()}`
    await openChat()
    await page.keyboard.type(line)
    expect(await page.inputValue('[data-testid="stageinput"]')).toBe(line)

    // Somebody halfway through a sentence is using the bar as much as somebody
    // with a hand on it, so the countdown must be suspended for them too.
    await new Promise(r => setTimeout(r, 5000))
    expect(await barShown(), 'the bar hid itself while a message was being typed').toBe(true)
    // And for the right reason: the keyboard is in it, not a pointer on it.
    expect(await page.getAttribute('[data-testid="stagebar"]', 'data-keepopen')).toBe('1')
    expect(await page.inputValue('[data-testid="stageinput"]')).toBe(line)
  }, 90_000)

  it('sends on Enter and keeps the box for the next line', async () => {
    // Its own message rather than the one the previous test sent, so a pass
    // here cannot be somebody else's success arriving late.
    const line = `sent from the bar ${Date.now()}`
    await openChat()
    await page.keyboard.type(line)
    expect(await page.inputValue('[data-testid="stageinput"]')).toBe(line)
    await page.keyboard.press('Enter')
    await expect.poll(
      () => guest.messages.map(m => m.text),
      { timeout: 20_000 }
    ).toContain(line)
    // Emptied rather than closed: whoever said one thing usually says another.
    expect(await page.inputValue('[data-testid="stageinput"]')).toBe('')
    expect(await page.locator('[data-testid="stageinput"]').count()).toBe(1)
  }, 90_000)

  it('opens and focuses the box when Enter is pressed over the film', async () => {
    // The shortcut still works, and now it brings the bar up with it rather
    // than asking a hidden field for the keyboard.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await page.mouse.move(5, 5)
    await expect.poll(barShown, { timeout: 15_000 }).toBe(false)

    await page.keyboard.press('Enter')
    await expect.poll(barShown, { timeout: 10_000 }).toBe(true)
    await expect.poll(
      async () => page.evaluate(() => document.activeElement?.getAttribute('data-testid')),
      { timeout: 10_000 }
    ).toBe('stageinput')
  }, 60_000)

  it('lets go of the keyboard on Escape, so the film shortcuts work again', async () => {
    await page.keyboard.press('Escape')
    await expect.poll(
      async () => page.evaluate(() => document.activeElement?.getAttribute('data-testid')),
      { timeout: 10_000 }
    ).not.toBe('stageinput')
  }, 60_000)

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
    expect(await page.evaluate(() => {
      const el = document.querySelector('[data-testid="stagechat"]')
      return el ? getComputedStyle(el).pointerEvents : null
    })).toBe('none')
    expect(await page.evaluate(() => {
      const el = document.querySelector('[data-testid="stagemsg"]')
      return el ? getComputedStyle(el).pointerEvents : null
    })).toBe('auto')
  }, 60_000)

  it('needs no second window to do any of it', async () => {
    const windows = await app.evaluate(async ({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().length)
    expect(windows).toBe(1)
  }, 60_000)
})

describe('a format Chromium refuses (B1.5)', () => {
  /**
   * The real check. An AVI carrying Xvid fails in Chromium with
   * DEMUXER_ERROR_COULD_NOT_OPEN -- measured, not assumed -- so the application
   * has to notice and convert it before handing it to the element. Everything
   * up to here has used files that play directly.
   */
  let avi = ''
  const haveFfmpeg = (): boolean => {
    try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true } catch { return false }
  }

  beforeAll(() => {
    if (!haveFfmpeg()) return
    avi = join(dirname(film), 'legacy-rip.avi')
    execFileSync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=24:duration=6',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6',
      '-c:v', 'mpeg4', '-vtag', 'XVID', '-c:a', 'libmp3lame', '-shortest', avi
    ], { stdio: 'ignore' })
  }, 120_000)
  afterAll(() => { try { if (avi) rmSync(avi, { force: true }) } catch { /* gone */ } })

  it.skipIf(!haveFfmpeg())('converts it and plays it, rather than showing a black rectangle', async () => {
    await app.evaluate(async ({ dialog }, chosen) => {
      ;(dialog as unknown as { showOpenDialog: unknown }).showOpenDialog =
        async () => ({ canceled: false, filePaths: [chosen] })
    }, avi)
    await page.click('[data-testid="unloadfilm"]').catch(() => { /* nothing open */ })
    await page.click('[data-testid="open"]')

    // It decodes, which an unconverted Xvid AVI never would.
    await expect.poll(async () => page.evaluate(() => {
      const v = document.querySelector('[data-testid="film"]') as HTMLVideoElement | null
      return v?.videoWidth ?? 0
    }), { timeout: 120_000 }).toBeGreaterThan(0)

    // And what is playing is the converted copy, not the AVI itself.
    const src = await page.getAttribute('[data-testid="film"]', 'src')
    expect(src ?? '').not.toMatch(/\.avi$/)
    expect(src ?? '').toMatch(/\.mkv$/)
  }, 180_000)

  it.skipIf(!haveFfmpeg())('plays the converted copy rather than converting it twice', async () => {
    // Keyed on the source's path, size and modification time, so opening the
    // same film again is instant.
    const before = await page.getAttribute('[data-testid="film"]', 'src')
    await page.click('[data-testid="unloadfilm"]')
    await page.click('[data-testid="open"]')
    await expect.poll(
      async () => page.getAttribute('[data-testid="film"]', 'src'),
      { timeout: 60_000 }
    ).toBe(before)
  }, 120_000)
})

describe('controls over the film in fullscreen', () => {
  /**
   * There is no footer in fullscreen -- the whole screen is the film -- so the
   * controls are drawn above it. The third thing in this phase that is trivial
   * with the film in this window and was impossible under mpv, where nothing
   * could be put above the surface at all.
   */
  beforeAll(async () => {
    await app.evaluate(async ({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setFullScreen(true)
    })
    await page.waitForFunction(
      () => !!document.querySelector('[data-testid="stagebar"]'),
      null, { timeout: 20_000 }
    )
  }, 60_000)

  afterAll(async () => {
    await app.evaluate(async ({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setFullScreen(false)
    })
  })

  const shown = (): Promise<boolean> => page.evaluate(() =>
    document.querySelector('[data-testid="stagebar"]')?.classList.contains('shown') ?? false)

  /**
   * Put the bar in a known state before each test.
   *
   * A click *toggles*, so a test running after one that left the bar up would
   * hide it and then wait for it to appear -- which is what these did until the
   * pointer was moved away first. Order-dependence in a suite is its own bug.
   */
  beforeEach(async () => {
    // Both holds have to be let go, not just the pointer: a chat box that still
    // has the keyboard keeps the bar up for as long as it holds it, which is
    // the whole point of that behaviour and made this wait for ever.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await page.mouse.move(5, 5)
    // Wait for the hold to actually let go before judging anything about the
    // countdown: blurring is asynchronous through React state, and a test that
    // raced it was measuring the previous test's chat box.
    await expect.poll(
      async () => page.getAttribute('[data-testid="stagebar"]', 'data-keepopen'),
      { timeout: 10_000 }
    ).toBe('0')
    // Toggled shut rather than waited out. Waiting on the countdown is at the
    // mercy of whatever is still holding the bar open -- a pointer, a focused
    // chat box -- and toggling is what a person would do anyway.
    if (await shown()) {
      await page.click('[data-testid="stage"]', { position: { x: 200, y: 120 } })
      await expect.poll(shown, { timeout: 10_000 }).toBe(false)
    }
  })

  /** Show the bar and keep it up, the way a hand on it would. */
  const openBar = async (): Promise<void> => {
    if (!await shown()) await page.click('[data-testid="stage"]', { position: { x: 200, y: 120 } })
    await expect.poll(shown, { timeout: 10_000 }).toBe(true)
    await page.hover('[data-testid="stagebar"]')
  }

  /**
   * Press something on the bar, making sure the bar is up first.
   *
   * Whether it stays up under the pointer is asserted on its own above; these
   * tests are about what the buttons *do*, and they should not fail because of
   * a few milliseconds of timing around the countdown.
   */
  const pressOnBar = async (id: string): Promise<void> => {
    await openBar()
    await page.click(`[data-testid="${id}"]`)
  }

  it('stays out of the way until it is asked for', async () => {
    // A bar across the bottom of a film somebody is watching is exactly what a
    // player should not do.
    expect(await shown()).toBe(false)
    expect(await page.evaluate(() =>
      getComputedStyle(document.querySelector('[data-testid="stagebar"]')!).pointerEvents
    )).toBe('none')
  }, 30_000)

  it('appears on a click on the film, and goes away again on its own', async () => {
    // Deliberately not hovering it afterwards: the point is that it hides
    // itself when nobody is using it.
    await page.click('[data-testid="stage"]', { position: { x: 200, y: 120 } })
    await expect.poll(shown, { timeout: 10_000 }).toBe(true)
    // Nothing holding it: no pointer on it, no keyboard in it.
    expect(await page.getAttribute('[data-testid="stagebar"]', 'data-keepopen')).toBe('0')
    // It takes itself away after a few quiet seconds rather than staying up.
    // Nothing is holding it: neither a pointer on it nor a keyboard in it.
    // Asserted rather than assumed, because a bar that stays up for one of
    // those reasons looks identical to one whose countdown is broken.
    expect(await page.getAttribute('[data-testid="stagebar"]', 'data-hover')).toBe('0')
    await expect.poll(shown, { timeout: 15_000 }).toBe(false)
  }, 60_000)

  it('carries play, seek, volume and a way out of fullscreen', async () => {
    await openBar()
    for (const id of ['stageplaypause', 'stagescrub', 'stagevolume', 'stagemute', 'stagefullscreen']) {
      expect(await page.locator(`[data-testid="${id}"]`).count(), id).toBe(1)
    }
    expect(await page.textContent('[data-testid="stageduration"]')).not.toBe('00:00:00')
  }, 60_000)

  it('does not vanish while the pointer is resting on it', async () => {
    // The most irritating thing a control bar can do is disappear mid-drag. A
    // hand resting still on the volume slider is using it just as much as one
    // that is moving, so the countdown is suspended by the pointer being there
    // rather than by movement.
    await openBar()
    // Comfortably longer than the countdown, without touching anything.
    await new Promise(r => setTimeout(r, 5000))
    expect(await shown(), 'the bar hid itself from under the pointer').toBe(true)

    // And it does go once the pointer leaves.
    await page.mouse.move(10, 10)
    await expect.poll(shown, { timeout: 15_000 }).toBe(false)
  }, 60_000)

  it('changes the film volume, and mutes and unmutes', async () => {
    await openBar()
    await page.locator('[data-testid="stagevolume"]').fill('40')
    await expect.poll(async () => page.evaluate(() => {
      const v = document.querySelector('[data-testid="film"]') as HTMLVideoElement | null
      return Math.round((v?.volume ?? 1) * 100)
    }), { timeout: 15_000 }).toBe(40)

    await pressOnBar('stagemute')
    await expect.poll(async () => page.evaluate(() => {
      const v = document.querySelector('[data-testid="film"]') as HTMLVideoElement | null
      return v?.muted ?? false
    }), { timeout: 15_000 }).toBe(true)

    await pressOnBar('stagemute')
    await expect.poll(async () => page.evaluate(() => {
      const v = document.querySelector('[data-testid="film"]') as HTMLVideoElement | null
      return Math.round((v?.volume ?? 0) * 100)
    }), { timeout: 15_000 }).toBe(100)
  }, 90_000)

  it('leaves fullscreen from its own button', async () => {
    await pressOnBar('stagefullscreen')
    await expect.poll(
      () => app.evaluate(async ({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]?.isFullScreen() ?? false),
      { timeout: 20_000 }
    ).toBe(false)
    // And the bar goes with it: the footer is back, and two sets of controls
    // over a windowed film would be one too many.
    expect(await page.locator('[data-testid="stagebar"]').count()).toBe(0)
  }, 60_000)
})
