import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { installWebRtc, isWebRtcInstalled } from '@cocine/client'

// Must run before any WebTorrent client exists, so it goes at module scope.
installWebRtc()

import WebTorrent, { type Torrent } from 'webtorrent'
import { SignallingServer } from '../src/server.js'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'

/**
 * The step that carried this phase's remaining risk. The harness measured
 * scheduling over loopback TCP and never touched WebRTC at all, so until this
 * passed, "peers can actually reach each other" was an assumption.
 */

let server: SignallingServer
let port: number
let dir: string
const clients: WebTorrent[] = []

beforeAll(async () => {
  server = new SignallingServer({})
  port = await server.listen()
  dir = mkdtempSync(join(tmpdir(), 'cocine-swarm-'))
})
afterAll(async () => {
  for (const c of clients) c.destroy()
  await server.close()
  rmSync(dir, { recursive: true, force: true })
})

// TCP and uTP off: anything that transfers, transferred over WebRTC.
const WEBRTC_ONLY = { dht: false, lsd: false, natUpnp: false, utp: false, tcp: false, webSeeds: false }
const make = (): WebTorrent => {
  // Loopback peers connect on host candidates; no STUN server involved, which
  // keeps this fast and free of an external dependency.
  const c = new WebTorrent({ ...WEBRTC_ONLY, tracker: { rtcConfig: { iceServers: [] } } } as never)
  clients.push(c)
  return c
}

describe('WebRTC availability', () => {
  it('is installed on the global WebTorrent reads', () => {
    // Forgetting this yields a TCP-only swarm that works on a LAN and fails
    // for everyone behind a NAT, silently.
    expect(isWebRtcInstalled()).toBe(true)
  })
})

describe('the room tracker', () => {
  it('refuses an info hash no room has announced', () => {
    expect(server.tracker.allows('0'.repeat(40))).toBe(false)
  })

  it('answers for one the room announced, and forgets it on request', () => {
    const hash = 'a'.repeat(40)
    server.tracker.allow(hash)
    expect(server.tracker.allows(hash)).toBe(true)
    expect(server.tracker.allows(hash.toUpperCase())).toBe(true)
    server.tracker.forget(hash)
    expect(server.tracker.allows(hash)).toBe(false)
  })
})

describe('a private swarm', () => {
  it('moves a film between two peers over WebRTC alone', async () => {
    const announce = [`ws://127.0.0.1:${port}/announce`]
    const file = join(dir, 'film.bin')
    writeFileSync(file, randomBytes(6 * 1024 * 1024))
    const want = createHash('sha256').update(readFileSync(file)).digest('hex')

    const seeded = await new Promise<{ infoHash: string; magnetURI: string }>(res =>
      make().seed(file, { announce }, (t: Torrent) => res(t)))
    server.tracker.allow(seeded.infoHash)

    const out = join(dir, 'out')
    const got = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('nothing transferred within 90s')), 90_000)
      make().add(seeded.magnetURI, { announce, path: out }, (torrent: Torrent) => {
        torrent.on('done', () => {
          clearTimeout(timer)
          resolve(createHash('sha256').update(readFileSync(join(out, torrent.name))).digest('hex'))
        })
      })
    })
    expect(got).toBe(want)
  }, 120_000)
})
