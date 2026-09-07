/**
 * Phase 1 exit criterion, as an executable check.
 *
 * N headless mpv instances, each driven by a real RoomClient against a real
 * signalling server, watching the same film while the room is pushed around
 * with random seeks and pauses. Measures the spread between what every client
 * is actually showing at one instant.
 *
 * Two numbers matter and they are different questions:
 *   steady-state drift  -- how tightly the room holds while nothing is happening
 *   recovery time       -- how long it takes to re-converge after an event
 *
 * Run:  npm run phase1
 *       npm run phase1 -- --peers=5 --film=7200 --duration=7200 --events=20
 */
import { SignallingServer } from '../src/server.js'
import { RoomClient } from '@cocine/client'
import { ExternalMpv, ensureTestVideo } from '@cocine/player'
import { join } from 'node:path'

const arg = (k: string, d: number): number => {
  const m = process.argv.find(a => a.startsWith(`--${k}=`))
  return m ? Number(m.split('=')[1]) : d
}

const PEERS = arg('peers', 5)
const FILM_SEC = arg('film', 300)
const RUN_SEC = arg('duration', 180)
const EVENTS = arg('events', 20)
const BUDGET_MS = arg('budget', 100)
const DELAY_MS = arg('latency', 0)
const JITTER_MS = arg('jitter', 0)
const SKEW_MS = arg('skew', 0)
const SETTLE_MS = arg('settle', 2000)
const SAMPLE_MS = 100
// --headless=0 gives every client a real video output instead of --vo=null.
// Worth running before trusting the headless numbers: a real vo paces off the
// display's refresh and presents actual frames, which is different timing from
// the null output the fast tests use.
const HEADLESS = arg('headless', 1) !== 0
// --res=1080 gives every client a real 1080p stream to decode. --vo=null still
// decodes and discards, so this exercises decode load without any display.
const RES = arg('res', 240)

const pct = (xs: number[], p: number): number =>
  xs.length === 0 ? NaN : [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))]!

interface Sample { t: number; spreadMs: number; settling: boolean; positions: number[] }

