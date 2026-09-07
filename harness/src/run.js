import WebTorrent from 'webtorrent'
import { Server as TrackerServer } from 'bittorrent-tracker'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { analyse, mbps } from './theory.js'
import { ensureFixture } from './fixture.js'
import { policies } from './policies.js'
import { renderRun } from './report.js'

const TICK_MS = 250

const args = process.argv.slice(2)
const scenarioPath = args.find(a => !a.startsWith('-'))
const policyName = (args.find(a => a.startsWith('--policy=')) || '--policy=sequential').split('=')[1]
const quiet = args.includes('--quiet')
if (!scenarioPath) {
  console.error('usage: node src/run.js scenarios/<name>.json [--policy=stock|sequential|planned]')
  process.exit(1)
}

const scenario = JSON.parse(readFileSync(resolve(scenarioPath), 'utf8'))
function scenarioPeerCount () { return scenario.peers.length }
const policy = policies[policyName]
if (!policy) { console.error(`unknown policy "${policyName}"`); process.exit(1) }

const cfg = {
  criticalSec: 10,
  bufferSec: 60,
  startBufferSec: 20,
  // Fixed slots starve a large room: with 4 slots in a 15-peer swarm the
  // planned policy chokes 10 of every peer's 14 wires and collapses aggregate
  // throughput. Scale with room size unless a scenario overrides it.
  uploadSlots: Math.max(4, Math.ceil(scenarioPeerCount() / 2)),
  superseed: true,
  maxSec: 900,
  ...(scenario.config || {})
}

const theory = analyse(scenario)
const bytesPerSec = theory.bitrate / 8

const workDir = mkdtempSync(join(tmpdir(), 'cocine-'))
const clients = []
let tracker

function log (...a) { if (!quiet) console.log(...a) }

function contiguousMarginSec (torrent, playheadSec) {
  if (!torrent || torrent.destroyed) return -1
  const len = torrent.pieceLength
  const total = torrent.pieces.length
  const playByte = playheadSec * bytesPerSec
  let i = Math.floor(playByte / len)
  if (i >= total) return Infinity
  while (i < total && torrent.bitfield.get(i)) i++
  const availableByte = Math.min(i * len, torrent.length)
  return (availableByte - playByte) / bytesPerSec
}

function makeClient (up, down) {
  return new WebTorrent({
    dht: false,
    lsd: false,
    natUpnp: false,
    utp: false,
    webSeeds: false,
    uploadLimit: process.env.NOTHROTTLE ? -1 : Math.round(mbps(up) / 8),
    downloadLimit: process.env.NOTHROTTLE ? -1 : Math.round(mbps(down) / 8)
  })
}

