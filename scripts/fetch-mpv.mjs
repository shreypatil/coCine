#!/usr/bin/env node
/**
 * Puts a copy of mpv where the packaged application will find it.
 *
 *   node scripts/fetch-mpv.mjs win
 *   node scripts/fetch-mpv.mjs mac --from /path/to/mpv
 *
 * Only Windows and macOS need this. Linux packages declare mpv as a dependency
 * and the package manager installs it, which is both smaller and more correct --
 * see the `deb.depends` entry in electron-builder.yml.
 *
 * Windows builds come from shinchiro's mpv-winbuild-cmake, which is the build
 * mpv.io itself points Windows users at. macOS has no equivalent published
 * binary that can be fetched unattended, so it takes `--from` pointing at an
 * mpv you already have (`brew install mpv` then `--from $(which mpv)`), and you
 * are responsible for its dylib dependencies being satisfiable.
 *
 * Note on licensing: mpv is GPLv2+ and ships here as a separate executable that
 * coCine talks to over a socket -- aggregation rather than a derived work. The
 * licence text is copied alongside it, which is the obligation that comes with
 * redistributing the binary.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, existsSync, copyFileSync, readdirSync, writeFileSync, statSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const here = dirname(fileURLToPath(import.meta.url))
const RESOURCES = join(here, '..', 'apps', 'desktop', 'resources', 'mpv')
const WIN_RELEASES = 'https://api.github.com/repos/shinchiro/mpv-winbuild-cmake/releases/latest'

const target = process.argv[2]
const fromIndex = process.argv.indexOf('--from')
const from = fromIndex > -1 ? process.argv[fromIndex + 1] : null

if (!['win', 'mac'].includes(target ?? '')) {
  console.error('usage: node scripts/fetch-mpv.mjs <win|mac> [--from /path/to/mpv]')
  console.error('       linux needs nothing — the package depends on mpv')
  process.exit(1)
}

const out = join(RESOURCES, target)
mkdirSync(out, { recursive: true })

function fromLocal () {
  if (!from || !existsSync(from)) {
    throw new Error(`--from must point at an mpv binary; ${from ?? '(nothing)'} does not exist`)
  }
  const name = target === 'win' ? 'mpv.exe' : 'mpv'
  copyFileSync(from, join(out, name))
  execFileSync('chmod', ['+x', join(out, name)])
  console.log(`  copied ${from} -> ${join(out, name)}`)
}

async function fetchWindows () {
  console.log('  looking up the latest Windows build...')
  const res = await fetch(WIN_RELEASES, { headers: { 'user-agent': 'cocine-build' } })
  if (!res.ok) throw new Error(`GitHub returned ${res.status}`)
  const release = await res.json()

  // mpv-dev-* is the library build for embedding; the plain one is the player.
  const asset = release.assets.find(a =>
    /^mpv-x86_64-\d/.test(a.name) && a.name.endsWith('.7z'))
  if (!asset) throw new Error('no mpv-x86_64 asset in the latest release')
  console.log(`  ${release.tag_name}: ${asset.name} (${(asset.size / 1e6).toFixed(1)} MB)`)

  const work = join(tmpdir(), `cocine-mpv-${Date.now()}`)
  mkdirSync(work, { recursive: true })
  const archive = join(work, asset.name)
  try {
    execFileSync('curl', ['-sSL', '-o', archive, asset.browser_download_url], { stdio: 'inherit' })
    execFileSync('7z', ['x', '-y', `-o${work}`, archive], { stdio: 'ignore' })

    // The archive is flat: mpv.exe beside the DLLs it needs. All of it ships,
    // because mpv.exe alone will not start.
    const files = readdirSync(work).filter(f => f !== asset.name)
    if (!files.includes('mpv.exe')) throw new Error(`no mpv.exe in ${asset.name}`)
    rmSync(out, { recursive: true, force: true })
    mkdirSync(out, { recursive: true })
    let bytes = 0
    for (const f of files) {
      const src = join(work, f)
      if (statSync(src).isDirectory()) continue
      copyFileSync(src, join(out, f))
      bytes += statSync(src).size
    }
    console.log(`  placed ${files.length} files (${(bytes / 1e6).toFixed(1)} MB) in ${out}`)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

try {
  if (from) fromLocal()
  else if (target === 'win') await fetchWindows()
  else {
    throw new Error('macOS has no unattended download; use --from, e.g.\n' +
      '  brew install mpv && node scripts/fetch-mpv.mjs mac --from "$(brew --prefix)/bin/mpv"')
  }
  writeFileSync(join(out, 'MPV-LICENSE.txt'),
    'mpv is distributed under the GNU General Public License version 2 or later.\n' +
    'Source: https://github.com/mpv-player/mpv\n' +
    'It ships here as a separate program that coCine communicates with over a\n' +
    'socket, and is not modified.\n')
  console.log('  done')
} catch (err) {
  console.error(`\n  could not fetch mpv for ${target}: ${err.message}\n`)
  process.exit(1)
}
