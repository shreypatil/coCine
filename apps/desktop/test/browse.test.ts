import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listDirectory, placesFor, startDirectory, crumbs, isPlayable } from '../src/main/browse.js'

/**
 * The application's own film browser. It exists because Electron's fallback
 * GTK chooser reports a double-click as a cancellation, so on Linux the system
 * dialog cannot be used at all -- see the note in browse.ts.
 */

let root: string

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'cocine-browse-'))
  mkdirSync(join(root, 'Films'))
  mkdirSync(join(root, '.hidden'))
  writeFileSync(join(root, 'dune.mkv'), 'x'.repeat(2048))
  writeFileSync(join(root, 'arrival.MP4'), 'x'.repeat(1024))
  writeFileSync(join(root, 'notes.txt'), 'not a film')
  writeFileSync(join(root, '.secret.mkv'), 'hidden film')
})

afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('listing a folder', () => {
  it('shows folders first, then films, alphabetically', async () => {
    const l = await listDirectory(root)
    expect(l.entries.map(e => e.name)).toEqual(['Films', 'arrival.MP4', 'dune.mkv'])
    expect(l.entries[0]!.isDir).toBe(true)
  })

  it('leaves out what cannot be played, and says that it did', async () => {
    const l = await listDirectory(root)
    expect(l.entries.some(e => e.name === 'notes.txt')).toBe(false)
    expect(l.filtered).toBe(true)
  })

  it('shows everything when asked, dotfiles included', async () => {
    const l = await listDirectory(root, { showAll: true })
    expect(l.entries.map(e => e.name)).toContain('notes.txt')
    expect(l.entries.map(e => e.name)).toContain('.hidden')
    expect(l.filtered).toBe(false)
  })

  it('reports size and playability, so the list can be read at a glance', async () => {
    const l = await listDirectory(root)
    const dune = l.entries.find(e => e.name === 'dune.mkv')!
    expect(dune.bytes).toBe(2048)
    expect(dune.playable).toBe(true)
    expect(dune.path).toBe(join(root, 'dune.mkv'))
  })

  it('offers a way up from anywhere but the filesystem root', async () => {
    expect((await listDirectory(root)).parent).toBe(join(root, '..'))
    expect((await listDirectory('/')).parent).toBe(null)
  })

  it('explains a folder it cannot open rather than throwing a code at the interface', async () => {
    await expect(listDirectory(join(root, 'nope'))).rejects.toThrow(/Could not open/)
  })

  it('knows a film by its extension, whatever the case', () => {
    expect(isPlayable('a.MKV')).toBe(true)
    expect(isPlayable('a.mp4')).toBe(true)
    expect(isPlayable('a.txt')).toBe(false)
    expect(isPlayable('mkv')).toBe(false)
  })
})

describe('where the picker starts', () => {
  it('offers only places that exist', () => {
    const places = placesFor('/home/x', [], p => p === '/home/x' || p === '/home/x/Videos')
    expect(places.map(p => p.label)).toEqual(['Home', 'Videos'])
  })

  it('does not offer the same folder twice', () => {
    const places = placesFor('/home/x', [{ label: 'Films', path: '/home/x/Videos' }], () => true)
    expect(places.filter(p => p.path === '/home/x/Videos')).toHaveLength(1)
  })

  it('opens where the last film came from, when it is still there', () => {
    expect(startDirectory('/films', '/home/x', p => p === '/films')).toBe('/films')
  })

  it('falls back to home when the remembered folder has gone', () => {
    expect(startDirectory('/gone', '/home/x', p => p === '/home/x')).toBe('/home/x')
    expect(startDirectory(null, '/home/x', () => true)).toBe('/home/x')
  })
})

describe('the breadcrumb', () => {
  it('is the path, one clickable piece at a time', () => {
    expect(crumbs('/home/x/Videos')).toEqual([
      { label: '/', path: '/' },
      { label: 'home', path: '/home' },
      { label: 'x', path: '/home/x' },
      { label: 'Videos', path: '/home/x/Videos' }
    ])
  })
})
