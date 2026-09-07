import { mkdir, readdir, readFile, writeFile, rm, stat, statfs } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Where received films live.
 *
 * Films are kept until someone removes them: a rewatch then costs nothing and
 * the extra copies stay available to the swarm. The cost of that choice is that
 * gigabytes accumulate silently, which is why listing and removal are part of
 * this class rather than an afterthought.
 *
 * Laid out as <root>/<infoHash>/<name>. Keying on the info hash means two films
 * with the same name cannot collide, and "do we already have this?" is a
 * directory check rather than a guess.
 */
export interface StoredFilm {
  infoHash: string
  name: string
  /** Full path to the film itself. */
  path: string
  bytes: number
  /** Bytes actually on disk, which is less than `bytes` for a partial download. */
  onDiskBytes: number
  complete: boolean
  addedAtMs: number
}

interface Meta { infoHash: string; name: string; bytes: number; addedAtMs: number }

export class OutOfSpaceError extends Error {
  constructor (readonly needBytes: number, readonly freeBytes: number) {
    super(`Not enough room: this film needs ${gb(needBytes)} and only ${gb(freeBytes)} is free`)
    this.name = 'OutOfSpaceError'
  }
}

const gb = (n: number): string => `${(n / 1024 ** 3).toFixed(1)} GB`

export class FilmStore {
  constructor (readonly root: string) {}

  dirFor (infoHash: string): string { return join(this.root, infoHash.toLowerCase()) }

  async has (infoHash: string): Promise<boolean> {
    try { return (await stat(this.dirFor(infoHash))).isDirectory() } catch { return false }
  }

  async record (m: Meta): Promise<void> {
    const dir = this.dirFor(m.infoHash)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'meta.json'), JSON.stringify(m, null, 2))
  }

  async list (): Promise<StoredFilm[]> {
    let entries: string[]
    try { entries = await readdir(this.root) } catch { return [] }
    const films: StoredFilm[] = []
    for (const infoHash of entries) {
      const dir = join(this.root, infoHash)
      try {
        const meta = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8')) as Meta
        let onDiskBytes = 0
        try { onDiskBytes = (await stat(join(dir, meta.name))).size } catch { /* not started */ }
        films.push({
          infoHash: meta.infoHash,
          name: meta.name,
          path: join(dir, meta.name),
          bytes: meta.bytes,
          onDiskBytes,
          complete: onDiskBytes >= meta.bytes,
          addedAtMs: meta.addedAtMs
        })
      } catch { /* a directory without readable metadata is not a film */ }
    }
    return films.sort((a, b) => b.addedAtMs - a.addedAtMs)
  }

  async remove (infoHash: string): Promise<void> {
    await rm(this.dirFor(infoHash), { recursive: true, force: true })
  }

  async totalBytes (): Promise<number> {
    return (await this.list()).reduce((n, f) => n + f.onDiskBytes, 0)
  }

  async freeBytes (): Promise<number> {
    await mkdir(this.root, { recursive: true })
    const s = await statfs(this.root)
    return Number(s.bsize) * Number(s.bavail)
  }

  /**
   * Refuse before starting rather than failing at ninety per cent. The margin
   * covers the filesystem's own overhead and leaves the machine usable.
   */
  async ensureRoomFor (bytes: number, marginBytes = 512 * 1024 * 1024): Promise<void> {
    const free = await this.freeBytes()
    if (free < bytes + marginBytes) throw new OutOfSpaceError(bytes + marginBytes, free)
  }
}
