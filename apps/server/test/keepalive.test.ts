import { describe, it, expect, afterEach } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { SignallingServer, HEALTH_PATH } from '../src/server.js'
import { RoomClient } from '@cocine/client'
import type { PlayerController } from '@cocine/player'

/**
 * The keepalive that stops Oracle reclaiming the instance.
 *
 * Oracle terminates an always-free instance whose CPU 95th percentile and
 * network utilisation both sit under twenty per cent across seven days. Only
 * one of those has to be broken, and CPU is the affordable one -- clearing a
 * 95th percentile needs about 8.4 hours a week above the threshold rather than
 * a week of load.
 *
 * The part worth testing is not that it can burn CPU. It is that it *does not*
 * while somebody is watching a film: this runs on a one-vCPU instance, and a
 * keepalive that competed with the server would be protecting it by degrading
 * it.
 */

const SCRIPT = join(process.cwd(), 'infra', 'keepalive.sh')

const stubPlayer = (): PlayerController => ({
  load: async () => {}, play: async () => {}, pause: async () => {},
  seek: async () => {}, setRate: async () => {},
  position: () => 0, isPaused: () => true, positionObservedAt: () => Date.now(),
  duration: () => null, showText: async () => {}, setVolume: async () => {},
  unload: async () => {},
  on: () => {}, close: async () => {}
}) as PlayerController

const cleanups: Array<() => unknown> = []
afterEach(async () => { for (const c of cleanups.splice(0)) await c() })

const run_ = promisify(execFile)

/**
 * Run the script against a given health URL, with a burn short enough to test.
 *
 * Asynchronously, and that is not a style preference. The server under test
 * runs in *this* process, so a synchronous child would block the event loop
 * that has to answer the script's own health request -- curl would time out,
 * the script would correctly conclude the server was down, and the test would
 * report a fault in the script that was entirely the test's doing.
 */
async function run (healthUrl: string, seconds = 1): Promise<{ out: string; ms: number }> {
  const started = Date.now()
  const { stdout } = await run_('bash', [SCRIPT], {
    encoding: 'utf8',
    env: { ...process.env, COCINE_HEALTH_URL: healthUrl, COCINE_KEEPALIVE_SECONDS: String(seconds) },
    timeout: 60_000
  })
  return { out: stdout, ms: Date.now() - started }
}

describe('the Oracle keepalive', () => {
  it('burns CPU when the server is idle, which is when reclamation accrues', async () => {
    const server = new SignallingServer({})
    const port = await server.listen()
    cleanups.push(() => server.close())

    const { out, ms } = await run(`http://127.0.0.1:${port}${HEALTH_PATH}`, 2)
    expect(out).toContain('idle; burning')
    // It really waited rather than reporting and returning.
    expect(ms).toBeGreaterThanOrEqual(1800)
  }, 60_000)

  it('stays out of the way while somebody is watching a film', async () => {
    // The whole point. On a single-vCPU instance a keepalive that ran during a
    // film would be protecting the server by degrading it.
    const server = new SignallingServer({})
    const port = await server.listen()
    cleanups.push(() => server.close())

    const client = new RoomClient({
      url: `ws://127.0.0.1:${port}`, code: null, name: 'anjali', player: stubPlayer()
    })
    cleanups.push(() => client.close())
    await client.connect()

    const { out, ms } = await run(`http://127.0.0.1:${port}${HEALTH_PATH}`, 30)
    expect(out).toContain('staying out of the way')
    expect(out).not.toContain('burning')
    // Returned immediately rather than burning for its thirty seconds.
    expect(ms).toBeLessThan(10_000)
  }, 60_000)

  it('burns when the server cannot be reached at all', async () => {
    // A server that is down means an instance that is idle by definition --
    // exactly the one that needs protecting. Failing to ask must not be read as
    // "somebody is watching".
    const { out } = await run('http://127.0.0.1:1/health', 1)
    expect(out).toContain('treating the server as idle')
    expect(out).toContain('burning')
  }, 60_000)

  it('never outlives its deadline', async () => {
    // It runs unattended for years; a wedged loop that outlived its run would
    // burn a core until somebody noticed.
    const { ms } = await run('http://127.0.0.1:1/health', 2)
    expect(ms).toBeLessThan(20_000)
  }, 60_000)
})
