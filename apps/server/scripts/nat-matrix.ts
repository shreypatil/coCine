/**
 * Phase B4.2 — who can actually reach whom.
 *
 * The number this exists to replace is the one in `docs/multi-machine-testing.md`:
 *
 *   > Ten to twenty-five per cent of peer pairs cannot reach each other directly.
 *
 * That is quoted from the literature, and it decides whether coCine works --
 * because the TURN relay carries voice and deliberately never carries film, a
 * pair with no direct path is a pair where one person hears everybody and never
 * receives the movie. This runs coCine's own ICE configuration, over the real
 * WebRTC stack, against real kernel NATs, and says for each kind of pairing
 * whether the film would arrive.
 *
 * **It cannot say how common each kind of pairing is.** That is a property of
 * people's ISPs, not of this machine, and it still needs real hardware on real
 * networks. What this replaces is the other half of the question: given a
 * pairing, what happens.
 *
 * Run:  npm run b4-matrix
 *       npm run b4-matrix -- --quick           just the decisive pairings
 *       npm run b4-matrix -- --repeat=5        each cell five times, for flakiness
 *       npm run b4-matrix -- --only=open,cone  one pairing, reported in full
 *       npm run b4-matrix -- --verbose         the candidate kinds behind each cell
 *       npm run b4-matrix -- --budget=35000    long enough for ICE to give up by itself
 */
import { execFileSync } from 'node:child_process'
import { NetsimUnavailable } from '@cocine/netsim'
import type { SiteSpec } from '@cocine/netsim'
import { iceServersFor } from '../src/turn.js'
import { attemptPairing, type PairingOutcome } from './support/pairing.js'

const arg = (k: string): string | null => {
  const m = process.argv.find(a => a.startsWith(`--${k}=`))
  return m ? m.slice(k.length + 3) : null
}
const QUICK = process.argv.includes('--quick')

/**
 * Whether a TURN server could be run inside the simulation.
 *
 * It matters to how the table should be read. Without one, voice is offered
 * exactly the ICE that the film is, so the two columns agree by construction
 * and the voice column says nothing about relaying -- which is the opposite of
 * what a reader would assume from a column headed "voice". Better to detect it
 * and say so than to print a number that quietly means something else.
 *
 * coturn cannot be borrowed from Docker for this: a container lives in a
 * network namespace the daemon owns, and there is no way to attach it to one
 * this process made without privileges.
 */
function turnAvailable (): boolean {
  try {
    execFileSync('sh', ['-c', 'command -v turnserver'], { stdio: 'ignore' })
    return true
  } catch { return false }
}
const TURN = turnAvailable()
const VERBOSE = process.argv.includes('--verbose')
/**
 * How many times to run each cell.
 *
 * A cell that connects four times in five is not the same finding as one that
 * connects every time, and reporting either as a bare yes would hide it. ICE is
 * a race by construction, and a single failure under load during development
 * turned out to be exactly that rather than a property of the NAT -- which is
 * only knowable by running it again.
 */
const REPEAT = Math.max(1, Number(arg('repeat') ?? 1))
/**
 * How long each end may spend before the harness stops waiting.
 *
 * Twelve seconds is not where ICE gives up -- libdatachannel keeps retrying
 * well past it -- so a failure here means "no connection within the budget"
 * rather than "ICE exhausted its checks", and the report says which. The
 * budget is defensible rather than arbitrary: on this simulated network a
 * connection that forms at all forms in under 0.2 s, so twelve seconds is a
 * sixty-fold margin. `--budget=35000` is long enough for ICE to reach `failed`
 * on its own, at the cost of a much slower run.
 */
const BUDGET_MS = Math.max(2000, Number(arg('budget') ?? 12_000))
const ONLY = arg('only')?.split(',').map(s => s.trim()) ?? null

/** The network positions worth telling apart, and what each stands for. */
const PROFILES = {
  open: { label: 'open', site: {} },
  cone: { label: 'cone', site: { nat: ['cone'] } },
  symmetric: { label: 'symmetric', site: { nat: ['symmetric'] } },
  cgnat: { label: 'cgnat', site: { nat: ['cone', 'symmetric'] } },
  blocked: { label: 'udp-blocked', site: { nat: ['cone'], udpBlocked: true } }
} as const satisfies Record<string, { label: string; site: Omit<SiteSpec, 'name'> }>

