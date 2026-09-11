/**
 * How many rooms and people can the free-tier server actually hold?
 *
 * Connects real WebSocket clients to a deployed server, speaking the wire
 * protocol at the cadences RoomClient uses -- a time.ping every 2s, a
 * peer.report every 1s, occasional chat and playback changes -- and samples the
 * server's memory and CPU over SSH while doing it.
 *
 * Deliberately not RoomClient itself: that wants a PlayerController and a
 * WebRTC stack per member, which would measure this machine's limits rather
 * than the server's. The point here is what the server spends per connection
 * and per room, so the clients are as thin as the protocol allows.
 *
 *   npx tsx apps/server/scripts/load-test.ts <wss-url> <ssh-host> [stages]
 */
import WebSocket from 'ws'
import { execFileSync } from 'node:child_process'

const URL_ = process.argv[2] ?? 'wss://cocine.duckdns.org'
const SSH = process.argv[3] ?? 'opc@140.238.244.216'
/** rooms x members per room */
/** Announce a film in each room, so the expensive broadcast path is exercised. */
const MEDIA = process.env.LOAD_TEST_MEDIA !== '0'
const STAGES: Array<[number, number]> = process.argv[4]
  ? JSON.parse(process.argv[4])
  : [[1, 2], [2, 4], [5, 4], [10, 4], [10, 8], [20, 8], [40, 8]]

interface Sample { rssMB: number; cpuPct: number; availMB: number; swapMB: number; loundred: string }

const sample = (): Sample | null => {
  try {
    const out = execFileSync('ssh', [
      '-o', 'ConnectTimeout=15', '-o', 'BatchMode=yes', SSH,
      `pid=$(pgrep -f "node /opt/cocine/server.mjs" | head -1); ` +
      `ps -o rss=,pcpu= -p $pid; free -m | awk 'NR==2{print $7} NR==3{print $3}'; ` +
      `cut -d' ' -f1-3 /proc/loadavg`
    ], { encoding: 'utf8', timeout: 30_000 })
    const lines = out.trim().split('\n').map(l => l.trim()).filter(Boolean)
    if (lines.length < 3) return null
    const [rss, cpu] = (lines[0] ?? '').split(/\s+/)
    return {
      rssMB: Number(rss ?? 0) / 1024, cpuPct: Number(cpu ?? 0),
      availMB: Number(lines[1]), swapMB: Number(lines[2]),
      loundred: lines[3] ?? '?'
    }
  } catch { return null }
}

