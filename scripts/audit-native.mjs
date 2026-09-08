#!/usr/bin/env node
/**
 * Which shipped dependencies are platform-specific, and how each finds its
 * binary.
 *
 *   node scripts/audit-native.mjs
 *
 * A Windows installer built on Linux failed to start twice, both times because
 * a native addon for the target platform was never installed on the machine
 * doing the building. npm only installs what matches the host, so the tree that
 * gets packaged is quietly incomplete, and nothing about the build says so.
 *
 * This walks the *shipped* dependency closure — what electron-builder actually
 * puts in the package, which is the production dependencies of apps/desktop and
 * nothing else — and reports, for every package with a native addon in it:
 *
 *   portable    one package carries prebuilds for every platform. Nothing to do.
 *   siblings    the binary is a separate package per platform, so the target's
 *               has to be fetched (scripts/fetch-native.mjs).
 *   local-build the binary is compiled or downloaded into the package itself,
 *               so a foreign target needs one put there (scripts/dist.mjs).
 *
 * Anything in the last two categories that is not already handled is a Windows
 * or macOS build waiting to fail, which is exactly what this is for.
 */
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const modules = join(root, 'node_modules')

/** Reads a package.json, or null when there is not one. */
const readPkg = dir => {
  const file = join(dir, 'package.json')
  if (!existsSync(file)) return null
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return null }
}

/** Node's own resolution: look in this directory's node_modules, then upwards. */
function resolvePackage (name, fromDir) {
  let at = fromDir
  for (;;) {
    const candidate = join(at, 'node_modules', name)
    if (existsSync(join(candidate, 'package.json'))) return candidate
    const up = dirname(at)
    if (up === at || !at.startsWith(root)) return null
    at = up
    if (at === dirname(root)) return null
  }
}

/**
 * Everything that ends up in the package: the production dependencies of the
 * desktop app, transitively. devDependencies are the build's own tools and are
 * never shipped, which is why esbuild and rollup — platform-specific though
 * they are — do not matter here.
 */
export function shippedClosure (appDir = join(root, 'apps', 'desktop')) {
  const seen = new Map()
  const queue = []

  const enqueue = (name, fromDir) => {
    const dir = resolvePackage(name, fromDir)
    if (!dir || seen.has(dir)) return
    const pkg = readPkg(dir)
    if (!pkg) return
    seen.set(dir, pkg)
    queue.push([dir, pkg])
  }

  const appPkg = readPkg(appDir)
  for (const name of Object.keys(appPkg?.dependencies ?? {})) enqueue(name, appDir)
  // Workspace packages are bundled by electron-vite, but their dependencies
  // still travel, so they count.
  for (const name of Object.keys(appPkg?.dependencies ?? {})) {
    const dir = resolvePackage(name, appDir)
    if (dir?.includes(join('packages', ''))) continue
  }

  while (queue.length) {
    const [dir, pkg] = queue.shift()
    for (const name of Object.keys(pkg.dependencies ?? {})) enqueue(name, dir)
    for (const name of Object.keys(pkg.optionalDependencies ?? {})) enqueue(name, dir)
  }
  return seen
}

/** Every .node file inside a package, ignoring nested packages. */
function addonsIn (dir) {
  const found = []
  const walk = at => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue
      const full = join(at, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.node')) found.push(relative(dir, full))
    }
  }
  try { walk(dir) } catch { /* unreadable is not native */ }
  return found
}

/**
 * Which platforms a "portable" package actually carries prebuilds for.
 *
 * Portable is a claim, not a guarantee: a package that publishes prebuilds for
 * every platform except the one being built for fails exactly like a missing
 * sibling package, just later and with a worse error.
 */
function prebuiltTuples (dir) {
  const at = join(dir, 'prebuilds')
  if (!existsSync(at)) return []
  try { return readdirSync(at).filter(n => statSync(join(at, n)).isDirectory()).sort() } catch { return [] }
}