type ProfileName = keyof typeof PROFILES
const ALL: ProfileName[] = ['open', 'cone', 'symmetric', 'cgnat', 'blocked']
const siteFor = (p: ProfileName): SiteSpec => ({ name: 'x', ...PROFILES[p].site }) as SiteSpec

/**
 * What each pairing should do, from first principles rather than from what it
 * did last time -- otherwise a regression would simply become the new baseline.
 *
 * A machine on the internet has a host candidate anyone can reach, so it pairs
 * with anything that is allowed to send UDP at all. Two endpoint-independent
 * NATs both present the port STUN reported, so a punch lands. A symmetric NAT
 * presents a different port to the peer than it did to STUN, and the
 * port-restricted filtering on the other side drops what arrives from an
 * unexpected source -- so it fails, and so does carrier-grade NAT, whose outer
 * layer is symmetric. A site with UDP blocked reaches nothing.
 */
const EXPECTED: Record<string, boolean> = {
  'open↔open': true, 'open↔cone': true, 'open↔symmetric': true, 'open↔cgnat': true, 'open↔blocked': false,
  'cone↔cone': true, 'cone↔symmetric': false, 'cone↔cgnat': false, 'cone↔blocked': false,
  'symmetric↔symmetric': false, 'symmetric↔cgnat': false, 'symmetric↔blocked': false,
  'cgnat↔cgnat': false, 'cgnat↔blocked': false, 'blocked↔blocked': false
}

const QUICK_PAIRS: Array<[ProfileName, ProfileName]> = [
  ['open', 'cone'], ['cone', 'cone'], ['cone', 'symmetric'], ['symmetric', 'symmetric'], ['blocked', 'cone']
]

function pairings (): Array<[ProfileName, ProfileName]> {
  if (ONLY) {
    const [a, b] = ONLY as ProfileName[]
    if (!a || !b || !(a in PROFILES) || !(b in PROFILES)) {
      throw new Error(`--only takes two of: ${ALL.join(', ')}`)
    }
    return [[a, b]]
  }
  if (QUICK) return QUICK_PAIRS
  const out: Array<[ProfileName, ProfileName]> = []
  for (let i = 0; i < ALL.length; i++) for (let j = i; j < ALL.length; j++) out.push([ALL[i]!, ALL[j]!])
  return out
}

interface Cell {
  ok: number
  of: number
  ms: number[]
  /** Failures where ICE exhausted its checks rather than the harness giving up. */
  gaveUp: number
  notes: string[]
  local: string
  remote: string
}

async function cellFor (a: ProfileName, b: ProfileName, plane: 'voice' | 'bulk'): Promise<Cell> {
  const cell: Cell = { ok: 0, of: REPEAT, ms: [], gaveUp: 0, notes: [], local: '', remote: '' }
  for (let i = 0; i < REPEAT; i++) {
    const o: PairingOutcome = await attemptPairing(siteFor(a), siteFor(b), plane, { budgetMs: BUDGET_MS })
    if (o.connected) { cell.ok++; if (o.ms !== null) cell.ms.push(o.ms) }
    else if (o.gaveUp) cell.gaveUp++
    if (o.note) cell.notes.push(o.note)
    cell.local = o.local
    cell.remote = o.remote
  }
  return cell
}

const describeCell = (c: Cell): string => {
  const rate = c.of === 1 ? (c.ok === 1 ? 'yes' : 'no') : `${c.ok}/${c.of}`
  if (c.ok === 0) return rate
  const median = [...c.ms].sort((x, y) => x - y)[Math.floor(c.ms.length / 2)] ?? 0
  return `${rate} ${(median / 1000).toFixed(1)}s`
}

const pad = (s: string, n: number): string => s.length >= n ? s : s + ' '.repeat(n - s.length)
/**
 * Order-independent, because a pairing is not directed and `--quick` lists some
 * of them the other way round. Keyed on the wrong order, a cell silently has no
 * expectation and the gate passes it whatever it does.
 */
const key = (a: ProfileName, b: ProfileName): string =>
  ALL.indexOf(a) <= ALL.indexOf(b) ? `${a}↔${b}` : `${b}↔${a}`

