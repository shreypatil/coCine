#!/usr/bin/env node
/**
 * Put another platform's native addons where the packager will find them.
 *
 *   node scripts/fetch-native.mjs win
 *   node scripts/fetch-native.mjs mac
 *
 * Why this exists: node-datachannel — the WebRTC implementation the swarm needs
 * — ships a binary per platform, and npm installs only the one matching the
 * machine doing the installing. A Windows installer built on Linux therefore
 * carried no WebRTC at all and died on launch, before any window existed:
 *
 *   Error: Cannot load native addon for node-datachannel on win32 (x64).
 *
 * There are **two** copies of that package in the tree, and they find their
 * binary in completely different ways:
 *
 *  - `node-datachannel` at the root (0.33+) resolves a sibling package,
 *    `@node-datachannel/<platform>-<arch>`, which is fetched here as a tarball.
 *    npm will not install one directly: each declares the platform it is for,
 *    so npm skips it everywhere else.
 *
 *  - `webrtc-polyfill` pins `^0.32.3`, and npm nests that older copy no matter
 *    what `overrides` says. Its loader is an unconditional require of a locally
 *    compiled `build/Release/node_datachannel.node` — no platform packages, no
 *    fallback — so the only way to satisfy it for another platform is to hand it
 *    that platform's build. Its own release page publishes one, which
 *    prebuild-install fetches.
 *
 * Everything lands under `.native/<platform>-<arch>/`, staged rather than
 * written into node_modules, so the tree keeps the binaries this machine needs
 * for its own tests. electron-builder copies them into the package (see the
 * per-platform `files` entries in electron-builder.yml), and
 * scripts/check-package.mjs refuses to ship a package where any of it is wrong.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, copyFileSync, cpSync, readdirSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const modules = join(root, 'node_modules')

const TARGETS = {
  win: { platform: 'win32', arch: 'x64', addon: 'win32-x64-msvc', format: 'PE' },
  mac: { platform: 'darwin', arch: 'arm64', addon: 'darwin-arm64', format: 'Mach-O' }
}

const target = process.argv[2]
if (!Object.keys(TARGETS).includes(target ?? '')) {
  console.error('usage: node scripts/fetch-native.mjs <win|mac>')
  process.exit(1)
}
const spec = TARGETS[target]
const stage = join(root, '.native', `${spec.platform}-${spec.arch}`)

/** What a file was built for, from its first four bytes. */
function formatOf (file) {
  const head = readFileSync(file).subarray(0, 4)
  if (head[0] === 0x4d && head[1] === 0x5a) return 'PE'
  if (head[0] === 0x7f && head.subarray(1, 4).toString() === 'ELF') return 'ELF'
  const be = head.readUInt32BE(0)
  const le = head.readUInt32LE(0)
  if (be === 0xcffaedfe || le === 0xcffaedfe || be === 0xfeedfacf || le === 0xfeedfacf || be === 0xcafebabe) return 'Mach-O'
  return 'unknown'
}

function expect (file, what) {
  const got = formatOf(file)
  if (got !== spec.format) throw new Error(`${what} is a ${got} binary; ${spec.platform} needs ${spec.format}`)
  console.log(`  ${what}: ${got}`)
}

/** Every copy of node-datachannel in the tree, root and nested. */
function copies () {
  const found = []
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const full = join(dir, entry.name)
      if (entry.name === 'node-datachannel' && existsSync(join(full, 'package.json'))) {
        found.push(full)
        continue
      }
      // Only descend into nested node_modules; the rest of a package is not
      // where another package lives.
      if (entry.name === 'node_modules') walk(full)
      else if (dir.endsWith('node_modules') || entry.name.startsWith('@')) walk(full)
    }
  }
  walk(modules)
  return found
}

/**
 * A modern copy: the binary is a separate package, fetched as a tarball because
 * `npm install` refuses a package whose declared platform is not this one.
 */
function fetchAddonPackage (v) {
  const dest = join(stage, 'addon')
  if (existsSync(join(dest, 'node_datachannel.node'))) return dest
  const work = join(tmpdir(), `cocine-native-${Date.now()}`)
  mkdirSync(work, { recursive: true })
  try {
    console.log(`  fetching @node-datachannel/${spec.addon}@${v}`)
    const out = execFileSync('npm', ['pack', `@node-datachannel/${spec.addon}@${v}`, '--pack-destination', work],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
    execFileSync('tar', ['-xzf', join(work, out.trim().split('\n').pop().trim()), '-C', work])
    rmSync(dest, { recursive: true, force: true })
    mkdirSync(dirname(dest), { recursive: true })
    // Copied, not renamed: /tmp is usually another filesystem and rename fails.
    cpSync(join(work, 'package'), dest, { recursive: true })
    return dest
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

/**
 * A legacy copy: the binary belongs at build/Release inside the package itself,
 * and its own release page publishes one per platform.
 */
function fetchPrebuild (pkgDir, v, name) {
  const out = join(stage, `${name}.node`)
  if (existsSync(out)) return out
  const work = join(tmpdir(), `cocine-prebuild-${Date.now()}`)
  mkdirSync(work, { recursive: true })
  try {
    console.log(`  fetching node-datachannel ${v} prebuild for ${spec.platform}-${spec.arch}`)
    copyFileSync(join(pkgDir, 'package.json'), join(work, 'package.json'))
    execFileSync('npx', ['--yes', 'prebuild-install@7', '-r', 'napi', '--platform', spec.platform, '--arch', spec.arch],
      { cwd: work, stdio: ['ignore', 'ignore', 'inherit'] })
    const built = join(work, 'build', 'Release', 'node_datachannel.node')
    if (!existsSync(built)) throw new Error('prebuild-install produced no binary')
    mkdirSync(stage, { recursive: true })
    copyFileSync(built, out)
    return out
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

const manifest = []
console.log(`staging native addons for ${spec.platform}-${spec.arch} in .native/`)
for (const dir of copies()) {
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  const where = relative(root, dir)
  const [major, minor] = pkg.version.split('.').map(Number)
  const modern = major > 0 || minor >= 33

  if (modern) {
    const dest = fetchAddonPackage(pkg.version)
    expect(join(dest, 'node_datachannel.node'), `${where} → @node-datachannel/${spec.addon}`)
    manifest.push({ kind: 'package', from: relative(root, dest), to: `node_modules/@node-datachannel/${spec.addon}` })
  } else {
    // Named after where it has to end up, since several could exist.
    const name = where.replaceAll('node_modules/', '').replaceAll('/', '-')
    const file = fetchPrebuild(dir, pkg.version, name)
    expect(file, `${where} → build/Release`)
    manifest.push({ kind: 'file', from: relative(root, file), to: `${where}/build/Release/node_datachannel.node` })
  }
}

writeFileSync(join(stage, 'manifest.json'), JSON.stringify({ target, ...spec, entries: manifest }, null, 2))
console.log(`\n${manifest.length} addon${manifest.length === 1 ? '' : 's'} staged:`)
for (const e of manifest) console.log(`  ${e.from}  →  ${e.to}`)
