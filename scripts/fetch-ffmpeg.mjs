#!/usr/bin/env node
/**
 * Puts ffmpeg and ffprobe where the packaged application will find them.
 *
 *   node scripts/fetch-ffmpeg.mjs linux
 *   node scripts/fetch-ffmpeg.mjs win
 *   node scripts/fetch-ffmpeg.mjs mac --from /opt/homebrew/bin
 *
 * The `<video>` engine cannot open every container -- AVI and MPEG-2 do not
 * demux -- so those are converted before playing, and that needs ffmpeg. It has
 * to ship: somebody who installed from a link has no reason to own a media
 * toolchain, and "install ffmpeg and try again" is not an answer for the person
 * this application is for.
 *
 * Unlike mpv this is fetched for **Linux too**. The `.deb` can and does declare
 * a dependency, but an AppImage cannot, and the AppImage is what a stranger
 * downloads -- so a static build ships inside it.
 *
 * Where the builds come from, and why these:
 *
 * - **Linux**: John Van Sickle's static builds, which are the ones ffmpeg.org
 *   links to and are genuinely static, so they run on any glibc.
 * - **Windows**: BtbN's FFmpeg-Builds, also linked from ffmpeg.org, in the
 *   **shared** variant. The static build is one self-contained executable per
 *   tool and simpler to place -- and twice the size, because ffmpeg.exe and
 *   ffprobe.exe each embed the whole of libav: 314 MB for the pair against
 *   roughly half that when they share DLLs. The DLLs are copied alongside.
 * - **macOS**: no published build can be fetched unattended without agreeing to
 *   a click-through, so it takes `--from` naming a directory that already holds
 *   both (`brew install ffmpeg`, then `--from $(brew --prefix)/bin`).
 *
 * Licensing: these are GPL builds. ffmpeg ships here as separate executables the
 * application runs, which is aggregation rather than a derived work -- the same
 * footing mpv is on. The licence text is copied alongside, which is the
 * obligation that comes with redistributing the binaries.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, existsSync, copyFileSync, readdirSync, writeFileSync, chmodSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const here = dirname(fileURLToPath(import.meta.url))
const RESOURCES = join(here, '..', 'apps', 'desktop', 'resources', 'ffmpeg')

const LINUX_URL = 'https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz'
const WIN_URL = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl-shared.zip'

const target = process.argv[2]
const fromIndex = process.argv.indexOf('--from')
const from = fromIndex > -1 ? process.argv[fromIndex + 1] : null

if (!['linux', 'win', 'mac'].includes(target ?? '')) {
  console.error('usage: node scripts/fetch-ffmpeg.mjs <linux|win|mac> [--from /dir/with/ffmpeg]')
  process.exit(1)
}

const outDir = join(RESOURCES, { linux: 'linux', win: 'win', mac: 'mac' }[target])
const exe = target === 'win' ? '.exe' : ''

const sh = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { stdio: 'inherit', ...opts })

/** Somewhere to unpack, cleaned up however this ends. */
const work = join(tmpdir(), `cocine-ffmpeg-${Date.now()}`)

function findUnder (dir, name) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      const hit = findUnder(full, name)
      if (hit) return hit
    } else if (entry.name === name) return full
  }
  return null
}

function place (ffmpegPath, ffprobePath) {
  mkdirSync(outDir, { recursive: true })
  for (const [src, name] of [[ffmpegPath, `ffmpeg${exe}`], [ffprobePath, `ffprobe${exe}`]]) {
    if (!src || !existsSync(src)) throw new Error(`could not find ${name} in the download`)
    const dest = join(outDir, name)
    copyFileSync(src, dest)
    // The archive's mode does not always survive; without this the packaged
    // copy is found and then refuses to run.
    if (target !== 'win') chmodSync(dest, 0o755)
    console.log(`  ${name}  ${(statSync(dest).size / 1024 / 1024).toFixed(1)} MB`)
  }
  writeFileSync(join(outDir, 'LICENSE.txt'),
    'FFmpeg is licensed under the GNU General Public License version 3 or later.\n' +
    'Source: https://ffmpeg.org/download.html\n' +
    'It ships here as separate executables that coCine runs, which is aggregation\n' +
    'rather than a derived work. The full licence text is at\n' +
    'https://www.gnu.org/licenses/gpl-3.0.html\n')
}

try {
  rmSync(work, { recursive: true, force: true })
  mkdirSync(work, { recursive: true })

  if (target === 'mac' || from) {
    if (!from) {
      console.error('macOS needs --from: brew install ffmpeg, then --from "$(brew --prefix)/bin"')
      process.exit(1)
    }
    place(join(from, `ffmpeg${exe}`), join(from, `ffprobe${exe}`))
  } else if (target === 'linux') {
    const tar = join(work, 'ffmpeg.tar.xz')
    console.log(`fetching ${LINUX_URL}`)
    sh('curl', ['-fL', '--retry', '3', '-o', tar, LINUX_URL])
    sh('tar', ['-xf', tar, '-C', work])
    place(findUnder(work, 'ffmpeg'), findUnder(work, 'ffprobe'))
  } else {
    const zip = join(work, 'ffmpeg.zip')
    console.log(`fetching ${WIN_URL}`)
    sh('curl', ['-fL', '--retry', '3', '-o', zip, WIN_URL])
    sh('unzip', ['-q', zip, '-d', work])
    const exePath = findUnder(work, 'ffmpeg.exe')
    place(exePath, findUnder(work, 'ffprobe.exe'))
    // The shared build's executables are small because the codecs live in DLLs
    // beside them. Without these the packaged copy is found and then refuses to
    // start, which looks exactly like ffmpeg being absent.
    const binDir = dirname(exePath)
    let dlls = 0
    for (const entry of readdirSync(binDir)) {
      if (!entry.toLowerCase().endsWith('.dll')) continue
      copyFileSync(join(binDir, entry), join(outDir, entry))
      dlls++
    }
    console.log(`  ${dlls} DLLs`)
  }

  console.log(`\nffmpeg staged in ${outDir}`)
} finally {
  rmSync(work, { recursive: true, force: true })
}