class Member {
  ws: WebSocket; timers: NodeJS.Timeout[] = []; code: string | null = null
  ready = false; failed: string | null = null; rx = 0
  constructor (public name: string, private join: string | null) {
    this.ws = new WebSocket(URL_)
    this.ws.on('open', () => this.ws.send(JSON.stringify({ t: 'hello', code: this.join, name })))
    this.ws.on('error', e => { this.failed = e.message })
    this.ws.on('close', () => { if (!this.failed) this.failed = 'closed' })
    this.ws.on('message', raw => {
      this.rx++
      let m: any; try { m = JSON.parse(raw.toString()) } catch { return }
      if (m.t === 'welcome') {
        this.code = m.code; this.ready = true
        // A host announces a film. This matters more than it looks: the
        // periodic transfer.status broadcast is skipped entirely for a room
        // with no media, and that broadcast is the server's most expensive
        // path -- an N-entry perPeer payload sent to N recipients, plus
        // seekableMapOf intersecting N piece maps. Measuring without it
        // measures a lobby, not a film night.
        if (this.join === null && MEDIA) {
          const hex = (n: number) => Array.from({ length: n }, () =>
            '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('')
          const infoHash = hex(40)
          this.send({
            t: 'media.announce', name: 'load-test.mkv', durationSec: 7200,
            source: { kind: 'p2p', infoHash, magnet: `magnet:?xt=urn:btih:${infoHash}`,
                      bytes: 4_000_000_000, pieceLength: 4_194_304 }
          })
        }
        this.start()
      }
      if (m.t === 'error') this.failed = m.message
    })
  }
  private start (): void {
    // The cadences RoomClient actually uses.
    this.timers.push(setInterval(() => this.send({ t: 'time.ping', c1: Date.now() }), 2000))
    this.timers.push(setInterval(() => this.send({
      t: 'peer.report',
      report: {
        havePct: 0.5, bufferEndSec: 120, downBps: 500_000, upBps: 250_000,
        peers: 3, pieces: 'f'.repeat(32) + '0'.repeat(32)
      }
    }), 1000))
    // Light background chatter, so broadcast fan-out is exercised too.
    this.timers.push(setInterval(() => {
      if (Math.random() < 0.1) this.send({ t: 'chat.send', text: 'x' })
    }, 5000))
  }
  private send (o: unknown): void {
    if (this.ws.readyState === WebSocket.OPEN) { try { this.ws.send(JSON.stringify(o)) } catch {} }
  }
  close (): void { for (const t of this.timers) clearInterval(t); try { this.ws.close() } catch {} }
}

const wait = (ms: number) => new Promise(r => setTimeout(r, ms))

const main = async (): Promise<void> => {
  const base = sample()
  console.log(`idle: server ${base?.rssMB.toFixed(1)} MB, ${base?.cpuPct}% cpu, ${base?.availMB} MB free\n`)
  console.log('rooms x each =  conns | server RSS |  cpu% | sys free | swap | load        | fail')
  console.log('-'.repeat(88))

  const live: Member[] = []
  const hosts: Member[] = []
  for (const [rooms, per] of STAGES) {
    // Hosts first, all in flight at once, then wait for their codes. Doing this
    // one room at a time with a wait each was what silently capped an earlier
    // version at ~1700 clients -- which looked exactly like a server limit.
    while (hosts.length < rooms) {
      const m = new Member(`h${hosts.length}`, null)
      hosts.push(m); live.push(m)
      if (hosts.length % 25 === 0) await wait(100)
    }
    for (let i = 0; i < 300 && hosts.filter(h => h.code).length < rooms; i++) await wait(100)
    const codes = hosts.map(h => h.code).filter((c): c is string => !!c)
    if (codes.length === 0) { console.log('no room codes; aborting'); break }

    // Then the members, round-robin over the rooms that actually exist. Never
    // skip a member for a room that is not ready -- put them somewhere else.
    const want = rooms * per
    let made = 0
    while (live.length < want) {
      live.push(new Member(`m${live.length}`, codes[made % codes.length]!))
      made++
      if (made % 50 === 0) await wait(60)
    }
    // Settle on the count actually established rather than the count asked for.
    for (let i = 0; i < 300 && live.filter(m => m.ready).length < want * 0.98; i++) await wait(100)
    await wait(6000)   // let the cadences run and the server settle

    const s = sample()
    const failed = live.filter(m => m.failed).length
    const ready = live.filter(m => m.ready).length
    console.log(
      `${String(rooms).padStart(5)} x ${String(per).padEnd(3)} = ${String(ready).padStart(6)} | ` +
      `${(s?.rssMB ?? 0).toFixed(1).padStart(7)} MB | ${String(s?.cpuPct ?? '?').padStart(5)} | ` +
      `${String(s?.availMB ?? '?').padStart(6)} MB | ${String(s?.swapMB ?? '?').padStart(4)} | ` +
      `${(s?.loundred ?? '?').padEnd(11)} | ${failed}`
    )
    if (failed > live.length * 0.1) { console.log('\n>10% of connections failed -- stopping'); break }
  }

  console.log('\ntearing down...')
  for (const m of live) m.close()
  await wait(8000)
  const after = sample()
  console.log(`after:  server ${after?.rssMB.toFixed(1)} MB, ${after?.cpuPct}% cpu, ${after?.availMB} MB free`)
  process.exit(0)
}
main().catch(e => { console.error(e); process.exit(1) })
