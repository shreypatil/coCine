/**
 * Phase B1.0 exit criteria, as an executable check.
 *
 * Phases 0 and 1 already cover control fidelity and room-wide drift, and both
 * are runnable against the candidate player directly:
 *
 *     npm run phase0:html      command latency, seek accuracy, rate control
 *     npm run phase1:html      five peers against the 100 ms budget
 *
 * This covers the two questions those cannot answer, both of which would
 * invalidate B1 if they failed:
 *
 *   decode   -- does a 4K film play without dropping frames, or is Chromium
 *               decoding in software and losing?
 *   stalling -- what does <video> do when the torrent stream server blocks on a
 *               piece that has not arrived? mpv's behaviour there is known.
 *               Recovering is required; stalling for ever is a blocker.
 *
 * Run: npm run b1-gate
 */
import { mkdtempSync, rmSync, existsSync, mkdirSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HtmlVideoPlayer, shutdownVideoHost } from '@cocine/player'
import { FilmStore, TransferManager } from '@cocine/client'
import type { P2PSource } from '@cocine/protocol'
import { SignallingServer } from '../src/server.js'

/** Frames may be dropped while a decoder warms up; a steady loss is the fault. */
const DROP_TOLERANCE = 0.02
const PLAY_SEC = 10

const report = (name: string, ok: boolean, detail: string): boolean => {
  console.log(`  ${ok ? '✓' : '✗'} ${name.padEnd(30)} ${detail}`)
  return ok
}

async function until (
  cond: () => boolean, what: string, ms: number
): Promise<void> {
  const deadline = Date.now() + ms
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise(r => setTimeout(r, 50))
  }
}

/** Play a file and report how much of it actually reached the screen. */
async function decodeGate (label: string, file: string, results: boolean[]): Promise<void> {
  if (!existsSync(file)) {
    results.push(report(label, false, `missing ${file} — see the header of this script`))
    return
  }
  const p = new HtmlVideoPlayer()
  let mediaError: string | null = null
  p.on('warning', (m: string) => { mediaError = m })
  await p.start()
  await p.load(file)
  await p.play()

  const t0 = Date.now()
  await new Promise(r => setTimeout(r, PLAY_SEC * 1000))
  const advanced = p.position()
  const wall = (Date.now() - t0) / 1000
  const q = p.playbackQuality()
  await p.close()

  if (mediaError) {
    results.push(report(label, false, `media error: ${mediaError as string}`))
    return
  }
  const dropped = q && q.total > 0 ? q.dropped / q.total : 1
  // Playing in real time matters as much as not dropping: a decoder that
  // cannot keep up stalls rather than skipping, and the position stops
  // advancing while the frame counter stays clean.
  const realtime = advanced / wall
  const ok = q !== null && q.total > 0 && dropped <= DROP_TOLERANCE && realtime > 0.9
  results.push(report(label, ok,
    `${q?.total ?? 0} frames · ${(dropped * 100).toFixed(2)} % dropped · ` +
    `${realtime.toFixed(2)}x real time · target < ${DROP_TOLERANCE * 100}% and ≥ 0.9x`))
}

/**
 * Point the player at a film that is still arriving, and see what it does when
 * it runs past the end of what has been downloaded.
 *
 * The whole product rests on this: the stream server blocks rather than
 * returning zeros, and a player that treats a slow response as a fatal error --
 * or that never recovers once stalled -- cannot be used to watch a film while
 * it downloads.
 */
