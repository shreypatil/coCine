import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { locateMpv, bundledMpvPath, MpvNotFoundError } from '../src/locate.js'

/**
 * Someone installing coCine from a link has no reason to own a media player, so
 * how mpv is found decides whether the application works at all for them. These
 * cover the order of preference and, just as importantly, that failing to find
 * it produces an explanation rather than a spawn error.
 */
let dir = ''
const fake = (path: string, executable = true): string => {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, '#!/bin/sh\nexit 0\n')
  chmodSync(path, executable ? 0o755 : 0o644)
  return path
}

beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'cocine-locate-')) })
afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

describe('finding mpv', () => {
  it('prefers a copy bundled with the application over one on PATH', () => {
    const resources = join(dir, 'resources')
    fake(bundledMpvPath(resources, 'linux'))
    const pathDir = join(dir, 'bin-a')
    fake(join(pathDir, 'mpv'))

    expect(locateMpv({ resourcesPath: resources, platform: 'linux', env: { PATH: pathDir } }))
      .toBe(bundledMpvPath(resources, 'linux'))
  })

  it('falls back to PATH when nothing is bundled, which is the Linux case', () => {
    const pathDir = join(dir, 'bin-b')
    const mpv = fake(join(pathDir, 'mpv'))
    expect(locateMpv({ platform: 'linux', env: { PATH: pathDir } })).toBe(mpv)
  })

  it('searches every PATH entry, not just the first', () => {
    const empty = join(dir, 'bin-empty')
    mkdirSync(empty, { recursive: true })
    const real = join(dir, 'bin-c')
    const mpv = fake(join(real, 'mpv'))
    expect(locateMpv({ platform: 'linux', env: { PATH: `${empty}:${real}` } })).toBe(mpv)
  })

  it('ignores a file that is not executable', () => {
    const pathDir = join(dir, 'bin-d')
    fake(join(pathDir, 'mpv'), false)
    expect(() => locateMpv({ platform: 'linux', env: { PATH: pathDir } })).toThrow(MpvNotFoundError)
  })

  it('looks for mpv.exe on Windows', () => {
    const resources = join(dir, 'win-resources')
    fake(bundledMpvPath(resources, 'win32'))
    expect(bundledMpvPath(resources, 'win32')).toMatch(/mpv\.exe$/)
    expect(locateMpv({ resourcesPath: resources, platform: 'win32', env: { PATH: '' } }))
      .toMatch(/mpv\.exe$/)
  })

  it('explains how to install rather than failing with a spawn error', () => {
    try {
      locateMpv({ platform: 'darwin', env: { PATH: '' } })
      throw new Error('should not have found mpv')
    } catch (err) {
      expect(err).toBeInstanceOf(MpvNotFoundError)
      expect((err as MpvNotFoundError).message).toContain('mpv')
      // The message has to name the command for the platform it is running on,
      // not a generic "install mpv".
      expect((err as MpvNotFoundError).howToInstall).toContain('brew install mpv')
    }
  })

  it('gives Linux users their package manager, not Homebrew', () => {
    try {
      locateMpv({ platform: 'linux', env: { PATH: '' } })
      throw new Error('should not have found mpv')
    } catch (err) {
      expect((err as MpvNotFoundError).howToInstall).toContain('apt install mpv')
    }
  })

  it('lets COCINE_MPV override everything, for an unusual install', () => {
    const resources = join(dir, 'override-resources')
    fake(bundledMpvPath(resources, 'linux'))
    const custom = fake(join(dir, 'custom', 'my-mpv'))
    expect(locateMpv({ resourcesPath: resources, platform: 'linux', env: { COCINE_MPV: custom, PATH: '' } }))
      .toBe(custom)
  })

  it('refuses a COCINE_MPV that does not exist rather than silently searching on', () => {
    // Silently ignoring it would run a different mpv than the one asked for,
    // which is worse than saying the override is wrong.
    const pathDir = join(dir, 'bin-e')
    fake(join(pathDir, 'mpv'))
    expect(() => locateMpv({ env: { COCINE_MPV: '/nope/mpv', PATH: pathDir }, platform: 'linux' }))
      .toThrow(/COCINE_MPV/)
  })
})
