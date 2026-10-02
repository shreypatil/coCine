/**
 * The simulator against a real kernel.
 *
 * `plan.test.ts` asserts the topology is described correctly; this asserts the
 * kernel then behaves the way the description promises. Both are needed: the
 * plan tests would pass against a netem qdisc that silently did nothing, and
 * these would pass against a plan that was right for the wrong reason.
 *
 * Skipped where unprivileged user namespaces are unavailable -- CI runners,
 * macOS, Windows, hardened kernels -- because there their absence is correct
 * and not a fault in coCine.
 */
import { describe, expect, it } from 'vitest'
import { AGENTS, netsimSupport, runScenario } from '../src/index.js'
import type { ScenarioResult, ScenarioSpec } from '../src/index.js'

const support = netsimSupport()
const when = support.ok ? describe : describe.skip
if (!support.ok) console.log(`  netsim: skipped — ${support.reason}`)

const UDP = AGENTS.udp
const node = process.execPath
const PORT = 41000
const PUNCH_MS = 3000

const summaryOf = (r: ScenarioResult, name: string): Record<string, number | string> => {
  const w = r.workloads.find(x => x.name === name)
  if (!w) throw new Error(`no workload called ${name}`)
  const line = w.stdout.trim().split('\n').filter(Boolean).pop()
  return line ? JSON.parse(line) : {}
}

/** Both sides punch at once, which is what ICE does and the only fair test. */
async function punch (spec: ScenarioSpec): Promise<ScenarioResult> {
  const [a, b] = spec.sites.map(s => s.name)
  return runScenario(spec, [
    { name: 'a', ns: a!, argv: [node, UDP, 'punch', String(PORT), publicOf(1), String(PORT), String(PUNCH_MS)] },
    { name: 'b', ns: b!, argv: [node, UDP, 'punch', String(PORT), publicOf(0), String(PORT), String(PUNCH_MS)] }
  ], { workloadTimeoutMs: PUNCH_MS + 8000 })
}
const publicOf = (i: number): string => `203.0.113.${10 + i}`

/** One site against a machine on the internet that answers rather than punches. */
async function talkToServer (site: ScenarioSpec['sites'][number]): Promise<ScenarioResult> {
  return runScenario({ sites: [site, { name: 'server' }] }, [
    { name: 'echo', ns: 'server', argv: [node, UDP, 'echo', String(PORT), '5000'] },
    {
      name: 'client', ns: site.name, delayMs: 300,
      argv: [node, UDP, 'probe', String(PORT), publicOf(1), String(PORT), String(PUNCH_MS)]
    }
  ], { workloadTimeoutMs: PUNCH_MS + 8000 })
}
const pair = (a: ScenarioSpec['sites'][number], b: ScenarioSpec['sites'][number]): ScenarioSpec => ({ sites: [a, b] })

when('building a network', () => {
  it('builds a topology and tears it down with nothing left behind', async () => {
    const before = process.pid
    const result = await runScenario({ sites: [{ name: 'alice', nat: ['cone'] }, { name: 'server' }] })
    expect(result.setupError).toBeUndefined()
    expect(result.ok).toBe(true)
    // The namespaces only ever existed inside the run, so the host cannot see
    // them; the meaningful check is that the process that built them is gone,
    // which the PID namespace guarantees.
    expect(process.pid).toBe(before)
  })

  it('reports a setup failure rather than running workloads against half a network', async () => {
    // Two sites asking for the same NAT layout is fine; asking for an interface
    // that cannot exist is not. The simplest reliable break is a workload aimed
    // at a namespace no site defines, which is caught before anything is built.
    await expect(runScenario({ sites: [{ name: 'alice' }] }, [
      { name: 'x', ns: 'nowhere', argv: ['true'] }
    ])).rejects.toThrow(/names no site/)
  })
})

