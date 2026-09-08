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
 * Opening a film through the application's own picker, in the real app.
 *
 * This is the path that replaced the system dialog on Linux, where Electron's
 * fallback GTK chooser reports a double-click on a file as a cancellation and
 * opening a film therefore did nothing at all. Everything here is real -- real
 * IPC, real filesystem, real mpv -- with only $HOME pointed at a temporary
 * folder so the listing is predictable.
 *
 * Runs under COCINE_HEADLESS, so nothing reaches a display.
 */

let app: ElectronApplication
let page: Page
let home: string
let film: string
let server: SignallingServer

beforeAll(async () => {
  const fixture = ensureTestVideo(30, join(process.cwd(), '.fixtures'))
  home = mkdtempSync(join(tmpdir(), 'cocine-home-'))
  mkdirSync(join(home, 'Videos'))
  film = join(home, 'Videos', basename(fixture))
  copyFileSync(fixture, film)

  execFileSync('npx', ['electron-vite', 'build'], { cwd: join(process.cwd(), 'apps/desktop'), stdio: 'ignore' })
  app = await electron.launch({
    args: [join(process.cwd(), 'apps/desktop')],
    env: { ...process.env, COCINE_HEADLESS: '1', HOME: home }
  })
  page = await app.firstWindow()
  await page.waitForSelector('[data-testid="stage"]', { timeout: 20_000 })
  // A film is opened inside a room, so there has to be one first.
  const started = await startServer()
  server = started.server
  await createRoom(page, started.port)
  await waitForPlayer(page)
}, 240_000)

afterAll(async () => {
  await Promise.race([app?.close(), new Promise(r => setTimeout(r, 15_000))])
  await server?.close()
  rmSync(home, { recursive: true, force: true })
}, 30_000)

describe('opening a film with the application\'s own picker', () => {
  it('opens on the home folder, with places to jump to', async () => {
    await page.click('[data-testid="open"]')
    await page.waitForSelector('[data-testid="picker"]', { timeout: 15_000 })
    await expect.poll(async () => await page.textContent('[data-testid="pickerplaces"]'), { timeout: 15_000 })
      .toContain('Videos')
  })

  it('walks into a folder and plays the film in it — the gesture the system dialog dropped', async () => {
    await page.click('[data-testid="pickerplaces"] >> text=Videos')
    await page.waitForSelector(`[data-testid="pickerfile"][data-name="${basename(film)}"]`, { timeout: 15_000 })
    await page.dblclick(`[data-testid="pickerfile"][data-name="${basename(film)}"]`)

    await expect.poll(async () => await page.textContent('aside'), { timeout: 30_000 })
      .toContain(basename(film))
    expect(await page.locator('[data-testid="picker"]').count()).toBe(0)
    expect(await page.isDisabled('[data-testid="playpause"]')).toBe(false)
  })

  it('remembers that folder the next time it is opened', async () => {
    await page.click('[data-testid="open"]')
    await page.waitForSelector('[data-testid="picker"]', { timeout: 15_000 })
    await expect.poll(async () => await page.textContent('[data-testid="pickercrumbs"]'), { timeout: 15_000 })
      .toContain('Videos')
    await page.keyboard.press('Escape')
  })
})
