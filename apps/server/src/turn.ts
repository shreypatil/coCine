import { createHmac } from 'node:crypto'

/**
 * Time-limited TURN credentials.
 *
 * coturn's `use-auth-secret` scheme: the username is an expiry timestamp joined
 * to a name, and the password is an HMAC of that username under a secret only
 * the server and coturn know. coturn recomputes the HMAC to check it, so no
 * account list exists anywhere and nothing needs provisioning.
 *
 * The alternative -- a fixed username and password compiled into the client --
 * is how open relays happen. A TURN server with static credentials is found and
 * used by strangers within days, and every relayed byte is billed to whoever
 * runs it.
 */
export interface TurnConfig {
  /** Shared with coturn as `static-auth-secret`. Never sent to a client. */
  secret: string
  /** e.g. ['turn:relay.example:3478', 'turns:relay.example:443'] */
  urls: string[]
  /** How long a minted credential stays valid. */
  ttlSeconds?: number
}

export interface IceServer {
  urls: string[]
  username?: string
  credential?: string
}

export const DEFAULT_TURN_TTL_SECONDS = 12 * 3600

/**
 * Public STUN, which needs no credentials and costs nothing to use.
 *
 * Two operators on purpose. A STUN server can only report an address it can
 * itself be reached over, so the IPv6 server-reflexive candidate depends on the
 * STUN hostname publishing a AAAA record and that path routing from the
 * client. Relying on one provider for that means a broken IPv6 route on their
 * side does not degrade connectivity, it deletes the IPv6 path -- which for a
 * client behind carrier-grade NAT is the only path that was going to work.
 * Both of these are dual-stack and unrelated to each other.
 */
export const PUBLIC_STUN: IceServer = {
  urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478']
}

export function mintTurnCredential (
  cfg: TurnConfig,
  name: string,
  nowMs = Date.now()
): { username: string; credential: string; expiresAtMs: number } {
  const ttl = cfg.ttlSeconds ?? DEFAULT_TURN_TTL_SECONDS
  const expiry = Math.floor(nowMs / 1000) + ttl
  // The name is decorative -- coturn only verifies the HMAC -- but it makes
  // relay logs readable when working out who used what.
  const username = `${expiry}:${name.replace(/[^A-Za-z0-9_-]/g, '') || 'guest'}`
  const credential = createHmac('sha1', cfg.secret).update(username).digest('base64')
  return { username, credential, expiresAtMs: expiry * 1000 }
}

/**
 * What a client should use for ICE, given what it is for.
 *
 * The two planes are treated oppositely on purpose. Voice and control are
 * kilobits and must always work, so they may relay. **Bulk transfer must never
 * relay:** a relayed film crosses the server twice, so four gigabytes becomes
 * eight gigabytes of metered traffic for one person -- and it defeats the point
 * of peer to peer entirely.
 *
 * Enforcement is by omission rather than by policy flag. The transfer client is
 * never given TURN credentials at all, so there is nothing for it to fall back
 * to and no setting anyone can flip.
 */
export function iceServersFor (
  plane: 'voice' | 'bulk',
  name: string,
  cfg?: TurnConfig,
  nowMs = Date.now()
): IceServer[] {
  if (plane === 'bulk') return [PUBLIC_STUN]
  if (!cfg || cfg.urls.length === 0) return [PUBLIC_STUN]
  const { username, credential } = mintTurnCredential(cfg, name, nowMs)
  return [PUBLIC_STUN, { urls: cfg.urls, username, credential }]
}
