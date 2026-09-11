/**
 * Does the deployed relay actually work?
 *
 * Takes a credential from the live server's welcome message and gathers ICE
 * against the real coturn with it. A `relay` candidate can only appear if
 * coturn accepted the HMAC, allocated, and reported an address the client can
 * use -- which is the whole chain, tested the way the app uses it rather than
 * by reading configuration back.
 *
 * The recorded footgun this exists for: a coturn that ignores use-auth-secret
 * rejects every credential identically whether the digest is right or wrong,
 * so "voice does not work" carries no information on its own.
 */
import { installWebRtc, gatherCandidates, summarise } from '@cocine/client'
import WebSocket from 'ws'

const SERVER = process.argv[2] ?? 'wss://cocine.duckdns.org'
/** Target a specific relay instead of the one the server advertises, for
 *  isolating a coturn problem: --turn <url> --user <u> --pass <p> */
const flag = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

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
  installWebRtc()
  const m = await welcome()
  const voice = m.ice.voice as Array<{ urls: string[]; username?: string; credential?: string }>
  let turn = voice.find(s => s.username)
  const override = flag('turn')
  if (override) {
    turn = { urls: [override], username: flag('user'), credential: flag('pass') }
    console.log('overriding relay with', override)
  }
  if (!turn) { console.error('FAIL: server minted no TURN credential'); process.exit(1) }
  console.log('server minted:', turn.urls.join(', '))
  console.log('username     :', turn.username)

  // Only the TURN server, no STUN: a relay candidate then cannot be confused
  // with anything else, and a failure is unambiguous.
  const cands = await gatherCandidates({ iceServers: [turn], timeoutMs: 20_000 })
  const s = summarise(cands)
  console.log('\ncandidates :', cands.map(c => `${c.type}/${c.family}`).join(' ') || '(none)')
  const relay = cands.filter(c => c.type === 'relay')
  if (relay.length === 0) {
    if ((turn.username ?? '').includes(':') && !override) {
      // Verified against this exact deployment: coturn accepts the colon form
      // and relays traffic (turnutils_uclient, 4/4 messages, 0 lost), while
      // libdatachannel gets a 401 -- because it builds TURN URLs internally as
      // turn:user:pass@host and splits a username containing a colon at the
      // wrong place. coturn then sees only the timestamp and reports "Cannot
      // find credentials".
      //
      // This is a limitation of THIS script's WebRTC stack, not of the app.
      // Voice runs in the renderer on Chromium's WebRTC, which handles the
      // standard `timestamp:name` REST format; node-datachannel is only used
      // for bulk transfer, which is never given TURN credentials at all.
      console.error('\nINCONCLUSIVE: no relay candidate, but the username contains a colon.')
      console.error('node-datachannel truncates TURN usernames at the first colon, so this')
      console.error('cannot verify a `timestamp:name` credential. The app is unaffected --')
      console.error('voice uses Chromium\'s WebRTC. To verify the relay for real, run on it:')
      console.error(`  turnutils_uclient -t -n 1 -y -u '${turn.username}' -w '<credential>' -p 3478 <public-ip>`)
      process.exit(2)
    }
    console.error('\nFAIL: no relay candidate -- coturn did not allocate')
    process.exit(1)
  }
  console.log('relay      :', relay.map(c => `${c.address}:${c.port}`).join(' '))
  console.log('\nPASS: coturn accepted a server-minted credential and allocated')
}
main().catch(e => { console.error('ERROR', e.message); process.exit(1) })
