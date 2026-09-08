import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { ensureTestVideo } from '@cocine/player'
import { startServer, createRoom, waitForPlayer } from './support/room.js'
import type { SignallingServer } from '../../server/src/server.js'

/**
 * The whole application: real Electron, real preload bridge, real IPC, real
 * mpv. Only the native file dialog is stubbed, because a modal GTK window
 * cannot be driven and is not what this is testing.
 *
 * Runs under COCINE_HEADLESS, which swaps the reparented player for a
 * standalone headless one and leaves the main window hidden, so nothing
 * reaches a display. Excluded from `npm test`; run with `npm run test:app`.
 */

let app: ElectronApplication
let page: Page
let film: string
let server: SignallingServer

beforeAll(async () => {
  film = ensureTestVideo(30, join(process.cwd(), '.fixtures'))
  execFileSync('npx', ['electron-vite', 'build'], { cwd: join(process.cwd(), 'apps/desktop'), stdio: 'ignore' })
  app = await electron.launch({
    args: [join(process.cwd(), 'apps/desktop')],
    // COCINE_NATIVE_DIALOG keeps the system dialog in play here, because these
    // cases are about the dialog path and stub it. Linux would otherwise use
    // the application's own picker, which picker.e2e.test.ts covers.
    env: { ...process.env, COCINE_HEADLESS: '1', COCINE_NATIVE_DIALOG: '1' }
  })
  page = await app.firstWindow()
  await page.waitForSelector('[data-testid="stage"]', { timeout: 20_000 })
  // A film needs a room now: watching alone is not what this is for, and the
  // two used to look like unrelated features.
  const started = await startServer()
  server = started.server
  await createRoom(page, started.port)
  await waitForPlayer(page)
}, 180_000)

afterAll(async () => {
  // Bounded: a hang here should fail loudly rather than time the suite out.
  await Promise.race([app?.close(), new Promise(r => setTimeout(r, 15_000))])
  await server?.close()
}, 30_000)

describe('the real application', () => {
  it('starts with a player ready, a room, and no film', async () => {
    expect(await page.isDisabled('[data-testid="open"]')).toBe(false)
    expect(await page.isDisabled('[data-testid="playpause"]')).toBe(true)
  })

  it('clicking Open film reaches the main process and loads the file', async () => {
    // Stub the native dialog inside the main process. This is the step that
    // makes the click path testable at all -- everything else is real.
    await app.evaluate(async ({ dialog }, chosen) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(dialog as any).showOpenDialog = async () => ({ canceled: false, filePaths: [chosen] })
    }, film)

    await page.click('[data-testid="open"]')

    await expect.poll(async () => await page.textContent('aside'), { timeout: 20_000 })
      .toContain('film-30s-240p.mp4')
    expect(await page.isDisabled('[data-testid="playpause"]')).toBe(false)
  })

  it('plays, and the position advances', async () => {
    await page.click('[data-testid="playpause"]')
    const read = async (): Promise<number> => {
      // Selected by test id, never by a styling class: the redesign renamed
      // .time to .tc and silently broke this assertion.
      const t = await page.textContent('[data-testid="position"]')
      const [h, m, s] = (t ?? '00:00:00').split(':').map(Number)
      return (h ?? 0) * 3600 + (m ?? 0) * 60 + (s ?? 0)
    }
    await expect.poll(read, { timeout: 20_000 }).toBeGreaterThan(1)
  })

  it('surfaces a load failure in the banner rather than silently doing nothing', async () => {
    await app.evaluate(async ({ dialog }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(dialog as any).showOpenDialog = async () => ({ canceled: false, filePaths: ['/nope/missing.mkv'] })
    })
    await page.click('[data-testid="open"]')
    await expect.poll(async () => await page.locator('[data-testid="banner"]').count(), { timeout: 20_000 })
      .toBeGreaterThan(0)
  })

  it('does nothing and reports nothing when the dialog is dismissed', async () => {
    await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-testid="banner"] button')?.click())
    await app.evaluate(async ({ dialog }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(dialog as any).showOpenDialog = async () => ({ canceled: true, filePaths: [] })
    })
    await page.click('[data-testid="open"]')
    await page.waitForTimeout(800)
    expect(await page.locator('[data-testid="banner"]').count()).toBe(0)
  })
})
