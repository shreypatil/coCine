import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * What the deployed relay is allowed to relay *to*.
 *
 * A TURN server is, by construction, a machine that makes connections on
 * somebody else's behalf. Left open it is a way into whatever it can route to:
 * the host's own loopback services, the hosting provider's internal network,
 * anything else on its LAN. `denied-peer-ip` is the entire defence, and it is a
 * config file nothing had ever checked.
 *
 * The IPv6 half is why this test exists. The IPv4 list was careful and complete
 * and said nothing whatsoever about IPv6, on a server that binds both -- and
 * because `::ffff:127.0.0.1` and `127.0.0.1` name the same host while only one
 * of them is matched by an IPv4 rule, every denial in that careful list could
 * be walked around by spelling the address the other way.
 *
 * Reading the shipped file rather than a copy is the point: a test against its
 * own fixture would have gone on passing while the deployed configuration was
 * wrong.
 */

const CONF = readFileSync(
  fileURLToPath(new URL('../../../infra/turnserver.conf', import.meta.url)), 'utf8'
)

const directives = (name: string): string[] =>
  CONF.split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l.startsWith(`${name}=`))
    .map(l => l.slice(name.length + 1).trim())

type Family = 4 | 6

/** An address as a single integer, alongside the family it belongs to. */
function parseAddress (text: string): { family: Family; value: bigint } {
  if (!text.includes(':')) {
    const octets = text.split('.').map(Number)
    if (octets.length !== 4 || octets.some(o => !Number.isInteger(o) || o < 0 || o > 255)) {
      throw new Error(`not an IPv4 address: ${text}`)
    }
    return { family: 4, value: octets.reduce((acc, o) => (acc << 8n) | BigInt(o), 0n) }
  }

  // An IPv6 address may end in dotted-quad form (`::ffff:127.0.0.1`), which is
  // exactly the notation the mapped-address rule is about, so it has to parse.
  let head = text
  let tail = ''
  const dot = text.lastIndexOf(':')
  if (text.slice(dot + 1).includes('.')) {
    const octets = text.slice(dot + 1).split('.').map(Number)
    if (octets.length !== 4) throw new Error(`not an address: ${text}`)
    head = text.slice(0, dot + 1)
    tail = [(octets[0]! << 8) | octets[1]!, (octets[2]! << 8) | octets[3]!]
      .map(h => h.toString(16)).join(':')
    head = head + tail
  }

  const [left, right] = head.split('::')
  const toGroups = (part: string): string[] => part.split(':').filter(g => g !== '')
  const leading = toGroups(left ?? '')
  const trailing = right === undefined ? [] : toGroups(right)
  const missing = 8 - leading.length - trailing.length
  if (right === undefined && leading.length !== 8) throw new Error(`not an IPv6 address: ${text}`)
  if (missing < 0) throw new Error(`not an IPv6 address: ${text}`)
  const groups = [...leading, ...Array<string>(right === undefined ? 0 : missing).fill('0'), ...trailing]
  return {
    family: 6,
    value: groups.reduce((acc, g) => (acc << 16n) | BigInt(parseInt(g, 16)), 0n)
  }
}

/** One `denied-peer-ip` entry: a single address, or an inclusive range. */
function parseRule (rule: string): { family: Family; from: bigint; to: bigint } {
  // Split on the '-' that separates two addresses, not on any inside an address
  // (IPv6 has none, so a simple split is safe once dotted-quad tails are gone).
  const dash = rule.indexOf('-')
  if (dash === -1) {
    const one = parseAddress(rule)
    return { family: one.family, from: one.value, to: one.value }
  }
  const from = parseAddress(rule.slice(0, dash).trim())
  const to = parseAddress(rule.slice(dash + 1).trim())
  expect(from.family).toBe(to.family)
  return { family: from.family, from: from.value, to: to.value }
}

const RULES = directives('denied-peer-ip').map(parseRule)

/** Whether coturn would refuse to relay to this address. */
function denied (address: string): boolean {
  const { family, value } = parseAddress(address)
  return RULES.some(r => r.family === family && value >= r.from && value <= r.to)
}

