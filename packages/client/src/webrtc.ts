import polyfill from 'node-datachannel/polyfill'

/**
 * Give WebTorrent a WebRTC implementation.
 *
 * WebTorrent looks for one on `globalThis.WRTC` and Node has none natively. If
 * this has not run before a client is constructed you get a swarm that works
 * perfectly on a LAN over TCP and fails for everyone behind a NAT -- with no
 * error, because falling back to TCP is not a failure as far as it is
 * concerned. Calling it is the only thing standing between working and a bug
 * that only appears once the app is on real networks.
 */
let installed = false

export function installWebRtc (): void {
  if (installed) return
  const g = globalThis as unknown as Record<string, unknown>
  if (!g.WRTC) g.WRTC = polyfill
  installed = true
}

export function isWebRtcInstalled (): boolean {
  const g = globalThis as unknown as Record<string, unknown>
  return typeof (g.WRTC as { RTCPeerConnection?: unknown } | undefined)?.RTCPeerConnection === 'function'
}

/** Public STUN carries phase 4; coturn arrives in phase 6. */
export const DEFAULT_ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }]
