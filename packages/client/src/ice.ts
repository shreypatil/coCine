/**
 * What ICE actually gathers on this machine, and which address families it
 * covers.
 *
 * Everything else in this project treats IPv6 as something that happens by
 * itself: ICE gathers every local address, prioritises IPv6 above IPv4 on its
 * own, and nothing here suppresses it. That reasoning is correct and it was
 * never once measured, which is a bad combination for the single property most
 * likely to decide whether two Indian home connections can exchange a film at
 * all. Jio hands out native IPv6 with no NAT on that path while the IPv4 side
 * sits behind carrier-grade NAT, so for a large share of the intended users
 * IPv6 is not an optimisation, it is the only thing that works.
 *
 * The failure this guards against is silent by construction. A stack that
 * gathers no IPv6 candidate does not error; it produces a perfectly valid
 * IPv4-only offer, works flawlessly on the developer's LAN, and fails only
 * between two people who both needed the address family that was missing. That
 * is precisely the shape of the phase 6 bug where TURN credentials were minted
 * correctly, unit tested, and then dropped before they reached the peer
 * connection.
 *
 * So this module exists to turn an argument into an observation: gather real
 * candidates from a real peer connection and say what came back.
 */

/** Which address family a candidate's address belongs to. */
export type Family = 'IPv4' | 'IPv6'

/** How a candidate was learnt, in the SDP's own vocabulary. */
export type CandidateType = 'host' | 'srflx' | 'prflx' | 'relay'

export interface Candidate {
  foundation: string
  /** Higher is tried first. libdatachannel ranks IPv6 host above IPv4 host. */
  priority: number
  address: string
  port: number
  type: CandidateType
  family: Family
  /**
   * Global unicast IPv6 (2000::/3) -- the only kind of IPv6 address a peer
   * somewhere else can actually reach.
   *
   * Worth separating out, because a machine with no usable IPv6 at all still
   * gathers IPv6 candidates: link-local `fe80::` on every interface, and a
   * unique-local `fd00::/8` address for anyone running Tailscale or similar.
   * Counting those as IPv6 support would report success on a machine that has
   * none, which is worse than reporting nothing.
   */
  globalV6: boolean
}

/**
 * The leading 16 bits of an IPv6 address, which is what every range that
 * matters here is distinguished by. Returns 0 for `::`-prefixed addresses,
 * where there is no leading group to read.
 */
function firstHextet (address: string): number {
  // A link-local address may carry a zone index (`fe80::1%eth0`).
  const bare = (address.split('%')[0] ?? address).trim()
  if (bare.startsWith('::')) return 0
  const head = bare.split(':')[0] ?? ''
  const value = parseInt(head, 16)
  return Number.isNaN(value) ? 0 : value
}

export function familyOf (address: string): Family {
  return address.includes(':') ? 'IPv6' : 'IPv4'
}

/**
 * Whether this is an IPv6 address a peer elsewhere could reach: global unicast,
 * 2000::/3. Excludes loopback (`::1`), link-local (`fe80::/10`) and unique-local
 * (`fc00::/7`), none of which route beyond the machine or the LAN.
 */
export function isGlobalV6 (address: string): boolean {
  if (familyOf(address) !== 'IPv6') return false
  const head = firstHextet(address)
  return head >= 0x2000 && head <= 0x3fff
}

/**
 * Parse one SDP candidate line.
 *
 * Accepts the three spellings that turn up in practice: a bare
 * `candidate:...`, the `a=candidate:...` that libdatachannel emits, and a full
 * SDP line with trailing attributes after the type, which are ignored.
 * Returns null for anything that is not a candidate, so a caller can filter a
 * whole SDP through it without pre-checking.
 */
export function parseCandidate (line: string): Candidate | null {
  const text = line.trim().replace(/^a=/, '')
  if (!text.startsWith('candidate:')) return null
  const parts = text.slice('candidate:'.length).trim().split(/\s+/)
  // foundation component transport priority address port "typ" type
  if (parts.length < 8 || parts[6] !== 'typ') return null
  const [foundation, , , priorityText, address, portText, , typeText] = parts
  if (!foundation || !address || !typeText) return null
  const priority = Number(priorityText)
  const port = Number(portText)
  if (!Number.isFinite(priority) || !Number.isFinite(port)) return null
  if (!['host', 'srflx', 'prflx', 'relay'].includes(typeText)) return null
  return {
    foundation,
    priority,
    address,
    port,
    type: typeText as CandidateType,
    family: familyOf(address),
    globalV6: isGlobalV6(address)
  }
}

/** Every candidate in an SDP, in the order the offer lists them. */
export function candidatesIn (sdp: string): Candidate[] {
  return sdp.split(/\r?\n/).map(parseCandidate).filter((c): c is Candidate => c !== null)
}

export interface CandidateSummary {
  /** A global-unicast IPv6 address of this machine was offered to peers. */
  globalV6: boolean
  /** Any IPv4 candidate at all. */
  v4: boolean
  /**
   * A global IPv6 address confirmed by a STUN server rather than only assumed.
   *
   * Its absence is normal and is not a fault. A global IPv6 host candidate is
   * already the address a peer would send to, so there is nothing for STUN to
   * discover and libdatachannel does not ask -- measured here, where raw STUN
   * over IPv6 answers fine and the stack still gathers an IPv4 srflx and no
   * IPv6 one. Reported because it distinguishes an address confirmed by a third
   * party from one merely read off an interface, not because it should be true.
   */
  reflexiveV6: boolean
  /** A STUN server reported this machine's IPv4 address. */
  reflexiveV4: boolean
  /**
   * Whether IPv6 is preferred where both exist. ICE tries higher priorities
   * first, and IPv6 being ranked below IPv4 would mean the good path is only
   * ever reached after the bad one times out.
   */
  v6PreferredOverV4: boolean
  candidates: Candidate[]
}