/** Optional dependencies that look like one-package-per-platform. */
function siblingFamilies (pkg) {
  const names = Object.keys(pkg.optionalDependencies ?? {})
  return names.filter(n => /(win32|darwin|linux|android|freebsd)[-_](x64|arm64|ia32|arm)/.test(n))
}

/**
 * How a package finds its native binary, from what it declares and what it
 * contains. Pure, so the rule itself can be tested without a node_modules tree.
 */
export function classify ({ addons = [], siblings = [], installScript = false } = {}) {
  if (siblings.length) return 'siblings'
  if (addons.some(a => /(^|[\\/])prebuilds[\\/]/.test(a))) return 'portable'
  if (addons.some(a => /^build[\\/]/.test(a))) return 'local-build'
  return installScript || addons.length ? 'none' : 'none'
}

/**
 * Packages whose per-platform binaries the build already supplies. Anything
 * else landing in `siblings` or `local-build` is a foreign build waiting to
 * fail, which is why unhandled() exists and why dist.mjs calls it.
 */
export const HANDLED = new Set(['node-datachannel'])

export function unhandled (rows = audit()) {
  return rows.filter(r => (r.kind === 'siblings' || r.kind === 'local-build') && !HANDLED.has(r.name))
}

export function audit () {
  const closure = shippedClosure()
  const rows = []

  for (const [dir, pkg] of closure) {
    const addons = addonsIn(dir)
    const siblings = siblingFamilies(pkg)
    const installScript = !!(pkg.scripts?.install || pkg.scripts?.postinstall)
    if (!addons.length && !siblings.length && !installScript) continue

    const kind = classify({ addons, siblings, installScript })

    rows.push({
      name: pkg.name,
      version: pkg.version,
      where: relative(root, dir),
      kind,
      addons: addons.length,
      siblings,
      tuples: prebuiltTuples(dir),
      installScript
    })
  }
  return rows.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name))
}

/** The platforms coCine is built for, and therefore has to be covered. */
const TARGET_TUPLES = ['linux-x64', 'win32-x64', 'darwin-arm64', 'darwin-x64']

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const rows = audit()
  const problems = []
  const byKind = k => rows.filter(r => r.kind === k)

  console.log(`\nShipped dependencies with native code: ${rows.length}\n`)

  const explain = {
    portable: 'one package, prebuilds for every platform — nothing to do',
    siblings: 'binary lives in a per-platform package — the target’s must be fetched',
    'local-build': 'binary is built into the package itself — a foreign target needs one put there',
    none: 'declares an install script but ships no addon here'
  }

  for (const kind of ['portable', 'siblings', 'local-build', 'none']) {
    const group = byKind(kind)
    if (!group.length) continue
    console.log(`${kind.toUpperCase()}  (${explain[kind]})`)
    for (const r of group) {
      console.log(`  ${r.name}@${r.version}`)
      console.log(`      at ${r.where}${r.addons ? `, ${r.addons} addon file${r.addons === 1 ? '' : 's'}` : ''}`)
      if (r.siblings.length) {
        const win = r.siblings.filter(n => n.includes('win32'))
        console.log(`      per-platform packages: ${r.siblings.length} (windows: ${win.join(', ') || 'none'})`)
      }
      if (r.tuples.length) {
        const missing = TARGET_TUPLES.filter(t => !r.tuples.includes(t))
        console.log(`      prebuilds: ${r.tuples.join(', ')}`)
        if (missing.length) {
          problems.push(`${r.name} has no prebuild for ${missing.join(' or ')} — a build for it will fail`)
        }
      }
    }
    console.log()
  }

  if (problems.length) {
    console.log('GAPS')
    for (const p of problems) console.log(`  ✗ ${p}`)
    console.log()
  }

  const needsWork = byKind('siblings').length + byKind('local-build').length
  console.log(
    needsWork
      ? `${needsWork} package${needsWork === 1 ? '' : 's'} need the target platform's binary supplied at build time.\n` +
        'scripts/fetch-native.mjs stages them and scripts/dist.mjs puts them in place;\n' +
        'scripts/check-package.mjs fails the build if any is missing from the artifact.'
      : 'Everything native here is portable. Nothing to stage.'
  )
}
