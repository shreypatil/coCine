/**
 * What this machine's network will do to a peer connection.  `npm run nat-check`
 *
 * Run it on each machine before a multi-machine session and the likely outcome
 * is known in advance, rather than inferred afterwards from a transfer that sat
 * at 0%.
 *
 * It asks several STUN servers what address they see, **from a single UDP
 * socket**. That detail is the whole test: if every server reports the same
 * external port, the NAT keeps one mapping per socket and a peer can be told
 * where to send -- hole punching works. If the port changes per destination the
 * NAT is symmetric, the address STUN learned is useless to anyone else, and two
 * such peers can never connect directly. Since coCine never relays film data,
 * that pairing cannot exchange a film at all.
 *
 * Separate RTCPeerConnections would each use their own socket and could not
 * distinguish the two cases, which is why this speaks STUN directly.
 */
import { createSocket, type Socket } from 'node:dgram'
import { randomBytes } from 'node:crypto'
import { networkInterfaces } from 'node:os'
import { installWebRtc, isWebRtcInstalled, probeIce, DEFAULT_ICE_SERVERS } from '@cocine/client'

const MAGIC = 0x2112a442
const TIMEOUT_MS = 4000

/** Different operators on purpose: one provider's anycast could hide a
 *  per-destination mapping that a genuinely different path reveals. */
const SERVERS_V4 = [
  { host: 'stun.l.google.com', port: 19302 },
  { host: 'stun.cloudflare.com', port: 3478 },
  { host: 'stun.nextcloud.com', port: 443 }
]

/**
 * The same idea for IPv6, and a separate list rather than a reuse of the one
 * above.
 *
 * These happen to be the same three hosts, because all three publish AAAA
 * records -- but that is a fact about those operators today, not a property of
 * the list. Probing IPv6 through a constant named `SERVERS_V4` meant the check
 * silently depended on it: an operator dropping their AAAA record, or a swap
 * for a v4-only server, would have turned the IPv6 section into "configured but
 * no STUN reply" and read as a fault on this network rather than in this
 * script. Naming it makes the requirement -- every host here must be
 * dual-stack -- something a future edit has to notice.
 */
const SERVERS_V6 = [
  { host: 'stun.l.google.com', port: 19302 },
  { host: 'stun.cloudflare.com', port: 3478 },
  { host: 'stun.nextcloud.com', port: 443 }
]

interface Mapped { address: string; port: number }

function bindingRequest (): { buf: Buffer; id: string } {
  const id = randomBytes(12)
  const buf = Buffer.alloc(20)
  buf.writeUInt16BE(0x0001, 0)
  buf.writeUInt16BE(0, 2)
  buf.writeUInt32BE(MAGIC, 4)
  id.copy(buf, 8)
  return { buf, id: id.toString('hex') }
}

/** Pulls XOR-MAPPED-ADDRESS (or the legacy MAPPED-ADDRESS) out of a response. */
function parseMapped (msg: Buffer): Mapped | null {
  if (msg.length < 20) return null
  const end = Math.min(20 + msg.readUInt16BE(2), msg.length)
  let off = 20
  while (off + 4 <= end) {
    const type = msg.readUInt16BE(off)
    const alen = msg.readUInt16BE(off + 2)
    const val = msg.subarray(off + 4, off + 4 + alen)
    if ((type === 0x0020 || type === 0x0001) && val.length >= 8) {
      const xor = type === 0x0020
      const family = val.readUInt8(1)
      let port = val.readUInt16BE(2)
      if (xor) port ^= MAGIC >>> 16
      if (family === 0x01) {
        const a = Buffer.from(val.subarray(4, 8))
        if (xor) for (let i = 0; i < 4; i++) a[i] = (a[i] ?? 0) ^ ((MAGIC >>> (24 - 8 * i)) & 0xff)
        return { address: Array.from(a).join('.'), port }
      }
      if (family === 0x02 && val.length >= 20) {
        const a = Buffer.from(val.subarray(4, 20))
        if (xor) {
          const mask = Buffer.alloc(16)
          mask.writeUInt32BE(MAGIC, 0)
          msg.subarray(8, 20).copy(mask, 4)
          for (let i = 0; i < 16; i++) a[i] = (a[i] ?? 0) ^ (mask[i] ?? 0)
        }
        const parts: string[] = []
        for (let i = 0; i < 16; i += 2) parts.push(a.readUInt16BE(i).toString(16))
        return { address: parts.join(':'), port }
      }
    }
    off += 4 + alen + ((4 - (alen % 4)) % 4)
  }
  return null
}