async function main (): Promise<void> {
  console.log('\n  Phase B4.2 — who can reach whom, and would the film arrive')
  console.log(`  ${'─'.repeat(70)}`)
  console.log('  The film plane is given STUN and never a relay, by design; voice may relay.')
  if (!TURN) {
    console.log('  No TURN server is installed, so the voice column is voice *without* a relay')
    console.log('  and matches the film column by construction. Install coturn to measure it.')
  }
  console.log(`  ${pad('pairing', 30)}${pad('film', 14)}voice`)

  const rows: Array<{ a: ProfileName; b: ProfileName; film: Cell; voice: Cell }> = []
  for (const [a, b] of pairings()) {
    const film = await cellFor(a, b, 'bulk')
    const voice = await cellFor(a, b, 'voice')
    rows.push({ a, b, film, voice })
    const name = `${pad(PROFILES[a].label, 12)} ↔ ${PROFILES[b].label}`
    const note = film.notes[0] ?? voice.notes[0]
    console.log(`  ${pad(name, 30)}${pad(describeCell(film), 14)}${describeCell(voice)}${note ? `   (${note})` : ''}`)
    if (VERBOSE) console.log(`  ${' '.repeat(30)}offered ${film.local || 'none'} · seen ${film.remote || 'none'}`)
  }

  const solid = rows.filter(r => r.film.ok === r.film.of)
  console.log(`  ${'─'.repeat(70)}`)
  console.log(`  ${solid.length} of ${rows.length} pairings carry a film${REPEAT > 1 ? ` on all ${REPEAT} attempts` : ''}.`)

  const flaky = rows.filter(r => r.film.ok > 0 && r.film.ok < r.film.of)
  if (flaky.length > 0) {
    console.log('\n  Connected only sometimes — distrust these until they are understood:')
    for (const r of flaky) console.log(`    ${PROFILES[r.a].label} ↔ ${PROFILES[r.b].label}: ${r.film.ok} of ${r.film.of}`)
  }

  const stranded = rows.filter(r => r.film.ok === 0)
  if (stranded.length > 0) {
    console.log('\n  Cannot receive a film peer to peer; relay mode is the only way to watch:')
    for (const r of stranded) {
      // A cell where ICE exhausted its checks is a confident no. One that only
      // ran out of budget might have connected given longer, and saying "no"
      // about it would be overclaiming.
      const sure = r.film.gaveUp === r.film.of ? '' : '  (budget expired rather than ICE giving up — may be understated)'
      console.log(`    ${PROFILES[r.a].label} ↔ ${PROFILES[r.b].label}${sure}`)
    }
  }

  // The gate. A cell disagreeing with first principles is either a regression
  // in coCine's ICE or a fault in the simulator, and both are worth stopping for.
  const surprises = rows
    .map(r => ({ r, want: EXPECTED[key(r.a, r.b)] }))
    .filter(({ r, want }) => want !== undefined && want !== (r.film.ok === r.film.of))
  if (surprises.length > 0) {
    console.log('\n  Not what the design predicts:')
    for (const { r, want } of surprises) {
      console.log(`    ${PROFILES[r.a].label} ↔ ${PROFILES[r.b].label}: expected ${want ? 'a connection' : 'none'}, got ${r.film.ok}/${r.film.of}`)
    }
  }

  const bulkRelayed = iceServersFor('bulk', 'matrix-probe')
    .some(s => (Array.isArray(s.urls) ? s.urls : [s.urls]).some(u => u.startsWith('turn')))
  if (bulkRelayed) console.log('\n  The film transport was offered a relay, which it must never be.')

  const pass = surprises.length === 0 && flaky.length === 0 && !bulkRelayed
  const why = [
    surprises.length > 0 ? `${surprises.length} cell${surprises.length > 1 ? 's' : ''} disagreed with the design` : null,
    flaky.length > 0 ? `${flaky.length} connected only sometimes` : null,
    bulkRelayed ? 'the film transport was offered a relay' : null
  ].filter(Boolean).join('; ')
  console.log(`\n  ${pass ? 'PASS' : 'FAIL'} — ${solid.length}/${rows.length} pairings carry a film` +
    `${pass ? ', and every cell matched the design' : `: ${why}`}\n`)
  process.exit(pass ? 0 : 1)
}

main().catch(e => {
  if (e instanceof NetsimUnavailable) {
    console.error(`\n  Cannot simulate a network here: ${e.message}\n`)
    process.exit(2)
  }
  console.error(e)
  process.exit(1)
})
