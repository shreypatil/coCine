#!/usr/bin/env node
/**
 * Refuse to ship an installer that cannot start.
 *
 *   node scripts/check-package.mjs win
 *   node scripts/check-package.mjs linux
 *
 * A Windows build made on Linux was published twice, and failed on launch both
 * times, before any window existed:
 *
 *   Error: Cannot load native addon for node-datachannel on win32 (x64).
 *   Error: Cannot find module '../../../build/Release/node_datachannel.node'
 *
 * The second one got past an earlier version of this script, which only looked
 * at files on disk — and the file it should have been looking for was inside
 * `app.asar`, where `find` cannot see it. So this reads the archive as well as
 * the directory beside it, and checks what the *loaders* will actually do:
 *
 *  - every copy of node-datachannel in the package can find a binary, by
 *    whichever mechanism its version uses — a sibling `@node-datachannel/…`
 *    package for 0.33 and later, a local `build/Release` for earlier;
 *  - every binary it would load is built for the target platform, not for the
 *    machine that did the building;
 *  - nothing native is left packed inside the archive, because a `.node` cannot
 *    be loaded from one.
 *
 * Nothing in the source tree was ever wrong for either bug. The only place they
 * existed was the artifact, so the artifact is what gets read.
 */
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join, dirname, relative, posix } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import asar from '@electron/asar'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

const TARGETS = {
  win: { dirs: ['release/win-unpacked'], addon: 'win32-x64-msvc', format: 'PE', tag: 'win32-x64' },
  linux: { dirs: ['release/linux-unpacked'], addon: 'linux-x64-gnu', format: 'ELF', tag: 'linux-x64' },
  // electron-builder names this after the architecture when one is listed
  // explicitly, and plainly when it is building for the host's own. Both are
  // correct output; looking for only one of them fails the run *after* a
  // perfectly good dmg has been produced.
  mac: {
    dirs: ['release/mac-arm64', 'release/mac'],
    addon: 'darwin-arm64', format: 'Mach-O', tag: 'darwin-arm64'
  }
}

/** The first of a target's candidate directories that exists. */
function outputDir (target) {
  const spec = TARGETS[target]
  for (const d of spec.dirs) if (existsSync(join(root, d))) return join(root, d)
  return join(root, spec.dirs[0])
}

/** What kind of executable a file is, from its first four bytes. */
export function binaryFormat (head) {
  if (head.length < 4) return 'unknown'
  if (head[0] === 0x4d && head[1] === 0x5a) return 'PE'
  if (head[0] === 0x7f && head.subarray(1, 4).toString() === 'ELF') return 'ELF'
  const be = head.readUInt32BE(0)
  const le = head.readUInt32LE(0)
  if (be === 0xcffaedfe || le === 0xcffaedfe || be === 0xfeedfacf || le === 0xfeedfacf || be === 0xcafebabe) {
    return 'Mach-O'
  }
  return 'unknown'
}

/**
 * Which mechanism a version of node-datachannel uses to find its binary.
 *
 * 0.33 split the binary into one package per platform. Before that the loader
 * required a locally built `build/Release/node_datachannel.node` by relative
 * path, with no fallback — which is why a nested older copy has to be handed a
 * build of its own.
 */
export function addonStrategy (version) {
  const [major, minor] = String(version).split('.').map(Number)
  return (major > 0 || minor >= 33) ? 'package' : 'local-build'
}

