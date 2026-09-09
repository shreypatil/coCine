import { createRequire } from 'node:module'

/**
 * Give WebTorrent a WebRTC implementation.
 *
 * WebTorrent looks for one on `globalThis.WRTC` and Node has none natively. If
 * this has not run before a client is constructed you get a swarm that works
 * perfectly on a LAN over TCP and fails for everyone behind a NAT -- with no
 * error, because falling back to TCP is not a failure as far as it is
 * concerned. Calling it is the only thing standing between working and a bug
 * that only appears once the app is on real networks.
 *
 * **Loaded on demand, and never at import time.** node-datachannel is a native
 * addon shipped as one package per platform, and a package built on one machine
 * for another can be missing it entirely. As a top-level import that turned into
 * an uncaught exception in Electron's main process before any window existed:
 * the whole application refused to start, with a raw stack trace, for want of
 * peer-to-peer transfer that the person may not even have been about to use.
 * Now the failure is contained -- everything except the swarm still works, and
 * the reason is a sentence rather than a dialog.
 */
let installed = false
let failure: string | null = null

export function installWebRtc (): void {
  if (installed || failure) return
  const g = globalThis as unknown as Record<string, unknown>
  if (g.WRTC) { installed = true; return }
  try {
    // require rather than await import: callers are synchronous, and this has
    // to have run before WebTorrent constructs anything.
    const require = createRequire(import.meta.url)
    const mod = require('node-datachannel/polyfill') as Record<string, unknown>
    g.WRTC = (mod.default as unknown) ?? mod
    installed = true
  } catch (err) {
    failure = err instanceof Error ? err.message : String(err)
  }
}

/**
 * Why WebRTC is unavailable, if it is. Null when everything is fine.
 *
 * Almost always one thing: the native addon for this platform was not included
 * when the application was packaged.
 */
export function webRtcFailure (): string | null {
  return failure
}

export function isWebRtcInstalled (): boolean {
  const g = globalThis as unknown as Record<string, unknown>
  return typeof (g.WRTC as { RTCPeerConnection?: unknown } | undefined)?.RTCPeerConnection === 'function'
}

/**
 * Public STUN carries phase 4; coturn arrives in phase 6.
 *
 * Two operators, not one, and the reason is address families rather than
 * uptime. A STUN server teaches a peer its own external address, and it can
 * only teach it one it can be reached over -- so the server-reflexive IPv6
 * candidate exists only if the STUN hostname publishes a AAAA record *and* that
 * address is actually routable from here. With a single provider, an outage or
 * a broken IPv6 anycast route on their side does not degrade the connection, it
 * removes the IPv6 path entirely and silently, leaving peers to fall back to an
 * IPv4 side that on a carrier-grade-NAT line may not work at all.
 *
 * Both of these publish A and AAAA records and are run by unrelated operators,
 * so no single failure can take IPv6 away.
 */
export const DEFAULT_ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' }
]
