/**
 * The simulator, from inside the namespaces.
 *
 * Runs as PID 1 of a private PID namespace, which is what guarantees nothing
 * survives the run: when this exits, the kernel reaps every process started
 * here, and the namespaces, interfaces, qdiscs and rules go with them. An
 * earlier version without the PID namespace leaked a STUN server onto the
 * developer's machine twice.
 *
 * Plain JavaScript rather than TypeScript because it is spawned directly by
 * `node` and a loader would cost a second of startup on every scenario.
 */
import { spawn, spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const planPath = process.argv[2]
const plan = JSON.parse(readFileSync(planPath, 'utf8'))
const { commands, workloads, resultPath, defaultTimeoutMs } = plan

const finish = (result) => {
  writeFileSync(resultPath, JSON.stringify(result))
  process.exit(result.ok ? 0 : 1)
}

/** `ip netns exec` is how a command is aimed at one namespace. */
const argvFor = (c) => (c.ns ? ['ip', 'netns', 'exec', c.ns, ...c.argv] : c.argv)

for (const c of commands) {
  const [bin, ...args] = argvFor(c)
  const r = spawnSync(bin, args, {
    input: c.stdin ?? undefined,
    encoding: 'utf8',
    timeout: 20_000
  })
  if (r.status === 0) continue
  if (c.optional) continue
  const why = (r.stderr || r.stdout || r.error?.message || `exit ${r.status}`).trim()
  finish({ ok: false, setupError: `${c.label}: ${why}`, workloads: [] })
}

if (workloads.length === 0) finish({ ok: true, workloads: [] })

const runOne = (w) => new Promise(resolve => {
  const start = () => {
    const [bin, ...args] = ['ip', 'netns', 'exec', w.ns, ...w.argv]
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    child.stdout.on('data', d => { stdout += d })
    child.stderr.on('data', d => { stderr += d })
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, w.timeoutMs ?? defaultTimeoutMs)
    child.on('error', err => {
      clearTimeout(timer)
      resolve({ name: w.name, code: null, stdout, stderr: String(err), timedOut: false })
    })
    child.on('close', code => {
      clearTimeout(timer)
      resolve({ name: w.name, code, stdout, stderr, timedOut })
    })
  }
  if (w.delayMs) setTimeout(start, w.delayMs)
  else start()
})

const results = await Promise.all(workloads.map(runOne))
finish({ ok: results.every(r => r.code === 0), workloads: results })
