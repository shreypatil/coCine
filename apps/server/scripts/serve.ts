/** Standalone signalling server for manual testing. `npm run server` */
import { SignallingServer } from '../src/server.js'
import { setupLogging } from '@cocine/logging'
import type { TurnConfig } from '../src/turn.js'
import type { OriginConfig } from '../src/origin.js'

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

/**
 * Object storage for relay mode. Optional: without it the host is offered no
 * P2P-or-relay toggle at all, rather than one that fails when pressed.
 *
 * COCINE_R2_ENDPOINT   https://<account>.r2.cloudflarestorage.com
 * COCINE_R2_BUCKET     bucket name
 * COCINE_R2_KEY_ID / COCINE_R2_SECRET   an R2 API token's credentials
 *
 * R2 is the intended target because its egress is free; the same variables work
 * against MinIO or S3, which speak the same API.
 */
function originFromEnv (): OriginConfig | undefined {
  const endpoint = process.env.COCINE_R2_ENDPOINT ?? ''
  const bucket = process.env.COCINE_R2_BUCKET ?? ''
  const accessKeyId = process.env.COCINE_R2_KEY_ID ?? ''
  const secretAccessKey = process.env.COCINE_R2_SECRET ?? ''
  const given = [endpoint, bucket, accessKeyId, secretAccessKey].filter(Boolean).length
  if (given === 0) return undefined
  if (given < 4) {
    console.error('\n  COCINE_R2_ENDPOINT, _BUCKET, _KEY_ID and _SECRET must all be set; starting without relay storage.\n')
    return undefined
  }
  return {
    endpoint: endpoint.replace(/\/$/, ''), bucket, accessKeyId, secretAccessKey,
    region: process.env.COCINE_R2_REGION ?? 'auto'
  }
}

const turn = turnFromEnv()
const origin = originFromEnv()

/**
 * Logs on disk as well as on stdout.
 *
 * journald already captures stdout, but it is rotated by size across the whole
 * machine and mixes every unit together -- so "what was voice doing on Tuesday"
 * is a much harder question than it should be. These are split by area and by
 * day, and pruned on a timer; see infra/cocine-logprune.*.
 */
const logging = setupLogging({
  dir: process.env.COCINE_LOG_DIR ?? '/var/log/cocine',
  level: 'info',
  keepDays: Number(process.env.COCINE_LOG_KEEP_DAYS ?? 7)
})
const server = new SignallingServer({
  port, log: m => console.log(`  ${m}`),
  logger: logging.logger('server'),
  ...(turn ? { turn } : {}),
  ...(origin ? { origin } : {})
})
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
console.log(origin
  ? `  relay storage: ${origin.bucket} at ${origin.endpoint} (the host can switch a room to it)`
  : '  relay storage: none -- rooms are peer-to-peer only')
console.log('  press ctrl-c to stop\n')

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => { void server.close().then(() => process.exit(0)) })
}