describe('the address parser these assertions rest on', () => {
  // If this is wrong, every assertion below is meaningless in whichever
  // direction the bug happens to point.
  it('reads both families, including the mixed notation', () => {
    expect(parseAddress('0.0.0.0').value).toBe(0n)
    expect(parseAddress('255.255.255.255').value).toBe(0xffffffffn)
    expect(parseAddress('::1').value).toBe(1n)
    expect(parseAddress('::ffff:127.0.0.1').value).toBe(parseAddress('::ffff:7f00:1').value)
    expect(parseAddress('2405:201:24:c1ac::1').value)
      .toBe(parseAddress('2405:201:24:c1ac:0:0:0:1').value)
  })

  it('keeps the families apart, so an IPv4 rule cannot match an IPv6 address', () => {
    expect(parseAddress('::1').family).toBe(6)
    expect(parseAddress('127.0.0.1').family).toBe(4)
  })
})

describe('what the relay refuses to reach over IPv4', () => {
  it('refuses loopback, so it cannot be used to reach services on its own host', () => {
    expect(denied('127.0.0.1')).toBe(true)
    expect(denied('127.255.255.254')).toBe(true)
  })

  it('refuses the private ranges, so it is not a way into the network it sits in', () => {
    for (const a of ['10.0.0.1', '10.255.255.255', '172.16.0.1', '172.31.255.255',
      '192.168.1.1', '169.254.169.254', '0.0.0.1']) {
      expect(denied(a), a).toBe(true)
    }
  })

  it('refuses link-local specifically, which is where cloud metadata lives', () => {
    // 169.254.169.254 is the instance metadata endpoint on every major provider,
    // and on some of them it hands out credentials to anything that asks.
    expect(denied('169.254.169.254')).toBe(true)
  })

  it('refuses carrier-grade NAT space', () => {
    // Nothing on a normal VPS, but a relay hosted on a carrier network can reach
    // that carrier's other subscribers through this range.
    expect(denied('100.64.0.1')).toBe(true)
    expect(denied('100.127.255.255')).toBe(true)
  })
})

describe('what the relay refuses to reach over IPv6', () => {
  it('refuses loopback and the unspecified address', () => {
    expect(denied('::1')).toBe(true)
    expect(denied('::')).toBe(true)
  })

  it('refuses link-local, reachable from the relay\'s segment and nowhere else', () => {
    expect(denied('fe80::1')).toBe(true)
    expect(denied('febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff')).toBe(true)
  })

  it('refuses unique-local, the IPv6 equivalent of 10.0.0.0/8', () => {
    expect(denied('fc00::1')).toBe(true)
    expect(denied('fd7a:115c:a1e0::e601:e8ed')).toBe(true)
    expect(denied('fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff')).toBe(true)
  })

  it('refuses IPv4-mapped addresses, which otherwise walk around every IPv4 rule', () => {
    // The reason this file exists. These name the same hosts as the IPv4
    // section above, and before the mapped range was denied, a dual-stack
    // listener would happily relay to them.
    for (const a of ['::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:192.168.1.1',
      '::ffff:169.254.169.254', '::ffff:100.64.0.1']) {
      expect(denied(a), a).toBe(true)
    }
  })
})

describe('what the relay still allows, because a relay that refuses everything is not one', () => {
  it('allows ordinary public addresses in both families', () => {
    // Without this the suite would pass just as happily against a rule denying
    // ::/0, which would break voice entirely rather than secure it.
    expect(denied('49.43.27.212')).toBe(false)
    expect(denied('8.8.8.8')).toBe(false)
    expect(denied('2405:201:24:c1ac:6111:1b0f:47db:8e44')).toBe(false)
    expect(denied('2606:4700:4700::1111')).toBe(false)
  })
})

describe('the rest of the relay configuration', () => {
  it('mints credentials rather than carrying an account list', () => {
    // Fixed credentials on a public relay are found and abused within days, and
    // every relayed byte is billed to whoever runs it.
    expect(CONF).toMatch(/^use-auth-secret$/m)
    expect(directives('static-auth-secret')).toHaveLength(1)
  })

  it('still refuses multicast peers', () => {
    expect(CONF).toMatch(/^no-multicast-peers$/m)
  })

  it('offers TLS on 443, which is what survives a network that blocks UDP', () => {
    expect(directives('tls-listening-port')).toEqual(['443'])
  })
})
