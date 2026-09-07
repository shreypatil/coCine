import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { userInfo } from 'node:os'
import { join, dirname } from 'node:path'

/**
 * Who you are on this machine, remembered between launches.
 *
 * Deliberately local: the id is generated here and never leaves the device yet.
 * That covers the whole visible benefit of an account -- your name and server
 * are simply there when the app opens -- without needing an identity provider.
 * OAuth only becomes necessary when this has to follow you to a second machine.
 */
export interface Identity {
  id: string
  name: string
  server: string
  lastCode: string | null
}

export const DEFAULT_SERVER = 'ws://127.0.0.1:8787'

/** A sensible first guess, so nobody has to type their own name on first run. */
function suggestedName (): string {
  try {
    const u = userInfo().username?.trim()
    if (u) return u.slice(0, 40)
  } catch { /* no user info on this platform */ }
  return 'me'
}

export function blankIdentity (): Identity {
  return { id: randomUUID(), name: suggestedName(), server: DEFAULT_SERVER, lastCode: null }
}

export class IdentityStore {
  private cached: Identity | null = null

  constructor (private readonly path: string) {}

  get (): Identity {
    if (this.cached) return this.cached
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<Identity>
      // Merge over defaults rather than trusting the file: a hand-edited or
      // half-written file should degrade to sensible values, not crash launch.
      this.cached = {
        id: typeof raw.id === 'string' && raw.id ? raw.id : randomUUID(),
        name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 40) : suggestedName(),
        server: typeof raw.server === 'string' && raw.server ? raw.server : DEFAULT_SERVER,
        lastCode: typeof raw.lastCode === 'string' && raw.lastCode ? raw.lastCode : null
      }
    } catch {
      this.cached = blankIdentity()
    }
    return this.cached
  }

  save (patch: Partial<Omit<Identity, 'id'>>): Identity {
    const next: Identity = { ...this.get(), ...patch }
    if (patch.name !== undefined) next.name = patch.name.trim().slice(0, 40) || this.get().name
    this.cached = next
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      // Write then rename, so a crash mid-write cannot leave a truncated file
      // that makes the app forget who you are.
      const tmp = `${this.path}.tmp`
      writeFileSync(tmp, JSON.stringify(next, null, 2))
      renameSync(tmp, this.path)
    } catch { /* a read-only home should not stop the app working */ }
    return next
  }
}

export const identityPathFor = (userDataDir: string): string => join(userDataDir, 'identity.json')
