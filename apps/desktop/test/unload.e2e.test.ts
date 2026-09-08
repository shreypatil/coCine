import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { ExternalMpv, ensureTestVideo } from '@cocine/player'
import { RoomClient, TransferManager, FilmStore } from '@cocine/client'
import { SignallingServer } from '../../server/src/server.js'

/**
 * What the *other* machine does when a film is taken off, or swapped.
 *
 * The application under test here is the guest, which is the side that was
 * wrong: it kept playing a film the room had already dropped, against playback
 * anchors that now described a different film — which on two machines looks
 * exactly like synchronisation collapsing, and was reported as such. The host
 * is a plain client with a real transfer, so the whole path is exercised:
 * announce, fetch, clear, fetch again.
 *
 * Runs under COCINE_HEADLESS, so nothing reaches a display.
 */

let server: SignallingServer
let app: ElectronApplication
let page: Page
let host: RoomClient
let hostPlayer: ExternalMpv
let transfer: TransferManager
let home: string
let filmA: string
let filmB: string

/** What the guest's interface is showing about films. */
const shown = async (): Promise<{ film: string | null; welcome: boolean; panel: boolean }> =>
  await page.evaluate(() => ({
    film: document.querySelector('.fname')?.textContent ?? null,
    welcome: !!document.querySelector('[data-testid="welcome"]'),
    panel: !!document.querySelector('[data-testid="gate"]')
  }))

beforeAll(async () => {
  filmA = ensureTestVideo(30, join(process.cwd(), '.fixtures'))
  filmB = ensureTestVideo(60, join(process.cwd(), '.fixtures'))
  home = mkdtempSync(join(tmpdir(), 'cocine-guest-'))
  execFileSync('npx', ['electron-vite', 'build'], { cwd: join(process.cwd(), 'apps/desktop'), stdio: 'ignore' })

  server = new SignallingServer({ startLeadMs: 200 })
  const port = await server.listen()

  hostPlayer = new ExternalMpv({ headless: true })
  await hostPlayer.start()
  host = new RoomClient({ url: `ws://127.0.0.1:${port}`, code: null, name: 'host', player: hostPlayer })
  await host.connect()
  transfer = new TransferManager({
    store: new FilmStore(mkdtempSync(join(tmpdir(), 'cocine-films-'))),
    trackerUrl: host.trackerUrl
  })

  app = await electron.launch({
    args: [join(process.cwd(), 'apps/desktop')],
    env: { ...process.env, COCINE_HEADLESS: '1', HOME: home }
  })
  const deadline = Date.now() + 30_000
  for (;;) {
    const hit = app.windows().find(w => w.url().includes('index.html') && !w.url().includes('overlay'))
    if (hit) { page = hit; break }
    if (Date.now() > deadline) throw new Error('the guest window never appeared')
    await new Promise(r => setTimeout(r, 200))
  }
  await page.waitForSelector('[data-testid="stage"]', { timeout: 30_000 })
  await page.fill('[data-testid="server"]', `ws://127.0.0.1:${port}`)
  await page.fill('[data-testid="name"]', 'guest')
  await page.fill('[data-testid="joincode"]', host.code)
  await page.click('[data-testid="join"]')
  await page.waitForSelector('[data-testid="code"]', { timeout: 30_000 })
}, 300_000)

afterAll(async () => {
  await Promise.race([app?.close(), new Promise(r => setTimeout(r, 15_000))])
  await host?.close()
  await hostPlayer?.close()
  await transfer?.destroy()
  await server?.close()
  rmSync(home, { recursive: true, force: true })
}, 60_000)

describe('a film being taken off the room', () => {
  it('reaches the other machine, which fetches it', async () => {
    host.announceMedia(basename(filmA), 30, await transfer.share(filmA))
    await expect.poll(async () => (await shown()).film, { timeout: 60_000 }).toContain('30s')
  }, 90_000)

  it('is cleared on the other machine when the sharer takes it off', async () => {
    // The bug: the guest kept the film, kept playing it, and kept obeying
    // playback anchors that by then described something else entirely.
    host.clearMedia()
    await expect.poll(async () => (await shown()).welcome, { timeout: 30_000 }).toBe(true)
    const after = await shown()
    expect(after.film).toBe('Nothing open')
    // And the transfer panel goes with it: rates and percentages for a film
    // nobody is watching are worse than nothing.
    expect(after.panel).toBe(false)
  }, 60_000)

  it('does not come back afterwards', async () => {
    // A fetch in flight when the film was dropped used to finish later and
    // quietly reinstate it.
    await new Promise(r => setTimeout(r, 3000))
    expect((await shown()).film).toBe('Nothing open')
  }, 30_000)

  it('is replaced cleanly when a different film is put on', async () => {
    host.announceMedia(basename(filmB), 60, await transfer.share(filmB))
    await expect.poll(async () => (await shown()).film, { timeout: 60_000 }).toContain('60s')
    expect((await shown()).film).not.toContain('30s')
  }, 90_000)
})
