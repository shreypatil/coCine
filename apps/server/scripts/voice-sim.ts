/**
 * Two people join a room and turn voice on, for real.
 *
 * Mirrors the desktop architecture exactly, because that is where the bug has
 * to be: Node holds the server and the RoomClients, as the main process does,
 * and a Chromium page holds the VoiceMesh and a real RTCPeerConnection with a
 * fake microphone, as the renderer does. Signals cross the same boundary they
 * cross in the application -- page to Node, over the room, back to the other
 * page -- rather than being handed directly between meshes.
 *
 * It reproduces the membership logic from App.tsx verbatim, including the part
 * that decides who is in the call, since "the mesh was never told" is one of
 * the failures being hunted.
 *
 *   npx tsx apps/server/scripts/voice-sim.ts [--peers 2] [--keep]
 */
import { chromium, type Browser, type Page } from 'playwright'
import { createServer } from 'node:http'
import { build } from 'esbuild'
import { mkdtempSync, readFileSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SignallingServer } from '../src/server.js'
import { RoomClient } from '@cocine/client'
import { LogHub, FileSink, ConsoleSink } from '@cocine/logging'
import type { PlayerController } from '@cocine/player'

const arg = (name: string, dflt: string): string => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] ?? dflt : dflt
}
const PEERS = Math.max(2, Number(arg('peers', '2')))

const stubPlayer = (): PlayerController => ({
  load: async () => {}, play: async () => {}, pause: async () => {},
  seek: async () => {}, setRate: async () => {},
  position: () => 0, isPaused: () => true, positionObservedAt: () => Date.now(),
  duration: () => null, showText: async () => {}, setVolume: async () => {},
  unload: async () => {}, on: () => {}, close: async () => {}
}) as PlayerController

const wait = (ms: number) => new Promise(r => setTimeout(r, ms))