async function main () {
  const filePath = await ensureFixture(scenario.fileMB, join(process.cwd(), 'results', '.fixtures'))

  tracker = new TrackerServer({ udp: false, ws: false, stats: false })
  await new Promise(res => tracker.listen(0, '127.0.0.1', res))
  const announce = [`http://127.0.0.1:${tracker.http.address().port}/announce`]
  log(`tracker on ${announce[0]}`)

  // --- the sharer -------------------------------------------------------
  const sharerClient = makeClient(scenario.sharer.up, scenario.sharer.down ?? 1000)
  clients.push(sharerClient)
  const seeded = await new Promise(res =>
    sharerClient.seed(filePath, { announce }, res))

  const sharer = {
    name: scenario.sharer.name || 'sharer',
    isSharer: true,
    joined: true,
    up: scenario.sharer.up,
    client: sharerClient,
    torrent: seeded,
    marginSec: Infinity,
    completedAt: 0
  }
  log(`seeding ${scenario.fileMB} MB in ${seeded.pieces.length} pieces of ${seeded.pieceLength} B`)

  // --- leechers ---------------------------------------------------------
  const leechers = scenario.peers.map(p => ({
    name: p.name,
    isSharer: false,
    joined: false,
    joinAtSec: p.joinAtSec || 0,
    up: p.up,
    down: p.down,
    client: null,
    torrent: null,
    marginSec: -1,
    completedAt: null
  }))
  const all = [sharer, ...leechers]
  const peersById = new Map()
  peersById.set(sharerClient.peerId, sharer)

  function joinPeer (p) {
    const dir = mkdtempSync(join(workDir, `${p.name}-`))
    p.client = makeClient(p.up, p.down)
    clients.push(p.client)
    peersById.set(p.client.peerId, p)
    p.client.add(seeded.magnetURI, { announce, path: dir }, t => {
      p.torrent = t
      t.on('done', () => { p.completedAt = (Date.now() - t0) / 1000 })
      if (policyName === 'planned') clearInterval(t._rechokeIntervalId)
    })
    p.joined = true
  }

  // --- run --------------------------------------------------------------
  const room = { phase: 'buffering', playheadSec: 0, stalls: [], stallSec: 0, ttffSec: null }
  const samples = []
  const t0 = Date.now()

  function swarmHasFullCopy () {
    const parts = leechers.filter(p => p.torrent).map(p => p.torrent)
    if (!parts.length) return false
    const total = seeded.pieces.length
    for (let i = 0; i < total; i++) {
      if (!parts.some(t => t.bitfield.get(i))) return false
    }
    return true
  }

  const ctx = { room, cfg, bytesPerSec, all, leechers, sharer, peersById, swarmHasFullCopy }
  for (const p of leechers) if (p.joinAtSec === 0) joinPeer(p)
  policy.init(ctx)

  let inStall = null
  await new Promise(done => {
    const iv = setInterval(() => {
      const now = (Date.now() - t0) / 1000
      const dt = TICK_MS / 1000

      for (const p of leechers) {
        if (!p.joined && now >= p.joinAtSec) { joinPeer(p); policy.init(ctx) }
        p.marginSec = p.joined && p.torrent
          ? (p.torrent.done ? Infinity : contiguousMarginSec(p.torrent, room.playheadSec))
          : -1
      }

      const active = leechers.filter(p => p.joined && p.torrent)
      policy.tick(ctx)
      const margins = active.map(p => p.marginSec)
      const minMargin = margins.length ? Math.min(...margins) : -1

      if (room.phase === 'buffering') {
        if (active.length === leechers.filter(p => now >= p.joinAtSec).length &&
            active.length > 0 && margins.every(m => m >= cfg.startBufferSec)) {
          room.phase = 'playing'
          room.ttffSec = now
          log(`  [${now.toFixed(1)}s] room ready — playback starts`)
        }
      } else if (room.phase === 'playing') {
        // Synchronised viewing: one person stalling stalls the room.
        if (minMargin <= 0) {
          if (!inStall) {
            inStall = { at: now, who: active.filter(p => p.marginSec <= 0).map(p => p.name) }
            log(`  [${now.toFixed(1)}s] STALL — waiting on ${inStall.who.join(', ')}`)
          }
        } else {
          if (inStall) {
            const d = now - inStall.at
            room.stalls.push({ ...inStall, sec: d })
            room.stallSec += d
            inStall = null
          }
          room.playheadSec = Math.min(room.playheadSec + dt, scenario.runtimeSec)
        }
      }

      if (!quiet && Math.round(now * 4) % 8 === 0) {
        console.log(`  [${now.toFixed(1)}s] ${active.map(p => `${p.name} w${p.torrent.numPeers} ${(p.torrent.progress * 100).toFixed(0)}% m${p.marginSec === Infinity ? '∞' : p.marginSec.toFixed(0)}`).join('  ')}`)
      }
      samples.push({
        t: +now.toFixed(2),
        playhead: +room.playheadSec.toFixed(2),
        minMargin: +minMargin.toFixed(2),
        progress: active.map(p => +(p.torrent.progress).toFixed(4))
      })

      const allDone = leechers.every(p => p.joined && p.torrent && p.torrent.done)
      const played = room.playheadSec >= scenario.runtimeSec
      if (allDone || played || now > cfg.maxSec) {
        if (inStall) { room.stallSec += now - inStall.at; room.stalls.push({ ...inStall, sec: now - inStall.at }) }
        clearInterval(iv)
        done()
      }
    }, TICK_MS)
  })

  log(`  wire→peer mapping: ${ctx.mapped || 0} resolved, ${ctx.unmapped || 0} unresolved`)
  const wall = (Date.now() - t0) / 1000
  const result = {
    scenario: scenario.name,
    policy: policyName,
    theory,
    cfg,
    ttffSec: room.ttffSec,
    stallCount: room.stalls.length,
    stallSec: +room.stallSec.toFixed(2),
    stalls: room.stalls,
    playedSec: +room.playheadSec.toFixed(1),
    runtimeSec: scenario.runtimeSec,
    wallSec: +wall.toFixed(1),
    completion: leechers.map(p => ({ name: p.name, sec: p.completedAt, progress: p.torrent ? +p.torrent.progress.toFixed(3) : 0 })),
    maxCompletionSec: Math.max(...leechers.map(p => p.completedAt ?? Infinity)),
    marginStats: marginStats(samples, room.ttffSec),
    samples
  }

  mkdirSync(join(process.cwd(), 'results'), { recursive: true })
  const out = join(process.cwd(), 'results', `${scenario.name}.${policyName}.json`)
  writeFileSync(out, JSON.stringify(result, null, 2))
  if (!quiet) renderRun(result)
  log(`\nwrote ${out}`)
}

// Only meaningful once playback has actually started -- before the readiness
// gate opens every peer legitimately has zero runway.
function marginStats (samples, ttffSec) {
  if (ttffSec == null) return { min: null, p05: null, median: null }
  const v = samples.filter(s => s.t >= ttffSec && s.minMargin != null && isFinite(s.minMargin)).map(s => s.minMargin).sort((a, b) => a - b)
  if (!v.length) return { min: null, p05: null, median: null }
  const q = f => v[Math.min(v.length - 1, Math.floor(v.length * f))]
  return { min: +v[0].toFixed(2), p05: +q(0.05).toFixed(2), median: +q(0.5).toFixed(2) }
}

function cleanup () {
  for (const c of clients) { try { c.destroy() } catch {} }
  try { tracker?.close() } catch {}
  try { rmSync(workDir, { recursive: true, force: true }) } catch {}
}

main().then(() => { cleanup(); process.exit(0) })
  .catch(e => { console.error(e); cleanup(); process.exit(1) })
