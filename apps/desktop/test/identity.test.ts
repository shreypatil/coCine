import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IdentityStore, identityPathFor, DEFAULT_SERVER } from '../src/main/identity.js'

let dir: string
let path: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cocine-id-')); path = identityPathFor(dir) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('IdentityStore', () => {
  it('invents a usable identity on first run', () => {
    const id = new IdentityStore(path).get()
    expect(id.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(id.name.length).toBeGreaterThan(0)
    expect(id.server).toBe(DEFAULT_SERVER)
    expect(id.lastCode).toBeNull()
  })

  it('remembers across instances, which is the whole point', () => {
    const a = new IdentityStore(path)
    const first = a.get()
    a.save({ name: 'anjali', server: 'ws://box:9000', lastCode: 'BCDFGHJK' })

    const b = new IdentityStore(path).get()
    expect(b.name).toBe('anjali')
    expect(b.server).toBe('ws://box:9000')
    expect(b.lastCode).toBe('BCDFGHJK')
    expect(b.id).toBe(first.id)
  })

  it('keeps the id stable even when everything else changes', () => {
    const s = new IdentityStore(path)
    const id = s.get().id
    s.save({ name: 'dev' }); s.save({ server: 'ws://elsewhere' })
    expect(new IdentityStore(path).get().id).toBe(id)
  })

  it('trims and bounds a name rather than storing whatever was typed', () => {
    const s = new IdentityStore(path)
    expect(s.save({ name: '  priya  ' }).name).toBe('priya')
    expect(s.save({ name: 'x'.repeat(120) }).name).toHaveLength(40)
  })

  it('ignores a blank name instead of forgetting who you are', () => {
    const s = new IdentityStore(path)
    s.save({ name: 'anjali' })
    expect(s.save({ name: '   ' }).name).toBe('anjali')
  })

  it('recovers from a corrupt file rather than failing to launch', () => {
    writeFileSync(path, '{ this is not json')
    const id = new IdentityStore(path).get()
    expect(id.name.length).toBeGreaterThan(0)
    expect(id.server).toBe(DEFAULT_SERVER)
  })

  it('fills gaps in a half-written file', () => {
    writeFileSync(path, JSON.stringify({ name: 'dev' }))
    const id = new IdentityStore(path).get()
    expect(id.name).toBe('dev')
    expect(id.server).toBe(DEFAULT_SERVER)
    expect(id.id).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('leaves no temporary file behind', () => {
    new IdentityStore(path).save({ name: 'sam' })
    expect(existsSync(`${path}.tmp`)).toBe(false)
    expect(JSON.parse(readFileSync(path, 'utf8')).name).toBe('sam')
  })

  it('keeps working when the location cannot be written', () => {
    // A read-only home should degrade to in-memory, not crash the app. Using a
    // regular file as if it were a directory gives an instant ENOTDIR; paths
    // under /proc look unwritable but make mkdir block instead of failing.
    const blocker = join(dir, 'not-a-directory')
    writeFileSync(blocker, 'x')
    const s = new IdentityStore(join(blocker, 'identity.json'))
    expect(() => s.save({ name: 'kiran' })).not.toThrow()
    expect(s.get().name).toBe('kiran')
  })
})
