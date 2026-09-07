/**
 * Phase 4 exit criterion, as an executable check.
 *
 * A film exists on exactly one machine. Everyone else fetches it from the
 * swarm, over WebRTC, and starts watching before it has finished arriving --
 * with the room staying in sync throughout.
 *
 * Every client here is a real RoomClient with a real headless mpv, so the sync
 * engine, the readiness gate, the piece scheduler and the transfer are all the
 * shipping code. Only the machines are simulated: this runs on loopback, which
 * is the one thing it cannot prove. See --help.
 *
 * Run:  npm run phase4
 *       npm run phase4 -- --gb=4 --peers=4
 */
import { installWebRtc } from '@cocine/client'
installWebRtc()

import { SignallingServer } from '../src/server.js'
import { RoomClient, FilmStore, TransferManager } from '@cocine/client'
import { ExternalMpv, ensureTestVideo } from '@cocine/player'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const arg = (k: string, d: number): number => {
  const m = process.argv.find(a => a.startsWith(`--${k}=`))
  return m ? Number(m.split('=')[1]) : d
}
const PEERS = arg('peers', 3)
const GB = arg('gb', 0.5)
const RUN_SEC = arg('duration', 90)
const BUDGET_MS = arg('budget', 100)
const FILM_SEC = arg('film', 600)
/** Megabits per second per receiver. Loopback is unrealistically fast. */
const DOWN_MBPS = arg('down', 16)
const UP_MBPS = arg('up', 8)

const pct = (xs: number[], p: number): number =>
  xs.length === 0 ? NaN : [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))]!
const secs = (ms: number): string => `${(ms / 1000).toFixed(1)}s`

