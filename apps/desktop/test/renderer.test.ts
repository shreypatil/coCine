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
  members: [{ id: '1', name: 'anjali', isHost: true, mayControl: true, inVoice: false, muted: false, deafened: false }],
  mediaName: 'dune.mkv', durationSec: 7200,
  positionSec: 12, expectedSec: 12, driftMs: 4,
  paused: true, rate: 1, clockOffsetMs: 3, rttMs: 20, lastAction: 'none',
  fullscreen: false,
  code: 'BCDFGHJK', messages: [] as unknown[], isHost: true, mayControl: true,
  transfers: [] as unknown[], receiving: null as unknown,
  phase: 'playing', waitForLatecomers: true, openControl: true, nativePicker: true, windowShown: true, sharing: 'off', sharedInfoHash: null, transferStatus: null as unknown,
    memberId: 'me',
    mode: 'p2p', originAvailable: false, voiceIce: [] as unknown[],
    startupError: null as unknown
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
  page = await browser.newPage({ viewport, permissions: ['clipboard-read', 'clipboard-write'] })
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
      browseActive: rec('browseActive'),
      browseStart: () => {
        (w.__calls as Array<{ name: string; args: unknown[] }>).push({ name: 'browseStart', args: [] })
        return Promise.resolve({ places: [{ label: 'Home', path: '/home/anjali' }, { label: 'Videos', path: '/home/anjali/Videos' }], path: '/home/anjali' })
      },
      browseList: (path: string, showAll?: boolean) => {
        (w.__calls as Array<{ name: string; args: unknown[] }>).push({ name: 'browseList', args: [path, showAll] })
        const dirs = (w.__tree ?? {}) as Record<string, unknown>
        const hit = dirs[path]
        if (!hit) return Promise.reject(new Error(`Could not open ${path}`))
        return Promise.resolve(hit)
      },
      pathForFile: () => '/films/stub.mkv',
      getIdentity: () => Promise.resolve({ id: 'local-1', name: 'anjali', server: 'ws://box:9000', lastCode: 'BCDFGHJK' }),
      listFilms: () => {
        (w.__calls as Array<{ name: string; args: unknown[] }>).push({ name: 'listFilms', args: [] })
        return Promise.resolve(w.__library ?? { films: [], usedBytes: 0, freeBytes: 500 * 1024 ** 3 })
      },
      removeFilm: rec('removeFilm'),
      startAnyway: rec('startAnyway'),
      setWaitForLatecomers: rec('setWaitForLatecomers'),
        setMode: rec('setMode'),
        setOpenControl: rec('setOpenControl'),
        shareFilm: rec('shareFilm'),
        setSharingPaused: rec('setSharingPaused'),
        unloadFilm: rec('unloadFilm'),
        focusChat: rec('focusChat'),
      sendSignal: rec('sendSignal'),
      setVoiceState: rec('setVoiceState'),
      moderateVoice: rec('moderateVoice'),
      duckFilm: rec('duckFilm'),
      onSignal: () => () => {},
      onModerated: (cb: (by: string, action: string) => void) => { w.__moderated = cb; return () => {} },
      connect: rec('connect'),
      disconnect: rec('disconnect'),
      play: rec('play'),
      pause: rec('pause'),
      seek: rec('seek'),
      setFullScreen: rec('setFullScreen'),
      sendChat: rec('sendChat'),
      setControl: rec('setControl'),
      transferHost: rec('transferHost'),
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
    await page.click('[data-testid="name"]')
    await page.keyboard.press('Space')
    await page.keyboard.press('f')
    expect(await calls('play')).toHaveLength(0)
    expect(await calls('setFullScreen')).toHaveLength(0)
    await page.close()
  })
})

const MSGS = [
  { id: '1', kind: 'joined', memberId: 'a', name: 'anjali', text: 'joined the room', atServerMs: 1_700_000_000_000 },
  { id: '2', kind: 'said', memberId: 'a', name: 'anjali', text: 'starting in five', atServerMs: 1_700_000_060_000 },
  { id: '3', kind: 'system', memberId: 'a', name: 'anjali', text: 'put on dune.mkv', atServerMs: 1_700_000_120_000 }
]

describe('voice', () => {
  const inVoice = [
    { id: 'me', name: 'anjali', isHost: true, mayControl: true, inVoice: true, muted: false, deafened: false },
    { id: 'b', name: 'dev', isHost: false, mayControl: true, inVoice: true, muted: true, deafened: false }
  ]

  it('offers to join, and says how to talk before you do', async () => {
    await open()
    await push()
    await page.waitForSelector('[data-testid="joinvoice"]')
    const text = await page.textContent('[data-testid="voice"]')
    expect(text).toContain('Hold')
    expect(text).toContain('Headphones')
    await page.close()
  })

  it('marks who is in voice and who is muted', async () => {
    await open()
    await push({ members: inVoice })
    expect(await page.locator('[data-testid="vdot"]').count()).toBe(2)
    expect(await page.locator('[data-testid="vdot"].off').count()).toBe(1)
    await page.close()
  })

  it('shows a deafened person as unable to hear the room', async () => {
    await open()
    await push({ members: [inVoice[0], { ...inVoice[1], deafened: true }] })
    expect(await page.textContent('[data-testid="member"][data-name="dev"]')).toContain('deafened')
    await page.close()
  })

  it('lets the host ask someone in voice to mute', async () => {
    await open()
    await push({ members: inVoice, isHost: true })
    await page.hover('[data-testid="member"][data-name="dev"]')
    await page.click('[data-testid="member"][data-name="dev"] [data-testid="mutethem"]')
    expect((await calls('moderateVoice'))[0]).toEqual(['b', 'unmute'])
    await page.close()
  })

  it('offers that to the host only', async () => {
    await open()
    await push({ members: inVoice, isHost: false })
    await page.hover('[data-testid="member"][data-name="dev"]')
    expect(await page.locator('[data-testid="mutethem"]').count()).toBe(0)
    await page.close()
  })

  it('complies when the host asks it to mute, and says who asked', async () => {
    // Advisory by nature: nothing forces this, the client chooses to comply.
    await open()
    await push({ members: inVoice })
    await page.evaluate(() => {
      const w = window as unknown as Record<string, unknown>
      ;(w.__moderated as (by: string, a: string) => void)('anjali', 'mute')
    })
    await expect.poll(async () => await page.textContent('[data-testid="voice"]')).toContain('anjali muted you')
    await page.close()
  })
})

