/**
 * coCine's own ICE, across a simulated NAT.
 *
 * `packages/netsim` proves the simulator behaves like the networks it imitates;
 * this proves the application behaves correctly inside it. The distinction
 * matters: netsim's own tests punch with a bare UDP socket, and a bare socket
 * succeeding says nothing about whether libdatachannel, configured the way the
 * signalling server configures it, finds the same path.
 *
 * Two cases only, because they are the two that decide the product. Everything
 * else is `npm run b4-matrix`, which is a measurement rather than an assertion.
 */
import { describe, expect, it } from 'vitest'
import { netsimSupport } from '@cocine/netsim'
import { attemptPairing, iceFor } from '../scripts/support/pairing.js'

const support = netsimSupport()
const when = support.ok ? describe : describe.skip
if (!support.ok) console.log(`  nat-traversal: skipped — ${support.reason}`)

describe('the ICE configuration a peer is handed', () => {
  it('never offers the film transport a relay, whatever the STUN substitution does', () => {
    const urlsOf = (list: unknown[]): string[] =>
      list.flatMap(s => {
        const u = (s as { urls: string | string[] }).urls
        return Array.isArray(u) ? u : [u]
      })
    expect(urlsOf(iceFor('bulk')).some(u => u.startsWith('turn'))).toBe(false)
    expect(urlsOf(iceFor('bulk'))).toContain('stun:203.0.113.1:3478')
  })
})

when('a real peer connection across a simulated NAT', () => {
  it('connects two home routers to each other', async () => {
    const outcome = await attemptPairing({ name: 'a', nat: ['cone'] }, { name: 'b', nat: ['cone'] }, 'bulk')
    expect(outcome.note).toBeUndefined()
    // Both ends must have learnt their own public address, or the connection
    // that follows proves nothing about NAT traversal.
    expect(outcome.local).toContain('srflx')
    expect(outcome.remote).toContain('srflx')
    expect(outcome.connected).toBe(true)
  })

  it('cannot connect two symmetric NATs, which is why relay mode exists', async () => {
    const outcome = await attemptPairing(
      { name: 'a', nat: ['symmetric'] }, { name: 'b', nat: ['symmetric'] }, 'bulk'
    )
    expect(outcome.note).toBeUndefined()
    // Candidates are gathered perfectly well; it is the addresses in them that
    // are useless to the other end, which is exactly what makes this failure so
    // confusing in the field -- everything looks configured and nothing works.
    expect(outcome.local).toContain('srflx')
    expect(outcome.connected).toBe(false)
  })
})
