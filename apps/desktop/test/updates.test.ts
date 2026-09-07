import { describe, it, expect } from 'vitest'
import { startUpdates, type UpdaterLike } from '../src/main/updates.js'

/**
 * Updating is the one part of packaging that behaves differently per platform
 * for a reason outside our control: macOS refuses to apply an unsigned update.
 * Pretending otherwise would download a file that can never be installed and
 * tell the user it is pending.
 */
function fakeUpdater (opts: { fail?: boolean } = {}): UpdaterLike & { events: string[]; checks: number } {
  const events: string[] = []
  return {
    events,
    checks: 0,
    autoDownload: false,
    autoInstallOnAppQuit: false,
    checkForUpdates (): Promise<unknown> {
      this.checks++
      return opts.fail ? Promise.reject(new Error('no network')) : Promise.resolve({})
    },
    on (event: string) { events.push(event); return this }
  }
}

const base = { log: () => {}, isPackaged: true, platform: 'linux' as NodeJS.Platform }

describe('checking for updates', () => {
  it('checks in an installed copy', async () => {
    const updater = fakeUpdater()
    const out = await startUpdates({ ...base, updater })
    expect(out).toEqual({ checked: true })
    expect(updater.checks).toBe(1)
  })

  it('downloads in the background and installs on quit, interrupting nothing', async () => {
    const updater = fakeUpdater()
    await startUpdates({ ...base, updater })
    expect(updater.autoDownload).toBe(true)
    expect(updater.autoInstallOnAppQuit).toBe(true)
  })

  it('does not check in a development build', async () => {
    const updater = fakeUpdater()
    const out = await startUpdates({ ...base, updater, isPackaged: false })
    expect(out).toMatchObject({ checked: false })
    expect(updater.checks).toBe(0)
  })

  it('does not check on macOS, where an unsigned update cannot be applied', async () => {
    const updater = fakeUpdater()
    const out = await startUpdates({ ...base, updater, platform: 'darwin' })
    expect(out).toMatchObject({ checked: false })
    expect((out as { reason: string }).reason).toContain('unsigned')
    expect(updater.checks).toBe(0)
  })

  it('reports a failed check instead of throwing', async () => {
    // Being unable to check for updates must never stop someone watching a film.
    const updater = fakeUpdater({ fail: true })
    const out = await startUpdates({ ...base, updater })
    expect(out).toMatchObject({ checked: false })
    expect((out as { reason: string }).reason).toContain('no network')
  })

  it('listens for the outcomes it reports on', async () => {
    const updater = fakeUpdater()
    await startUpdates({ ...base, updater })
    expect(updater.events).toContain('update-available')
    expect(updater.events).toContain('update-downloaded')
    expect(updater.events).toContain('error')
  })
})