export function summarise (candidates: Candidate[]): CandidateSummary {
  const global6 = candidates.filter(c => c.globalV6)
  const v4 = candidates.filter(c => c.family === 'IPv4')
  const best = (list: Candidate[]): number =>
    list.reduce((max, c) => Math.max(max, c.priority), -1)
  return {
    globalV6: global6.length > 0,
    v4: v4.length > 0,
    reflexiveV6: global6.some(c => c.type === 'srflx'),
    reflexiveV4: v4.some(c => c.type === 'srflx'),
    // Vacuously true when there is nothing to compare, which is the honest
    // answer: no preference has been expressed either way.
    v6PreferredOverV4: global6.length === 0 || v4.length === 0 || best(global6) > best(v4),
    candidates
  }
}

/**
 * An ICE server as either half of this project spells it: the client's own
 * defaults carry a single `urls` string, the server's minted lists carry an
 * array. Both are valid WebRTC and both turn up here.
 */
export interface IceServerLike {
  urls: string | string[]
  username?: string
  credential?: string
}

/**
 * The part of a peer connection this module touches, described structurally
 * rather than pulled from the DOM library -- these packages compile without
 * DOM, and the implementation at runtime is node-datachannel's polyfill.
 */
interface GatheringConnection {
  createDataChannel: (label: string) => unknown
  createOffer: () => Promise<{ type: string; sdp?: string }>
  setLocalDescription: (d: { type: string; sdp?: string }) => Promise<void>
  addEventListener: (type: string, listener: (e: never) => void) => void
  readonly localDescription: { sdp?: string } | null
  readonly iceGatheringState: string
  close: () => void
}

/** The candidate event, in the shape both browsers and the polyfill emit. */
interface IceCandidateEvent { candidate: { candidate: string } | null }

export interface GatherOptions {
  /**
   * STUN (and never, for bulk, TURN) servers. Omitted or empty gathers host
   * candidates only, which needs no network at all and is what makes the
   * address-family test deterministic.
   */
  iceServers?: IceServerLike[]
  /** A hard ceiling. Gathering against an unreachable STUN server otherwise
   *  waits on that server's own timeout, which is not ours to depend on. */
  timeoutMs?: number
}

/**
 * Gather ICE candidates from a real peer connection and report what came back.
 *
 * Deliberately builds the connection with nothing but `iceServers`. In
 * particular it never sets libdatachannel's `bindAddress`, which pins the
 * socket to one local address and would silently reduce this to whichever
 * family that address belongs to -- a one-line change that would break IPv6
 * everywhere while every existing test kept passing.
 *
 * Always resolves and always closes the connection, including on a gathering
 * process that never completes.
 */
export async function gatherCandidates (opts: GatherOptions = {}): Promise<Candidate[]> {
  const { RTCPeerConnection } = (globalThis as unknown as {
    WRTC?: {
      RTCPeerConnection?: new (c?: { iceServers?: IceServerLike[] }) => GatheringConnection
    }
  }).WRTC ?? {}
  if (typeof RTCPeerConnection !== 'function') {
    throw new Error('WebRTC is not installed; call installWebRtc() first')
  }

  const pc = new RTCPeerConnection({ iceServers: opts.iceServers ?? [] })
  try {
    // A connection with no media and no data channel gathers nothing at all.
    pc.createDataChannel('ice-probe')
    const found: Candidate[] = []
    pc.addEventListener('icecandidate', ((e: IceCandidateEvent) => {
      const parsed = e.candidate ? parseCandidate(e.candidate.candidate) : null
      if (parsed) found.push(parsed)
    }) as (e: never) => void)
    await pc.setLocalDescription(await pc.createOffer())

    await new Promise<void>(resolve => {
      let settled = false
      let drain: ReturnType<typeof setTimeout> | null = null
      const finish = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (drain) clearTimeout(drain)
        resolve()
      }
      const timer = setTimeout(finish, opts.timeoutMs ?? 8000)
      // unref so a gather left running can never hold the process open.
      timer.unref?.()

      // The null candidate is end-of-candidates, and it is the only signal that
      // arrives *after* the last real one.
      pc.addEventListener('icecandidate', ((e: IceCandidateEvent) => {
        if (e.candidate === null) finish()
      }) as (e: never) => void)

      // `complete` is not that signal, however much it reads like it. Measured
      // against libdatachannel: the state flips to complete and the
      // server-reflexive candidate is delivered immediately afterwards, in the
      // same millisecond. Resolving on the state alone therefore returned host
      // candidates only and reported a machine with working STUN as having
      // none -- so the state change starts a short drain rather than ending
      // the gather, and the events that follow it are still collected.
      const startDrain = (): void => {
        if (settled || drain) return
        drain = setTimeout(finish, 250)
        drain.unref?.()
      }
      pc.addEventListener('icegatheringstatechange', () => {
        if (pc.iceGatheringState === 'complete') startDrain()
      })
      if (pc.iceGatheringState === 'complete') startDrain()
    })

    // The event stream is the primary source, but a connection that completed
    // gathering before the listener attached still has them in the SDP.
    if (found.length === 0) return candidatesIn(pc.localDescription?.sdp ?? '')
    return found
  } finally {
    try { pc.close() } catch { /* already gone */ }
  }
}

/** Gather and summarise in one call, which is all most callers want. */
export async function probeIce (opts: GatherOptions = {}): Promise<CandidateSummary> {
  return summarise(await gatherCandidates(opts))
}
