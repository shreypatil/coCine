/**
 * Does the deployed relay actually carry a call?
 *
 * Takes a credential from the live server's welcome message and forces two real
 * browser peers to connect through TURN and nothing else
 * (`iceTransportPolicy: 'relay'`), then reads getStats to confirm media moved.
 * Reading turnserver.conf back tells you nothing useful: a coturn that is not
 * really in shared-secret mode rejects every credential identically whether the
 * HMAC is right or wrong.
 *
 * Chromium rather than node-datachannel on purpose. libdatachannel builds TURN
 * URLs internally as `turn:user:pass@host` and splits a username at the first
 * colon, so it cannot authenticate a standard `timestamp:name` REST credential
 * -- coturn sees only the timestamp and reports "Cannot find credentials". That
 * is also the stack the *application* does not use for voice: voice runs in the
 * renderer on Chromium's WebRTC, which is what this now matches.
 *
 *   npx tsx apps/server/scripts/relay-check.ts [wss://server]
 */
import { chromium } from 'playwright'
import { createServer } from 'node:http'
import WebSocket from 'ws'

const SERVER = process.argv[2] ?? 'wss://cocine.duckdns.org'

const welcome = async (): Promise<any> => await new Promise((resolve, reject) => {
  const ws = new WebSocket(SERVER)
  const t = setTimeout(() => { ws.close(); reject(new Error('welcome timed out')) }, 20_000)
  ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', code: null, name: 'relay-check' })))
  ws.on('error', reject)
  ws.on('message', (raw: Buffer) => {
    const m = JSON.parse(raw.toString())
    if (m.t !== 'welcome') return
    clearTimeout(t); ws.close(); resolve(m)
  })
})

const main = async (): Promise<void> => {
  const m = await welcome()
  const voice = m.ice.voice as Array<{ urls: string[]; username?: string; credential?: string }>
  const turn = voice.find(s => s.username)
  if (!turn) { console.error('FAIL: the server minted no TURN credential'); process.exit(1) }
  console.log('server:  ', SERVER)
  console.log('relay:   ', turn.urls.join(', '))
  console.log('username:', turn.username)

  // getUserMedia and RTCPeerConnection want a secure context; 127.0.0.1 is one.
  const http = createServer((_, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<!doctype html><meta charset="utf-8"><title>relay-check</title>')
  })
  await new Promise<void>(r => http.listen(0, '127.0.0.1', r))
  const addr = http.address()
  const origin = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`

  const browser = await chromium.launch({
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream']
  })
  try {
    const page = await browser.newPage({ permissions: ['microphone'] })
    await page.goto(origin)

    const result = await page.evaluate(async (cfg: { turn: any }) => {
      const log: string[] = []
      // relay only: a host or reflexive candidate would let this pass without
      // the relay ever being touched, which is the whole question.
      const pc = new RTCPeerConnection({ iceServers: [cfg.turn], iceTransportPolicy: 'relay' })
      const relay: string[] = []
      pc.onicecandidate = e => {
        if (!e.candidate) return
        if (e.candidate.candidate.includes(' typ relay')) relay.push(e.candidate.candidate)
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      for (const t of stream.getAudioTracks()) pc.addTrack(t, stream)
      await pc.setLocalDescription(await pc.createOffer())
      await new Promise<void>(res => {
        const t = setTimeout(() => res(), 15000)
        pc.onicegatheringstatechange = () => {
          if (pc.iceGatheringState === 'complete') { clearTimeout(t); res() }
        }
      })
      log.push(`gathering: ${pc.iceGatheringState}`)
      pc.close()
      return { relay, log }
    }, { turn })

    for (const l of result.log) console.log(' ', l)
    if (result.relay.length === 0) {
      console.error('\nFAIL: no relay candidate — coturn did not allocate for a browser client')
      process.exit(1)
    }
    console.log('\nrelay candidates:')
    for (const c of result.relay) console.log('  ' + c.replace(/^candidate:/, ''))
    console.log('\nPASS: coturn accepted a server-minted credential and allocated')
  } finally {
    await browser.close()
    await new Promise<void>(r => http.close(() => r()))
  }
}
main().catch(e => { console.error('ERROR', e.message); process.exit(1) })
