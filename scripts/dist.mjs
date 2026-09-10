#!/usr/bin/env node
/**
 * Build an installer for one platform, with the right native binaries in it.
 *
 *   node scripts/dist.mjs win
 *   node scripts/dist.mjs linux
 *   node scripts/dist.mjs mac
 *
 * The whole reason this is a script rather than three commands chained with
 * `&&` is the `finally`. Building for another platform means putting that
 * platform's binaries into node_modules, because one of the packages involved
 * loads its addon by relative path and there is no way to hand it a different
 * one at packaging time — electron-builder's own file injection loses to the
 * copy already in the tree, which is how a Windows build shipped with a Linux
 * binary at exactly the path Windows would look in.
 *
 * So: swap in, build, check, and put the tree back however it went. Leaving a
 * Windows binary in node_modules would break every test on this machine, and
 * silently — which is worse than a failed build.
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const app = join(root, 'apps', 'desktop')

const TARGETS = {
  win: { flag: '--win', stage: 'win32-x64', foreign: true },
  mac: { flag: '--mac', stage: 'darwin-arm64', foreign: true },
  linux: { flag: '--linux', stage: null, foreign: false }
}

const target = process.argv[2]
if (!Object.keys(TARGETS).includes(target ?? '')) {
  console.error('usage: node scripts/dist.mjs <win|linux|mac>')
  process.exit(1)
}
const spec = TARGETS[target]
const run = (cmd, args, cwd = root) => execFileSync(cmd, args, { cwd, stdio: 'inherit' })

/** Files put aside while a foreign build runs, and put back afterwards. */
const swapped = []

function swapIn () {
  if (!spec.foreign) return
  run('node', [join(here, 'fetch-native.mjs'), target])
  const manifest = JSON.parse(readFileSync(join(root, '.native', spec.stage, 'manifest.json'), 'utf8'))
  const backups = join(root, '.native', 'host-backup')
  mkdirSync(backups, { recursive: true })

  for (const entry of manifest.entries) {
    // Package-shaped addons are injected by electron-builder itself: they do
    // not exist in the tree for a foreign platform, so nothing can shadow them.
    if (entry.kind !== 'file') continue
    const live = join(root, entry.to)
    const backup = join(backups, entry.to.replaceAll('/', '_'))
    if (existsSync(live)) {
      copyFileSync(live, backup)
      swapped.push({ live, backup })
    } else {
      mkdirSync(dirname(live), { recursive: true })
      swapped.push({ live, backup: null })
    }
    copyFileSync(join(root, entry.from), live)
    console.log(`  swapped in ${entry.to}`)
  }
}

function swapBack () {
  for (const { live, backup } of swapped.reverse()) {
    try {
      if (backup) copyFileSync(backup, live)
      else rmSync(live, { force: true })
      console.log(`  restored ${live.slice(root.length + 1)}`)
    } catch (err) {
      // Loud, because a half-restored tree fails tests in confusing ways.
      console.error(`  COULD NOT RESTORE ${live}: ${String(err)}`)
    }
  }
  swapped.length = 0
}

// A new dependency that ships a per-platform binary would fail exactly the way
// node-datachannel did, so the build refuses to proceed until it is handled.
const { unhandled } = await import('./audit-native.mjs')
const gaps = unhandled()
if (gaps.length) {
  console.error('\nDependencies with per-platform native binaries that nothing supplies:')
  for (const g of gaps) console.error(`  ✗ ${g.name}@${g.version} (${g.kind}) at ${g.where}`)
  console.error('\nAdd them to scripts/fetch-native.mjs and to HANDLED in scripts/audit-native.mjs.')
  process.exit(1)
}

/**
 * The tools that have to ship beside the application.
 *
 * A build that quietly omits them produces an installer that works perfectly on
 * this machine -- where both are on PATH -- and fails for the person it was
 * built for, which is exactly how the Windows installer shipped twice with no
 * WebRTC. Named as a warning rather than a failure: a development build is
 * legitimate, and PATH is a real answer there.
 */
const bundled = [
  { name: 'ffmpeg', dir: join(app, 'resources', 'ffmpeg', target), needs: ['ffmpeg', 'ffprobe'] },
  // Linux packages declare mpv as a dependency instead of bundling it.
  ...(target === 'linux' ? [] : [{ name: 'mpv', dir: join(app, 'resources', 'mpv', target), needs: ['mpv'] }])
]
for (const b of bundled) {
  const exe = target === 'win' ? '.exe' : ''
  const missing = b.needs.filter(n => !existsSync(join(b.dir, `${n}${exe}`)))
  if (missing.length) {
    console.warn(
      `\n  ! ${b.name} is not staged for ${target}: ${missing.join(', ')} missing from ${b.dir}\n` +
      `    The build will proceed and the installed copy will fall back to PATH,\n` +
      `    which the person who installs it almost certainly has not got.\n` +
      `    Fix: node scripts/fetch-${b.name}.mjs ${target}\n`
    )
  }
}

try {
  swapIn()
  run('npx', ['electron-vite', 'build'], app)
  run('npx', ['electron-builder', spec.flag, '--config', 'electron-builder.yml'], app)
} finally {
  swapBack()
}
// After restoring, so a failing check still leaves the tree correct.
run('node', [join(here, 'check-package.mjs'), target])