/** One socket, every server. Bounded: it always resolves, and always closes. */
async function probe (family: 'udp4' | 'udp6', servers: Array<{ host: string; port: number }>):
Promise<Array<{ server: string; mapped: Mapped }>> {
  return new Promise(resolve => {
    const sock: Socket = createSocket({ type: family, reuseAddr: true })
    const pending = new Map<string, string>()
    const found: Array<{ server: string; mapped: Mapped }> = []
    let done = false

    const finish = (): void => {
      if (done) return
      done = true
      try { sock.close() } catch { /* already closed */ }
      resolve(found)
    }
    const timer = setTimeout(finish, TIMEOUT_MS)
    timer.unref()

    sock.on('message', msg => {
      const id = msg.subarray(8, 20).toString('hex')
      const server = pending.get(id)
      if (!server) return
      pending.delete(id)
      const mapped = parseMapped(msg)
      if (mapped) found.push({ server, mapped })
      if (pending.size === 0) { clearTimeout(timer); finish() }
    })
    sock.on('error', () => { clearTimeout(timer); finish() })

    sock.bind(() => {
      for (const s of servers) {
        const { buf, id } = bindingRequest()
        pending.set(id, `${s.host}:${s.port}`)
        sock.send(buf, s.port, s.host, err => {
          if (err) pending.delete(id)
        })
      }
    })
  })
}

const isCgnat = (ip: string): boolean => {
  const [a, b] = ip.split('.').map(Number)
  return a === 100 && b !== undefined && b >= 64 && b <= 127
}
const isPrivateV4 = (ip: string): boolean => {
  const [a, b] = ip.split('.').map(Number)
  return a === 10 || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168)
}

function localAddresses (): { v4: string[]; v6: string[] } {
  const v4: string[] = []
  const v6: string[] = []
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.internal) continue
      if (a.family === 'IPv4') v4.push(a.address)
      // Global unicast only: link-local (fe80::) and unique-local (fc00::/7)
      // are not routable to a peer elsewhere and would flatter the result.
      else if (a.family === 'IPv6' && /^[23]/.test(a.address)) v6.push(a.address)
    }
  }
  return { v4, v6 }
}

