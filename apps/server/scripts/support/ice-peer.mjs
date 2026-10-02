/**
 * One end of a peer connection, for asking a simulated network whether two
 * machines can reach each other.
 *
 * The stack is the shipping one -- `node-datachannel/polyfill` is exactly what
 * `installWebRtc()` installs -- so what this measures is libdatachannel's real
 * ICE against a real kernel's real NAT. What it deliberately does not involve
 * is the signalling server: the two ends exchange their descriptions through a
 * directory, because the question here is only whether a path exists, and
 * putting a room, a roster and a playback authority in the way would mean a
 * failure had several possible causes instead of one.
 *
 *   node ice-peer.mjs <offer|answer> <sigDir> <iceServersJson> <budgetMs>
 *
 * Prints one JSON line: whether it connected, how long it took, and which kinds
 * of candidate each side offered.
 *
 * Plain JavaScript because it is spawned once per arm per pairing, and a
 * TypeScript loader costs a second of startup every time.
 */
import { createRequire } from 'node:module'
import { createSocket } from 'node:dgram'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [role, sigDir, iceJson, budgetArg] = process.argv.slice(2)
const budgetMs = Number(budgetArg ?? 15000)
const iceServers = JSON.parse(iceJson ?? '[]')

const require = createRequire(import.meta.url)
const { RTCPeerConnection } = require('node-datachannel/polyfill')

/**
 * Do not start ICE until the STUN server is actually answering.
 *
 * Starting on a fixed delay and hoping is how this harness produced its own
 * false negatives: under the load of a fifteen-pairing run, the responder
 * occasionally had not finished binding when the first binding request went
 * out, the peer gathered host candidates only, and a pairing that connects ten
 * times out of ten in isolation was reported as failing. A measurement tool
 * that is less reliable than the thing it measures is worse than no tool, so
 * the wait is on the server answering rather than on a guess about how long it
 * takes to start.
 */
async function awaitStun (servers, timeoutMs = 8000) {
  const url = servers.flatMap(s => (Array.isArray(s.urls) ? s.urls : [s.urls]))
    .find(u => typeof u === 'string' && u.startsWith('stun:'))
  if (!url) return // no STUN configured: host candidates are all there is to gather
  const [host, port] = url.slice('stun:'.length).split(':')
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const answered = await new Promise(resolve => {
      const sock = createSocket('udp4')
      const done = (ok) => { try { sock.close() } catch { /* already closed */ } resolve(ok) }
      const timer = setTimeout(() => done(false), 300)
      sock.on('message', () => { clearTimeout(timer); done(true) })
      sock.on('error', () => { clearTimeout(timer); done(false) })
      // A binding request: type 0x0001, no attributes, magic cookie, random id.
      const req = Buffer.alloc(20)
      req.writeUInt16BE(0x0001, 0)
      req.writeUInt16BE(0, 2)
      req.writeUInt32BE(0x2112a442, 4)
      for (let i = 8; i < 20; i++) req.writeUInt8(Math.floor(Math.random() * 256), i)
      sock.send(req, Number(port ?? 3478), host, err => { if (err) { clearTimeout(timer); done(false) } })
    })
    if (answered) return
  }
  // Falling through is deliberate: a pairing with no STUN still tells us
  // something, and the candidate kinds in the report will show what was missing.
}

let exchangedAt = null
let gaveUp = false
const mine = role === 'offer' ? 'offer' : 'answer'
const theirs = role === 'offer' ? 'answer' : 'offer'
mkdirSync(sigDir, { recursive: true })

await awaitStun(iceServers)
const pc = new RTCPeerConnection({ iceServers })
let connectedAt = null

const report = (extra = {}) => {
  console.log(JSON.stringify({
    role,
    connected: connectedAt !== null,
    // Measured from the moment both descriptions were in hand, which is when
    // ICE can first do anything. Timing from process start would instead report
    // how long the two ends took to swap SDP through a directory, which is an
    // artefact of this harness and not a property of the network.
    ms: connectedAt === null || exchangedAt === null ? null : connectedAt - exchangedAt,
    local: kinds(pc.localDescription?.sdp),
    remote: kinds(pc.remoteDescription?.sdp),
    iceConnectionState: pc.iceConnectionState,
    /** True when ICE exhausted its checks, as opposed to the budget running out. */
    gaveUp,
    ...extra
  }))
  process.exit(connectedAt === null ? 1 : 0)
}

/** The candidate types in an SDP, which is how a relayed path announces itself. */
const kinds = (sdp) => [...new Set(
  (sdp ?? '').split('\n').filter(l => l.includes('candidate:'))
    .map(l => (l.match(/ typ (\w+)/) ?? [])[1]).filter(Boolean)
)].sort().join(',')

pc.addEventListener('connectionstatechange', () => {
  if (pc.connectionState === 'connected' && connectedAt === null) connectedAt = Date.now()
  // ICE declaring `failed` is a real answer and a terminal one, so waiting out
  // the rest of the budget would only make a fifteen-pairing matrix slower
  // without making it truer. Recorded separately from a timeout, because "ICE
  // gave up" and "we stopped asking" are different findings.
  if (pc.connectionState === 'failed') gaveUp = true
})

/**
 * Wait for gathering to finish.
 *
 * Three ways out, because libdatachannel does not reliably deliver the null
 * end-of-candidates event through the polyfill and waiting for one costs the
 * full timeout on every peer -- twenty seconds a pairing, which is most of a
 * matrix run. `complete` is not the signal either: measured against
 * libdatachannel, the state flips and the server-reflexive candidate arrives
 * immediately afterwards in the same millisecond, so the state starts a short
 * drain rather than ending the gather. This mirrors `gatherCandidates` in
 * packages/client, which learnt the same thing the same way.
 */
const gathered = () => new Promise(resolve => {
  let drain = null
  const cap = setTimeout(finish, 4000)
  if (cap.unref) cap.unref()
  function finish () { clearTimeout(cap); if (drain) clearTimeout(drain); resolve() }
  function startDrain () { if (drain) return; drain = setTimeout(finish, 300); if (drain.unref) drain.unref() }
  pc.addEventListener('icecandidate', e => { if (e.candidate === null) finish() })
  pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') startDrain() })
  if (pc.iceGatheringState === 'complete') startDrain()
})

/** Written to a temporary name and renamed, so the other end never reads half a description. */
const publish = (name, value) => {
  const tmp = join(sigDir, `.${name}.tmp`)
  writeFileSync(tmp, JSON.stringify(value))
  renameSync(tmp, join(sigDir, `${name}.json`))
}

const collect = async (name) => {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    try { return JSON.parse(readFileSync(join(sigDir, `${name}.json`), 'utf8')) } catch { /* not yet */ }
    await new Promise(r => setTimeout(r, 100))
  }
  report({ error: `no ${name} description arrived` })
}

if (role === 'offer') {
  pc.createDataChannel('probe')
  await pc.setLocalDescription(await pc.createOffer())
  await gathered()
  publish(mine, pc.localDescription)
  await pc.setRemoteDescription(await collect(theirs))
} else {
  await pc.setRemoteDescription(await collect(theirs))
  await pc.setLocalDescription(await pc.createAnswer())
  await gathered()
  publish(mine, pc.localDescription)
}
exchangedAt = Date.now()
if (connectedAt !== null) connectedAt = exchangedAt

// Checks run until they succeed or the budget runs out. Exiting the moment the
// connection comes up is what keeps a fifteen-pairing matrix to a few minutes.
const deadline = Date.now() + budgetMs
while (connectedAt === null && !gaveUp && Date.now() < deadline) await new Promise(r => setTimeout(r, 100))
report()
