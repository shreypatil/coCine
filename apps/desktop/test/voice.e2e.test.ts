import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { _electron as electron, chromium, type Browser, type ElectronApplication, type Page } from 'playwright'
import { execFileSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { join } from 'node:path'
import { build } from 'esbuild'
import { RoomClient } from '@cocine/client'
import type { PlayerController } from '@cocine/player'
import { SignallingServer } from '../../server/src/server.js'

/**
 * A voice call through the real application.
 *
 * Every earlier voice test stopped short of the boundary that was actually
 * broken. mesh.test.ts drives VoiceMesh with fakes; mesh-live.test.ts and
 * voice-sim.ts put real peers in Chromium pages but pass their signals between
 * pages through Playwright's serialiser. The application passes them through
 * Electron IPC, which is structured clone -- and an RTCIceCandidate crosses
 * that as `{}`, silently. Offers and answers went through intact, so both ends
 * logged every signal sent and received while every connection sat at `new`,
 * with no error, on every platform. Days went to the network.
 *
 * So this one joins voice by pressing the button in the real renderer, with the
 * real preload, the real main process and a real RTCPeerConnection, and reads
 * the result off the screen: "Connected to 1 of 1". The second participant is
 * the same VoiceMesh in a plain Chromium page over a headless RoomClient, which
 * is exactly the half the simulation already proved sound.
 *
 * Both peers are on this machine, so host candidates carry it and neither STUN
 * nor TURN is exercised. That is fine: the fault this guards against is in the
 * application's plumbing, not in the network.
 */

const stubPlayer = (): PlayerController => ({
  load: async () => {}, play: async () => {}, pause: async () => {},
  seek: async () => {}, setRate: async () => {},
  position: () => 0, isPaused: () => true, positionObservedAt: () => Date.now(),
  duration: () => null, showText: async () => {}, setVolume: async () => {},
  unload: async () => {}, on: () => {}, close: async () => {}
}) as PlayerController

let server: SignallingServer
let app: ElectronApplication
let page: Page
let browser: Browser
let pageHost: Server
let guest: RoomClient
let guestPage: Page

beforeAll(async () => {
  execFileSync('npx', ['electron-vite', 'build'], { cwd: join(process.cwd(), 'apps/desktop'), stdio: 'ignore' })
  server = new SignallingServer()
  const port = await server.listen()

  app = await electron.launch({
    // Chromium's fake microphone: a real getUserMedia with nobody's device. It
    // generates a tone, and the renderer plays what it receives through a real
    // <audio> element -- muted here, or the test beeps out of the speakers.
    args: [join(process.cwd(), 'apps/desktop'), '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--mute-audio'],
    env: { ...process.env, COCINE_HEADLESS: '1' }
  })
  page = await app.firstWindow()
  await page.waitForSelector('[data-testid="stage"]', { timeout: 20_000 })
  await page.fill('[data-testid="server"]', `ws://127.0.0.1:${port}`)
  await page.fill('[data-testid="name"]', 'anjali')
  await page.click('[data-testid="create"]')
  await page.waitForSelector('[data-testid="code"]', { timeout: 20_000 })
  const code = (await page.textContent('[data-testid="code"]'))!.replace(/[^A-Z0-9]/g, '').replace(/COPY|COPIED/, '')

  // The other person: room connection in Node, as main holds it; mesh and
  // peer connection in a page, as the renderer holds them.
  guest = new RoomClient({ url: `ws://127.0.0.1:${port}`, code, name: 'dev', player: stubPlayer() })
  await guest.connect()

  const meshJs = (await build({
    entryPoints: [join(process.cwd(), 'packages/voice/src/mesh.ts')],
    bundle: true, format: 'iife', globalName: 'Voice', write: false, platform: 'browser'
  })).outputFiles[0]!.text
  // getUserMedia needs a secure context, which http://127.0.0.1 is.
  pageHost = createServer((_, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>guest</title>') })
  await new Promise<void>(r => pageHost.listen(0, '127.0.0.1', r))
  const a = pageHost.address()
  browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--mute-audio'] })
  guestPage = await browser.newPage({ permissions: ['microphone'] })
  await guestPage.goto(`http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`)
  await guestPage.addScriptTag({ content: meshJs })
  await guestPage.exposeFunction('__send', (to: string, payload: unknown) => guest.sendSignal(to, payload))
  // What the application actually received from the other side, verbatim.
  const arrived: Array<{ kind?: string; candidate?: unknown }> = []
  await guestPage.addScriptTag({ content: `
    window.__setup = async function (selfId) {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
      window.states = {}
      window.mesh = new window.Voice.VoiceMesh({
        selfId,
        // Own enumerable properties only -- the copy Electron IPC makes. The
        // guest must be no more forgiving than a second copy of the
        // application would be, or ICE finds the other side by itself through
        // peer-reflexive candidates and the test passes on broken code.
        send: function (to, payload) {
          window.__send(to, payload.candidate ? Object.assign({}, payload, { candidate: Object.assign({}, payload.candidate) }) : payload)
        },
        createConnection: function () { return new RTCPeerConnection({ iceServers: [] }) },
        onRemoteStream: function () {},
        onPeerStateChange: function (id, state) { window.states[id] = state }
      })
      window.mesh.setLocalStream(stream, stream.getAudioTracks())
    }
  ` })
  await guestPage.evaluate(`window.__setup(${JSON.stringify(guest.memberId!)})`)
  guest.on('rtc-signal', (from: string, payload: unknown) => {
    arrived.push(payload as { kind?: string; candidate?: unknown })
    void guestPage.evaluate(`window.mesh.handleSignal(${JSON.stringify(from)}, ${JSON.stringify(payload)})`)
  })
  // The renderer's membership effect, as App.tsx computes it: whoever the room
  // says is in voice, plus self.
  const follow = (): void => {
    const ids = guest.members.filter(m => m.inVoice || m.id === guest.memberId).map(m => m.id)
    void guestPage.evaluate(`window.mesh.setMembers(${JSON.stringify(ids)})`)
  }
  guest.on('members', follow)
  guest.setVoiceState({ inVoice: true, muted: false, deafened: false })
  follow()

  await page.waitForFunction(() => document.querySelectorAll('[data-testid="member"]').length === 2, null, { timeout: 20_000 })
  received = arrived
}, 240_000)
let received: Array<{ kind?: string; candidate?: unknown }> = []

afterAll(async () => {
  await Promise.race([app?.close(), new Promise(r => setTimeout(r, 15_000))])
  await guestPage?.close(); await browser?.close()
  await guest?.close(); await server?.close()
  await new Promise<void>(r => pageHost?.close(() => r()))
}, 40_000)

describe('joining voice in the application', () => {
  it('connects to the other person, as read off the screen', async () => {
    await page.click('[data-testid="joinvoice"]')
    // The line that used to read "Nobody else is in voice yet" for ever.
    await expect.poll(() => page.textContent('[data-testid="voicepeers"]'), { timeout: 40_000 })
      .toContain('Connected to 1 of 1')
    // And the same from the other end, so it is a connection and not a claim.
    await expect.poll(async () => Object.values(await guestPage.evaluate('window.states') as Record<string, string>), { timeout: 20_000 })
      .toEqual(['connected'])
    // The candidates the application sent had something in them. Under the
    // bug every one arrived as {} -- and this is the assertion that names it,
    // where "did not connect" only says that something did not work.
    const candidates = received.filter(p => p.kind === 'candidate')
    expect(candidates.length).toBeGreaterThan(0)
    for (const c of candidates) {
      expect(c.candidate, 'an ICE candidate hollowed out crossing IPC').toMatchObject({ candidate: expect.stringContaining('candidate:') })
    }
    expect(await page.textContent('[data-testid="voiceerror"]').catch(() => null)).toBeNull()
  }, 90_000)
})
