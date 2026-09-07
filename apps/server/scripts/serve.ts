/** Standalone signalling server for manual testing. `npm run server` */
import { SignallingServer } from '../src/server.js'

const port = Number(process.env.PORT ?? 8787)
const server = new SignallingServer({ port, log: m => console.log(`  ${m}`) })
await server.listen()
console.log(`\n  coCine signalling on ws://127.0.0.1:${port}`)
console.log('  press ctrl-c to stop\n')

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => { void server.close().then(() => process.exit(0)) })
}
