/**
 * The topology, asserted without building one.
 *
 * Every defect that made the prototype of this simulator lie about coCine's
 * connectivity was a defect in the plan rather than in the kernel, and each one
 * reported the *application* as broken when it was not -- the worst failure a
 * test rig has, because it is believed. So the properties that were wrong then
 * are asserted here, where they cost no namespace and run on any machine.
 */
import { describe, expect, it } from 'vitest'
import {
  INTERNET, INTERNET_GATEWAY, MAX_SITES,
  describeScenario, netemArgs, planScenario, publicAddressOf
} from '../src/index.js'
import type { Command, ScenarioSpec } from '../src/index.js'

const plan = (spec: ScenarioSpec): Command[] => planScenario(spec)
const rulesets = (cmds: Command[]): string[] =>
  cmds.filter(c => c.argv[0] === 'nft').map(c => c.stdin ?? '')
const argvs = (cmds: Command[]): string[] => cmds.map(c => `${c.ns ?? '-'} ${c.argv.join(' ')}`)
const two: ScenarioSpec = { sites: [{ name: 'alice', nat: ['cone'] }, { name: 'bob', nat: ['cone'] }] }

describe('NAT behaviour', () => {
  it('gives a cone NAT an endpoint-independent mapping and a symmetric one a random port', () => {
    const cone = rulesets(plan({ sites: [{ name: 'alice', nat: ['cone'] }] })).join('\n')
    const sym = rulesets(plan({ sites: [{ name: 'alice', nat: ['symmetric'] }] })).join('\n')
    expect(cone).toMatch(/masquerade\b/)
    expect(cone).not.toMatch(/masquerade random/)
    expect(sym).toMatch(/masquerade random/)
  })

  /**
   * The bug this exists for: Linux conntrack records an inbound packet that
   * matches nothing, and that record holds the external port the outbound hole
   * punch then needs. masquerade reallocates, the replies land on a port nobody
   * holds, and a cone NAT punches exactly as badly as a symmetric one -- so the
   * simulator reports every pairing as unreachable and "proves" coCine cannot
   * connect. Covering `forward` alone is not enough, which is the part that
   * cost an afternoon: a packet addressed to the router's own WAN address is
   * delivered to `input`, and conntrack records it there just the same.
   */
  it('drops unsolicited inbound on both the forward and the input hook', () => {
    for (const ruleset of rulesets(plan(two))) {
      if (!ruleset.includes('masquerade')) continue
      const forward = /chain forward \{[^}]*ct state \{ new, invalid \} drop/s.test(ruleset)
      const input = /chain input \{[^}]*ct state \{ new, invalid \} drop/s.test(ruleset)
      expect(forward, 'forward hook drops unsolicited inbound').toBe(true)
      expect(input, 'input hook drops unsolicited inbound').toBe(true)
    }
  })

  it('registers a prerouting nat chain so replies are translated back', () => {
    expect(rulesets(plan(two)).join('\n')).toMatch(/type nat hook prerouting/)
  })

  it('blocks UDP only at the outermost hop, and only when asked', () => {
    const open = rulesets(plan({ sites: [{ name: 'alice', nat: ['cone', 'symmetric'] }] })).join('\n')
    expect(open).not.toMatch(/l4proto udp drop/)

    const blocked = rulesets(plan({ sites: [{ name: 'alice', nat: ['cone', 'symmetric'], udpBlocked: true }] }))
      .filter(r => r.includes('masquerade'))
    const blocking = blocked.filter(r => /l4proto udp drop/.test(r))
    expect(blocking).toHaveLength(1)
    // The outermost router is the one whose WAN faces the internet.
    expect(blocking[0]).toMatch(/r0w1/)
  })
})

describe('addressing', () => {
  /**
   * Two point-to-point links numbered out of one subnet leave the internet
   * namespace with ambiguous routes. The symptom is not an error: one peer
   * silently gathers no reflexive candidate at all, and the connection simply
   * never forms -- which reads as a NAT failure and is not one.
   */
  it('puts every site on its own LAN and its own public address', () => {
    const cmds = plan({ sites: [{ name: 'a', nat: ['cone'] }, { name: 'b', nat: ['cone'] }, { name: 'c', nat: ['cone'] }] })
    const addrs = cmds.filter(c => c.argv[1] === 'addr').map(c => c.argv[3] ?? '')
    const unique = new Set(addrs)
    expect(unique.size).toBe(addrs.length)
    expect(publicAddressOf(0)).not.toBe(publicAddressOf(1))
  })

  it('makes the internet a bridge every site attaches to, not a mesh of links', () => {
    const cmds = plan(two)
    const text = argvs(cmds)
    expect(text).toContain(`${INTERNET} ip link add br0 type bridge`)
    const attached = text.filter(l => l.includes('master br0'))
    expect(attached).toHaveLength(2)
    // No site knows a route *to* another site's LAN: every private network is
    // reachable only as whatever its NAT makes it look like from the bridge,
    // which is the point of simulating a NAT at all.
    expect(text.some(l => /ip route add 192\.168\./.test(l))).toBe(false)
  })

  it('routes every hop towards the internet gateway', () => {
    const routes = plan(two).filter(c => c.argv[1] === 'route')
    expect(routes.length).toBeGreaterThan(0)
    for (const r of routes) expect(r.argv.join(' ')).toMatch(/default via/)
    expect(routes.some(r => r.argv.includes(INTERNET_GATEWAY))).toBe(true)
  })

  it('chains a carrier-grade NAT through a second router in the shared range', () => {
    const cmds = plan({ sites: [{ name: 'phone', nat: ['cone', 'symmetric'] }] })
    const text = argvs(cmds)
    expect(text.some(l => l.startsWith('phone-r0 '))).toBe(true)
    expect(text.some(l => l.startsWith('phone-r1 '))).toBe(true)
    // 100.64.0.0/10 is the range reserved for carrier-grade NAT.
    expect(text.some(l => /ip addr add 100\.64\.1\./.test(l))).toBe(true)
    // The inner router's way out is the outer router, not the internet.
    expect(text).toContain('phone-r0 ip route add default via 100.64.1.1')
    expect(text).toContain(`phone-r1 ip route add default via ${INTERNET_GATEWAY}`)
  })

  it('puts a site with no NAT straight onto the bridge with no router at all', () => {
    const cmds = plan({ sites: [{ name: 'server' }] })
    const text = argvs(cmds)
    expect(text.some(l => l.includes('server-r0'))).toBe(false)
    expect(text).toContain(`server ip addr add ${publicAddressOf(0)}/24 dev h0`)
    expect(text.some(l => l.includes('masquerade'))).toBe(false)
  })

  it("keeps every interface name inside the kernel's 15-character limit", () => {
    const sites = Array.from({ length: MAX_SITES }, (_, i) => ({ name: `site-number-${i}`, nat: ['cone' as const, 'cone' as const] }))
    for (const c of plan({ sites })) {
      const dev = c.argv.includes('dev') ? c.argv[c.argv.indexOf('dev') + 1] : null
      if (dev) expect(dev.length).toBeLessThanOrEqual(15)
    }
  })
})

