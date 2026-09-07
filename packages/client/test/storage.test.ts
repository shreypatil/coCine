import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FilmStore, OutOfSpaceError } from '../src/storage.js'

let root: string
let store: FilmStore
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'films-')); store = new FilmStore(join(root, 'films')) })
afterEach(() => rmSync(root, { recursive: true, force: true }))

const put = (infoHash: string, name: string, bytes: number, onDisk = bytes): void => {
  const dir = store.dirFor(infoHash)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'meta.json'), JSON.stringify({ infoHash, name, bytes, addedAtMs: Date.now() }))
  writeFileSync(join(dir, name), Buffer.alloc(onDisk))
}

describe('FilmStore', () => {
  it('starts empty rather than failing when nothing has been stored', async () => {
    expect(await store.list()).toEqual([])
    expect(await store.totalBytes()).toBe(0)
  })

  it('keys on the info hash so two films with one name cannot collide', async () => {
    put('a'.repeat(40), 'dune.mkv', 100)
    put('b'.repeat(40), 'dune.mkv', 200)
    const films = await store.list()
    expect(films).toHaveLength(2)
    expect(new Set(films.map(f => f.path)).size).toBe(2)
  })

  it('reports a partial download as incomplete', async () => {
    put('c'.repeat(40), 'arrival.mkv', 1000, 400)
    const [f] = await store.list()
    expect(f!.complete).toBe(false)
    expect(f!.onDiskBytes).toBe(400)
    expect(f!.bytes).toBe(1000)
  })

  it('counts only what is actually on disk', async () => {
    put('d'.repeat(40), 'solaris.mkv', 1000, 250)
    expect(await store.totalBytes()).toBe(250)
  })

  it('answers whether a film is already here, so it is not fetched twice', async () => {
    put('e'.repeat(40), 'stalker.mkv', 10)
    expect(await store.has('E'.repeat(40))).toBe(true)
    expect(await store.has('f'.repeat(40))).toBe(false)
  })

  it('removes a film and everything belonging to it', async () => {
    put('a'.repeat(40), 'dune.mkv', 100)
    await store.remove('A'.repeat(40))
    expect(await store.list()).toEqual([])
    expect(await store.has('a'.repeat(40))).toBe(false)
  })

  it('ignores a directory that is not a film rather than crashing the listing', async () => {
    mkdirSync(store.dirFor('9'.repeat(40)), { recursive: true })
    put('a'.repeat(40), 'dune.mkv', 100)
    expect(await store.list()).toHaveLength(1)
  })

  it('lists newest first, which is what someone clearing space wants', async () => {
    put('a'.repeat(40), 'old.mkv', 10)
    await new Promise(r => setTimeout(r, 12))
    put('b'.repeat(40), 'new.mkv', 10)
    expect((await store.list()).map(f => f.name)).toEqual(['new.mkv', 'old.mkv'])
  })
})

describe('disk space', () => {
  it('reports something plausible for free space', async () => {
    expect(await store.freeBytes()).toBeGreaterThan(0)
  })

  it('allows a film that comfortably fits', async () => {
    await expect(store.ensureRoomFor(1024)).resolves.toBeUndefined()
  })

  it('refuses before starting rather than failing at ninety per cent', async () => {
    const free = await store.freeBytes()
    await expect(store.ensureRoomFor(free * 2)).rejects.toBeInstanceOf(OutOfSpaceError)
  })

  it('explains the refusal in gigabytes, not bytes', async () => {
    const free = await store.freeBytes()
    await expect(store.ensureRoomFor(free * 2)).rejects.toThrow(/needs [\d.]+ GB and only [\d.]+ GB is free/)
  })

  it('keeps a margin so the machine is still usable afterwards', async () => {
    // Asking for exactly the free space must fail: filling a disk completely
    // breaks far more than this application.
    const free = await store.freeBytes()
    await expect(store.ensureRoomFor(free)).rejects.toBeInstanceOf(OutOfSpaceError)
  })
})