const main = async (): Promise<void> => {
  console.log(`\n  Phase 1 — synchronised playback across ${PEERS} clients`)
  console.log(`  ${'─'.repeat(66)}`)
  console.log(`  film ${FILM_SEC}s · run ${RUN_SEC}s · ${EVENTS} random events · budget ${BUDGET_MS} ms`)
  console.log(`  simulated network: ${DELAY_MS} ms one-way ± ${JITTER_MS} ms jitter · server clock skewed ${SKEW_MS} ms`)
  console.log(`  video output: ${HEADLESS ? 'null (headless)' : 'REAL WINDOWS'} · source ${RES}p\n`)
  if (!HEADLESS) {
    console.log(`  ⚠  --headless=0 opens ${PEERS} mpv windows on your desktop for ${RUN_SEC}s.`)
    console.log(`     Run it under a virtual display to keep them off screen:`)
    console.log(`       Xvfb :99 & DISPLAY=:99 npm run phase1 -- --headless=0\n`)
    await new Promise(r => setTimeout(r, 3000))
  }

  const film = ensureTestVideo(FILM_SEC, join(process.cwd(), '.fixtures'), { height: RES })
  const server = new SignallingServer({
    startLeadMs: 400,
    simulatedDelayMs: DELAY_MS,
    simulatedJitterMs: JITTER_MS,
    simulatedSkewMs: SKEW_MS
  })
  const port = await server.listen()

  const names = ['anjali', 'dev', 'priya', 'sam', 'rohan', 'kiran', 'meera', 'arjun']
  const players: ExternalMpv[] = []
  const clients: RoomClient[] = []

  for (let i = 0; i < PEERS; i++) {
    const player = new ExternalMpv({ headless: HEADLESS })
    await player.start()
    await player.load(film)
    players.push(player)
    // The first client creates the room; everyone else joins it by code.
    const client = new RoomClient({
      url: `ws://127.0.0.1:${port}`,
      code: clients[0]?.code ?? null,
      name: names[i % names.length]!,
      player
    })
    await client.connect()
    clients.push(client)
  }
  console.log(`  ${PEERS} clients connected · clock offsets ${clients.map(c => c.clock.offsetMs().toFixed(0)).join('/')} ms · rtt ${clients.map(c => c.clock.rttMs().toFixed(1)).join('/')} ms\n`)

  const host = clients[0]!
  host.announceMedia('film', FILM_SEC)
  await new Promise(r => setTimeout(r, 300))
  host.requestPlay(0)

  const samples: Sample[] = []
  let lastEventAt = Date.now()
  let inBudgetRun = 0
  const events: Array<{ at: number; kind: string; recoveredMs: number | null }> = []

  const eventEvery = (RUN_SEC * 1000) / (EVENTS + 1)
  let nextEventAt = Date.now() + eventEvery
  const t0 = Date.now()

  await new Promise<void>(done => {
    const iv = setInterval(() => {
      const now = Date.now()
      const positions = clients.map(c => c.actualPosition(now))
      const spreadMs = (Math.max(...positions) - Math.min(...positions)) * 1000
      const settling = now - lastEventAt < SETTLE_MS
      samples.push({ t: (now - t0) / 1000, spreadMs, settling, positions })

      // Recovery is the first moment the room is back inside budget and stays
      // there. Deliberately not gated on the settle flag: gating on it would
      // make every event appear to take exactly one settle window to recover.
      const open = events.at(-1)
      if (open && open.recoveredMs === null && now - open.at > 200) {
        if (spreadMs <= BUDGET_MS) {
          inBudgetRun++
          if (inBudgetRun >= 3) open.recoveredMs = now - open.at - 2 * SAMPLE_MS
        } else inBudgetRun = 0
      }

      if (now >= nextEventAt && events.length < EVENTS) {
        const roll = Math.random()
        const at = host.expectedPosition(now) ?? 0
        if (roll < 0.6) {
          const to = Math.max(1, Math.min(FILM_SEC - 20, Math.random() * (FILM_SEC - 30)))
          host.requestSeek(to)
          events.push({ at: now, kind: `seek→${to.toFixed(0)}s`, recoveredMs: null })
        } else if (roll < 0.85) {
          host.requestPause(at)
          events.push({ at: now, kind: 'pause', recoveredMs: null })
          setTimeout(() => host.requestPlay(), 1200)
        } else {
          host.requestPlay()
          events.push({ at: now, kind: 'play', recoveredMs: null })
        }
        lastEventAt = now
        inBudgetRun = 0
        nextEventAt = now + eventEvery
      }

      if (now - t0 > RUN_SEC * 1000) { clearInterval(iv); done() }
    }, SAMPLE_MS)
  })

  const steady = samples.filter(s => !s.settling).map(s => s.spreadMs)
  const worst = Math.max(...steady)
  const p99 = pct(steady, 0.99)
  const p50 = pct(steady, 0.5)
  const recovered = events.map(e => e.recoveredMs).filter((x): x is number => x !== null)
  const overBudget = steady.filter(s => s > BUDGET_MS).length

  // Which client is consistently the odd one out, if any.
  const perClient = clients.map((_, i) => {
    const errs = samples.filter(s => !s.settling).map(s => {
      const mean = s.positions.reduce((a, b) => a + b, 0) / s.positions.length
      return Math.abs(s.positions[i]! - mean) * 1000
    })
    return { name: names[i % names.length]!, p99: pct(errs, 0.99) }
  })

  console.log(`  ${'─'.repeat(66)}`)
  console.log(`  steady-state spread   p50 ${p50.toFixed(1)} ms · p99 ${p99.toFixed(1)} ms · worst ${worst.toFixed(1)} ms`)
  console.log(`  samples over budget   ${overBudget} of ${steady.length}  (${(100 * overBudget / steady.length).toFixed(2)} %)`)
  console.log(`  events                ${events.length} issued · ${recovered.length} re-converged`)
  if (recovered.length) {
    console.log(`  recovery after event  p50 ${(pct(recovered, 0.5) / 1000).toFixed(2)}s · worst ${(Math.max(...recovered) / 1000).toFixed(2)}s`)
  }
  console.log(`  per-client deviation  ${perClient.map(c => `${c.name} ${c.p99.toFixed(0)}ms`).join(' · ')}`)

  for (const c of clients) await c.close()
  for (const p of players) await p.close()
  await server.close()

  const pass = p99 <= BUDGET_MS && recovered.length === events.length
  console.log(`  ${'─'.repeat(66)}`)
  console.log(`  ${pass ? 'PASS' : 'FAIL'} — p99 steady-state drift ${p99.toFixed(1)} ms against a ${BUDGET_MS} ms budget\n`)
  process.exit(pass ? 0 : 1)
}

main().catch(e => { console.error(e); process.exit(1) })
