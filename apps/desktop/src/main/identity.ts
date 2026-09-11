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
  /** The folder the last film was opened from, so the picker starts there. */
  lastFilmDir: string | null
}

/**
 * The server a release talks to when nobody has said otherwise.
 *
 * Having one means a friend who is sent a build needs no setup at all: they
 * open it, type a room code, and are watching. That is the whole point of
 * running it -- self-hosting is the option, not the requirement.
 */
export const PUBLIC_SERVER = 'wss://cocine.duckdns.org'

/** A server you started yourself, which is what a development run wants. */
export const LOCAL_SERVER = 'ws://127.0.0.1:8787'

declare const __COCINE_DEFAULT_SERVER__: string | undefined

/**
 * Where the application looks for a room, in order of who gets the last word.
 *
 * `COCINE_SERVER` wins, for pointing a build somewhere once without changing
 * anything. Then `COCINE_DEFAULT_SERVER`, baked in at build time, for a release
 * aimed at a different instance. Then the public server for a packaged
 * application, and a local one for an unpackaged run -- so `npm run desktop`
 * never quietly joins strangers on the real server, and a release never
 * requires anyone to know a URL.
 *
 * The settings field overrides whatever this returns and is persisted, so the
 * address is never hard-coded beyond reach.
 */
export function defaultServer (isPackaged: boolean): string {
  if (process.env.COCINE_SERVER) return process.env.COCINE_SERVER
  if (typeof __COCINE_DEFAULT_SERVER__ === 'string' && __COCINE_DEFAULT_SERVER__) {
    return __COCINE_DEFAULT_SERVER__
  }
  return isPackaged ? PUBLIC_SERVER : LOCAL_SERVER
}

/** The development default. Packaged builds go through `defaultServer`. */
export const DEFAULT_SERVER: string = defaultServer(false)

/** A sensible first guess, so nobody has to type their own name on first run. */
function suggestedName (): string {
  try {
    const u = userInfo().username?.trim()
    if (u) return u.slice(0, 40)
  } catch { /* no user info on this platform */ }
  return 'me'
}

export function blankIdentity (server: string = DEFAULT_SERVER): Identity {
  return { id: randomUUID(), name: suggestedName(), server, lastCode: null, lastFilmDir: null }
}

export class IdentityStore {
  private cached: Identity | null = null

  constructor (
    private readonly path: string,
    /** What a first run, or a file with no server in it, should point at. */
    private readonly fallbackServer: string = DEFAULT_SERVER
  ) {}

  get (): Identity {
    if (this.cached) return this.cached
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<Identity>
      // Merge over defaults rather than trusting the file: a hand-edited or
      // half-written file should degrade to sensible values, not crash launch.
      this.cached = {
        id: typeof raw.id === 'string' && raw.id ? raw.id : randomUUID(),
        name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 40) : suggestedName(),
        server: typeof raw.server === 'string' && raw.server ? raw.server : this.fallbackServer,
        lastCode: typeof raw.lastCode === 'string' && raw.lastCode ? raw.lastCode : null,
        lastFilmDir: typeof raw.lastFilmDir === 'string' && raw.lastFilmDir ? raw.lastFilmDir : null
      }
    } catch {
      this.cached = blankIdentity(this.fallbackServer)
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