describe('the readiness gate', () => {
  const status = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    perPeer: [
      { memberId: 'a', name: 'anjali', havePct: 1, bufferEndSec: 900, downBps: 0, upBps: 5e6, peers: 2, ready: true },
      { memberId: 'b', name: 'dev', havePct: 0.42, bufferEndSec: 8, downBps: 3e6, upBps: 1e6, peers: 2, ready: false }
    ],
    etaSec: 240, tMinSec: 130, bottleneck: 'dev', fullCopies: 1, safeForSharerToLeave: false,
    ...over
  })

  it('shows who is holding the room up, and for how long', async () => {
    await open()
    await push({ phase: 'preparing', transferStatus: status() })
    await page.waitForSelector('[data-testid="gate"]')
    expect(await page.textContent('[data-testid="eta"]')).toContain('about 4 min')
    expect(await page.textContent('[data-testid="eta"]')).toContain('dev')
    expect(await page.locator('[data-testid="peerstatus"]').count()).toBe(2)
    expect(await page.textContent('[data-testid="peerstatus"][data-name="dev"]')).toContain('42%')
    await page.close()
  })

  it('shows the floor as well as the estimate, so the wait is explicable', async () => {
    await open()
    await push({ phase: 'preparing', transferStatus: status() })
    await page.waitForSelector('[data-testid="floor"]')
    expect(await page.textContent('[data-testid="floor"]')).toContain('about 2 min')
    await page.close()
  })

  it('admits when it cannot estimate rather than inventing a number', async () => {
    await open()
    await push({ phase: 'preparing', transferStatus: status({ etaSec: null }) })
    await page.waitForSelector('[data-testid="eta"]')
    expect(await page.textContent('[data-testid="eta"]')).toContain('working it out')
    await page.close()
  })

  it('says whether the film survives the sharer leaving', async () => {
    await open()
    await push({ phase: 'preparing', transferStatus: status() })
    expect(await page.textContent('[data-testid="durability"]')).toContain('needs the sharer')
    await push({ phase: 'preparing', transferStatus: status({ fullCopies: 2, safeForSharerToLeave: true }) })
    expect(await page.textContent('[data-testid="durability"]')).toContain('Safe for the sharer to leave')
    await page.close()
  })

  it('offers the host a way past the gate, naming who gets left behind', async () => {
    await open()
    await push({ phase: 'preparing', transferStatus: status(), isHost: true })
    const label = await page.textContent('[data-testid="startanyway"]')
    expect(label).toContain('dev')
    await page.click('[data-testid="startanyway"]')
    expect(await calls('startAnyway')).toHaveLength(1)
    await page.close()
  })

  it('offers that override to the host only', async () => {
    await open()
    await push({ phase: 'preparing', transferStatus: status(), isHost: false })
    expect(await page.locator('[data-testid="startanyway"]').count()).toBe(0)
    await page.close()
  })

  it('lets the host decide whether the room waits for latecomers', async () => {
    await open()
    await push({ phase: 'preparing', transferStatus: status(), isHost: true, waitForLatecomers: true })
    expect(await page.isChecked('[data-testid="waitlate"]')).toBe(true)
    // Controlled by server state, so it stays checked until the server says
    // otherwise. What matters is that clicking asks; the box follows the room.
    await page.click('[data-testid="waitlate"]')
    expect((await calls('setWaitForLatecomers'))[0]).toEqual([false])
    expect(await page.isChecked('[data-testid="waitlate"]')).toBe(true)

    await push({ phase: 'preparing', transferStatus: status(), isHost: true, waitForLatecomers: false })
    expect(await page.isChecked('[data-testid="waitlate"]')).toBe(false)
    await page.close()
  })

  it('drops the waiting-for-people parts once the film is playing, and keeps the numbers', async () => {
    // The countdown and the override belong to the wait. What the transfer is
    // doing is worth seeing for as long as it is happening.
    await open()
    await push({ phase: 'playing', transferStatus: status({ bottleneck: null }), isHost: true })
    expect(await page.locator('[data-testid="eta"]').count()).toBe(0)
    expect(await page.locator('[data-testid="startanyway"]').count()).toBe(0)
    expect(await page.locator('[data-testid="gate"]').count()).toBe(1)
    expect(await page.locator('[data-testid="peerstatus"]').count()).toBe(2)
    await page.close()
  })
})

