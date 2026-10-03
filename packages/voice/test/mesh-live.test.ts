/// <reference lib="dom" />
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { chromium, type Browser, type Page } from 'playwright'
import { createServer, type Server } from 'node:http'
import { build } from 'esbuild'
import { join } from 'node:path'

/**
 * Does a call actually connect, and does audio actually flow?
 *
 * mesh.test.ts drives VoiceMesh against stubbed connections. That proves the
 * negotiation bookkeeping and nothing whatever about WebRTC. This runs the same
 * class in two real Chromium pages, with real RTCPeerConnections and a fake
 * microphone, relaying signalling between them the way RoomClient does, and
 * then reads getStats to confirm RTP packets arrived. A stub cannot fake that
 * number.
 *
 * It exists because "voice does not work" was once diagnosed from a DNS line in
 * a log, with nothing testing the voice path at all behind the claim.
 *
 * What this deliberately does NOT cover: both pages are on this machine, so
 * host candidates always win and neither STUN nor TURN is exercised. A pass
 * means the mesh, the negotiation and the media path are sound. It says nothing
 * about whether a relay is reachable from somebody else's network.
 */

let browser: Browser
let server: Server
let origin = ''
let meshJs = ''

beforeAll(async () => {
  // esbuild rather than hand-stripping types: the point is to run the real
  // class, and a bespoke transpiler would be testing itself.
  const out = await build({
    entryPoints: [join(__dirname, '../src/mesh.ts')],
    bundle: true, format: 'iife', globalName: 'Voice', write: false, platform: 'browser'
  })
  meshJs = out.outputFiles[0]!.text

  // getUserMedia needs a secure context, which about:blank is not and
  // http://127.0.0.1 is.
  server = createServer((_, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<!doctype html><meta charset="utf-8"><title>voice</title>')
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const a = server.address()
  origin = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`

  browser = await chromium.launch({
    // Muted: the fake microphone is a tone, and nothing here listens to it.
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--mute-audio']
  })
}, 180_000)

afterAll(async () => {
  await browser?.close()
  await new Promise<void>(r => server?.close(() => r()))
})

/** One participant, holding the real VoiceMesh. */
async function participant (selfId: string, retryDelaysMs?: number[]): Promise<Page> {
  const page = await browser.newPage({ permissions: ['microphone'] })
  await page.goto(origin)
  await page.addScriptTag({ content: meshJs })
  await page.evaluate(async ({ id, retryDelaysMs }: { id: string; retryDelaysMs?: number[] }) => {
    const w = window as any
    w.outbox = []
    w.remote = []
    w.states = {}
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
    w.mesh = new w.Voice.VoiceMesh({
      selfId: id,
      send: (to: string, payload: unknown) => w.outbox.push({ to, payload }),
      createConnection: () => new RTCPeerConnection({ iceServers: [] }),
      onRemoteStream: (memberId: string, stream: MediaStream) => {
        w.remote.push(memberId)
        // Actually play it: an unread track is not pulled, and the inbound
        // stats below would stay at zero for the wrong reason.
        const el = new Audio(); el.srcObject = stream; el.muted = true; void el.play()
        w.audioEl = el
      },
      onPeerStateChange: (memberId: string, state: string) => { w.states[memberId] = state },
      retryDelaysMs
    })
    w.mesh.setLocalStream(stream, stream.getAudioTracks())
  }, { id: selfId, retryDelaysMs })
  return page
}

/** Relay signalling both ways until the call settles, as the room would. */
async function pump (a: { page: Page; id: string }, b: { page: Page; id: string }, rounds = 50): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    for (const [from, to] of [[a, b], [b, a]] as Array<[typeof a, typeof b]>) {
      const out: Array<{ to: string; payload: unknown }> =
        await from.page.evaluate(() => (window as any).outbox.splice(0))
      for (const m of out) {
        await to.page.evaluate(async (p: { from: string; payload: unknown }) => {
          await (window as any).mesh.handleSignal(p.from, p.payload)
        }, { from: from.id, payload: m.payload })
      }
    }
    await new Promise(r => setTimeout(r, 100))
  }
}

/** Audio packets the current connection to `from` has received, waiting a while for the first. */
async function packetsFrom (page: Page, from: string): Promise<number> {
  return await page.evaluate(async (id: string) => {
    const w = window as any
    const pc: RTCPeerConnection = w.mesh.peers.get(id).conn
    for (let i = 0; i < 40; i++) {
      let n = 0
      ;(await pc.getStats()).forEach((r: any) => {
        if (r.type === 'inbound-rtp' && r.kind === 'audio') n = r.packetsReceived ?? 0
      })
      if (n > 0) return n
      await new Promise(r => setTimeout(r, 200))
    }
    return 0
  }, from)
}

describe('a real call between two participants', () => {
  it('connects, exchanges streams, and delivers audio packets', async () => {
    // shouldInitiate compares ids, so these decide who offers.
    const a = { page: await participant('aaaa'), id: 'aaaa' }
    const b = { page: await participant('bbbb'), id: 'bbbb' }
    try {
      await a.page.evaluate(async (p: string) => { await (window as any).mesh.setMembers([p]) }, b.id)
      await b.page.evaluate(async (p: string) => { await (window as any).mesh.setMembers([p]) }, a.id)
      await pump(a, b)

      expect(await a.page.evaluate((p: string) => (window as any).states[p], b.id)).toBe('connected')
      expect(await b.page.evaluate((p: string) => (window as any).states[p], a.id)).toBe('connected')

      expect(await a.page.evaluate(() => (window as any).remote)).toContain(b.id)
      expect(await b.page.evaluate(() => (window as any).remote)).toContain(a.id)

      expect(await packetsFrom(b.page, a.id), 'audio packets received').toBeGreaterThan(0)
    } finally { await a.page.close(); await b.page.close() }
  }, 240_000)

  it('comes back with audio after a connection fails', async () => {
    // A real failure takes Chromium half a minute to declare, so the failure is
    // delivered the way the connection would deliver it, and everything after
    // -- the new connection, the new offer, the other side replacing its end,
    // and audio flowing again -- is real.
    const a = { page: await participant('aaaa', [50]), id: 'aaaa' }
    const b = { page: await participant('bbbb', [50]), id: 'bbbb' }
    try {
      await a.page.evaluate(async (p: string) => { await (window as any).mesh.setMembers([p]) }, b.id)
      await b.page.evaluate(async (p: string) => { await (window as any).mesh.setMembers([p]) }, a.id)
      await pump(a, b, 20)
      expect(await a.page.evaluate((p: string) => (window as any).states[p], b.id)).toBe('connected')

      const before = await a.page.evaluate((p: string) => {
        const w = window as any
        const peer = w.mesh.peers.get(p)
        w.oldConn = peer.conn
        // What the connection itself does when ICE gives up.
        Object.defineProperty(peer.conn, 'connectionState', { value: 'failed', configurable: true })
        peer.conn.onconnectionstatechange()
        return w.states[p]
      }, b.id)
      expect(before).toBe('failed')

      await new Promise(r => setTimeout(r, 200))
      await pump(a, b, 20)

      const replaced = await a.page.evaluate((p: string) => {
        const w = window as any
        return w.mesh.peers.get(p).conn !== w.oldConn && w.oldConn.signalingState === 'closed'
      }, b.id)
      expect(replaced, 'a new connection replaced the failed one').toBe(true)
      expect(await a.page.evaluate((p: string) => (window as any).states[p], b.id)).toBe('connected')
      expect(await b.page.evaluate((p: string) => (window as any).states[p], a.id)).toBe('connected')
      expect(await packetsFrom(b.page, a.id), 'audio packets on the new connection').toBeGreaterThan(0)
    } finally { await a.page.close(); await b.page.close() }
  }, 240_000)
})
