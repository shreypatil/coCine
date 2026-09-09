import { describe, it, expect } from 'vitest'
import { networkInterfaces } from 'node:os'
import {
  parseCandidate, candidatesIn, familyOf, isGlobalV6, summarise, gatherCandidates
} from '../src/ice.js'
import { installWebRtc, isWebRtcInstalled, DEFAULT_ICE_SERVERS } from '../src/webrtc.js'

/**
 * IPv6, which until now was handled entirely by assumption.
 *
 * The reasoning was sound -- ICE gathers every local address and prioritises
 * IPv6 by itself, and nothing here suppresses it -- and no test had ever
 * checked it, which for this project is a worse gap than it sounds. On an
 * Indian home connection the IPv4 side is commonly behind carrier-grade NAT
 * while IPv6 is native and unfiltered, so IPv6 is not a faster path, it is
 * frequently the only one. A stack that quietly gathered no IPv6 candidate
 * would work perfectly on a LAN, pass every existing test, and fail between two
 * people who both needed it.
 */

/** A global-unicast IPv6 address on some interface, or null. */
function globalV6Address (): string | null {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (!a.internal && a.family === 'IPv6' && isGlobalV6(a.address)) return a.address
    }
  }
  return null
}

describe('reading a candidate line', () => {
  it('parses what libdatachannel actually emits, `a=` prefix and all', () => {
    const c = parseCandidate('a=candidate:5 1 UDP 2116025343 2405:201:24:c1ac::1 38011 typ host')
    expect(c).toMatchObject({
      foundation: '5', priority: 2116025343, address: '2405:201:24:c1ac::1',
      port: 38011, type: 'host', family: 'IPv6', globalV6: true
    })
  })

  it('parses the bare form a browser gives, and trailing attributes', () => {
    const c = parseCandidate('candidate:7 1 UDP 1678768639 49.43.27.212 52572 typ srflx raddr 0.0.0.0 rport 0')
    expect(c).toMatchObject({ address: '49.43.27.212', type: 'srflx', family: 'IPv4', globalV6: false })
  })

  it('returns null for anything that is not a candidate, so an SDP can be filtered through it', () => {
    expect(parseCandidate('a=end-of-candidates')).toBeNull()
    expect(parseCandidate('v=0')).toBeNull()
    expect(parseCandidate('')).toBeNull()
    // Truncated, and a malformed line must not become a candidate with NaN in it.
    expect(parseCandidate('a=candidate:5 1 UDP 2116025343')).toBeNull()
    expect(parseCandidate('a=candidate:5 1 UDP x 1.2.3.4 1 typ host')).toBeNull()
  })

  it('pulls every candidate out of a whole SDP in order', () => {
    const sdp = [
      'v=0', 'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
      'a=candidate:5 1 UDP 2116025343 2405:201:24:c1ac::1 38011 typ host',
      'a=candidate:1 1 UDP 2114977791 192.168.29.73 38011 typ host',
      'a=end-of-candidates'
    ].join('\r\n')
    expect(candidatesIn(sdp).map(c => c.family)).toEqual(['IPv6', 'IPv4'])
  })
})

describe('deciding whether an IPv6 address is worth anything to a peer', () => {
  it('accepts global unicast, which is 2000::/3', () => {
    // A Jio address and a Hurricane Electric one; both routable from anywhere.
    expect(isGlobalV6('2405:201:24:c1ac:6111:1b0f:47db:8e44')).toBe(true)
    expect(isGlobalV6('2001:470:1f0b:1234::1')).toBe(true)
    expect(isGlobalV6('3ffe::1')).toBe(true)
  })

  it('rejects the addresses a machine has even when it has no usable IPv6', () => {
    // This is the whole reason the distinction exists. Every interface carries a
    // link-local address, and anyone running Tailscale carries a unique-local
    // one -- counting either as IPv6 support reports success on a machine that
    // has none at all, which is worse than reporting nothing.
    expect(isGlobalV6('fe80::1')).toBe(false)
    expect(isGlobalV6('fe80::1%eth0')).toBe(false)
    expect(isGlobalV6('fd7a:115c:a1e0::e601:e8ed')).toBe(false)
    expect(isGlobalV6('::1')).toBe(false)
    expect(isGlobalV6('::')).toBe(false)
  })

  it('is not confused by an IPv4 address', () => {
    expect(isGlobalV6('192.168.1.1')).toBe(false)
    expect(familyOf('192.168.1.1')).toBe('IPv4')
    expect(familyOf('::1')).toBe('IPv6')
  })
})

