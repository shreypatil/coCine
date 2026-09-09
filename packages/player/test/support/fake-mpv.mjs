#!/usr/bin/env node
/**
 * A stand-in for mpv that speaks its JSON IPC protocol and nothing else.
 *
 * MpvIpc is the most latency-critical path in the application and the one place
 * a framing bug would be invisible: newline-delimited JSON arriving over a
 * socket does not respect message boundaries, so a response can be split across
 * two reads, several can share one, and a malformed line can appear between
 * good ones. Real mpv produces those situations only under load and never on
 * demand, which is why they were untested.
 *
 * This produces them on demand. The test drives it by sending commands whose
 * name begins with `__`; everything else is answered like mpv would answer it.
 *
 * Started by MpvIpc exactly as mpv is, so the socket path, the connect retry
 * and the process lifecycle are all the real ones. It is executable with a
 * shebang rather than run as `node fake-mpv.mjs`, because MpvIpc puts
 * `--input-ipc-server` first in the argument list -- correct for mpv, and a
 * flag node itself would reject before ever reaching this file.
 */
import { createServer } from 'node:net'

const socketArg = process.argv.find(a => a.startsWith('--input-ipc-server='))
if (!socketArg) {
  process.stderr.write('fake-mpv: no --input-ipc-server\n')
  process.exit(2)
}
const path = socketArg.slice('--input-ipc-server='.length)
const mode = process.env.FAKE_MPV_MODE ?? 'normal'

// A failure before the socket ever exists, which is how a real mpv fails when
// it cannot open a display or cannot find a codec.
if (mode === 'exit-before-ipc') {
  process.stderr.write('fake mpv: could not open display\n')
  process.exit(3)
}

const ok = (id, data) => `${JSON.stringify({ request_id: id, error: 'success', data })}\n`
const sleep = ms => new Promise(r => setTimeout(r, ms))

const server = createServer(sock => {
  sock.setNoDelay(true)

  const handle = async msg => {
    const id = msg.request_id
    const [name, ...rest] = msg.command ?? []

    switch (name) {
      // One response, delivered a byte at a time. If MpvIpc buffered per read
      // rather than per newline, this would never resolve.
      case '__split': {
        const text = ok(id, 'reassembled')
        for (const ch of text) { sock.write(ch); await sleep(1) }
        return
      }

      // Several complete messages in a single write, which is what a busy mpv
      // actually does. A parser that handled one message per read would drop
      // all but the first.
      case '__burst': {
        sock.write(
          `${JSON.stringify({ event: 'file-loaded' })}\n` +
          `${JSON.stringify({ event: 'playback-restart' })}\n` +
          ok(id, 'after events')
        )
        return
      }

      // Junk in the stream: a blank line, a line that is not JSON at all, and a
      // response for a request that was never made. None of them may stop the
      // real response arriving.
      case '__garbage': {
        sock.write('\n')
        sock.write('this is not json at all\n')
        sock.write('   \n')
        sock.write(`${JSON.stringify({ request_id: 999999, error: 'success', data: 'nobody asked' })}\n`)
        sock.write(ok(id, 'survived'))
        return
      }

      // mpv's own failure shape: a request_id with an error that is not
      // 'success'.
      case '__fail':
        sock.write(`${JSON.stringify({ request_id: id, error: 'property not found' })}\n`)
        return

      // Never answered, so the caller's promise is still outstanding. Used to
      // check that closing rejects rather than leaking a pending promise.
      case '__silent':
        return

      // An unsolicited event, which is how mpv reports everything the
      // application did not ask for.
      case '__event':
        sock.write(`${JSON.stringify({ event: rest[0] ?? 'pause', data: rest[1] ?? null })}\n`)
        sock.write(ok(id, null))
        return

      // A property-change event with an exact id and payload. Real mpv only
      // produces these as a consequence of playing something, so the shapes
      // that matter most -- a null where a number is expected -- cannot be
      // asked for directly there.
      case '__prop':
        sock.write(`${JSON.stringify({
          event: 'property-change',
          id: rest[0],
          data: rest[1] === undefined ? null : rest[1]
        })}\n`)
        sock.write(ok(id, null))
        return

      case 'quit':
        sock.write(ok(id, null))
        setTimeout(() => process.exit(0), 5)
        return

      case 'get_property':
        sock.write(ok(id, rest[0] === 'time-pos' ? 12.5 : `value-of-${rest[0]}`))
        return

      default:
        sock.write(ok(id, null))
    }
  }

  let buf = ''
  sock.on('data', chunk => {
    buf += String(chunk)
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line) continue
      try { void handle(JSON.parse(line)) } catch { /* the test is asserting something else */ }
    }
  })
  sock.on('error', () => { /* the client went away */ })
})

server.on('error', err => {
  process.stderr.write(`fake-mpv: ${err.message}\n`)
  process.exit(4)
})

// A slow start, so the connect-retry loop in MpvIpc.start() is exercised rather
// than always succeeding first time.
const delay = Number(process.env.FAKE_MPV_LISTEN_DELAY_MS ?? 0)
setTimeout(() => server.listen(path), delay)
