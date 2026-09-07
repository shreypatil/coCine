const pad = (s, n) => String(s).padEnd(n)
const rpad = (s, n) => String(s).padStart(n)
const fmt = v => v == null ? '—' : (isFinite(v) ? v.toFixed(1) : 'never')

export function renderRun (r) {
  const t = r.theory
  console.log(`\n  ${r.scenario}  ·  policy: ${r.policy}`)
  console.log('  ' + '─'.repeat(64))
  console.log(`  bitrate r            ${(t.bitrate / 1e6).toFixed(2)} Mbps   (${r.runtimeSec}s of film)`)
  console.log(`  T_min (Kumar–Ross)   ${t.tMin.toFixed(1)}s`)
  console.log(`    sharer upload      ${t.terms.sharerUpload.toFixed(1)}s`)
  console.log(`    slowest download   ${t.terms.slowestDownload.toFixed(1)}s`)
  console.log(`    aggregate upload   ${t.terms.aggregateUpload.toFixed(1)}s`)
  console.log(`  watchable live?      ${t.watchable.all ? 'yes' : 'NO — someone cannot keep up'}`)
  console.log('  ' + '─'.repeat(64))
  console.log(`  time to first frame  ${fmt(r.ttffSec)}s`)
  console.log(`  room stalls          ${r.stallCount}  (${r.stallSec.toFixed(1)}s total)`)
  console.log(`  min buffer margin    ${fmt(r.marginStats.min)}s   p05 ${fmt(r.marginStats.p05)}s   median ${fmt(r.marginStats.median)}s`)
  console.log(`  last peer complete   ${fmt(r.maxCompletionSec)}s   (${(r.maxCompletionSec / t.tMin).toFixed(2)}× T_min)`)
  console.log(`  film played          ${r.playedSec}/${r.runtimeSec}s`)
  if (r.stalls.length) {
    for (const s of r.stalls.slice(0, 6)) {
      console.log(`      stalled ${s.sec.toFixed(1)}s waiting on ${s.who.join(', ')}`)
    }
  }
}

export function renderComparison (rows) {
  const cols = ['policy', 'TTFF', 'stalls', 'stalled s', 'min margin', 'p05 margin', 'complete', '×T_min']
  const w = [12, 8, 8, 11, 12, 12, 10, 8]
  console.log('\n  ' + cols.map((c, i) => i === 0 ? pad(c, w[i]) : rpad(c, w[i])).join(''))
  console.log('  ' + '─'.repeat(w.reduce((a, b) => a + b, 0)))
  for (const r of rows) {
    const cells = [
      pad(r.policy, w[0]),
      rpad(fmt(r.ttffSec), w[1]),
      rpad(r.stallCount, w[2]),
      rpad(r.stallSec.toFixed(1), w[3]),
      rpad(fmt(r.marginStats.min), w[4]),
      rpad(fmt(r.marginStats.p05), w[5]),
      rpad(fmt(r.maxCompletionSec), w[6]),
      rpad(isFinite(r.maxCompletionSec) ? (r.maxCompletionSec / r.theory.tMin).toFixed(2) : '—', w[7])
    ]
    console.log('  ' + cells.join(''))
  }
  const [stock, seq, plan] = ['stock', 'sequential', 'planned'].map(n => rows.find(r => r.policy === n))
  console.log()
  if (stock && seq) {
    console.log(`  stock → sequential   what correct API usage buys:`)
    console.log(`      TTFF ${fmt(stock.ttffSec)}s → ${fmt(seq.ttffSec)}s`)
    console.log(`      stalled ${stock.stallSec.toFixed(1)}s → ${seq.stallSec.toFixed(1)}s`)
  }
  if (seq && plan) {
    console.log(`  sequential → planned  what writing your own policy buys:`)
    console.log(`      TTFF ${fmt(seq.ttffSec)}s → ${fmt(plan.ttffSec)}s`)
    console.log(`      stalled ${seq.stallSec.toFixed(1)}s → ${plan.stallSec.toFixed(1)}s`)
    console.log(`      min margin ${fmt(seq.marginStats.min)}s → ${fmt(plan.marginStats.min)}s`)
  }
}