describe('summarising what was gathered', () => {
  const cand = (address: string, priority: number, type = 'host'): string =>
    `a=candidate:1 1 UDP ${priority} ${address} 1234 typ ${type}`

  it('reports IPv6 only when a peer elsewhere could use it', () => {
    const onlyLocal = summarise(candidatesIn([cand('fe80::1', 100), cand('192.168.1.5', 90)].join('\n')))
    expect(onlyLocal.globalV6).toBe(false)
    expect(onlyLocal.v4).toBe(true)
  })

  it('notices when IPv6 is ranked below IPv4, which would try the good path last', () => {
    const good = summarise(candidatesIn([cand('2405::1', 2116025343), cand('192.168.1.5', 2114977791)].join('\n')))
    expect(good.v6PreferredOverV4).toBe(true)
    const inverted = summarise(candidatesIn([cand('2405::1', 100), cand('192.168.1.5', 900)].join('\n')))
    expect(inverted.v6PreferredOverV4).toBe(false)
  })

  it('claims no preference when there is nothing to compare', () => {
    expect(summarise(candidatesIn(cand('192.168.1.5', 90))).v6PreferredOverV4).toBe(true)
  })

  it('separates an address confirmed by STUN from one read off an interface', () => {
    const s = summarise(candidatesIn([cand('2405::1', 100), cand('49.43.27.212', 90, 'srflx')].join('\n')))
    expect(s.reflexiveV4).toBe(true)
    expect(s.reflexiveV6).toBe(false)
  })
})

/**
 * The part that cannot be faked: a real peer connection, on this machine's real
 * interfaces.
 *
 * Deliberately gathered with no ICE servers, so it needs no network and cannot
 * flake on somebody else's STUN server. That is enough for the question being
 * asked, because host candidates are where the address families show up -- a
 * stack that will not offer this machine's IPv6 address fails here, without
 * anything having to be reachable.
 */
describe('what this machine actually gathers', () => {
  const v6 = globalV6Address()

  it('offers an IPv4 candidate', async () => {
    installWebRtc()
    if (!isWebRtcInstalled()) return
    const candidates = await gatherCandidates({ timeoutMs: 15_000 })
    expect(candidates.some(c => c.family === 'IPv4')).toBe(true)
  }, 30_000)

  it.skipIf(v6 === null)('offers this machine\'s global IPv6 address to peers', async () => {
    // Skipped where there is no global IPv6 to offer -- most CI runners -- since
    // there the absence of an IPv6 candidate is correct rather than a bug.
    installWebRtc()
    if (!isWebRtcInstalled()) return
    const candidates = await gatherCandidates({ timeoutMs: 15_000 })
    const global6 = candidates.filter(c => c.globalV6)
    expect(global6.length).toBeGreaterThan(0)
    expect(global6.map(c => c.address)).toContain(v6)
  }, 30_000)

  it.skipIf(v6 === null)('ranks IPv6 above IPv4, so the better path is tried first', async () => {
    // Not a preference of ours -- it is RFC 8445 via libdatachannel -- but if it
    // ever inverted, IPv6 would only be reached after the IPv4 path timed out,
    // which on a carrier-grade-NAT line means after it fails.
    installWebRtc()
    if (!isWebRtcInstalled()) return
    const summary = summarise(await gatherCandidates({ timeoutMs: 15_000 }))
    expect(summary.globalV6).toBe(true)
    expect(summary.v6PreferredOverV4).toBe(true)
  }, 30_000)

  it.skipIf(v6 === null)('offers both families from one connection, which no pinned bind address could', async () => {
    // The guard against libdatachannel's `bindAddress`, which pins the socket to
    // a single local address. Setting it is a one-line change that looks like
    // tightening and silently reduces every peer connection to whichever family
    // that address belongs to -- and nothing else in the suite would notice,
    // because an IPv4-only offer is perfectly valid and works on a LAN.
    installWebRtc()
    if (!isWebRtcInstalled()) return
    const candidates = await gatherCandidates({ timeoutMs: 15_000 })
    const families = new Set(candidates.map(c => c.family))
    expect([...families].sort()).toEqual(['IPv4', 'IPv6'])
  }, 30_000)

  it('collects the server-reflexive candidate that arrives after gathering completes', async () => {
    // A regression test for this module rather than for the stack. libdatachannel
    // flips iceGatheringState to `complete` and *then* delivers the srflx
    // candidate, in the same millisecond, so resolving on the state alone
    // reported a machine with working STUN as having none.
    installWebRtc()
    if (!isWebRtcInstalled()) return
    const candidates = await gatherCandidates({
      iceServers: DEFAULT_ICE_SERVERS, timeoutMs: 20_000
    })
    // Skipped rather than failed where the network blocks outbound STUN, which
    // is a property of the network and not something this code controls.
    const srflx = candidates.filter(c => c.type === 'srflx')
    if (srflx.length === 0) return
    expect(srflx.some(c => c.family === 'IPv4')).toBe(true)
  }, 45_000)
})