describe('films on disk', () => {
  const FILMS = {
    films: [
      { infoHash: 'a'.repeat(40), name: 'dune.mkv', path: '/f/a/dune.mkv', bytes: 4 * 1024 ** 3, onDiskBytes: 4 * 1024 ** 3, complete: true, addedAtMs: 2 },
      { infoHash: 'b'.repeat(40), name: 'arrival.mkv', path: '/f/b/arrival.mkv', bytes: 2 * 1024 ** 3, onDiskBytes: 1024 ** 3, complete: false, addedAtMs: 1 }
    ],
    usedBytes: 5 * 1024 ** 3,
    freeBytes: 120 * 1024 ** 3
  }

  const openLibrary = async (): Promise<void> => {
    await page.evaluate(l => { (window as unknown as Record<string, unknown>).__library = l }, FILMS)
    await push()
    await page.click('[data-testid="films"]')
    await page.waitForSelector('[data-testid="storedfilm"]')
  }

  it('lists what is stored, in gigabytes rather than bytes', async () => {
    await open()
    await openLibrary()
    expect(await page.locator('[data-testid="storedfilm"]').count()).toBe(2)
    expect(await page.textContent('[data-testid="library"]')).toContain('4.0 GB')
    expect(await page.textContent('[data-testid="library"]')).toContain('120.0 GB free')
    await page.close()
  })

  it('marks a partial download rather than pretending it is whole', async () => {
    await open()
    await openLibrary()
    const row = await page.textContent('[data-testid="storedfilm"][data-name="arrival.mkv"]')
    expect(row).toContain('1.0 GB of 2.0 GB')
    expect(row).toContain('partial')
    await page.close()
  })

  it('deletes a film', async () => {
    await open()
    await openLibrary()
    await page.click('[data-testid="storedfilm"][data-name="dune.mkv"] [data-testid="removefilm"]')
    expect((await calls('removeFilm'))[0]).toEqual(['a'.repeat(40)])
    await page.close()
  })

  it('says so plainly when nothing is stored', async () => {
    await open()
    await push()
    await page.click('[data-testid="films"]')
    await page.waitForSelector('[data-testid="library"]')
    expect(await page.textContent('[data-testid="library"]')).toContain('Nothing stored yet')
    await page.close()
  })

  it('returns to the room when toggled off', async () => {
    await open()
    await openLibrary()
    await page.click('[data-testid="films"]')
    expect(await page.locator('[data-testid="library"]').count()).toBe(0)
    expect(await page.locator('[data-testid="chat"]').count()).toBe(1)
    await page.close()
  })
})

describe('receiving a film', () => {
  it('shows progress instead of the film details while one is arriving', async () => {
    await open()
    await push({
      receiving: { name: 'dune.mkv', infoHash: 'a'.repeat(40) },
      transfers: [{ infoHash: 'a'.repeat(40), name: 'dune.mkv', progress: 0.42, downBps: 3 * 1024 ** 2, upBps: 0, peers: 3, done: false, bytes: 100 }]
    })
    await page.waitForSelector('[data-testid="receivebar"]')
    const text = await page.textContent('.sect.film')
    expect(text).toContain('42%')
    expect(text).toContain('3.0 MB/s')
    expect(text).toContain('3 peers')
    await page.close()
  })
})

describe('remembered identity', () => {
  it('fills the join panel from what was stored, instead of asking again', async () => {
    await open()
    await push({ connected: false })
    await expect.poll(async () => await page.inputValue('[data-testid="name"]')).toBe('anjali')
    expect(await page.inputValue('[data-testid="server"]')).toBe('ws://box:9000')
    expect(await page.inputValue('[data-testid="joincode"]')).toBe('BCDFGHJK')
    await page.close()
  })

  it('offers a way back to the default when the stored address is not it', async () => {
    // A stored address that no longer works is otherwise a dead end: the field
    // is prefilled with it and nothing says what it should have been.
    await open()
    await push({ connected: false })
    await expect.poll(async () => await page.inputValue('[data-testid="server"]')).toBe('ws://box:9000')
    await page.click('[data-testid="resetserver"]')
    expect(await page.inputValue('[data-testid="server"]')).toBe('ws://127.0.0.1:8787')
    expect(await page.locator('[data-testid="resetserver"]').count()).toBe(0)
    await page.close()
  })

  it('refuses to join with a blank name', async () => {
    await open()
    await push({ connected: false })
    await expect.poll(async () => await page.inputValue('[data-testid="name"]')).toBe('anjali')
    await page.fill('[data-testid="name"]', '   ')
    expect(await page.isDisabled('[data-testid="create"]')).toBe(true)
    expect(await page.isDisabled('[data-testid="join"]')).toBe(true)
    await page.close()
  })
})

describe('chat', () => {
  it('renders conversation and room events in the same column', async () => {
    await open()
    await push({ messages: MSGS })
    expect(await page.locator('[data-testid="msg"]').count()).toBe(3)
    expect(await page.textContent('[data-testid="chat"]')).toContain('starting in five')
    expect(await page.textContent('[data-testid="chat"]')).toContain('put on dune.mkv')
    // Conversation gets an avatar; room events do not.
    expect(await page.locator('.msg .av').count()).toBe(1)
    await page.close()
  })

  it('sends on Enter and clears the field', async () => {
    await open()
    await push()
    await page.fill('[data-testid="chatinput"]', 'this bit is great')
    await page.press('[data-testid="chatinput"]', 'Enter')
    expect((await calls('sendChat'))[0]).toEqual(['this bit is great'])
    expect(await page.inputValue('[data-testid="chatinput"]')).toBe('')
    await page.close()
  })

  it('refuses to send whitespace', async () => {
    await open()
    await push()
    await page.fill('[data-testid="chatinput"]', '   ')
    await page.press('[data-testid="chatinput"]', 'Enter')
    expect(await calls('sendChat')).toHaveLength(0)
    await page.close()
  })

  it('follows new messages, including a backlog present on first render', async () => {
    await open()
    const many = Array.from({ length: 40 }, (_, i) => ({
      id: `m${i}`, kind: 'said', memberId: 'a', name: 'anjali', text: `line ${i}`, atServerMs: 1_700_000_000_000 + i
    }))
    await push({ messages: many })
    await page.waitForTimeout(120)
    // And keeps following as more arrive.
    await push({ messages: [...many, { id: 'x', kind: 'said', memberId: 'a', name: 'dev', text: 'one more', atServerMs: 1 }] })
    await page.waitForTimeout(120)
    const atBottom = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="chat"]')!
      return el.scrollHeight - el.scrollTop - el.clientHeight
    })
    expect(atBottom).toBeLessThan(90)
    await page.close()
  })
})

