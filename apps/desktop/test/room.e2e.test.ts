import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { ensureTestVideo, ExternalMpv } from '@cocine/player'
import { RoomClient } from '@cocine/client'
import { SignallingServer } from '../../server/src/server.js'

/**
 * Phase 3's exit criterion, end to end: the real application in a real room
 * with a second participant, chatting, with the host handing over control.
 *
 * The second participant is a headless RoomClient rather than a second Electron
 * instance -- it exercises the same protocol and keeps the test to one window.
 */

let server: SignallingServer
let app: ElectronApplication
let page: Page
let guest: RoomClient
let guestPlayer: ExternalMpv
let code = ''

beforeAll(async () => {
  const film = ensureTestVideo(30, join(process.cwd(), '.fixtures'))
  execFileSync('npx', ['electron-vite', 'build'], { cwd: join(process.cwd(), 'apps/desktop'), stdio: 'ignore' })
  server = new SignallingServer({ startLeadMs: 200 })
  const port = await server.listen()

  app = await electron.launch({
    args: [join(process.cwd(), 'apps/desktop')],
    // The film is put on through the stubbed system dialog here, so the system
    // dialog has to be the one in use. Linux would otherwise open the
    // application's own picker, which picker.e2e.test.ts covers.
    env: { ...process.env, COCINE_HEADLESS: '1', COCINE_NATIVE_DIALOG: '1' }
  })
  page = await app.firstWindow()
  await page.waitForSelector('[data-testid="stage"]', { timeout: 20_000 })

  // The room comes first: a film cannot be opened without one.
  await page.fill('[data-testid="server"]', `ws://127.0.0.1:${port}`)
  await page.fill('[data-testid="name"]', 'anjali')
  await page.click('[data-testid="create"]')
  await page.waitForSelector('[data-testid="code"]', { timeout: 20_000 })
  code = (await page.textContent('[data-testid="code"]'))!.replace(/[^A-Z0-9]/g, '').replace(/COPY|COPIED/, '')

  await app.evaluate(async ({ dialog }, chosen) => {
    ;(dialog as unknown as { showOpenDialog: unknown }).showOpenDialog = async () => ({ canceled: false, filePaths: [chosen] })
  }, film)
  await page.click('[data-testid="open"]')
  await page.waitForFunction(() => !!document.querySelector('.fname')?.textContent?.includes('.mp4'), null, { timeout: 20_000 })
  // And opening it no longer shares it, so that is a second step.
  await page.click('[data-testid="startsharing"]')

  guestPlayer = new ExternalMpv({ headless: true })
  await guestPlayer.start(); await guestPlayer.load(film)
  guest = new RoomClient({ url: `ws://127.0.0.1:${port}`, code, name: 'dev', player: guestPlayer })
  await guest.connect()
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="member"]').length === 2, null, { timeout: 20_000 })
}, 240_000)

afterAll(async () => {
  await Promise.race([app?.close(), new Promise(r => setTimeout(r, 15_000))])
  await guest?.close(); await guestPlayer?.close(); await server?.close()
}, 40_000)

describe('a room with two people', () => {
  it('gives the other machine something it can actually fetch', async () => {
    // The bug this exists for: the transport was created before the room client
    // had been assigned, found nothing, and never retried -- so Start sharing
    // announced the film's name and duration with a null source. The second
    // machine showed a duration at the bottom of the window, said "Nothing
    // open", and waited for ever. Everything else -- chat, sync, playback --
    // worked perfectly and hid it.
    await expect.poll(() => guest.media?.source?.kind, { timeout: 20_000 }).toBe('p2p')
    const source = guest.media!.source as { kind: 'p2p'; infoHash: string; magnet: string }
    expect(source.infoHash).toMatch(/^[0-9a-f]{40}$/)
    expect(source.magnet).toContain(source.infoHash)
  }, 30_000)

  it('created a room and the guest joined it by code', () => {
    expect(code).toMatch(/^[A-Z0-9]{8}$/)
    expect(guest.members.map(m => m.name).sort()).toEqual(['anjali', 'dev'])
  })

  it('shows the guest arriving in the room log', async () => {
    await expect.poll(async () => await page.textContent('[data-testid="chat"]'), { timeout: 15_000 })
      .toContain('dev')
  })

  it('carries chat from the guest into the application', async () => {
    guest.sendChat('this bit is great')
    await expect.poll(async () => await page.textContent('[data-testid="chat"]'), { timeout: 15_000 })
      .toContain('this bit is great')
  })

  it('carries chat from the application out to the guest', async () => {
    await page.fill('[data-testid="chatinput"]', 'rewinding ten seconds')
    await page.press('[data-testid="chatinput"]', 'Enter')
    await expect.poll(() => guest.messages.map(m => m.text), { timeout: 15_000 })
      .toContain('rewinding ten seconds')
  })

  it('lets the host take playback control away, and the server refuses the guest', async () => {
    await page.hover('[data-testid="member"][data-name="dev"]')
    await page.click('[data-testid="member"][data-name="dev"] [data-testid="togglecontrol"]')
    await expect.poll(() => guest.me()?.mayControl, { timeout: 15_000 }).toBe(false)

    const refused = new Promise<string>(res => guest.once('server-error', res))
    guest.requestPlay()
    expect(await refused).toMatch(/playback control/)
  })

  it('starts a second film from its own beginning, not the first one\'s position', async () => {
    // The bug this exists for: mpv reports time-pos as null once nothing is
    // loaded, that was ignored as "not a number", and the old position stayed
    // cached with pause still false. The playhead therefore kept advancing with
    // no film open, and the next film had to fight a position that never
    // existed — which on two machines looks exactly like sync collapsing.
    const second = ensureTestVideo(60, join(process.cwd(), '.fixtures'))
    await page.click('[data-testid="playpause"]')          // get it moving first
    await expect.poll(async () => await page.textContent('[data-testid="position"]'), { timeout: 15_000 })
      .not.toBe('00:00:00')

    await page.click('[data-testid="unloadfilm"]')
    await expect.poll(async () => await page.textContent('[data-testid="position"]'), { timeout: 15_000 })
      .toBe('00:00:00')
    // And it stays there: nothing is playing, so nothing may advance.
    await new Promise(r => setTimeout(r, 1200))
    expect(await page.textContent('[data-testid="position"]')).toBe('00:00:00')

    await app.evaluate(async ({ dialog }, chosen) => {
      ;(dialog as unknown as { showOpenDialog: unknown }).showOpenDialog = async () => ({ canceled: false, filePaths: [chosen] })
    }, second)
    await page.click('[data-testid="open"]')
    await expect.poll(async () => await page.textContent('.fname'), { timeout: 20_000 }).toContain('60s')
    expect(await page.textContent('[data-testid="position"]')).toBe('00:00:00')
    // The new film's own length, not the previous one's.
    await expect.poll(async () => await page.textContent('[data-testid="duration"]'), { timeout: 15_000 })
      .toBe('00:01:00')
  }, 90_000)

  it('hands hosting over mid-session, and control moves with it', async () => {
    await page.hover('[data-testid="member"][data-name="dev"]')
    await page.click('[data-testid="member"][data-name="dev"] [data-testid="makehost"]')
    await expect.poll(() => guest.me()?.isHost, { timeout: 15_000 }).toBe(true)
    // The new host always has control, even though it was just revoked.
    expect(guest.me()?.mayControl).toBe(true)
    // And the application, no longer host, loses the role controls.
    await expect.poll(async () => await page.locator('[data-testid="makehost"]').count(), { timeout: 15_000 }).toBe(0)
  })
})
