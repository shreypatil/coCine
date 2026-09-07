// Runs every policy against one or more scenarios in fresh processes,
// then prints the two deltas the decision turns on.
import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve, basename } from 'node:path'
import { renderComparison } from './report.js'

const args = process.argv.slice(2)
const only = args.filter(a => !a.startsWith('-'))
const arms = (args.find(a => a.startsWith('--policies=')) || '--policies=stock,sequential,planned').split('=')[1].split(',')

const dir = resolve('scenarios')
const files = (only.length ? only : readdirSync(dir).filter(f => f.endsWith('.json')).map(f => join(dir, f))).sort()

for (const f of files) {
  const name = basename(f, '.json')
  console.log(`\n${'═'.repeat(70)}\n  SCENARIO: ${name}\n${'═'.repeat(70)}`)
  const rows = []
  for (const p of arms) {
    process.stdout.write(`  running ${p} … `)
    const t = Date.now()
    const r = spawnSync('node', ['src/run.js', f, `--policy=${p}`, '--quiet'], { stdio: ['ignore', 'inherit', 'inherit'] })
    if (r.status !== 0) { console.log('FAILED'); continue }
    console.log(`${((Date.now() - t) / 1000).toFixed(0)}s`)
    rows.push(JSON.parse(readFileSync(join('results', `${name}.${p}.json`), 'utf8')))
  }
  if (rows.length) renderComparison(rows)
}
