/** Standalone signalling server for manual testing. `npm run server` */
import { SignallingServer } from '../src/server.js'
import type { TurnConfig } from '../src/turn.js'

const port = Number(process.env.PORT ?? 8787)

/**
 * A TURN relay is optional. Without one, two people whose routers both refuse
 * direct connections simply cannot hear each other -- roughly one pairing in ten
 * on home connections, and far more behind corporate or carrier-grade NAT.
 *
 * COCINE_TURN_URLS  comma separated, e.g. turn:relay.example:3478,turns:relay.example:443
 * COCINE_TURN_SECRET  the same string as static-auth-secret in turnserver.conf
 */
function turnFromEnv (): TurnConfig | undefined {
  const urls = (process.env.COCINE_TURN_URLS ?? '').split(',').map(s => s.trim()).filter(Boolean)
  const secret = process.env.COCINE_TURN_SECRET ?? ''
  if (urls.length === 0 && !secret) return undefined
  // Half a configuration is worse than none: it looks configured and silently
  // hands out credentials nothing will accept.
  if (urls.length === 0 || !secret) {
    console.error('\n  COCINE_TURN_URLS and COCINE_TURN_SECRET must be set together; starting without a relay.\n')
    return undefined
  }
  const ttl = Number(process.env.COCINE_TURN_TTL_SECONDS ?? '')
  return { secret, urls, ...(Number.isFinite(ttl) && ttl > 0 ? { ttlSeconds: ttl } : {}) }
}

const turn = turnFromEnv()
const server = new SignallingServer({ port, log: m => console.log(`  ${m}`), ...(turn ? { turn } : {}) })
try {
  await server.listen()
} catch (err) {
  // A bare stack trace here sends people hunting through the code for a bug that
  // is really "something else is already on this port".
  const code = (err as NodeJS.ErrnoException).code
  if (code === 'EADDRINUSE') {
    console.error(`\n  Port ${port} is already in use -- another coCine server is probably running.`)
    console.error(`  Stop it, or start this one elsewhere:  PORT=${port + 1} npm run server\n`)
  } else if (code === 'EACCES') {
    console.error(`\n  Not allowed to bind port ${port}. Ports below 1024 need elevated privileges.\n`)
  } else {
    console.error(`\n  Could not start the server: ${String(err)}\n`)
  }
  process.exit(1)
}

console.log(`\n  coCine signalling on ws://127.0.0.1:${port}`)
console.log(turn
  ? `  voice relay: ${turn.urls.join(', ')} (bulk transfer is never relayed)`
  : '  voice relay: none -- peers behind strict NAT will fail to connect')
console.log('  press ctrl-c to stop\n')

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => { void server.close().then(() => process.exit(0)) })
}
