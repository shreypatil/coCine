/**
 * Building a scenario and running things inside it.
 *
 * Everything happens under one `unshare`, and the flags are load-bearing:
 *
 * - `--user --map-root-user` is what makes this work without `sudo`. It grants
 *   CAP_NET_ADMIN over namespaces this process owns, and nothing outside them.
 * - `--net --mount` give it a network to build and somewhere to keep
 *   `/run/netns`.
 * - `--pid --fork --mount-proc` make the inner process PID 1 of its own PID
 *   namespace, so every process it starts is reaped when it exits. Without this
 *   a workload that ignores its kill outlives the run.
 * - `--kill-child` ends the inner process if this one dies, so an interrupted
 *   test takes its simulation with it.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { netsimSupport } from './available.js'
import { planScenario } from './plan.js'
import type { ScenarioResult, ScenarioSpec, WorkloadSpec } from './types.js'

const INNER = fileURLToPath(new URL('./inner.mjs', import.meta.url))

export interface RunOptions {
  /** Default kill time for a workload that names none. */
  workloadTimeoutMs?: number
  /** Kill time for the whole run, topology included. */
  totalTimeoutMs?: number
}

export class NetsimUnavailable extends Error {}

/**
 * Build `spec`, run `workloads` in it, tear everything down.
 *
 * Throws `NetsimUnavailable` where the kernel will not allow it, so a caller
 * can skip with the reason rather than reporting a failure that is not one.
 */
export async function runScenario (
  spec: ScenarioSpec,
  workloads: WorkloadSpec[] = [],
  opts: RunOptions = {}
): Promise<ScenarioResult> {
  const support = netsimSupport()
  if (!support.ok) throw new NetsimUnavailable(support.reason ?? 'unavailable')

  const names = new Set(spec.sites.map(s => s.name).concat('net'))
  for (const w of workloads) {
    if (!names.has(w.ns)) {
      throw new Error(`workload ${JSON.stringify(w.name)} names no site: ${JSON.stringify(w.ns)}`)
    }
  }

  const commands = planScenario(spec)
  const dir = mkdtempSync(join(tmpdir(), 'netsim-'))
  const planPath = join(dir, 'plan.json')
  const resultPath = join(dir, 'result.json')
  const workloadTimeoutMs = opts.workloadTimeoutMs ?? 30_000
  // The topology itself is quick; the slack is for whatever the workloads do.
  const totalTimeoutMs = opts.totalTimeoutMs ??
    (workloads.reduce((m, w) => Math.max(m, (w.delayMs ?? 0) + (w.timeoutMs ?? workloadTimeoutMs)), 0) + 30_000)

  writeFileSync(planPath, JSON.stringify({
    commands, workloads, resultPath, defaultTimeoutMs: workloadTimeoutMs
  }))

  try {
    const stderr = await spawnInner(planPath, totalTimeoutMs)
    try {
      return JSON.parse(readFileSync(resultPath, 'utf8')) as ScenarioResult
    } catch {
      // No result file means the inner process never got far enough to write
      // one -- it was killed, or unshare itself refused. Its stderr is the only
      // thing that knows why, so it must not be swallowed.
      return { ok: false, setupError: stderr.trim() || 'the simulator exited without a result', workloads: [] }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function spawnInner (planPath: string, totalTimeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('unshare', [
      '--kill-child', '--user', '--map-root-user',
      '--net', '--mount', '--pid', '--fork', '--mount-proc',
      process.execPath, INNER, planPath
    ], { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', d => { stderr += String(d) })
    const timer = setTimeout(() => {
      stderr += `\nthe simulation was killed after ${totalTimeoutMs} ms`
      child.kill('SIGKILL')
    }, totalTimeoutMs)
    child.on('error', err => { clearTimeout(timer); reject(err) })
    child.on('close', () => { clearTimeout(timer); resolve(stderr) })
  })
}
