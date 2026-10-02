/**
 * Programs to run inside a simulated network.
 *
 * Plain JavaScript, and deliberately ignorant of coCine: a UDP peer and a STUN
 * responder are the vocabulary of networks in general, and keeping them that
 * way is what lets the simulator be trusted about the application rather than
 * being part of it.
 */
import { fileURLToPath } from 'node:url'

/** Absolute paths, because they are spawned by `node <path>` inside a namespace. */
export const AGENTS = {
  /** `udp.mjs echo|probe|punch …` — measures reachability and round trips. */
  udp: fileURLToPath(new URL('./udp.mjs', import.meta.url)),
  /** `stun.mjs [port]` — the binding responder ICE needs to learn its own address. */
  stun: fileURLToPath(new URL('./stun.mjs', import.meta.url))
} as const