async function stallGate (results: boolean[]): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'cocine-b1-'))
  const server = new SignallingServer({})
  const port = await server.listen()
  const trackerUrl = `ws://127.0.0.1:${port}/announce`
  const peers: TransferManager[] = []
  const p = new HtmlVideoPlayer()

  try {
    // A film big enough that a shaped receiver cannot finish it before the
    // player reaches the end of what has arrived.
    const seedDir = join(root, 'seed')
    const filmPath = join(seedDir, 'film.mp4')
    // A real encoded film rather than random bytes: the player has to decode
    // what the swarm delivers, which is the whole point of the check.
    const source4k = join(process.cwd(), '.fixtures', '4k-hevc-15s.mp4')
    if (!existsSync(source4k)) {
      results.push(report('recovers from a missing piece', false, 'missing .fixtures/4k-hevc-15s.mp4'))
      return
    }
    mkdirSync(seedDir, { recursive: true })
    copyFileSync(source4k, filmPath)

    const seeder = new TransferManager({
      store: new FilmStore(join(seedDir, 'films')), trackerUrl, webrtcOnly: true, iceServers: []
    })
    peers.push(seeder)
    const shared = await seeder.share(filmPath) as P2PSource
    server.tracker.allow(shared.infoHash)

    // Shaped hard, so the film genuinely arrives more slowly than it plays and
    // the player is forced past the downloaded edge rather than merely near it.
    const receiver = new TransferManager({
      store: new FilmStore(join(root, 'recv', 'films')),
      trackerUrl, webrtcOnly: true, iceServers: [], downloadLimitBps: 1_200_000
    })
    peers.push(receiver)
    await receiver.receive(shared)
    await until(
      () => (receiver.get(shared.infoHash)?.progress ?? 0) > 0.01,
      'the first pieces', 90_000
    )

    const url = receiver.streamUrl(shared.infoHash)
    if (!url) { results.push(report('streams while downloading', false, 'no stream URL')); return }

    let mediaError: string | null = null
    p.on('warning', (m: string) => { mediaError = m })
    await p.start()
    await p.load(url)
    await p.play()

    // The property under test is stall-then-recover, not "never stalls".
    // Stalling is correct when the bytes are not there yet; never resuming once
    // they arrive is the failure that would sink B1. So watch until the film
    // ends or the download finishes and it has had a chance to catch up.
    const duration = p.duration() ?? 15
    const deadline = Date.now() + 150_000
    let last = p.position()
    let stalledFor = 0
    let longestStall = 0
    let resumedAfterStall = false
    let sawStall = false

    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 500))
      const now = p.position()
      if (now - last < 0.01) {
        stalledFor += 0.5
        longestStall = Math.max(longestStall, stalledFor)
        if (stalledFor >= 1.5) sawStall = true
      } else {
        // Advancing again after having been stuck is the recovery this exists
        // to prove.
        if (sawStall && stalledFor > 0) resumedAfterStall = true
        stalledFor = 0
      }
      last = now
      if (mediaError) break
      // Reaching the end is a pass regardless of how it got there.
      if (now >= duration - 0.6) break
    }

    const progress = receiver.get(shared.infoHash)?.progress ?? 0
    const reachedEnd = last >= duration - 0.6
    // Either it played through, or it stalled for want of bytes and then picked
    // up again once they arrived. Stalling and never resuming is the blocker.
    const ok = !mediaError && (reachedEnd || (sawStall && resumedAfterStall))
    results.push(report('recovers from a missing piece', ok,
      mediaError
        ? `media error: ${mediaError as string}`
        : `reached ${last.toFixed(1)}s of ${duration.toFixed(1)}s · ` +
          `longest stall ${longestStall.toFixed(1)}s · ` +
          `${sawStall ? (resumedAfterStall ? 'stalled then resumed' : 'stalled and did NOT resume') : 'never stalled'} · ` +
          `${(progress * 100).toFixed(0)}% downloaded`))
  } finally {
    await p.close().catch(() => {})
    for (const t of peers) await t.destroy().catch(() => {})
    await server.close().catch(() => {})
    rmSync(root, { recursive: true, force: true })
  }
}

const main = async (): Promise<void> => {
  console.log(`\n  Phase B1.0 — is a <video> element good enough to build on?\n  ${'─'.repeat(66)}`)
  console.log('  Control fidelity and room drift: npm run phase0:html · npm run phase1:html\n')
  const results: boolean[] = []

  await decodeGate('4K H.264 decode', join(process.cwd(), '.fixtures', '4k-h264-15s.mp4'), results)
  await decodeGate('4K HEVC decode', join(process.cwd(), '.fixtures', '4k-hevc-15s.mp4'), results)
  await stallGate(results)

  await shutdownVideoHost()
  const passed = results.every(Boolean)
  console.log(`  ${'─'.repeat(66)}\n  ${passed ? 'PASS' : 'FAIL'} — B1.0 ${passed ? 'criteria met' : 'criteria NOT met'}\n`)
  process.exit(passed ? 0 : 1)
}

main().catch(async e => {
  console.error(e)
  // Never leave the Electron host or a swarm running behind a failure.
  await shutdownVideoHost().catch(() => {})
  process.exit(1)
})
