import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { createConnection } from 'node:net'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import polyfill from 'node-datachannel/polyfill'
import { iceServersFor } from '../src/turn.js'

// The server package builds without the DOM lib, so the handful of WebRTC
// shapes this test touches are declared here rather than pulled in wholesale.
interface Cand { candidate: string }
interface Chan {
  onopen: (() => void) | null
  onmessage: ((m: { data: unknown }) => void) | null
  send: (data: string) => void
}
interface PC {
  onicecandidate: ((e: { candidate: Cand | null }) => void) | null
  ondatachannel: ((e: { channel: Chan }) => void) | null
  localDescription: unknown
  addIceCandidate: (c: Cand) => Promise<void>
  createDataChannel: (label: string) => Chan
  createOffer: () => Promise<unknown>
  createAnswer: () => Promise<unknown>
  setLocalDescription: (d: unknown) => Promise<void>
  setRemoteDescription: (d: unknown) => Promise<void>
  close: () => void
}
const { RTCPeerConnection } = polyfill as unknown as { RTCPeerConnection: new (cfg: unknown) => PC }

const CONTAINER = 'cocine-turn-e2e'
const USER = 'cocine'
const PASS = 'relay-test-pw'

function hasDocker (): boolean {
  try { execFileSync('docker', ['info'], { stdio: 'ignore' }); return true } catch { return false }
}

// This test costs a container start, so it runs only where Docker exists. It is
// the one check that cannot be faked: every other TURN test asserts what we
// *send*, and only a real relay proves a call survives a network that blocks
// direct peer connections entirely.
const suite = hasDocker() ? describe : describe.skip

suite('voice falls back to a TURN relay', () => {
  let dir = ''

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cocine-turn-'))
    // Loopback peers are refused by default, and rightly so -- a relay that can
    // reach 127.0.0.0/8 can reach whatever else the host can. The production
    // config in infra/turnserver.conf denies these ranges; only this test, whose
    // two peers *are* on loopback, opens them.
    writeFileSync(join(dir, 'turnserver.conf'), [
      'listening-port=3478', 'listening-ip=127.0.0.1', 'relay-ip=127.0.0.1',
      'lt-cred-mech', `user=${USER}:${PASS}`, 'realm=cocine.test',
      'min-port=49160', 'max-port=49200',
      'no-multicast-peers', 'allow-loopback-peers',
      'fingerprint', 'no-cli', 'log-file=stdout'
    ].join('\n'))

    execFileSync('docker', ['rm', '-f', CONTAINER], { stdio: 'ignore' })
    execFileSync('docker', ['run', '-d', '--name', CONTAINER, '--network', 'host',
      '-v', `${join(dir, 'turnserver.conf')}:/etc/coturn/turnserver.conf:ro`,
      'coturn/coturn:latest', '-c', '/etc/coturn/turnserver.conf'], { stdio: 'ignore' })

    // Wait on the port rather than on the log: coturn only announces its
    // listeners at verbose level, so log scraping quietly waits forever on a
    // server that is already accepting connections.
    const listening = () => new Promise<boolean>(resolve => {
      const sock = createConnection({ host: '127.0.0.1', port: 3478 })
      const done = (ok: boolean) => { sock.destroy(); resolve(ok) }
      sock.once('connect', () => done(true))
      sock.once('error', () => done(false))
      setTimeout(() => done(false), 500)
    })
    const deadline = Date.now() + 20000
    while (!(await listening())) {
      if (Date.now() > deadline) {
        const r = spawnSync('docker', ['logs', CONTAINER], { encoding: 'utf8' })
        throw new Error(`coturn did not start:\n${r.stdout ?? ''}${r.stderr ?? ''}`)
      }
      await new Promise(r => setTimeout(r, 250))
    }
  }, 60000)

  afterAll(() => {
    execFileSync('docker', ['rm', '-f', CONTAINER], { stdio: 'ignore' })
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('carries a voice channel when only relayed candidates are allowed', async () => {
    // iceTransportPolicy 'relay' discards host and server-reflexive candidates
    // outright, so this cannot accidentally pass over a direct loopback path.
    const ice = {
      iceServers: [{ urls: ['turn:127.0.0.1:3478'], username: USER, credential: PASS }],
      iceTransportPolicy: 'relay' as const
    }
    const a = new RTCPeerConnection(ice)
    const b = new RTCPeerConnection(ice)
    const kinds = new Set<string>()
    const note = (c: Cand) => { const m = /typ (\w+)/.exec(c.candidate); if (m) kinds.add(m[1]!) }

    try {
      a.onicecandidate = e => { if (e.candidate) { note(e.candidate); void b.addIceCandidate(e.candidate) } }
      b.onicecandidate = e => { if (e.candidate) { note(e.candidate); void a.addIceCandidate(e.candidate) } }

      const arrived = new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(
          `nothing arrived in 25s; candidate types gathered: ${[...kinds].join(',') || 'none'}`)), 25000)
        b.ondatachannel = ev => { ev.channel.onmessage = m => { clearTimeout(timer); resolve(String(m.data)) } }
      })

      const ch = a.createDataChannel('voice')
      ch.onopen = () => ch.send('through the relay')
      await a.setLocalDescription(await a.createOffer())
      await b.setRemoteDescription(a.localDescription)
      await b.setLocalDescription(await b.createAnswer())
      await a.setRemoteDescription(b.localDescription)

      expect(await arrived).toBe('through the relay')
      expect([...kinds]).toEqual(['relay'])
    } finally {
      a.close()
      b.close()
    }
  }, 40000)

  it('never hands the bulk plane a relay, even with one running', () => {
    const cfg = { secret: 'phase6-test-secret', urls: ['turn:127.0.0.1:3478'] }
    const urls = iceServersFor('bulk', 'anjali', cfg).flatMap(s => s.urls)
    expect(urls.some(u => u.startsWith('turn:'))).toBe(false)
    expect(urls.every(u => u.startsWith('stun:'))).toBe(true)
  })
})