/** Everything in the package: archive entries and the files beside it. */
function contents (dir) {
  const archive = join(dir, 'resources', 'app.asar')
  const unpacked = join(dir, 'resources', 'app.asar.unpacked')

  const packed = existsSync(archive)
    ? asar.listPackage(archive).map(p => p.replace(/^[/\\]/, '').split('\\').join('/'))
    : []

  const loose = []
  const walk = (base, at = base) => {
    if (!existsSync(at)) return
    for (const entry of readdirSync(at)) {
      const full = join(at, entry)
      if (statSync(full).isDirectory()) walk(base, full)
      else loose.push(relative(base, full).split('\\').join('/'))
    }
  }
  walk(unpacked)

  return {
    archive,
    unpacked,
    packed,
    loose,
    has: p => packed.includes(p) || loose.includes(p),
    /** Bytes of a file wherever it lives, unpacked first. */
    read: p => {
      const onDisk = join(unpacked, p)
      if (existsSync(onDisk)) return readFileSync(onDisk)
      return asar.extractFile(archive, p)
    },
    isUnpacked: p => loose.includes(p)
  }
}

export function check (target, dir = outputDir(target)) {
  const spec = TARGETS[target]
  if (!existsSync(dir)) throw new Error(`${relative(root, dir)} does not exist — build it first`)
  const pkg = contents(dir)
  const problems = []
  let checked = 0

  // Every copy of node-datachannel, found the way the loaders find themselves.
  const copies = [...new Set(pkg.packed.concat(pkg.loose))]
    .filter(p => p.endsWith('/node-datachannel/package.json') || p === 'node_modules/node-datachannel/package.json')
    .map(p => posix.dirname(p))

  if (copies.length === 0) problems.push('no copy of node-datachannel in the package at all')

  for (const copy of copies) {
    let version
    try { version = JSON.parse(pkg.read(posix.join(copy, 'package.json')).toString()).version } catch {
      problems.push(`${copy}: package.json unreadable`)
      continue
    }
    const strategy = addonStrategy(version)
    const wanted = strategy === 'package'
      ? `node_modules/@node-datachannel/${spec.addon}/node_datachannel.node`
      : posix.join(copy, 'build/Release/node_datachannel.node')

    if (!pkg.has(wanted)) {
      problems.push(
        `${copy} (${version}, loads by ${strategy}) has no binary: ${wanted} is missing. ` +
        `Run \`npm run fetch-native ${target}\`.`
      )
      continue
    }
    if (!pkg.isUnpacked(wanted)) {
      problems.push(`${wanted} is packed inside app.asar; a native addon cannot be loaded from an archive`)
      continue
    }
    const format = binaryFormat(pkg.read(wanted).subarray(0, 4))
    if (format !== spec.format) {
      problems.push(`${wanted} is a ${format} binary; ${target} needs ${spec.format}`)
    }
    checked++
  }

  // And nothing else native may be the wrong platform or stuck in the archive.
  for (const file of pkg.packed.filter(p => p.endsWith('.node'))) {
    if (!pkg.isUnpacked(file)) problems.push(`${file} is packed inside app.asar and cannot be loaded`)
  }
  for (const file of pkg.loose.filter(p => p.endsWith('.node'))) {
    checked++
    // Only the ones a loader would actually choose: prebuilds are published for
    // every platform and the rest are simply along for the ride.
    const chosen = file.includes('build/Release/') || file.includes(`prebuilds/${spec.tag}/`) ||
      file.includes(`@node-datachannel/${spec.addon}/`)
    if (!chosen) continue
    const format = binaryFormat(pkg.read(file).subarray(0, 4))
    if (format !== spec.format) problems.push(`${file} would be loaded on ${target} but is a ${format} binary`)
  }

  return { problems, checked, copies }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const target = process.argv[2]
  if (!Object.keys(TARGETS).includes(target ?? '')) {
    console.error('usage: node scripts/check-package.mjs <win|linux|mac>')
    process.exit(1)
  }
  const { problems, checked, copies } = check(target)
  if (problems.length) {
    console.error(`\n${target} package is not shippable:`)
    for (const p of problems) console.error(`  ✗ ${p}`)
    process.exit(1)
  }
  console.log(
    `${target} package looks shippable — ${copies.length} copies of node-datachannel, ` +
    `${checked} native addons checked, all ${TARGETS[target].format} and all loadable`
  )
}
