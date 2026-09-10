import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { locateMpv, bundledMpvPath, MpvNotFoundError, INSTALL_HINTS, linuxInstallHint } from '../src/locate.js'
import { locateFfmpeg, locateFfTool, bundledFfmpegPath, linuxFfmpegHint } from '../src/locate.js'

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

  it('gives Linux users their own package manager, not Homebrew', () => {
    // Which one depends on the machine this runs on -- the point is that it is
    // a package manager command and not the wrong platform's.
    try {
      locateMpv({ platform: 'linux', env: { PATH: '' } })
      throw new Error('should not have found mpv')
    } catch (err) {
      const hint = (err as MpvNotFoundError).howToInstall
      expect(hint).toMatch(/\b(apt|dnf|pacman|zypper|apk)\b/)
      expect(hint).not.toContain('brew')
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

describe('telling someone how to install mpv', () => {
  // Whoever reads this followed a link and now needs a terminal command. A list
  // of three package managers to choose between is not an instruction.
  const release = (id: string, like?: string): string =>
    `NAME="X"\nID=${id}\n${like ? `ID_LIKE="${like}"\n` : ''}`

  it('names the package manager this system actually has', () => {
    expect(linuxInstallHint(release('ubuntu', 'debian'))).toBe('sudo apt install mpv')
    expect(linuxInstallHint(release('debian'))).toBe('sudo apt install mpv')
    expect(linuxInstallHint(release('fedora'))).toBe('sudo dnf install mpv')
    expect(linuxInstallHint(release('manjaro', 'arch'))).toBe('sudo pacman -S mpv')
    expect(linuxInstallHint(release('arch'))).toBe('sudo pacman -S mpv')
    expect(linuxInstallHint(release('opensuse-tumbleweed', 'suse'))).toBe('sudo zypper install mpv')
    expect(linuxInstallHint(release('alpine'))).toBe('sudo apk add mpv')
  })

  it('falls back to something honest when it cannot tell', () => {
    expect(linuxInstallHint(null)).toBe(INSTALL_HINTS.linux)
    expect(linuxInstallHint(release('someobscuredistro'))).toBe(INSTALL_HINTS.linux)
  })
})


describe('finding ffmpeg', () => {
  /**
   * ffmpeg is how the `<video>` engine plays the containers Chromium refuses.
   * It is found the same way mpv is and for the same reason -- somebody who
   * installed from a link owns no media toolchain -- with one deliberate
   * difference: it is **optional**. Most films need no conversion, and refusing
   * to play them because a tool they do not use is missing would be absurd, so
   * absence is null rather than an exception.
   */

  it('prefers a copy shipped beside the application over one on PATH', () => {
    const res = join(dir, 'ff-resources')
    fake(bundledFfmpegPath(res, 'ffmpeg', 'linux'))
    fake(bundledFfmpegPath(res, 'ffprobe', 'linux'))
    const onPath = join(dir, 'ff-bin')
    fake(join(onPath, 'ffmpeg'))
    fake(join(onPath, 'ffprobe'))

    const found = locateFfmpeg({ resourcesPath: res, platform: 'linux', env: { PATH: onPath } })
    expect(found?.ffmpeg).toBe(bundledFfmpegPath(res, 'ffmpeg', 'linux'))
  })

  it('falls back to PATH, which is the whole answer in development', () => {
    const onPath = join(dir, 'ff-only-path')
    fake(join(onPath, 'ffmpeg'))
    fake(join(onPath, 'ffprobe'))
    const found = locateFfmpeg({ platform: 'linux', env: { PATH: onPath } })
    expect(found).toEqual({
      ffmpeg: join(onPath, 'ffmpeg'),
      ffprobe: join(onPath, 'ffprobe')
    })
  })

  it('returns null rather than throwing when there is none', () => {
    // The caller decides. Most films need nothing, and the media element gets
    // its chance to say for itself whether it can play the file.
    expect(locateFfmpeg({ platform: 'linux', env: { PATH: join(dir, 'nothing-here') } })).toBeNull()
  })

  it('refuses one tool without the other, which is no use', () => {
    // A conversion needs ffprobe to decide and ffmpeg to do it.
    const half = join(dir, 'ff-half')
    fake(join(half, 'ffmpeg'))
    expect(locateFfmpeg({ platform: 'linux', env: { PATH: half } })).toBeNull()
  })

  it('takes a directory from COCINE_FFMPEG, for an unusual install', () => {
    const custom = join(dir, 'ff-custom')
    fake(join(custom, 'ffmpeg'))
    fake(join(custom, 'ffprobe'))
    const found = locateFfmpeg({ platform: 'linux', env: { COCINE_FFMPEG: custom, PATH: '' } })
    expect(found?.ffmpeg).toBe(join(custom, 'ffmpeg'))
  })

  it('ignores a COCINE_FFMPEG that points nowhere rather than failing', () => {
    // An override that is wrong must not stop films that need no conversion.
    const onPath = join(dir, 'ff-fallback')
    fake(join(onPath, 'ffmpeg'))
    fake(join(onPath, 'ffprobe'))
    const found = locateFfmpeg({
      platform: 'linux', env: { COCINE_FFMPEG: join(dir, 'absent'), PATH: onPath }
    })
    expect(found?.ffmpeg).toBe(join(onPath, 'ffmpeg'))
  })

  it('looks for the .exe names on Windows', () => {
    const res = join(dir, 'ff-win')
    fake(bundledFfmpegPath(res, 'ffmpeg', 'win32'))
    fake(bundledFfmpegPath(res, 'ffprobe', 'win32'))
    expect(locateFfTool('ffmpeg', { resourcesPath: res, platform: 'win32', env: {} }))
      .toMatch(/ffmpeg\.exe$/)
  })

  it('ignores a file that is not executable', () => {
    const notExec = join(dir, 'ff-noexec')
    fake(join(notExec, 'ffmpeg'), false)
    fake(join(notExec, 'ffprobe'), false)
    expect(locateFfmpeg({ platform: 'linux', env: { PATH: notExec } })).toBeNull()
  })
})

describe('telling someone how to install ffmpeg', () => {
  it('names this distribution\'s package manager rather than listing four', () => {
    // Whoever reads this followed a link and now needs a command they did not
    // write; naming the wrong package manager makes it useless.
    expect(linuxFfmpegHint('ID=ubuntu')).toBe('sudo apt install ffmpeg')
    expect(linuxFfmpegHint('ID=fedora')).toBe('sudo dnf install ffmpeg')
    expect(linuxFfmpegHint('ID=arch')).toBe('sudo pacman -S ffmpeg')
    expect(linuxFfmpegHint('ID=manjaro\nID_LIKE=arch')).toBe('sudo pacman -S ffmpeg')
  })

  it('falls back to something usable when the system will not say', () => {
    expect(linuxFfmpegHint(null)).toContain('ffmpeg')
  })
})
