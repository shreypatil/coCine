// Recomputes margin statistics from saved sample series, restricted to the
// window where playback was actually running. Lets you re-read old results
// without re-running the suite.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderComparison } from './report.js'

const dir = 'results'
const files = readdirSync(dir).filter(f => f.endsWith('.json'))
const byScenario = new Map()

for (const f of files) {
  const r = JSON.parse(readFileSync(join(dir, f), 'utf8'))
  const v = r.ttffSec == null ? [] :
    r.samples.filter(s => s.t >= r.ttffSec && s.minMargin != null && isFinite(s.minMargin)).map(s => s.minMargin).sort((a, b) => a - b)
  const q = fr => v.length ? +v[Math.min(v.length - 1, Math.floor(v.length * fr))].toFixed(2) : null
  r.marginStats = { min: v.length ? +v[0].toFixed(2) : null, p05: q(0.05), median: q(0.5) }
  writeFileSync(join(dir, f), JSON.stringify(r, null, 2))
  if (!byScenario.has(r.scenario)) byScenario.set(r.scenario, [])
  byScenario.get(r.scenario).push(r)
}

const order = { stock: 0, sequential: 1, planned: 2 }
for (const [name, rows] of byScenario) {
  if (name === 'smoke') continue
  console.log(`\n${'═'.repeat(70)}\n  ${name}   (T_min ${rows[0].theory.tMin.toFixed(1)}s, r ${(rows[0].theory.bitrate / 1e6).toFixed(1)} Mbps, ${rows[0].theory.N} peers)\n${'═'.repeat(70)}`)
  renderComparison(rows.sort((a, b) => order[a.policy] - order[b.policy]))
}