async function main (): Promise<void> {
  const logDir = mkdtempSync(join(tmpdir(), 'cocine-sim-logs-'))
  const hub = new LogHub({
    level: 'debug',
    sinks: [new FileSink({ root: logDir }), new ConsoleSink()]
  })
  const simLog = hub.logger('sim')
  simLog.info('simulation starting', { peers: PEERS, logDir })

  const server = new SignallingServer({ logger: hub.logger('server') })
  const port = await server.listen()

  // A blank page over 127.0.0.1: getUserMedia needs a secure context.
  const pageHost = createServer((_, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<!doctype html><meta charset="utf-8"><title>sim</title>')
  })
  await new Promise<void>(r => pageHost.listen(0, '127.0.0.1', r))
  const a = pageHost.address()
  const origin = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`

  const meshJs = (await build({
    entryPoints: [join(import.meta.dirname, '../../../packages/voice/src/mesh.ts')],
    bundle: true, format: 'iife', globalName: 'Voice', write: false, platform: 'browser'
  })).outputFiles[0]!.text

  const browser: Browser = await chromium.launch({
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream']
  })

  interface Person {
    name: string; client: RoomClient; page: Page
    log: ReturnType<typeof hub.logger>
    joinVoice: () => void
  }
  const people: Person[] = []
  let code: string | null = null

  for (let i = 0; i < PEERS; i++) {
    const name = `person${i + 1}`
    const log = hub.logger(`client.${name}`)
    const client: RoomClient = new RoomClient({ url: `ws://127.0.0.1:${port}`, code, name, player: stubPlayer() })
    await client.connect()
    code ??= client.code
    log.info('joined room', { room: client.code, memberId: client.memberId?.slice(0, 8) })

    const page = await browser.newPage({ permissions: ['microphone'] })
    page.on('console', m => log.debug(`page: ${m.text()}`))
    page.on('pageerror', e => log.error('page threw', e))
    await page.goto(origin)
    await page.addScriptTag({ content: meshJs })

    // The renderer's half: mesh, microphone, real peer connections.
    await page.exposeFunction('__send', (to: string, payload: unknown) => {
      const p = payload as { kind?: string; sdp?: string } | undefined
      log.info('signal out', { to: to.slice(0, 8), kind: p?.kind ?? 'candidate', sdpBytes: p?.sdp?.length })
      client.sendSignal(to, payload)
    })
    await page.exposeFunction('__peerState', (id: string, state: string) => {
      log.info('peer state', { peer: id.slice(0, 8), state })
    })
    await page.exposeFunction('__remote', (id: string) => log.info('remote stream', { peer: id.slice(0, 8) }))

    // Defined as plain script rather than passed as a closure: tsx compiles
    // this file with esbuild, which injects `__name` helpers into every
    // function -- and those do not exist inside the page, so a closure handed
    // to page.evaluate dies with "__name is not defined".
    await page.addScriptTag({ content: `
      window.__setup = async function (selfId) {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
        window.mesh = new window.Voice.VoiceMesh({
          selfId: selfId,
          send: function (to, payload) { window.__send(to, payload) },
          createConnection: function () { return new RTCPeerConnection({ iceServers: [] }) },
          onRemoteStream: function (id) { window.__remote(id) },
          onPeerStateChange: function (id, state) { window.__peerState(id, state) }
        })
        window.mesh.setLocalStream(stream, stream.getAudioTracks())
        return stream.getAudioTracks().length
      }
      window.__setMembers = function (ids) { return window.mesh.setMembers(ids) }
      window.__signal = function (from, payload) { return window.mesh.handleSignal(from, payload) }
      window.__report = function () {
        const out = {}
        for (const entry of window.mesh.peers) out[entry[0]] = entry[1].conn.connectionState
        return out
      }
    ` })
    const tracks = await page.evaluate(`window.__setup(${JSON.stringify(client.memberId!)})`)
    log.info('microphone open', { audioTracks: tracks })

    // Main's half: hand every incoming signal to the page.
    client.on('rtc-signal', (from: string, payload: unknown) => {
      const p = payload as { kind?: string } | undefined
      log.info('signal → renderer', { from: from.slice(0, 8), kind: p?.kind ?? 'candidate' })
      void page.evaluate(`window.__signal(${JSON.stringify(from)}, ${JSON.stringify(payload)})`)
        .catch(e => log.error('handleSignal failed', e))
    })

    /**
     * The renderer's membership effect, reproduced.
     *
     * App.tsx recomputes `memberIds` on every render and useVoice calls
     * setMembers whenever the joined string changes. Modelling it as a reaction
     * to the roster -- rather than calling setMembers once when everybody is
     * already present -- is the difference between the tidy case and the real
     * one, where people turn voice on at different moments.
     */
    let lastIds = ''
    let joinedVoice = false
    client.on('members', () => {
      if (!joinedVoice) return
      const memberIds = client.members
        .filter(m => m.inVoice || m.id === client.memberId)
        .map(m => m.id)
      const key = memberIds.join(',')
      if (key === lastIds) return
      lastIds = key
      log.info('members changed', {
        self: client.memberId?.slice(0, 8),
        members: memberIds.map(i => i.slice(0, 8)),
        roomSays: client.members.map(m => ({ name: m.name, inVoice: m.inVoice }))
      })
      void page.evaluate(`window.__setMembers(${JSON.stringify(memberIds)})`)
        .catch(e => log.error('setMembers failed', e))
    })

    people.push({ name, client, page, log, joinVoice: () => { joinedVoice = true } })
  }

  /**
   * Staggered, because that is how people join: one presses the button, and the
   * other does so some seconds later. The first person's mesh must then learn
   * about the second from the roster alone -- there is no second chance to call
   * setMembers by hand.
   */
  for (const p of people) {
    p.joinVoice()
    p.client.setVoiceState({ inVoice: true, muted: false, deafened: false })
    p.log.info('turned voice on')

    // What useVoice's join() does: set members from what is known right now.
    const memberIds = p.client.members
      .filter(m => m.inVoice || m.id === p.client.memberId)
      .map(m => m.id)
    p.log.info('join: members at this moment', {
      self: p.client.memberId?.slice(0, 8), members: memberIds.map(i => i.slice(0, 8))
    })
    await p.page.evaluate(`window.__setMembers(${JSON.stringify(memberIds)})`)
    await wait(Number(arg('stagger', '4000')))
  }

  simLog.info('waiting for connections to settle')
  await wait(12_000)

  // What actually happened.
  const report: Array<Record<string, unknown>> = []
  for (const p of people) {
    const state = await p.page.evaluate('window.__report()') as Record<string, string>
    report.push({ who: p.name, peers: Object.fromEntries(Object.entries(state).map(([k, v]) => [k.slice(0, 8), v])) })
  }
  simLog.info('outcome', report)

  const connected = report.every(r => Object.values(r.peers as Record<string, string>).every(v => v === 'connected'))
  const anyPeers = report.every(r => Object.keys(r.peers as Record<string, string>).length > 0)

  console.log('\n' + '='.repeat(70))
  if (!anyPeers) console.log('NO PEER CONNECTIONS WERE EVER CREATED — the mesh was never told who is in the call')
  else if (!connected) console.log('PEERS CREATED BUT DID NOT CONNECT — negotiation started and stalled')
  else console.log('ALL PEERS CONNECTED — the shared path works; the fault is above it')
  console.log('='.repeat(70))
  console.log(`logs: ${logDir}`)
  for (const ch of existsSync(logDir) ? readdirSync(logDir) : []) {
    for (const f of readdirSync(join(logDir, ch))) {
      console.log(`  ${join(logDir, ch, f)}  (${readFileSync(join(logDir, ch, f), 'utf8').split('\n').length - 1} lines)`)
    }
  }

  for (const p of people) { await p.page.close(); await p.client.close() }
  await browser.close()
  await server.close()
  await new Promise<void>(r => pageHost.close(() => r()))
  process.exit(connected ? 0 : 1)
}
main().catch(e => { console.error(e); process.exit(2) })
