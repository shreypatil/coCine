/**
 * Phase 0 exit criteria, as an executable check.
 *
 *   - position events arrive at 10 Hz or better
 *   - commands round-trip in under 20 ms
 *   - absolute seeks land where they were asked to
 *   - rate changes take effect
 *
 * Run: npm run phase0            (mpv, the shipped player)
 *      npm run phase0:html       (a <video> element -- the B1.0 gate)
 *
 * The engine is selectable because that is the point of the B1.0 gate: a new
 * player has to clear the same bar the current one clears, measured by the same
 * code. A gate with its own measurements would be marking its own homework.
 */
import { ExternalMpv, HtmlVideoPlayer, shutdownVideoHost, ensureTestVideo } from '../src/index.js'
import type { PlayerController } from '../src/index.js'
import { join } from 'node:path'

/** Both engines expose this beyond PlayerController; the harness needs it to
 *  measure command latency and to check a seek landed. */
interface Measurable extends PlayerController {
  start: () => Promise<void>
  positionExact: () => Promise<number>
}

const ENGINE = process.argv.includes('--player=html') ? 'html' : 'mpv'

const TARGET_HZ = 10
const TARGET_RTT_MS = 20
const SEEK_TOLERANCE_S = 0.15

const pct = (xs: number[], p: number): number =>
  xs.length === 0 ? NaN : [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))]!

function report (name: string, ok: boolean, detail: string): boolean {
  console.log(`  ${ok ? '✓' : '✗'} ${name.padEnd(34)} ${detail}`)
  return ok
}

const main = async (): Promise<void> => {
  const title = ENGINE === 'html'
    ? 'Phase 0 — a <video> element, over a socket'
    : 'Phase 0 — mpv control over JSON IPC'
  console.log(`\n  ${title}\n  ${'─'.repeat(62)}`)
  const film = ensureTestVideo(60, join(process.cwd(), '.fixtures'))

  let mpv: Measurable
  if (ENGINE === 'html') {
    const p = new HtmlVideoPlayer()
    p.on('warning', (m: string) => console.error(`  media error: ${m}`))
    mpv = p
  } else {
    const p = new ExternalMpv({ headless: true })
    p.on('exit', (code, stderr) => { if (code) console.error(`  mpv exited ${code}: ${stderr}`) })
    mpv = p
  }

  const t0 = Date.now()
  await mpv.start()
  await mpv.load(film)
  const startup = Date.now() - t0
  const results: boolean[] = []

  results.push(report('launch + load', true, `${startup} ms, duration ${mpv.duration()?.toFixed(1)}s`))

  // --- command round trip -------------------------------------------------
  const rtts: number[] = []
  for (let i = 0; i < 200; i++) {
    const a = performance.now()
    await mpv.positionExact()
    rtts.push(performance.now() - a)
  }
  const p50 = pct(rtts, 0.5); const p99 = pct(rtts, 0.99)
  results.push(report('command round trip', p99 < TARGET_RTT_MS,
    `p50 ${p50.toFixed(2)} ms · p99 ${p99.toFixed(2)} ms · target p99 < ${TARGET_RTT_MS}`))

  // --- position event rate ------------------------------------------------
  const stamps: number[] = []
  mpv.on('position', (_s, at) => stamps.push(at))
  await mpv.seek(0)
  await mpv.play()
  await new Promise(r => setTimeout(r, 5000))
  await mpv.pause()
  const span = (stamps.at(-1)! - stamps[0]!) / 1000
  const hz = (stamps.length - 1) / span
  results.push(report('position event rate', hz >= TARGET_HZ,
    `${hz.toFixed(1)} Hz over ${span.toFixed(1)}s · target ≥ ${TARGET_HZ}`))

  // --- seek accuracy ------------------------------------------------------
  const errors: number[] = []
  for (const target of [5, 41.5, 12.25, 55, 0.5, 30]) {
    await mpv.seek(target)
    errors.push(Math.abs(await mpv.positionExact() - target))
  }
  const worst = Math.max(...errors)
  results.push(report('absolute seek accuracy', worst < SEEK_TOLERANCE_S,
    `worst ${(worst * 1000).toFixed(0)} ms across 6 seeks · target < ${SEEK_TOLERANCE_S * 1000} ms`))

  // --- rate control -------------------------------------------------------
  await mpv.seek(0)
  await mpv.setRate(2.0)
  await mpv.play()
  const rateStart = performance.now()
  await new Promise(r => setTimeout(r, 3000))
  const advanced = await mpv.positionExact()
  const wall = (performance.now() - rateStart) / 1000
  await mpv.pause()
  await mpv.setRate(1.0)
  const ratio = advanced / wall
  results.push(report('rate control at 2.0x', ratio > 1.8 && ratio < 2.2,
    `advanced ${ratio.toFixed(2)}x wall clock`))

  await mpv.close()
  if (ENGINE === 'html') await shutdownVideoHost()
  const passed = results.every(Boolean)
  console.log(`  ${'─'.repeat(62)}\n  ${passed ? 'PASS' : 'FAIL'} — phase 0 ${passed ? 'criteria met' : 'criteria NOT met'}\n`)
  process.exit(passed ? 0 : 1)
}

main().catch(async e => {
  console.error(e)
  // Never leave the host running behind a failure.
  if (ENGINE === 'html') await shutdownVideoHost().catch(() => {})
  process.exit(1)
})
