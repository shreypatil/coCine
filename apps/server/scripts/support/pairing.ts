/**
 * Two machines, one simulated network, and the question of whether they meet.
 *
 * Shared by the phase B4.2 gate and by the test that guards it, so that the
 * measurement and the assertion cannot drift apart -- if these were written
 * twice, the gate could pass against a harness the test no longer describes.
 */
import { AGENTS, INTERNET_GATEWAY, runScenario } from '@cocine/netsim'
import type { ScenarioSpec, SiteSpec } from '@cocine/netsim'
import { iceServersFor } from '../../src/turn.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PEER = fileURLToPath(new URL('./ice-peer.mjs', import.meta.url))
export const STUN_PORT = 3478

export interface PairingOutcome {
  connected: boolean
  /** ICE exhausted its checks, rather than the harness running out of patience. */
  gaveUp?: boolean
  /** Milliseconds from both descriptions being in hand to the connection opening. */
  ms: number | null
  /** Candidate kinds this end offered, e.g. `host,srflx`. */
  local: string
  /** Candidate kinds it was given. */
  remote: string
  /** Why it could not be measured, as opposed to failing to connect. */
  note?: string
}

/**
 * coCine's own ICE policy, pointed at the simulated internet.
 *
 * `iceServersFor` is imported rather than restated, so what is under test is the
 * shipping decision -- voice may relay, bulk transfer never may -- and not a
 * copy of it that could quietly disagree. Only the STUN address is substituted,
 * because the public servers coCine ships with are unreachable from a namespace
 * with no route off this machine.
 */
export function iceFor (plane: 'voice' | 'bulk', stunHost = INTERNET_GATEWAY): unknown[] {
  return iceServersFor(plane, 'matrix-probe').map(s => {
    const urls = Array.isArray(s.urls) ? s.urls : [s.urls]
    const isStun = urls.every(u => u.startsWith('stun:'))
    return isStun ? { urls: `stun:${stunHost}:${STUN_PORT}` } : s
  })
}

export interface PairingOptions {
  /** How long each end may spend gathering, exchanging and checking. */
  budgetMs?: number
}

/** Build the two sites, run a peer at each end, and report what happened. */
export async function attemptPairing (
  a: SiteSpec, b: SiteSpec, plane: 'voice' | 'bulk', opts: PairingOptions = {}
): Promise<PairingOutcome> {
  const budgetMs = opts.budgetMs ?? 12_000
  const sig = mkdtempSync(join(tmpdir(), 'pairing-'))
  const ice = JSON.stringify(iceFor(plane))
  const spec: ScenarioSpec = { sites: [{ ...a, name: 'alpha' }, { ...b, name: 'beta' }] }
  try {
    const result = await runScenario(spec, [
      // Started first and outliving the peers: a STUN server that is not yet
      // answering when the first binding request goes out costs a peer its
      // reflexive candidate, and the pairing then fails for a reason that has
      // nothing to do with the NAT under test.
      { name: 'stun', ns: 'net', argv: [process.execPath, AGENTS.stun, String(STUN_PORT), String(budgetMs + 6000)] },
      { name: 'offer', ns: 'alpha', delayMs: 250, argv: [process.execPath, PEER, 'offer', sig, ice, String(budgetMs)] },
      { name: 'answer', ns: 'beta', delayMs: 250, argv: [process.execPath, PEER, 'answer', sig, ice, String(budgetMs)] }
    ], { workloadTimeoutMs: budgetMs + 8000 })

    if (result.setupError) return { connected: false, ms: null, local: '', remote: '', note: result.setupError }

    const read = (name: string): (PairingOutcome & { error?: string }) | string => {
      const w = result.workloads.find(x => x.name === name)
      const line = w?.stdout.trim().split('\n').filter(Boolean).pop()
      if (!line) return (w?.stderr ?? `${name} produced no output`).trim().slice(0, 160)
      try { return JSON.parse(line) as PairingOutcome & { error?: string } } catch { return `${name} output was not JSON` }
    }

    const offer = read('offer')
    const answer = read('answer')
    if (typeof offer === 'string') return { connected: false, ms: null, local: '', remote: '', note: offer }

    // Both ends are read, not just one. ICE is symmetric and the two should
    // always agree, so a disagreement is either a bug in this harness or a real
    // and surprising property of the path -- and either way it must not be
    // averaged away by reporting whichever end was asked.
    const note = typeof answer === 'string'
      ? answer
      : answer.connected !== offer.connected
        ? `the two ends disagreed: offer ${offer.connected ? 'connected' : 'did not'}, answer ${answer.connected ? 'connected' : 'did not'}`
        : offer.error

    return {
      connected: offer.connected, ms: offer.ms, local: offer.local, remote: offer.remote,
      ...(offer.gaveUp ? { gaveUp: true } : {}),
      ...(note ? { note } : {})
    }
  } finally {
    rmSync(sig, { recursive: true, force: true })
  }
}
