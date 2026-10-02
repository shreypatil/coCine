/**
 * Turning a scenario into the commands that build it.
 *
 * Pure on purpose. Every mistake that made the prototype of this lie about
 * coCine's connectivity was a mistake in *these* commands -- a shared subnet
 * that left one peer with no reflexive candidate, a conntrack rule on one hook
 * instead of two -- and none of them needed a namespace to catch. Keeping the
 * plan a value means the topology can be asserted in an ordinary unit test that
 * runs anywhere, including on the machines that cannot run the simulator at all.
 */
import type { Command, NatKind, ScenarioSpec, Shaping, SiteSpec } from './types.js'

/** The namespace standing in for the internet, and the name a site may not use. */
export const INTERNET = 'net'
/** The internet segment. TEST-NET-3, which is reserved for documentation. */
export const INTERNET_SUBNET = '203.0.113'
/** The address of the internet segment's gateway, and where a STUN server goes. */
export const INTERNET_GATEWAY = `${INTERNET_SUBNET}.1`
/**
 * Interface names are capped at 15 characters by the kernel, so they are built
 * from the site's index rather than its name. Ten sites is far more than any
 * scenario needs and keeps every name to four characters.
 */
export const MAX_SITES = 10

/** Where a site's machine sits, from the outside. */
export function publicAddressOf (index: number): string {
  return `${INTERNET_SUBNET}.${10 + index}`
}

/** The subnet of a site's own LAN. */
export function lanSubnetOf (index: number): string {
  return `192.168.${10 + index}`
}

/**
 * The subnet between NAT layer `layer - 1` and `layer`.
 *
 * Drawn from 100.64.0.0/10, which is the range reserved for exactly this --
 * carrier-grade NAT -- so the simulated topology reads like the real one it is
 * standing in for.
 */
export function midSubnetOf (index: number, layer: number): string {
  return `100.${64 + index}.${layer}`
}

interface SiteLayout {
  spec: SiteSpec
  index: number
  /** `[]` for a machine sitting directly on the internet. */
  routers: string[]
  hostIf: string
  /** The interface facing the host from the other side, and the namespace it is in. */
  downstream: { ns: string; iface: string }
  /** The outermost WAN interface, and its namespace. Absent for a public machine. */
  wan?: { ns: string; iface: string }
}

function layoutOf (spec: SiteSpec, index: number): SiteLayout {
  const nat = spec.nat ?? []
  const routers = nat.map((_, j) => `${spec.name}-r${j}`)
  const hostIf = `h${index}`
  if (routers.length === 0) {
    return { spec, index, routers, hostIf, downstream: { ns: INTERNET, iface: `b${index}` } }
  }
  return {
    spec, index, routers, hostIf,
    downstream: { ns: routers[0]!, iface: `r${index}l0` },
    wan: { ns: routers[routers.length - 1]!, iface: `r${index}w${routers.length - 1}` }
  }
}

/** The `tc netem` arguments for a shaping, or null when it asks for nothing. */
export function netemArgs (s: Shaping | undefined): string[] | null {
  if (!s) return null
  const out: string[] = []
  // netem's own argument order: delay first, because loss, reorder and rate are
  // all expressed relative to the delayed stream.
  if (s.delayMs !== undefined) {
    out.push('delay', `${s.delayMs}ms`)
    if (s.jitterMs !== undefined) out.push(`${s.jitterMs}ms`, 'distribution', 'normal')
  }
  if (s.lossPct !== undefined) out.push('loss', `${s.lossPct}%`)
  // Reordering is "some packets skip the delay", so without a delay there is
  // nothing for them to skip and netem silently reorders nothing.
  if (s.reorderPct !== undefined) out.push('reorder', `${s.reorderPct}%`, '50%')
  if (s.rateMbit !== undefined) out.push('rate', `${s.rateMbit}mbit`)
  return out.length > 0 ? out : null
}