async function main (): Promise<void> {
  console.log('\n  Checking what this network does to a peer connection...\n')
  const local = localAddresses()

  const v4 = await probe('udp4', SERVERS_V4)
  const v6 = local.v6.length > 0 ? await probe('udp6', SERVERS_V6) : []

  // ---- IPv4 ----
  console.log('  IPv4')
  if (v4.length === 0) {
    console.log('    no STUN reply — UDP to the internet appears blocked.')
    console.log('    Peer connections will fail entirely on this network.')
  } else {
    for (const { server, mapped } of v4) {
      console.log(`    ${server.padEnd(30)} sees ${mapped.address}:${mapped.port}`)
    }
    const ports = new Set(v4.map(r => r.mapped.port))
    const addrs = new Set(v4.map(r => r.mapped.address))
    const ip = v4[0]!.mapped.address

    console.log()
    if (local.v4.includes(ip)) {
      console.log('    No NAT: this machine holds a public address directly.')
      console.log('    Best case — any peer can reach it.')
    } else if (isCgnat(ip)) {
      console.log(`    Carrier-grade NAT: ${ip} is in 100.64.0.0/10, the carrier's own`)
      console.log('    shared range. There are two layers of NAT between here and the internet,')
      console.log('    and no port forwarding you configure at home can change that.')
    } else if (isPrivateV4(ip)) {
      console.log(`    Unexpected: STUN reports a private address (${ip}).`)
    } else {
      console.log(`    Behind NAT, with a public external address (${ip}).`)
    }

    console.log()
    if (addrs.size > 1) {
      console.log('    Mapping: the external ADDRESS changes per destination — unusual, and')
      console.log('    as hostile to hole punching as a changing port.')
      console.log('    Verdict: direct connections will usually fail.')
    } else if (ports.size === 1 && v4.length > 1) {
      console.log('    Mapping: endpoint-independent — every server saw the same port, so one')
      console.log('    mapping serves all destinations and a peer can be told where to send.')
      console.log('    Verdict: hole punching should work, including to most other NATs.')
    } else if (ports.size > 1) {
      console.log(`    Mapping: address-dependent (symmetric) — ${[...ports].join(', ')} from one socket.`)
      console.log('    The port a peer is told is not the port their packets arrive on, so')
      console.log('    punching fails against anything but a very permissive NAT.')
      console.log('    Verdict: expect failure against another symmetric or CGNAT peer.')
    } else {
      console.log(`    Mapping: only ${v4.length} server answered — not enough to compare. Re-run.`)
    }
  }

  // ---- IPv6 ----
  console.log('\n  IPv6')
  if (local.v6.length === 0) {
    console.log('    None. No global IPv6 address on any interface.')
    console.log('    Every connection must survive the IPv4 NAT above.')
  } else {
    console.log(`    Global address present: ${local.v6[0]}`)
    if (v6.length > 0) {
      console.log(`    Reaches the internet: ${v6[0]!.server} saw ${v6[0]!.mapped.address}`)
      const direct = local.v6.includes(v6[0]!.mapped.address)
      console.log(direct
        ? '    Unchanged in transit — no NAT at all on this path.'
        : '    Address differs from the local one, which is unusual for IPv6.')
      console.log('\n    This is the good path. With IPv6 there is nothing to punch through:')
      console.log('    both ends are directly addressable, and a pairing that is hopeless over')
      console.log('    CGNAT often connects immediately here — provided the other end has it too.')
    } else {
      console.log('    Configured but no STUN reply over IPv6 — it may not actually route.')
    }
  }

  // ---- what the application's own stack gathers ----
  //
  // Everything above is raw STUN from a plain UDP socket, which proves what the
  // *network* will do. It does not prove what coCine will do with it: the two
  // are only connected if the WebRTC stack actually gathers a candidate for
  // each family and offers it to peers. That step has its own ways of failing
  // -- an addon built without IPv6, a bind pinned to one local address -- and
  // each of them produces a valid IPv4-only offer rather than an error.
  console.log('\n  What coCine gathers')
  let iceV6 = false
  installWebRtc()
  if (!isWebRtcInstalled()) {
    console.log('    WebRTC is unavailable on this machine, so nothing can be gathered.')
    console.log('    The film transfer will not work at all here; voice and chat still will.')
  } else {
    try {
      const ice = await probeIce({ iceServers: DEFAULT_ICE_SERVERS, timeoutMs: 10_000 })
      iceV6 = ice.globalV6
      const kinds = (f: 'IPv4' | 'IPv6'): string => {
        const types = [...new Set(ice.candidates.filter(c => c.family === f).map(c => c.type))]
        return types.length > 0 ? types.join(', ') : 'none'
      }
      console.log(`    IPv4 candidates: ${kinds('IPv4')}`)
      console.log(`    IPv6 candidates: ${kinds('IPv6')}${ice.globalV6 ? '' : ' (none globally routable)'}`)
      if (ice.globalV6 && !ice.reflexiveV6) {
        console.log('    A global IPv6 address is offered, but no STUN server confirmed it over')
        console.log('    IPv6 -- peers will still try it, and it is usually right.')
      }
      if (!ice.v6PreferredOverV4) {
        console.log('    Unexpected: IPv6 is ranked below IPv4, so the better path is only tried')
        console.log('    after the worse one fails. Worth reporting.')
      }
      if (local.v6.length > 0 && !ice.globalV6) {
        console.log('    Unexpected: this machine has a global IPv6 address that the WebRTC stack')
        console.log('    did not offer. That address will go unused. Worth reporting.')
      }
    } catch (err) {
      console.log(`    Could not gather: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // ---- what it means for a session ----
  console.log('\n  For a coCine session')
  const v6Works = v6.length > 0 && iceV6
  const v4Punchable = v4.length > 1 && new Set(v4.map(r => r.mapped.port)).size === 1
  if (v6Works) {
    console.log('    Good, if the other person also has IPv6. Compare this output with theirs;')
    console.log('    IPv6 on both ends is the most reliable outcome available.')
  }
  if (v4Punchable) {
    console.log('    IPv4 should also work against most peers.')
  } else if (v4.length > 0 && !v6Works) {
    console.log('    IPv4 looks difficult and there is no IPv6 to fall back on. Against another')
    console.log('    peer in the same position, expect the film transfer to sit at 0%.')
    console.log('    Voice can still relay through TURN; film data never does, so relay mode')
    console.log('    is the answer for that pairing.')
  }
  console.log('\n  Run this on the other machine too — connectivity is a property of the pair.\n')
}

await main()
process.exit(0)
