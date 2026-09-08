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
})