function validate (spec: ScenarioSpec): void {
  const { sites } = spec
  if (sites.length === 0) throw new Error('a scenario needs at least one site')
  if (sites.length > MAX_SITES) {
    throw new Error(`at most ${MAX_SITES} sites (interface names are capped at 15 characters)`)
  }
  const seen = new Set<string>()
  for (const s of sites) {
    if (!/^[a-z][a-z0-9-]{0,24}$/.test(s.name)) {
      throw new Error(`site name ${JSON.stringify(s.name)} must be lowercase letters, digits and dashes, starting with a letter`)
    }
    if (s.name === INTERNET) throw new Error(`"${INTERNET}" is the internet's namespace and cannot be a site name`)
    if (seen.has(s.name)) throw new Error(`two sites are both called ${JSON.stringify(s.name)}`)
    seen.add(s.name)
    if ((s.nat ?? []).length > 2) throw new Error(`${s.name}: at most two NAT layers`)
    for (const [which, sh] of [['link', s.link], ['up', s.up], ['down', s.down]] as const) {
      if (sh?.reorderPct !== undefined && sh.delayMs === undefined) {
        throw new Error(`${s.name}.${which}: reorderPct needs a delayMs to reorder around`)
      }
      if (sh?.jitterMs !== undefined && sh.delayMs === undefined) {
        throw new Error(`${s.name}.${which}: jitterMs needs a delayMs to vary`)
      }
    }
  }
}

function natTable (wanIface: string, kind: NatKind, blockUdp: boolean): string {
  // `random` is what turns an endpoint-independent mapping into a
  // destination-dependent one, which is the whole of what makes a symmetric NAT
  // unpunchable.
  const masq = kind === 'symmetric' ? 'masquerade random' : 'masquerade'
  // Dropping unsolicited inbound is not decoration and not merely realistic.
  // Linux conntrack records an inbound packet that matches nothing, and that
  // record occupies the external port the outbound hole punch then needs -- so
  // masquerade reallocates, the peer's replies arrive at a port nobody is
  // listening on, and a cone NAT behaves exactly like a symmetric one. Both
  // hooks are required: a packet addressed to the router's own WAN address
  // reaches `input`, not `forward`, and conntrack records it there just the same.
  const udp = blockUdp
    ? `
    iifname "${wanIface}" meta l4proto udp drop
    oifname "${wanIface}" meta l4proto udp drop`
    : ''
  return `table ip nat {
  chain postrouting {
    type nat hook postrouting priority 100; policy accept;
    oifname "${wanIface}" ${masq}
  }
  chain prerouting {
    type nat hook prerouting priority -100; policy accept;
  }
}
table ip filter {
  chain forward {
    type filter hook forward priority 0; policy accept;
    iifname "${wanIface}" ct state { new, invalid } drop${udp}
  }
  chain input {
    type filter hook input priority 0; policy accept;
    iifname "${wanIface}" ct state { new, invalid } drop
  }
}
`
}

/** A filter for a machine with no router of its own to block UDP on. */
function hostUdpBlockTable (hostIf: string): string {
  return `table ip filter {
  chain input {
    type filter hook input priority 0; policy accept;
    iifname "${hostIf}" meta l4proto udp drop
  }
  chain output {
    type filter hook output priority 0; policy accept;
    oifname "${hostIf}" meta l4proto udp drop
  }
}
`
}

/**
 * Every command needed to build `spec`, in order.
 *
 * Throws rather than producing a half-valid plan: a scenario that names two
 * sites the same, or asks for reordering with no delay, is a mistake in the
 * test rather than a network worth simulating.
 */
