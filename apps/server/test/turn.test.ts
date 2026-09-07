import { describe, it, expect } from 'vitest'
import { createHmac } from 'node:crypto'
import { mintTurnCredential, iceServersFor, PUBLIC_STUN, DEFAULT_TURN_TTL_SECONDS, type TurnConfig } from '../src/turn.js'

const CFG: TurnConfig = { secret: 'a-shared-secret', urls: ['turn:relay.test:3478', 'turns:relay.test:443'] }
const NOW = 1_700_000_000_000

describe('minting a relay credential', () => {
  it('produces what coturn will recompute and accept', () => {
    // coturn verifies by recomputing this exact HMAC, so a mismatch here means
    // every relayed connection is rejected at the moment it is needed most.
    const { username, credential } = mintTurnCredential(CFG, 'anjali', NOW)
    const expected = createHmac('sha1', CFG.secret).update(username).digest('base64')
    expect(credential).toBe(expected)
  })

  it('puts the expiry in the username, which is what makes it time-limited', () => {
    const { username, expiresAtMs } = mintTurnCredential(CFG, 'anjali', NOW)
    const [expiry, name] = username.split(':')
    expect(Number(expiry)).toBe(NOW / 1000 + DEFAULT_TURN_TTL_SECONDS)
    expect(name).toBe('anjali')
    expect(expiresAtMs).toBe(Number(expiry) * 1000)
  })

  it('honours a shorter lifetime', () => {
    const { expiresAtMs } = mintTurnCredential({ ...CFG, ttlSeconds: 600 }, 'dev', NOW)
    expect(expiresAtMs).toBe(NOW + 600_000)
  })

  it('gives a different credential at a different time', () => {
    const a = mintTurnCredential(CFG, 'anjali', NOW)
    const b = mintTurnCredential(CFG, 'anjali', NOW + 60_000)
    expect(a.credential).not.toBe(b.credential)
  })

  it('is worthless under a different secret', () => {
    const a = mintTurnCredential(CFG, 'anjali', NOW)
    const b = mintTurnCredential({ ...CFG, secret: 'other' }, 'anjali', NOW)
    expect(a.credential).not.toBe(b.credential)
  })

  it('strips a name that could break the username format', () => {
    // The name is decorative, but a colon in it would move the expiry field.
    const { username } = mintTurnCredential(CFG, 'an:jali droppedtable', NOW)
    expect(username.split(':')).toHaveLength(2)
    expect(username).toMatch(/^\d+:[A-Za-z0-9_-]+$/)
  })

  it('falls back to a placeholder rather than an empty name', () => {
    expect(mintTurnCredential(CFG, '!!!', NOW).username).toMatch(/:guest$/)
  })

  it('never puts the secret anywhere a client can see', () => {
    const minted = mintTurnCredential(CFG, 'anjali', NOW)
    expect(JSON.stringify(minted)).not.toContain(CFG.secret)
  })
})

describe('which relays each plane is given', () => {
  it('gives voice a relay, because a call that cannot connect is useless', () => {
    const ice = iceServersFor('voice', 'anjali', CFG, NOW)
    expect(ice.some(s => s.urls.some(u => u.startsWith('turn')))).toBe(true)
    expect(ice.find(s => s.username)?.credential).toBeTruthy()
  })

  it('never gives bulk transfer a relay, even when one is configured', () => {
    // A relayed film crosses the server twice: 4 GB becomes 8 GB of metered
    // traffic for one viewer, and peer-to-peer stops meaning anything.
    const ice = iceServersFor('bulk', 'anjali', CFG, NOW)
    expect(ice).toEqual([PUBLIC_STUN])
    expect(JSON.stringify(ice)).not.toMatch(/turn/)
  })

  it('enforces that by omission, so there is no setting to get wrong', () => {
    // Nothing to fall back to beats a policy flag someone can flip.
    const ice = iceServersFor('bulk', 'anjali', CFG, NOW)
    expect(ice.every(s => s.username === undefined)).toBe(true)
  })

  it('falls back to public STUN when no relay is configured at all', () => {
    expect(iceServersFor('voice', 'anjali', undefined, NOW)).toEqual([PUBLIC_STUN])
    expect(iceServersFor('voice', 'anjali', { secret: 's', urls: [] }, NOW)).toEqual([PUBLIC_STUN])
  })

  it('always offers STUN alongside the relay, so a direct path is tried first', () => {
    // Relaying when a direct connection was possible wastes the relay's
    // bandwidth on every call.
    const ice = iceServersFor('voice', 'anjali', CFG, NOW)
    expect(ice[0]).toEqual(PUBLIC_STUN)
  })
})