describe('shaping', () => {
  it('shapes upload on the machine itself and download on whatever faces it', () => {
    const cmds = plan({ sites: [{ name: 'alice', nat: ['cone'], up: { rateMbit: 2 }, down: { rateMbit: 20 } }] })
    const qdiscs = cmds.filter(c => c.argv[0] === 'tc')
    const up = qdiscs.find(c => c.ns === 'alice')
    const down = qdiscs.find(c => c.ns === 'alice-r0')
    expect(up?.argv.join(' ')).toContain('dev h0')
    expect(up?.argv.join(' ')).toContain('rate 2mbit')
    expect(down?.argv.join(' ')).toContain('dev r0l0')
    expect(down?.argv.join(' ')).toContain('rate 20mbit')
  })

  it("shapes a public machine's download from the bridge port, since it has no router", () => {
    const cmds = plan({ sites: [{ name: 'server', down: { delayMs: 5 } }] })
    const down = cmds.filter(c => c.argv[0] === 'tc').find(c => c.ns === INTERNET)
    expect(down?.argv.join(' ')).toContain('dev b0')
  })

  it('applies defaultLink only where a site asks for nothing', () => {
    const cmds = plan({
      defaultLink: { delayMs: 20 },
      sites: [{ name: 'a', nat: ['cone'] }, { name: 'b', nat: ['cone'], link: { delayMs: 80 } }]
    })
    const tc = cmds.filter(c => c.argv[0] === 'tc').map(c => `${c.ns} ${c.argv.join(' ')}`)
    expect(tc.some(l => l.startsWith('a ') && l.includes('delay 20ms'))).toBe(true)
    expect(tc.some(l => l.startsWith('b ') && l.includes('delay 80ms'))).toBe(true)
  })

  it('builds netem arguments in the order netem parses them', () => {
    expect(netemArgs({ delayMs: 40, jitterMs: 10, lossPct: 1, reorderPct: 5, rateMbit: 8 }))
      .toEqual(['delay', '40ms', '10ms', 'distribution', 'normal', 'loss', '1%', 'reorder', '5%', '50%', 'rate', '8mbit'])
    expect(netemArgs({})).toBeNull()
    expect(netemArgs(undefined)).toBeNull()
  })
})

describe('rejecting scenarios that cannot mean what they say', () => {
  it('refuses a site called after the internet', () => {
    expect(() => plan({ sites: [{ name: 'net' }] })).toThrow(/internet/)
  })
  it('refuses two sites with one name', () => {
    expect(() => plan({ sites: [{ name: 'a' }, { name: 'a' }] })).toThrow(/both called/)
  })
  it('refuses more sites than there are short interface names', () => {
    const sites = Array.from({ length: MAX_SITES + 1 }, (_, i) => ({ name: `s${i}` }))
    expect(() => plan({ sites })).toThrow(/at most/)
  })
  it('refuses reordering with no delay to reorder around', () => {
    expect(() => plan({ sites: [{ name: 'a', link: { reorderPct: 5 } }] })).toThrow(/reorderPct/)
  })
  it('refuses jitter with no delay to vary', () => {
    expect(() => plan({ sites: [{ name: 'a', link: { jitterMs: 5 } }] })).toThrow(/jitterMs/)
  })
  it('refuses a name that would not survive being an interface or a namespace', () => {
    expect(() => plan({ sites: [{ name: 'Alice; rm -rf /' }] })).toThrow(/must be lowercase/)
  })
  it('refuses an empty scenario', () => {
    expect(() => plan({ sites: [] })).toThrow(/at least one site/)
  })
})

describe('describeScenario', () => {
  it('says where each site sits and what its link does', () => {
    const lines = describeScenario({
      sites: [
        { name: 'alice', nat: ['cone'], link: { delayMs: 30, jitterMs: 8, rateMbit: 16 } },
        { name: 'phone', nat: ['cone', 'symmetric'], udpBlocked: true },
        { name: 'server' }
      ]
    })
    expect(lines[0]).toContain('cone NAT')
    expect(lines[0]).toContain('30ms±8')
    expect(lines[1]).toContain('cone behind symmetric NAT')
    expect(lines[1]).toContain('UDP blocked')
    expect(lines[2]).toContain('on the internet')
  })
})