describe('chat scrolling', () => {
  it('stays put when someone has scrolled up to read back', async () => {
    await open()
    const many = Array.from({ length: 40 }, (_, i) => ({
      id: `m${i}`, kind: 'said', memberId: 'a', name: 'anjali', text: `line ${i}`, atServerMs: 1_700_000_000_000 + i
    }))
    await push({ messages: many })
    await page.waitForTimeout(120)
    await page.evaluate(() => { document.querySelector('[data-testid="chat"]')!.scrollTop = 0 })
    await page.waitForTimeout(60)
    await push({ messages: [...many, { id: 'x', kind: 'said', memberId: 'a', name: 'dev', text: 'new line', atServerMs: 2 }] })
    await page.waitForTimeout(120)
    expect(await page.evaluate(() => document.querySelector('[data-testid="chat"]')!.scrollTop)).toBe(0)
    await page.close()
  })
})

describe('room code', () => {
  it('shows the code in a readable grouped form', async () => {
    await open()
    await push({ code: 'BCDFGHJK' })
    expect(await page.textContent('[data-testid="code"]')).toContain('BCDF-GHJK')
    await page.close()
  })

  it('copies it to the clipboard and says so', async () => {
    await open()
    await push({ code: 'BCDFGHJK' })
    await page.click('[data-testid="code"]')
    await expect.poll(async () => await page.textContent('[data-testid="code"]')).toContain('copied')
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('BCDF-GHJK')
    await page.close()
  })
})