const main = async (): Promise<void> => {
  console.log(`\n  Phase 4 — a film reaching machines that never had it`)
  console.log(`  ${'─'.repeat(66)}`)
  console.log(`  ${PEERS} receivers · ${GB} GB film · ${FILM_SEC}s runtime · ${BUDGET_MS} ms sync budget`)
  console.log(`  shaped links: ${DOWN_MBPS} Mbps down · ${UP_MBPS} Mbps up per peer\n`)

  const fixtures = join(process.cwd(), '.fixtures')
  // Height chosen to land near the requested size at this duration.
  const height = GB >= 3 ? 1080 : GB >= 1 ? 720 : 480
  const film = ensureTestVideo(FILM_SEC, fixtures, { height, crf: GB >= 3 ? 26 : 30 })
  const bytes = statSync(film).size
  console.log(`  film on disk: ${(bytes / 1024 ** 3).toFixed(2)} GB\n`)

  const server = new SignallingServer({ startLeadMs: 400, log: m => console.log(`  [server] ${m}`) })
  const port = await server.listen()
  const root = mkdtempSync(join(tmpdir(), 'phase4-'))

  interface Participant { name: string; client: RoomClient; player: ExternalMpv; transfer: TransferManager }
  const all: Participant[] = []

  const join_ = async (name: string, code: string | null, isSharer: boolean): Promise<Participant> => {
    const player = new ExternalMpv({ headless: true })
    await player.start()
    const store = new FilmStore(join(root, name, 'films'))
    const transfer = new TransferManager({
      store,
      trackerUrl: `ws://127.0.0.1:${port}/announce`,
      iceServers: [],
      // The sharer needs upload to give the film away; receivers are shaped to
      // something like a home connection so the gate has something to gate.
      downloadLimitBps: isSharer ? -1 : Math.round((DOWN_MBPS * 1e6) / 8),
      uploadLimitBps: Math.round((UP_MBPS * 1e6) / 8)
    })
    let shared: string | null = null
    const client: RoomClient = new RoomClient({
      url: `ws://127.0.0.1:${port}`, code, name, player,
      getReport: () => {
        const t = client.media?.torrent
        if (!t) return null
        if (t.infoHash === shared) {
          return { havePct: 1, bufferEndSec: client.media?.durationSec ?? 0, downBps: 0, upBps: 0, peers: 0 }
        }
        return transfer.reportFor(t.infoHash, client.expectedPosition() ?? 0, client.media?.durationSec ?? 0)
      }
    })
    // Attached before connect: room.state arrives while connecting, so a
    // listener added afterwards misses a film that was already on.
    if (!isSharer) {
      client.on('media', () => {
        void (async () => {
          const t = client.media?.torrent
          if (!t || t.infoHash === shared) return
          console.log(`  [${name}] receiving ${t.infoHash.slice(0, 8)}…`)
          await transfer.receive(t)
          console.log(`  [${name}] metadata ready`)
          const url = transfer.streamUrl(t.infoHash)
          if (url) { await player.load(url); console.log(`  [${name}] player opened the stream`) }
        })().catch(e => console.error(`  ${name}: ${String(e)}`))
      })
    }
    client.on('server-error', (m: string) => console.log(`  [${name}] server said: ${m}`))
    await client.connect()

    if (isSharer) {
      await player.load(film)
      const info = await transfer.share(film)
      shared = info.infoHash
      client.announceMedia('film', FILM_SEC, info)
    }
    const p = { name, client, player, transfer }
    all.push(p)
    return p
  }

  const t0 = Date.now()
  const sharer = await join_('rohan', null, true)
  const names = ['anjali', 'dev', 'priya', 'sam', 'kiran']
  for (let i = 0; i < PEERS; i++) await join_(names[i % names.length]!, sharer.client.code, false)

  // --- wait for the gate ---------------------------------------------------
  let gateAt: number | null = null
  let progressAtGate = 0
  const deadline = Date.now() + 10 * 60_000
  while (Date.now() < deadline) {
    const st = sharer.client.transfer
    if (sharer.client.phase === 'ready' || sharer.client.phase === 'playing') {
      gateAt = Date.now() - t0
      progressAtGate = Math.min(...all.slice(1).map(p => p.transfer.progress()[0]?.progress ?? 0))
      break
    }
    if (st) {
      const worst = st.perPeer.reduce((w, p) => p.havePct < w.havePct ? p : w)
      console.log(`  waiting: slowest ${(worst.havePct * 100).toFixed(0)}% (${worst.name})`)
    }
    await new Promise(r => setTimeout(r, 3000))
  }
  if (gateAt === null) { console.error('  the room never became ready'); process.exit(1) }
  console.log(`  gate opened after ${secs(gateAt)} — slowest receiver had ${(progressAtGate * 100).toFixed(1)}% of the film`)

  // --- watch, and measure drift while the rest still arrives --------------
  sharer.client.requestPlay(0)
  const spreads: number[] = []
  let progressDuringPlayback: number[] = []
  const started = Date.now()
  while (Date.now() - started < RUN_SEC * 1000) {
    const now = Date.now()
    const ps = all.map(p => p.client.actualPosition(now))
    spreads.push((Math.max(...ps) - Math.min(...ps)) * 1000)
    progressDuringPlayback.push(Math.min(...all.slice(1).map(p => p.transfer.progress()[0]?.progress ?? 0)))
    await new Promise(r => setTimeout(r, 200))
  }

  const settled = spreads.slice(Math.floor(spreads.length * 0.15))
  const p99 = pct(settled, 0.99)
  const worst = Math.max(...settled)
  const startedEarly = progressAtGate < 0.98
  const stillArriving = progressDuringPlayback[0]! < 0.98

  const st = sharer.client.transfer
  console.log(`\n  ${'─'.repeat(66)}`)
  console.log(`  watchable before complete   ${startedEarly ? 'yes' : 'no'} (${(progressAtGate * 100).toFixed(1)}% at the gate)`)
  console.log(`  still arriving while playing ${stillArriving ? 'yes' : 'no'}`)
  console.log(`  sync during transfer        p99 ${p99.toFixed(1)} ms · worst ${worst.toFixed(1)} ms`)
  console.log(`  full copies in the room     ${st?.fullCopies ?? 0} · sharer may leave: ${st?.safeForSharerToLeave ? 'yes' : 'not yet'}`)

  // Verdict before teardown: a slow shutdown must not hide the result, and
  // closing a client with live swarm connections is not instant.
  const pass = startedEarly && p99 <= BUDGET_MS
  console.log(`  ${'─'.repeat(66)}`)
  console.log(`  ${pass ? 'PASS' : 'FAIL'} — watched before it arrived, room held to ${p99.toFixed(0)} ms\n`)

  await Promise.race([
    (async () => {
      for (const p of all) {
        await p.client.close()
        await p.transfer.destroy()
        await p.player.close()
      }
      await server.close()
    })(),
    new Promise(r => setTimeout(r, 20_000))
  ])
  try { rmSync(root, { recursive: true, force: true }) } catch { /* leftovers in tmp are harmless */ }
  process.exit(pass ? 0 : 1)
}

main().catch(e => { console.error(e); process.exit(1) })
