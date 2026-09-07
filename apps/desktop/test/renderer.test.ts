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
  phase: 'playing', waitForLatecomers: true, transferStatus: null as unknown,
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

  it('drops the gate out of the way once the film is playing', async () => {
    await open()
    await push({ phase: 'playing', transferStatus: status({ bottleneck: null }) })
    expect(await page.locator('[data-testid="gate"]').count()).toBe(0)
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

  it('is not dismissible, because there is nothing behind it worth reaching', async () => {
    await open()
    await push({ startupError: { message: 'no mpv', howToInstall: 'install it' } })
    // The ordinary error banner has a Dismiss button; this deliberately does not.
    expect(await page.locator('[data-testid="startuperror"] button').count()).toBe(0)
    await page.close()
  })

  it('shows nothing when the application started normally', async () => {
    await open()
    await push({ startupError: null })
    expect(await page.locator('[data-testid="startuperror"]').count()).toBe(0)
    await page.close()
  })
})