describe('roles', () => {
  const members = [
    { id: 'a', name: 'anjali', isHost: true, mayControl: true, inVoice: false, muted: false, deafened: false },
    { id: 'b', name: 'dev', isHost: false, mayControl: true, inVoice: false, muted: false, deafened: false }
  ]

  it('offers role actions to the host only', async () => {
    await open()
    await push({ members, isHost: true })
    await page.hover('[data-testid="member"][data-name="dev"]')
    expect(await page.locator('[data-testid="togglecontrol"]').count()).toBe(1)
    await push({ members, isHost: false })
    expect(await page.locator('[data-testid="togglecontrol"]').count()).toBe(0)
    await page.close()
  })

  it('toggles playback control to the opposite of what it is', async () => {
    await open()
    await push({ members, isHost: true })
    await page.hover('[data-testid="member"][data-name="dev"]')
    await page.click('[data-testid="member"][data-name="dev"] [data-testid="togglecontrol"]')
    expect((await calls('setControl'))[0]).toEqual(['b', false])
    await page.close()
  })

  it('hands hosting over', async () => {
    await open()
    await push({ members, isHost: true })
    await page.hover('[data-testid="member"][data-name="dev"]')
    await page.click('[data-testid="member"][data-name="dev"] [data-testid="makehost"]')
    expect((await calls('transferHost'))[0]).toEqual(['b'])
    await page.close()
  })

  it('marks someone who cannot control playback', async () => {
    await open()
    await push({ members: [members[0], { ...members[1], mayControl: false }], isHost: false })
    expect(await page.textContent('[data-testid="member"][data-name="dev"]')).toContain('no control')
    await page.close()
  })

  it('disables the transport when the host has withheld control', async () => {
    await open()
    await push({ connected: true, mayControl: false })
    expect(await page.isDisabled('[data-testid="playpause"]')).toBe(true)
    expect(await page.isDisabled('.scrub')).toBe(true)
    await push({ connected: true, mayControl: true })
    expect(await page.isDisabled('[data-testid="playpause"]')).toBe(false)
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

  it('strips Electron IPC wrapping from an error before showing it', async () => {
    await open()
    await push()
    await page.evaluate(() => {
      const w = window as unknown as Record<string, unknown>
      w.cocine = {
        ...(w.cocine as object),
        openFile: () => Promise.reject(new Error("Error invoking remote method 'file:open': Error: Nothing is listening at ws://x"))
      }
    })
    await page.click('[data-testid="open"]')
    await expect.poll(async () => await page.textContent('[data-testid="banner"]')).toContain('Nothing is listening')
    expect(await page.textContent('[data-testid="banner"]')).not.toContain('remote method')
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

describe('choosing how the film is shared', () => {
  it('offers the host a choice of transport only when the server has storage', async () => {
    await open()
    await push({ isHost: true, originAvailable: false })
    // A toggle that fails when pressed is worse than no toggle at all.
    expect(await page.locator('[data-testid="sharemode"]').count()).toBe(0)

    await push({ isHost: true, originAvailable: true })
    expect(await page.locator('[data-testid="sharemode"]').count()).toBe(1)
    await page.close()
  })

  it('does not offer the transport choice to anyone but the host', async () => {
    await open()
    await push({ isHost: false, originAvailable: true })
    expect(await page.locator('[data-testid="sharemode"]').count()).toBe(0)
    await page.close()
  })

  it('asks the server to switch transport, and follows the room rather than itself', async () => {
    await open()
    await push({ isHost: true, originAvailable: true, mode: 'p2p' })
    expect(await page.inputValue('[data-testid="modeselect"]')).toBe('p2p')

    await page.selectOption('[data-testid="modeselect"]', 'origin')
    expect((await calls('setMode'))[0]).toEqual(['origin'])

    // The room's mode is server state: the control shows what the room says, not
    // what was clicked, so a rejected change cannot leave the interface claiming
    // something untrue.
    expect(await page.inputValue('[data-testid="modeselect"]')).toBe('p2p')
    await push({ isHost: true, originAvailable: true, mode: 'origin' })
    expect(await page.inputValue('[data-testid="modeselect"]')).toBe('origin')
    await page.close()
  })

  it('tells a guest when the film is coming through the server', async () => {
    await open()
    await push({ isHost: false, mode: 'origin' })
    expect(await page.textContent('[data-testid="modenote"]')).toContain('through the server')
    await page.close()
  })
})

describe('when the application cannot run at all', () => {
  it('replaces the interface with an explanation and how to fix it', async () => {
    await open()
    await push({
      startupError: {
        message: 'coCine needs the mpv media player, and could not find it.',
        howToInstall: 'brew install mpv'
      }
    })
    const wall = await page.textContent('[data-testid="startuperror"]')
    expect(wall).toContain('mpv media player')
    expect(wall).toContain('brew install mpv')
    await page.close()
  })

  it('cannot be dismissed, because there is nothing behind it worth reaching', async () => {
    await open()
    await push({ startupError: { message: 'no mpv', howToInstall: 'install it' } })
    // The ordinary error banner has a Dismiss button; this offers only the one
    // thing that helps, and stays put afterwards.
    await page.click('[data-testid="copycmd"]')
    expect(await page.locator('[data-testid="startuperror"]').count()).toBe(1)
    await page.close()
  })

  it('puts the command on the clipboard, so nobody has to retype it', async () => {
    // Whoever hits this wall is the least technical person in the room: they
    // followed a link, and now they need a terminal command they did not write.
    await open()
    await push({ startupError: { message: 'no mpv', howToInstall: 'sudo pacman -S mpv' } })
    await page.click('[data-testid="copycmd"]')
    await expect.poll(async () => await page.evaluate(() => navigator.clipboard.readText()))
      .toBe('sudo pacman -S mpv')
    await page.close()
  })

  it('shows nothing when the application started normally', async () => {
    await open()
    await push({ startupError: null })
    expect(await page.locator('[data-testid="startuperror"]').count()).toBe(0)
    await page.close()
  })
})

describe('losing the connection', () => {
  it('says so, rather than showing a drift reading that is no longer true', async () => {
    await open()
    await push({ connected: true, connection: 'reconnecting' })
    expect(await page.textContent('[data-testid="reconnecting"]')).toContain('reconnecting')
    // The sync pill is meaningless while disconnected; showing it was the bug.
    expect(await page.locator('[data-testid="drift"]').count()).toBe(0)
    await page.close()
  })

  it('goes back to showing sync once reconnected', async () => {
    await open()
    await push({ connected: true, connection: 'reconnecting' })
    await push({ connected: true, connection: 'connected' })
    expect(await page.locator('[data-testid="reconnecting"]').count()).toBe(0)
    expect(await page.locator('[data-testid="drift"]').count()).toBe(1)
    await page.close()
  })
})

describe('a window a tiling manager made narrow', () => {
  it('keeps every header control reachable at 305px', async () => {
    // i3 tiles this window to about 300px wide alongside other windows. At that
    // size the header used to overflow and put Open film past the right edge:
    // present in the DOM, impossible to click.
    await open({ width: 305, height: 506 })
    await push({ connected: true })

    const header = (await page.locator('[data-testid="header"]').boundingBox())!
    for (const id of ['open', 'films', 'leave']) {
      const box = await page.locator(`[data-testid="${id}"]`).boundingBox()
      if (!box) continue
      expect(box.x).toBeGreaterThanOrEqual(header.x - 1)
      expect(box.x + box.width).toBeLessThanOrEqual(header.x + header.width + 1)
    }
    await page.close()
  })

  it('still lays out on one row when there is room', async () => {
    await open({ width: 1180, height: 800 })
    await push({ connected: true })
    const header = (await page.locator('[data-testid="header"]').boundingBox())!
    expect(header.height).toBeLessThan(60)
    await page.close()
  })
})


describe('creating a room', () => {
  /** The join panel, with identity loaded so the buttons are live. */
  const lobby = async (): Promise<void> => {
    await open()
    await push({ connected: false })
    await expect.poll(async () => await page.inputValue('[data-testid="name"]')).toBe('anjali')
  }

  it('shows the choices that shape the room rather than hiding them in a room that exists', async () => {
    await lobby()
    await page.waitForSelector('[data-testid="roomoptions"]')
    const text = await page.textContent('[data-testid="roomoptions"]')
    expect(text).toContain('How the film is shared')
    expect(text).toContain('Who can control playback')
    expect(text).toContain('Pause when someone arrives late')
    await page.close()
  })

  it('keeps the latecomer checkbox beside its own sentence', async () => {
    // The field labels in this panel are uppercase blocks, which stacked the
    // checkbox above shouted text until the toggle was made more specific.
    await lobby()
    const row = await page.evaluate(() => {
      const box = document.querySelector('[data-testid="optlate"]')!.getBoundingClientRect()
      const label = document.querySelector('[data-testid="optlate"]')!.parentElement!.getBoundingClientRect()
      return { boxMid: box.y + box.height / 2, labelMid: label.y + label.height / 2, labelHeight: label.height }
    })
    expect(Math.abs(row.boxMid - row.labelMid)).toBeLessThan(4)
    expect(row.labelHeight).toBeLessThan(40)
    await page.close()
  })

  it('creates with what the host chose', async () => {
    await lobby()
    await page.selectOption('[data-testid="optmode"]', 'origin')
    await page.selectOption('[data-testid="optcontrol"]', 'host')
    await page.uncheck('[data-testid="optlate"]')
    await page.click('[data-testid="create"]')
    expect((await calls('connect'))[0]![0]).toMatchObject({
      code: null,
      options: { mode: 'origin', openControl: false, waitForLatecomers: false }
    })
    await page.close()
  })

  it('defaults to peer to peer, everyone in control, waiting for latecomers', async () => {
    await lobby()
    await page.click('[data-testid="create"]')
    expect((await calls('connect'))[0]![0]).toMatchObject({
      options: { mode: 'p2p', openControl: true, waitForLatecomers: true }
    })
    await page.close()
  })

  it('says what each way of sharing costs, because one of them costs money', async () => {
    await lobby()
    await page.selectOption('[data-testid="optmode"]', 'origin')
    expect(await page.textContent('[data-testid="roomoptions"]')).toContain('costs whoever runs the server')
    await page.selectOption('[data-testid="optmode"]', 'p2p')
    expect(await page.textContent('[data-testid="roomoptions"]')).toContain('Free')
    await page.close()
  })

  it('sends no options when joining, because the room already has its own', async () => {
    await lobby()
    await page.click('[data-testid="join"]')
    const args = (await calls('connect'))[0]![0] as { code: string; options?: unknown }
    expect(args.code).toBe('BCDFGHJK')
    expect(args.options).toBeUndefined()
    await page.close()
  })
})

describe('room settings once the room exists', () => {
  it('lets the host close playback control to everyone else', async () => {
    await open()
    await push({ isHost: true, openControl: true })
    expect(await page.isChecked('[data-testid="opencontrol"]')).toBe(true)
    await page.click('[data-testid="opencontrol"]')
    expect((await calls('setOpenControl'))[0]).toEqual([false])
    await page.close()
  })

  it('offers that to the host only', async () => {
    await open()
    await push({ isHost: false })
    expect(await page.locator('[data-testid="opencontrol"]').count()).toBe(0)
    await page.close()
  })
})

describe('chat in fullscreen', () => {
  it('Enter asks the overlay for a composer, since nothing is drawn over the film until it does', async () => {
    await open()
    await push({ fullscreen: true, connected: true })
    await page.keyboard.press('Enter')
    expect(await calls('focusChat')).toHaveLength(1)
    await page.close()
  })

  it('leaves Enter alone when the film is not fullscreen', async () => {
    await open()
    await push({ fullscreen: false, connected: true })
    await page.keyboard.press('Enter')
    expect(await calls('focusChat')).toHaveLength(0)
    await page.close()
  })
})

const TREE = {
  '/home/anjali': {
    path: '/home/anjali',
    parent: '/home',
    filtered: true,
    entries: [
      { name: 'Films', path: '/home/anjali/Films', isDir: true, bytes: 0, modifiedMs: 2, playable: false },
      { name: 'trailer.mp4', path: '/home/anjali/trailer.mp4', isDir: false, bytes: 5 * 1024 ** 2, modifiedMs: 1, playable: true }
    ]
  },
  '/home/anjali/Films': {
    path: '/home/anjali/Films',
    parent: '/home/anjali',
    filtered: true,
    entries: [
      { name: 'dune.mkv', path: '/home/anjali/Films/dune.mkv', isDir: false, bytes: 4 * 1024 ** 3, modifiedMs: 3, playable: true }
    ]
  },
  '/home/anjali/Videos': { path: '/home/anjali/Videos', parent: '/home/anjali', filtered: true, entries: [] }
}

describe('choosing a film without the system dialog', () => {
  // Electron's fallback GTK chooser reports a double-click on a file as a
  // cancellation, so on Linux opening a film silently did nothing. The
  // application browses for itself there instead.
  const openPicker = async (over: Record<string, unknown> = {}): Promise<void> => {
    await open()
    await page.evaluate(t => { (window as unknown as Record<string, unknown>).__tree = t }, TREE)
    // The system dialog is trusted in the default fixture; these cases are
    // about the platforms where it is not.
    await push({ nativePicker: false, ...over })
    await page.click('[data-testid="open"]')
    await page.waitForSelector('[data-testid="picker"]')
  }

  it('uses the system dialog where it can be trusted', async () => {
    await open()
    await push({ nativePicker: true })
    await page.click('[data-testid="open"]')
    expect(await calls('openFile')).toHaveLength(1)
    expect(await page.locator('[data-testid="picker"]').count()).toBe(0)
    await page.close()
  })

  it('browses for itself where it cannot', async () => {
    await openPicker()
    expect(await calls('openFile')).toHaveLength(0)
    expect(await page.locator('[data-testid="pickerfile"]').count()).toBe(1)
    expect(await page.locator('[data-testid="pickerdir"]').count()).toBe(1)
    await page.close()
  })

  it('gets the video surface out of the way, and puts it back', async () => {
    // The native surface floats above the window's content: without this the
    // picker is behind the film and cannot be seen at all.
    await openPicker()
    expect((await calls('browseActive'))[0]).toEqual([true])
    await page.click('[data-testid="pickercancel"]')
    await expect.poll(async () => (await calls('browseActive')).length).toBe(2)
    expect((await calls('browseActive'))[1]).toEqual([false])
    await page.close()
  })

  it('walks into a folder and opens the film in it', async () => {
    await openPicker()
    await page.dblclick('[data-testid="pickerdir"][data-name="Films"]')
    await page.waitForSelector('[data-testid="pickerfile"][data-name="dune.mkv"]')
    await page.dblclick('[data-testid="pickerfile"][data-name="dune.mkv"]')
    expect((await calls('openPath'))[0]).toEqual(['/home/anjali/Films/dune.mkv'])
    // And it gets out of the way once it has done its job.
    expect(await page.locator('[data-testid="picker"]').count()).toBe(0)
    await page.close()
  })

  it('opens the selected film from the keyboard, which the system dialog would not', async () => {
    await openPicker()
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')
    expect((await calls('openPath'))[0]).toEqual(['/home/anjali/trailer.mp4'])
    await page.close()
  })

  it('jumps to a place in one click', async () => {
    await openPicker()
    await page.click('[data-testid="pickerplaces"] >> text=Videos')
    await page.waitForSelector('[data-testid="pickerempty"]')
    expect(await page.textContent('[data-testid="pickerempty"]')).toContain('No films')
    await page.close()
  })

  it('shows every file when asked', async () => {
    await openPicker()
    await page.check('[data-testid="pickerall"]')
    await expect.poll(async () => (await calls('browseList')).at(-1)).toEqual(['/home/anjali', true])
    await page.close()
  })

  it('says what went wrong with a folder it cannot read', async () => {
    await openPicker()
    await page.click('[data-testid="pickerup"]')
    await page.waitForSelector('[data-testid="pickererror"]')
    expect(await page.textContent('[data-testid="pickererror"]')).toContain('Could not open /home')
    await page.close()
  })

  it('closes on Escape without opening anything', async () => {
    await openPicker()
    await page.keyboard.press('Escape')
    await expect.poll(async () => await page.locator('[data-testid="picker"]').count()).toBe(0)
    expect(await calls('openPath')).toHaveLength(0)
    await page.close()
  })

  it('keeps the film underneath from hearing the keyboard', async () => {
    // Space would otherwise pause the film while somebody is browsing.
    await openPicker({ mediaName: 'dune.mkv', paused: true })
    await page.keyboard.press(' ')
    expect(await calls('play')).toHaveLength(0)
    await page.close()
  })
})

describe('the launch animation', () => {
  it('waits for the window to be on screen before it starts', async () => {
    // A hidden window has its animations frozen and its timers throttled, so a
    // mark started at mount was missed entirely or caught half-finished.
    await open()
    await push({ windowShown: false })
    expect(await page.locator('[data-testid="splash"]').count()).toBe(0)
    await push({ windowShown: true })
    expect(await page.locator('[data-testid="splash"]').count()).toBe(1)
    await page.close()
  })

  it('shows the mark and then gets out of the way', async () => {
    await open()
    await push()
    expect(await page.locator('[data-testid="splash"]').count()).toBe(1)
    await expect.poll(async () => await page.locator('[data-testid="splash"]').count(), { timeout: 6000 }).toBe(0)
    await page.close()
  })

  it('starts anyway if the window never reports itself', async () => {
    // Nothing may leave the interface behind a mark that will not finish.
    await open()
    await expect.poll(async () => await page.locator('[data-testid="splash"]').count(), { timeout: 6000 }).toBe(1)
    await expect.poll(async () => await page.locator('[data-testid="splash"]').count(), { timeout: 6000 }).toBe(0)
    await page.close()
  })

  it('never blocks a click, even while it is on screen', async () => {
    await open()
    await push()
    expect(await page.evaluate(() =>
      getComputedStyle(document.querySelector('[data-testid="splash"]')!).pointerEvents)).toBe('none')
    await page.close()
  })

  it('gets out of the way when the picker opens, rather than hiding it', async () => {
    // The picker used to open behind the mark: the screen dimmed, no picker was
    // visible, and a film opened into a window nobody could see.
    await open()
    await page.evaluate(t => { (window as unknown as Record<string, unknown>).__tree = t }, TREE)
    await push({ nativePicker: false })
    expect(await page.locator('[data-testid="splash"]').count()).toBe(1)
    await page.click('[data-testid="open"]')
    await page.waitForSelector('[data-testid="picker"]')
    expect(await page.locator('[data-testid="splash"]').count()).toBe(0)
    await page.close()
  })

  it('keeps the picker above the mark even so', async () => {
    await open()
    await page.evaluate(t => { (window as unknown as Record<string, unknown>).__tree = t }, TREE)
    await push({ nativePicker: false })
    await page.click('[data-testid="open"]')
    await page.waitForSelector('[data-testid="picker"]')
    const z = await page.evaluate(() => getComputedStyle(document.querySelector('.picker-wrap')!).zIndex)
    expect(Number(z)).toBeGreaterThan(900)
    await page.close()
  })
})

describe('the stage before a film is open', () => {
  // The native video surface is off until something is playing, which is the
  // only reason anything here can be seen at all.
  it('says what to do instead of showing a black rectangle', async () => {
    await open()
    await push({ mediaName: null })
    await page.waitForSelector('[data-testid="welcome"]')
    const text = await page.textContent('[data-testid="welcome"]')
    expect(text).toContain('Put a film on')
    expect(text).toContain('Open film')
    await page.close()
  })

  it('gets out of the way once there is a picture', async () => {
    await open()
    await push({ mediaName: 'dune.mkv' })
    expect(await page.locator('[data-testid="welcome"]').count()).toBe(0)
    await page.close()
  })

  it('never changes the size of the box the surface is measured from', async () => {
    // Anything that grows the stage moves the native window with it.
    await open()
    await push({ mediaName: 'dune.mkv' })
    const withFilm = await page.evaluate(() => document.querySelector('[data-testid="stage"]')!.getBoundingClientRect().height)
    await push({ mediaName: null })
    await page.waitForSelector('[data-testid="welcome"]')
    const empty = await page.evaluate(() => document.querySelector('[data-testid="stage"]')!.getBoundingClientRect().height)
    expect(empty).toBe(withFilm)
    await page.close()
  })
})

const WITH_PIECES = {
  perPeer: [
    { memberId: 'me', name: 'anjali', havePct: 1, bufferEndSec: 7200, downBps: 0, upBps: 6.2e6, peers: 2, ready: true,
      pieces: 'f'.repeat(64), sharer: true },
    { memberId: 'b', name: 'dev', havePct: 0.5, bufferEndSec: 120, downBps: 3.1e6, upBps: 1e5, peers: 2, ready: true,
      pieces: 'f'.repeat(32) + '0'.repeat(32) },
    { memberId: 'c', name: 'priya', havePct: 0.1, bufferEndSec: 4, downBps: 4e5, upBps: 0, peers: 1, ready: false,
      pieces: 'f'.repeat(6) + '0'.repeat(58), paused: true }
  ],
  etaSec: 300, tMinSec: 120, bottleneck: 'priya', fullCopies: 1, safeForSharerToLeave: false
}

describe('putting a film on, which is now separate from sharing it', () => {
  it('will not open a film before there is a room to watch it with', async () => {
    await open()
    await push({ connected: false, mediaName: null })
    expect(await page.isDisabled('[data-testid="open"]')).toBe(true)
    expect(await page.textContent('[data-testid="welcome"]')).toContain('Start with a room')
    await push({ connected: true, mediaName: null })
    expect(await page.isDisabled('[data-testid="open"]')).toBe(false)
    await page.close()
  })

  it('says the film is playing here only, and offers to share it', async () => {
    await open()
    await push({ mediaName: 'dune.mkv', sharing: 'off' })
    expect(await page.textContent('[data-testid="sharestate"]')).toContain('this machine only')
    await page.click('[data-testid="startsharing"]')
    expect(await calls('shareFilm')).toHaveLength(1)
    await page.close()
  })

  it('offers to pause while sharing, and to resume once paused', async () => {
    await open()
    await push({ mediaName: 'dune.mkv', sharing: 'sharing' })
    expect(await page.locator('[data-testid="startsharing"]').count()).toBe(0)
    await page.click('[data-testid="pausesharing"]')
    expect((await calls('setSharingPaused'))[0]).toEqual([true])

    await push({ mediaName: 'dune.mkv', sharing: 'paused' })
    expect(await page.textContent('[data-testid="sharestate"]')).toContain('nobody is receiving')
    await page.click('[data-testid="resumesharing"]')
    expect((await calls('setSharingPaused'))[1]).toEqual([false])
    await page.close()
  })

  it('unloads a film so another can be opened', async () => {
    await open()
    await push({ mediaName: 'dune.mkv', sharing: 'sharing' })
    await page.click('[data-testid="unloadfilm"]')
    expect(await calls('unloadFilm')).toHaveLength(1)
    await page.close()
  })

  it('offers none of that with no film open', async () => {
    await open()
    await push({ mediaName: null })
    expect(await page.locator('[data-testid="filmacts"]').count()).toBe(0)
    await page.close()
  })
})

describe('what the transfer is doing', () => {
  it('shows this machine\'s own upload rate and peer count', async () => {
    // The number whoever is sharing actually wants, and could not see anywhere.
    await open()
    await push({ phase: 'playing', mediaName: 'dune.mkv', transferStatus: WITH_PIECES, memberId: 'me' })
    const mine = await page.textContent('[data-testid="mytransfer"]')
    expect(mine).toContain('5.9 MB/s')
    expect(mine).toContain('2 peers')
    await page.close()
  })

  it('shows every peer\'s share, rates and whether they are keeping up', async () => {
    await open()
    await push({ phase: 'playing', mediaName: 'dune.mkv', transferStatus: WITH_PIECES, memberId: 'me' })
    const priya = await page.textContent('[data-testid="peerstatus"][data-name="priya"]')
    expect(priya).toContain('10%')
    expect(priya).toContain('furthest behind')
    expect(priya).toContain('paused')
    const dev = await page.textContent('[data-testid="peerstatus"][data-name="dev"]')
    expect(dev).toContain('50%')
    expect(dev).toContain('2 min ahead of the playhead')
    // Somebody holding all of it is described that way rather than by a buffer.
    expect(await page.textContent('[data-testid="peerstatus"][data-name="anjali"]')).toContain('has the whole film')
    await page.close()
  })

  it('marks who put the film on, and which row is you', async () => {
    await open()
    await push({ phase: 'playing', mediaName: 'dune.mkv', transferStatus: WITH_PIECES, memberId: 'me' })
    const mine = await page.textContent('[data-testid="peerstatus"][data-name="anjali"]')
    expect(mine).toContain('source')
    expect(mine).toContain('you')
    await page.close()
  })

  it('draws which parts of the film each person holds', async () => {
    // Not just how much: somebody missing the stretch about to be watched looks
    // different from somebody missing the credits.
    await open()
    await push({ phase: 'playing', mediaName: 'dune.mkv', transferStatus: WITH_PIECES, memberId: 'me' })
    const strips = await page.$$eval('[data-testid="piecestrip"]', els => els.map(e => ({
      map: e.getAttribute('data-map'),
      slices: e.children.length,
      full: [...e.children].filter(c => c.className === 'full').length
    })))
    expect(strips).toHaveLength(3)
    expect(strips[0]!.slices).toBe(64)
    expect(strips[0]!.full).toBe(64)          // the sharer holds all of it
    expect(strips[1]!.full).toBe(32)          // dev has the first half
    expect(strips[2]!.full).toBe(6)           // priya has the opening only
    await page.close()
  })

  it('leaves the strip out when a transport cannot say', async () => {
    // Relay mode fetches byte ranges, not pieces, and says so by omission.
    await open()
    await push({
      phase: 'playing', mediaName: 'dune.mkv', memberId: 'me',
      transferStatus: { ...WITH_PIECES, perPeer: WITH_PIECES.perPeer.map(p => ({ ...p, pieces: undefined })) }
    })
    expect(await page.locator('[data-testid="peerstatus"]').count()).toBe(3)
    expect(await page.locator('[data-testid="piecestrip"]').count()).toBe(0)
    await page.close()
  })
})