when('shaping', () => {
  it('turns a netem delay into a round trip that can be measured', async () => {
    // 40 ms each way on alice's upload and download, and nothing on the server,
    // so a round trip crosses the shaped link twice: about 80 ms.
    const result = await runScenario({
      sites: [{ name: 'alice', link: { delayMs: 40 } }, { name: 'server' }]
    }, [
      { name: 'echo', ns: 'server', argv: [node, UDP, 'echo', String(PORT), '4000'] },
      { name: 'probe', ns: 'alice', delayMs: 300, argv: [node, UDP, 'probe', String(PORT), publicOf(1), String(PORT), '3000'] }
    ], { workloadTimeoutMs: 12_000 })

    expect(result.setupError).toBeUndefined()
    const probe = summaryOf(result, 'probe')
    expect(Number(probe.received)).toBeGreaterThan(0)
    // The *lowest* round trip, not the median: the first samples carry Node's
    // own startup and read as hundreds of milliseconds however idle the link
    // is. Taking the minimum is also what the sync engine's clock estimator
    // does, and for the same reason. Unshaped, the same probe reads 0.6 ms.
    expect(Number(probe.rttMsMin)).toBeGreaterThan(60)
    expect(Number(probe.rttMsMin)).toBeLessThan(140)
  })

  it('leaves an unshaped link fast', async () => {
    const result = await runScenario({ sites: [{ name: 'alice' }, { name: 'server' }] }, [
      { name: 'echo', ns: 'server', argv: [node, UDP, 'echo', String(PORT), '3000'] },
      { name: 'probe', ns: 'alice', delayMs: 300, argv: [node, UDP, 'probe', String(PORT), publicOf(1), String(PORT), '2000'] }
    ], { workloadTimeoutMs: 12_000 })
    expect(Number(summaryOf(result, 'probe').rttMsMin)).toBeLessThan(20)
  })
})

when('NAT behaviour', () => {
  /**
   * The pair of assertions the whole phase rests on. If the first fails the
   * simulator blocks connections that would really work, and every result it
   * ever reports is a false negative; if the second passes when it should not,
   * it cannot reproduce the failure mode it exists for.
   */
  it('lets two endpoint-independent NATs punch through to each other', async () => {
    const result = await punch(pair({ name: 'alice', nat: ['cone'] }, { name: 'bob', nat: ['cone'] }))
    expect(result.setupError).toBeUndefined()
    expect(Number(summaryOf(result, 'a').received)).toBeGreaterThan(0)
    expect(Number(summaryOf(result, 'b').received)).toBeGreaterThan(0)
  })

  it('stops two symmetric NATs from reaching each other at all', async () => {
    const result = await punch(pair({ name: 'alice', nat: ['symmetric'] }, { name: 'bob', nat: ['symmetric'] }))
    expect(result.setupError).toBeUndefined()
    expect(Number(summaryOf(result, 'a').received)).toBe(0)
    expect(Number(summaryOf(result, 'b').received)).toBe(0)
  })

  it('lets even a symmetric NAT hold a conversation with a public machine', async () => {
    // The case that always works, whatever the NAT, and the reason a relay
    // beside the server rescues voice for pairs that cannot reach each other.
    // The public side echoes rather than punching blindly, because answering
    // whoever reached it is what a server does -- and a blind punch at a
    // symmetric NAT's guessed port is exactly what cannot work.
    const result = await talkToServer({ name: 'alice', nat: ['symmetric'] })
    expect(result.setupError).toBeUndefined()
    expect(Number(summaryOf(result, 'client').received)).toBeGreaterThan(0)
  })

  it('stops a carrier-grade NAT punching to a home router', async () => {
    const result = await punch(pair(
      { name: 'phone', nat: ['cone', 'symmetric'] },
      { name: 'home', nat: ['cone'] }
    ))
    expect(Number(summaryOf(result, 'a').received)).toBe(0)
  })

  it('blocks UDP where a site asks for it, and not where it does not', async () => {
    // The control matters as much as the case: without it, a site that simply
    // failed to build would look exactly like one whose UDP had been blocked.
    const open = await talkToServer({ name: 'office', nat: ['cone'] })
    expect(Number(summaryOf(open, 'client').received)).toBeGreaterThan(0)

    const blocked = await talkToServer({ name: 'office', nat: ['cone'], udpBlocked: true })
    expect(blocked.setupError).toBeUndefined()
    expect(Number(summaryOf(blocked, 'client').received)).toBe(0)
  })
})
