/**
 * A STUN binding responder, for a simulated internet that has none.
 *
 * ICE cannot learn a peer's external address without one, and the public STUN
 * servers coCine ships with are unreachable from inside a namespace with no
 * route to the real internet. Without this every peer would offer host
 * candidates only, every pairing would fail, and the simulator would report
 * that coCine cannot connect anybody.
 *
 * Binding requests only. That is the whole of what ICE needs from STUN; TURN is
 * a different protocol and deliberately not implemented here.
 *
 *   node stun.mjs [port] [ms]
 *
 * Exits after `ms` so a scenario is not held open waiting to kill it.
 */
import { createSocket } from 'node:dgram'

const MAGIC = 0x2112a442
const BINDING_REQUEST = 0x0001
const BINDING_SUCCESS = 0x0101
const XOR_MAPPED_ADDRESS = 0x0020
const FAMILY_IPV4 = 0x01

const port = Number(process.argv[2] ?? 3478)
const lifetimeMs = Number(process.argv[3] ?? 60_000)
const sock = createSocket('udp4')

sock.on('message', (msg, from) => {
  if (msg.length < 20) return
  if (msg.readUInt16BE(0) !== BINDING_REQUEST) return
  if (msg.readUInt32BE(4) !== MAGIC) return

  // XOR-MAPPED-ADDRESS rather than the deprecated MAPPED-ADDRESS: the port and
  // address are xored with the magic cookie so that NATs rewriting payloads
  // they mistake for addresses cannot corrupt them in flight.
  const attr = Buffer.alloc(12)
  attr.writeUInt16BE(XOR_MAPPED_ADDRESS, 0)
  attr.writeUInt16BE(8, 2)
  attr.writeUInt8(0, 4)
  attr.writeUInt8(FAMILY_IPV4, 5)
  attr.writeUInt16BE(from.port ^ (MAGIC >>> 16), 6)
  const octets = from.address.split('.').map(Number)
  for (let i = 0; i < 4; i++) {
    attr.writeUInt8(octets[i] ^ ((MAGIC >>> (24 - 8 * i)) & 0xff), 8 + i)
  }

  const head = Buffer.alloc(20)
  head.writeUInt16BE(BINDING_SUCCESS, 0)
  head.writeUInt16BE(attr.length, 2)
  head.writeUInt32BE(MAGIC, 4)
  msg.copy(head, 8, 8, 20) // the transaction id, echoed back

  sock.send(Buffer.concat([head, attr]), from.port, from.address)
})

sock.bind(port, '0.0.0.0', () => console.log(`stun: listening on ${port}`))
setTimeout(() => { sock.close(); process.exit(0) }, lifetimeMs)
