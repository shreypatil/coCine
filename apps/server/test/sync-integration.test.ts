import { describe, it, expect, afterAll } from 'vitest'
import { SignallingServer } from '../src/server.js'
import { RoomClient } from '@cocine/client'
import { ExternalMpv, ensureTestVideo } from '@cocine/player'
import { join } from 'node:path'

/**
 * A short version of the phase 1 drift test, sized to run on every commit.
 * The full criterion (five clients, a two-hour film, twenty events) lives in
 * scripts/drift-test.ts; this guards against regressions cheaply.
 */
const cleanups: Array<() => Promise<void>> = []
afterAll(async () => { for (const c of cleanups) await c() })

describe('synchronised playback', () => {
  it('holds three clients inside 100 ms through a seek, over a delayed link', async () => {
    const film = ensureTestVideo(60, join(process.cwd(), '.fixtures'))
    const server = new SignallingServer({ startLeadMs: 400, simulatedDelayMs: 30, simulatedJitterMs: 10, simulatedSkewMs: 12_000 })
    const port = await server.listen()
    cleanups.push(() => server.close())

    const clients: RoomClient[] = []
    for (const name of ['a', 'b', 'c']) {
      const player = new ExternalMpv({ headless: true })
      await player.start()
      await player.load(film)
      cleanups.push(() => player.close())
      const client = new RoomClient({ url: `ws://127.0.0.1:${port}`, room: 'r', name, player })
      await client.connect()
      cleanups.push(() => client.close())
      clients.push(client)
    }

    // Every client must have recovered the server's 12 s clock skew.
    for (const c of clients) expect(Math.abs(c.clock.offsetMs() - 12_000)).toBeLessThan(100)

    const host = clients[0]!
    host.announceMedia('film', 60)
    await new Promise(r => setTimeout(r, 200))
    host.requestPlay(0)
    await new Promise(r => setTimeout(r, 4000))

    const spread = (): number => {
      const now = Date.now()
      const ps = clients.map(c => c.actualPosition(now))
      return (Math.max(...ps) - Math.min(...ps)) * 1000
    }

    const before: number[] = []
    for (let i = 0; i < 15; i++) { before.push(spread()); await new Promise(r => setTimeout(r, 100)) }
    expect(Math.max(...before)).toBeLessThan(100)

    host.requestSeek(35)
    await new Promise(r => setTimeout(r, 3000))
    const after: number[] = []
    for (let i = 0; i < 15; i++) { after.push(spread()); await new Promise(r => setTimeout(r, 100)) }
    expect(Math.max(...after)).toBeLessThan(100)

    // And they landed near the seek target, not merely near each other.
    for (const c of clients) expect(c.actualPosition()).toBeGreaterThan(34)
  }, 60_000)
})
