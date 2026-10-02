/**
 * Whether this machine can run a simulated network at all.
 *
 * The answer is yes on an ordinary Linux desktop and no almost everywhere else,
 * so every caller has to be able to skip rather than fail. A CI runner, a Mac,
 * and a hardened kernel with `kernel.unprivileged_userns_clone=0` all land here,
 * and none of them is a fault in coCine.
 */
import { execFileSync } from 'node:child_process'

export interface Support {
  ok: boolean
  /** Why not, phrased for someone reading a skipped test. */
  reason?: string
}

const REQUIRED = ['unshare', 'ip', 'tc', 'nft'] as const

let cached: Support | null = null

function has (bin: string): boolean {
  try {
    execFileSync('sh', ['-c', `command -v ${bin}`], { stdio: 'ignore' })
    return true
  } catch { return false }
}

/** Cached, because the probe forks and callers ask once per test file. */
export function netsimSupport (): Support {
  if (cached) return cached
  cached = probe()
  return cached
}

function probe (): Support {
  if (process.platform !== 'linux') {
    return { ok: false, reason: `network simulation needs Linux namespaces; this is ${process.platform}` }
  }
  const missing = REQUIRED.filter(b => !has(b))
  if (missing.length > 0) {
    return { ok: false, reason: `missing ${missing.join(', ')} — install iproute2 and nftables` }
  }
  try {
    // The real question, and the only one worth asking directly: can an
    // unprivileged process get CAP_NET_ADMIN over a namespace of its own?
    execFileSync('unshare', ['--user', '--map-root-user', '--net', 'true'],
      { stdio: 'ignore', timeout: 10_000 })
  } catch {
    return {
      ok: false,
      reason: 'unprivileged user namespaces are unavailable — check kernel.unprivileged_userns_clone'
    }
  }
  return { ok: true }
}