export function planScenario (spec: ScenarioSpec): Command[] {
  validate(spec)
  const cmds: Command[] = []
  const add = (label: string, argv: string[], ns?: string, stdin?: string): void => {
    cmds.push(ns === undefined ? { label, argv } : { label, argv, ns, ...(stdin ? { stdin } : {}) })
  }
  const addStdin = (label: string, argv: string[], ns: string, stdin: string): void => {
    cmds.push({ label, argv, ns, stdin })
  }

  // `ip netns` keeps its bind mounts under /run/netns, which is owned by the
  // real root outside this user namespace. A tmpfs of our own is the only way
  // to get a writable one without privileges.
  cmds.push({ label: 'make mounts private', argv: ['mount', '--make-rprivate', '/'], optional: true })
  add('mount a private /run', ['mount', '-t', 'tmpfs', 'tmpfs', '/run'])
  add('create /run/netns', ['mkdir', '-p', '/run/netns'])

  const layouts = spec.sites.map(layoutOf)
  const namespaces = [INTERNET, ...layouts.flatMap(l => [l.spec.name, ...l.routers])]
  for (const ns of namespaces) {
    add(`create namespace ${ns}`, ['ip', 'netns', 'add', ns])
    add(`bring up loopback in ${ns}`, ['ip', 'link', 'set', 'lo', 'up'], ns)
  }

  // The internet is one bridge every site's outermost hop attaches to. It has
  // to be a bridge rather than a veth per site: two point-to-point links
  // numbered out of the same subnet leave the internet namespace with ambiguous
  // routes, and the symptom is not an error -- it is one peer silently
  // gathering no reflexive candidate and a connection that never forms.
  add('create the internet bridge', ['ip', 'link', 'add', 'br0', 'type', 'bridge'], INTERNET)
  add('address the internet bridge', ['ip', 'addr', 'add', `${INTERNET_GATEWAY}/24`, 'dev', 'br0'], INTERNET)
  add('bring up the internet bridge', ['ip', 'link', 'set', 'br0', 'up'], INTERNET)

  for (const l of layouts) {
    const { index, spec: site } = l
    const lan = lanSubnetOf(index)

    if (l.routers.length === 0) {
      // Directly on the internet: a server, or someone with a public address.
      const peerIf = `b${index}`
      add(`${site.name}: link to the internet`, ['ip', 'link', 'add', l.hostIf, 'type', 'veth', 'peer', 'name', peerIf])
      add(`${site.name}: move its interface`, ['ip', 'link', 'set', l.hostIf, 'netns', site.name])
      add(`${site.name}: move the bridge port`, ['ip', 'link', 'set', peerIf, 'netns', INTERNET])
      add(`${site.name}: address it`, ['ip', 'addr', 'add', `${publicAddressOf(index)}/24`, 'dev', l.hostIf], site.name)
      add(`${site.name}: bring it up`, ['ip', 'link', 'set', l.hostIf, 'up'], site.name)
      add(`${site.name}: attach to the bridge`, ['ip', 'link', 'set', peerIf, 'master', 'br0'], INTERNET)
      add(`${site.name}: bring up the bridge port`, ['ip', 'link', 'set', peerIf, 'up'], INTERNET)
      add(`${site.name}: default route`, ['ip', 'route', 'add', 'default', 'via', INTERNET_GATEWAY], site.name)
      if (site.udpBlocked) {
        addStdin(`${site.name}: block UDP`, ['nft', '-f', '-'], site.name, hostUdpBlockTable(l.hostIf))
      }
    } else {
      // The LAN: machine to its own router.
      const r0 = l.routers[0]!
      add(`${site.name}: LAN link`, ['ip', 'link', 'add', l.hostIf, 'type', 'veth', 'peer', 'name', `r${index}l0`])
      add(`${site.name}: move its interface`, ['ip', 'link', 'set', l.hostIf, 'netns', site.name])
      add(`${site.name}: move the router's LAN side`, ['ip', 'link', 'set', `r${index}l0`, 'netns', r0])
      add(`${site.name}: address it`, ['ip', 'addr', 'add', `${lan}.2/24`, 'dev', l.hostIf], site.name)
      add(`${site.name}: bring it up`, ['ip', 'link', 'set', l.hostIf, 'up'], site.name)
      add(`${r0}: address the LAN side`, ['ip', 'addr', 'add', `${lan}.1/24`, 'dev', `r${index}l0`], r0)
      add(`${r0}: bring up the LAN side`, ['ip', 'link', 'set', `r${index}l0`, 'up'], r0)
      add(`${site.name}: default route`, ['ip', 'route', 'add', 'default', 'via', `${lan}.1`], site.name)

      // Each further NAT layer: this router's WAN side to the next one's LAN side.
      for (let j = 0; j < l.routers.length - 1; j++) {
        const inner = l.routers[j]!
        const outer = l.routers[j + 1]!
        const mid = midSubnetOf(index, j + 1)
        add(`${inner}: link to ${outer}`, ['ip', 'link', 'add', `r${index}w${j}`, 'type', 'veth', 'peer', 'name', `r${index}l${j + 1}`])
        add(`${inner}: move its WAN side`, ['ip', 'link', 'set', `r${index}w${j}`, 'netns', inner])
        add(`${outer}: move its LAN side`, ['ip', 'link', 'set', `r${index}l${j + 1}`, 'netns', outer])
        add(`${inner}: address its WAN side`, ['ip', 'addr', 'add', `${mid}.2/24`, 'dev', `r${index}w${j}`], inner)
        add(`${inner}: bring up its WAN side`, ['ip', 'link', 'set', `r${index}w${j}`, 'up'], inner)
        add(`${outer}: address its LAN side`, ['ip', 'addr', 'add', `${mid}.1/24`, 'dev', `r${index}l${j + 1}`], outer)
        add(`${outer}: bring up its LAN side`, ['ip', 'link', 'set', `r${index}l${j + 1}`, 'up'], outer)
        add(`${inner}: default route`, ['ip', 'route', 'add', 'default', 'via', `${mid}.1`], inner)
      }

      // The outermost router onto the internet bridge.
      const last = l.routers.length - 1
      const outermost = l.routers[last]!
      const wanIf = `r${index}w${last}`
      const portIf = `b${index}`
      add(`${outermost}: link to the internet`, ['ip', 'link', 'add', wanIf, 'type', 'veth', 'peer', 'name', portIf])
      add(`${outermost}: move its WAN side`, ['ip', 'link', 'set', wanIf, 'netns', outermost])
      add(`${outermost}: move the bridge port`, ['ip', 'link', 'set', portIf, 'netns', INTERNET])
      add(`${outermost}: address its WAN side`, ['ip', 'addr', 'add', `${publicAddressOf(index)}/24`, 'dev', wanIf], outermost)
      add(`${outermost}: bring up its WAN side`, ['ip', 'link', 'set', wanIf, 'up'], outermost)
      add(`${outermost}: attach to the bridge`, ['ip', 'link', 'set', portIf, 'master', 'br0'], INTERNET)
      add(`${outermost}: bring up the bridge port`, ['ip', 'link', 'set', portIf, 'up'], INTERNET)
      add(`${outermost}: default route`, ['ip', 'route', 'add', 'default', 'via', INTERNET_GATEWAY], outermost)

      // Forwarding and the NAT itself, one table per router.
      for (let j = 0; j < l.routers.length; j++) {
        const ns = l.routers[j]!
        const iface = `r${index}w${j}`
        add(`${ns}: enable forwarding`, ['sysctl', '-q', '-w', 'net.ipv4.ip_forward=1'], ns)
        addStdin(`${ns}: NAT rules`, ['nft', '-f', '-'], ns,
          natTable(iface, site.nat![j]!, j === last && site.udpBlocked === true))
      }
    }

    // Shaping. netem only ever shapes what leaves an interface, so each
    // direction is a qdisc on the interface that direction departs from: the
    // machine's own for upload, and whatever faces it for download.
    const fallback = site.link ?? spec.defaultLink
    const up = netemArgs(site.up ?? fallback)
    const down = netemArgs(site.down ?? fallback)
    if (up) add(`${site.name}: shape upload`, ['tc', 'qdisc', 'add', 'dev', l.hostIf, 'root', 'netem', ...up], site.name)
    if (down) {
      add(`${site.name}: shape download`,
        ['tc', 'qdisc', 'add', 'dev', l.downstream.iface, 'root', 'netem', ...down], l.downstream.ns)
    }
  }

  return cmds
}

/** A one-line description of each site, for a gate's output. */
export function describeScenario (spec: ScenarioSpec): string[] {
  return spec.sites.map((s, i) => {
    const nat = (s.nat ?? [])
    const where = nat.length === 0 ? 'on the internet' : nat.join(' behind ') + ' NAT'
    const sh = s.link ?? spec.defaultLink
    const bits = [
      sh?.delayMs !== undefined ? `${sh.delayMs}ms${sh.jitterMs !== undefined ? `±${sh.jitterMs}` : ''}` : null,
      sh?.lossPct !== undefined ? `${sh.lossPct}% loss` : null,
      sh?.rateMbit !== undefined ? `${sh.rateMbit}Mbit` : null,
      s.udpBlocked === true ? 'UDP blocked' : null
    ].filter(Boolean)
    return `${s.name} (${publicAddressOf(i)}) — ${where}${bits.length > 0 ? ` · ${bits.join(' · ')}` : ''}`
  })
}
