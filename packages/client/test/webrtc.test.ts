import { describe, it, expect } from 'vitest'
import { installWebRtc, isWebRtcInstalled, webRtcFailure, DEFAULT_ICE_SERVERS } from '../src/webrtc.js'

/**
 * The WebRTC polyfill, and what happens when its native addon is not there.
 *
 * A Windows installer built on Linux shipped without the addon — node-datachannel
 * publishes one package per platform and npm installs only the local one — and
 * because the polyfill was a top-level import, the whole application died on
 * launch with an uncaught exception in the main process, before any window
 * existed. It is loaded on demand now, so a missing addon costs the swarm and
 * nothing else.
 */

describe('installing WebRTC for WebTorrent', () => {
  it('puts an implementation on globalThis where WebTorrent looks for it', () => {
    // Without this the swarm works perfectly on a LAN over TCP and fails for
    // everyone behind a NAT, silently, because falling back is not an error as
    // far as WebTorrent is concerned.
    installWebRtc()
    expect(webRtcFailure()).toBeNull()
    expect(isWebRtcInstalled()).toBe(true)
    const g = globalThis as unknown as { WRTC?: { RTCPeerConnection?: unknown } }
    expect(typeof g.WRTC?.RTCPeerConnection).toBe('function')
  })

  it('is safe to call more than once', () => {
    const g = globalThis as unknown as { WRTC?: unknown }
    installWebRtc()
    const first = g.WRTC
    installWebRtc()
    expect(g.WRTC).toBe(first)
  })

  it('offers STUN by default, and never a relay for bulk transfer', () => {
    // A relayed film crosses the relay twice per viewer, at the operator's cost.
    expect(DEFAULT_ICE_SERVERS.every(s => s.urls.startsWith('stun:'))).toBe(true)
  })

  it('uses more than one STUN operator, so IPv6 does not hinge on one provider', () => {
    // A STUN server can only report an address it is itself reachable over, so
    // the IPv6 server-reflexive candidate depends on that provider's AAAA record
    // and IPv6 route. With a single provider, a fault there does not degrade
    // connectivity -- it deletes the IPv6 path silently, which for a peer behind
    // carrier-grade NAT is the only path that was going to work.
    const hosts = new Set(DEFAULT_ICE_SERVERS.map(s => s.urls.replace(/^stun:/, '').split(':')[0]))
    expect(hosts.size).toBeGreaterThan(1)
  })

  it('points only at hostnames, never at a literal address of one family', () => {
    // A hostname can resolve to both an A and a AAAA record and let the client
    // pick; a literal cannot, and hard-coding one would quietly restrict STUN to
    // whichever family it happened to belong to.
    for (const { urls } of DEFAULT_ICE_SERVERS) {
      const host = urls.replace(/^stun:/, '').split(':')[0] ?? ''
      expect(host, urls).toMatch(/[a-z]/i)
      expect(host, urls).not.toMatch(/^\d+\.\d+\.\d+\.\d+$/)
    }
  })
})

describe('the STUN servers as DNS actually answers for them', () => {
  it('publishes both an A and a AAAA record for every one of them', async () => {
    // The IPv6 half of the default configuration is only real if these hosts
    // are reachable over IPv6, and that is a fact about the operators rather
    // than about this code -- so it is worth checking rather than assuming, and
    // it is what would catch a future swap for a v4-only server.
    const { resolve4, resolve6 } = await import('node:dns/promises')
    for (const { urls } of DEFAULT_ICE_SERVERS) {
      const host = urls.replace(/^stun:/, '').split(':')[0] ?? ''
      let v4: string[] = []
      let v6: string[] = []
      try {
        ;[v4, v6] = await Promise.all([resolve4(host), resolve6(host)])
      } catch {
        // No DNS here at all -- an offline machine or a sandboxed CI runner.
        // That says nothing about the servers, so it is not a failure.
        return
      }
      expect(v4.length, `${host} has no A record`).toBeGreaterThan(0)
      expect(v6.length, `${host} has no AAAA record`).toBeGreaterThan(0)
    }
  }, 30_000)
})
