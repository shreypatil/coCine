/**
 * A UDP peer, for asking a simulated network what it does.
 *
 * Plain JavaScript and nothing but `node:dgram`, because it is started inside a
 * network namespace once per assertion and a TypeScript loader would cost more
 * than the measurement.
 *
 *   node udp.mjs echo  <port> <ms>                     reply to whatever arrives
 *   node udp.mjs probe <port> <peer> <peerPort> <ms>   measure round trips
 *   node udp.mjs punch <port> <peer> <peerPort> <ms>   send and receive at once
 *
 * `punch` is the one that matters: both sides run it simultaneously, and
 * whether either receives anything is the whole question a NAT poses. It keeps
 * sending for the full duration rather than stopping at the first packet --
 * an earlier version stopped, and so stopped punching before the other side's
 * mapping existed, which looked exactly like a NAT that had blocked it.
 */
import { createSocket } from 'node:dgram'

const [mode, portArg, ...rest] = process.argv.slice(2)
const port = Number(portArg)
const sock = createSocket('udp4')
const received = []
const rtts = []
let sent = 0

const done = (ok) => {
  const summary = { mode, sent, received: received.length }
  if (rtts.length > 0) {
    const sorted = [...rtts].sort((a, b) => a - b)
    summary.rttMsMin = Number(sorted[0].toFixed(2))
    summary.rttMsMedian = Number(sorted[Math.floor(sorted.length / 2)].toFixed(2))
    summary.rttMsMax = Number(sorted[sorted.length - 1].toFixed(2))
    summary.samples = sorted.length
  }
  if (received.length > 0) summary.firstFrom = received[0]
  console.log(JSON.stringify(summary))
  process.exit(ok ? 0 : 1)
}

if (mode === 'echo') {
  const ms = Number(rest[0])
  sock.on('message', (msg, from) => { received.push(`${from.address}:${from.port}`); sock.send(msg, from.port, from.address) })
  sock.bind(port)
  setTimeout(() => done(true), ms)
} else {
  const [peer, peerPortArg, msArg] = rest
  const peerPort = Number(peerPortArg)
  const ms = Number(msArg)
  sock.on('message', msg => {
    received.push('peer')
    if (mode === 'probe' && msg.length >= 8) {
      // The packet carries the time it left, so the round trip needs no clock
      // agreement between the two namespaces.
      rtts.push(Number(process.hrtime.bigint() - msg.readBigUInt64LE(0)) / 1e6)
    }
  })
  sock.bind(port, () => {
    const tick = setInterval(() => {
      const buf = Buffer.alloc(8)
      buf.writeBigUInt64LE(process.hrtime.bigint())
      sock.send(buf, peerPort, peer, () => {})
      sent++
    }, 100)
    setTimeout(() => { clearInterval(tick); done(received.length > 0) }, ms)
  })
}
