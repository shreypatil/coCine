import type { Page } from 'playwright'
import { SignallingServer } from '../../../server/src/server.js'

/**
 * Scaffolding every end-to-end suite now needs.
 *
 * A film cannot be opened outside a room any more -- watching alone is not what
 * the application is for, and the two used to look like unrelated features. So
 * each suite starts a signalling server of its own and creates a room before it
 * can do anything with a film.
 */

export interface TestRoom {
  server: SignallingServer
  port: number
  code: string
}

export async function startServer (): Promise<{ server: SignallingServer; port: number }> {
  const server = new SignallingServer({ startLeadMs: 200 })
  const port = await server.listen()
  return { server, port }
}

/** Fill in the join panel and create a room, returning its code. */
export async function createRoom (page: Page, port: number, name = 'anjali'): Promise<string> {
  await page.fill('[data-testid="server"]', `ws://127.0.0.1:${port}`)
  await page.fill('[data-testid="name"]', name)
  await page.click('[data-testid="create"]')
  await page.waitForSelector('[data-testid="code"]', { timeout: 30_000 })
  const shown = await page.textContent('[data-testid="code"]')
  return (shown ?? '').replace(/[^A-Z0-9]/g, '').replace(/COPY|COPIED/, '')
}

/** Wait until the player has started, which is what enables Open film. */
export async function waitForPlayer (page: Page, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    // Disabled until mpv is up *and* a room exists, so this is checked after
    // the room has been created.
    if (!(await page.isDisabled('[data-testid="open"]'))) return
    if (Date.now() > deadline) throw new Error('Open film never became usable')
    await new Promise(r => setTimeout(r, 200))
  }
}
