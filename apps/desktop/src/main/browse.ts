import { readdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, dirname, extname, join, parse } from 'node:path'

/**
 * Choosing a film without the operating system's file dialog.
 *
 * Electron's own GTK file chooser is used whenever no desktop portal is
 * installed, and on that path an activate gesture -- a double-click on a file,
 * or Enter -- comes back to the application as a *cancellation*. Only clicking
 * the Open button works. Reproduced in a twelve-line Electron app on i3 with no
 * portal present, so it is neither this application's code nor its window
 * handling, and it cannot be patched from here.
 *
 * The consequence is worse than it sounds: opening a film is the first thing
 * anybody does, and on that setup it silently does nothing. So Linux browses
 * with the application's own picker, which behaves the same on every desktop
 * and needs nothing installed. Windows and macOS keep their native dialogs,
 * which people know and which work.
 *
 * Everything here is filesystem reading with no Electron in sight, so it is
 * testable directly.
 */

export const VIDEO_EXTENSIONS = [
  'mkv', 'mp4', 'avi', 'mov', 'webm', 'm4v', 'ts', 'mpg', 'mpeg', 'wmv', 'flv', 'ogv', 'm2ts', '3gp'
]

export interface DirEntry {
  name: string
  path: string
  isDir: boolean
  bytes: number
  modifiedMs: number
  /** Whether this is a file the player is expected to be able to open. */
  playable: boolean
}

export interface Listing {
  path: string
  /** Null at the filesystem root, where there is nowhere further up. */
  parent: string | null
  entries: DirEntry[]
  /** True when entries were filtered down to films. */
  filtered: boolean
}

export const isPlayable = (name: string): boolean =>
  VIDEO_EXTENSIONS.includes(extname(name).slice(1).toLowerCase())

/**
 * One directory, sorted the way people expect: folders first, then films, each
 * alphabetically and case-insensitively.
 *
 * Entries that cannot be stat'ed are dropped rather than thrown over: a broken
 * symlink or a permission-denied file in an otherwise readable folder must not
 * take the whole listing down with it.
 */
export async function listDirectory (
  dir: string,
  opts: { showAll?: boolean } = {}
): Promise<Listing> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch (err) {
    const code = (err as { code?: string }).code
    if (code === 'EACCES' || code === 'EPERM') throw new Error(`No permission to open ${dir}`)
    if (code === 'ENOTDIR') throw new Error(`${dir} is not a folder`)
    throw new Error(`Could not open ${dir}`)
  }

  const entries: DirEntry[] = []
  for (const name of names) {
    // Dotfiles are noise in a film picker, and hiding them is what every other
    // file browser does by default.
    if (!opts.showAll && name.startsWith('.')) continue
    const full = join(dir, name)
    let info
    try { info = await stat(full) } catch { continue }
    const isDir = info.isDirectory()
    if (!isDir && !info.isFile()) continue
    const playable = !isDir && isPlayable(name)
    if (!isDir && !playable && !opts.showAll) continue
    entries.push({ name, path: full, isDir, bytes: isDir ? 0 : info.size, modifiedMs: info.mtimeMs, playable })
  }

  entries.sort((a, b) =>
    a.isDir === b.isDir
      ? a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
      : a.isDir ? -1 : 1)

  const up = dirname(dir)
  return { path: dir, parent: up === dir ? null : up, entries, filtered: !opts.showAll }
}

/**
 * The places worth one click, in the order someone would look.
 *
 * Only directories that exist are offered: a shortcut to a folder that is not
 * there is a dead end, and the set of standard folders differs between desktops
 * and between people.
 */
export function placesFor (
  home: string,
  extra: Array<{ label: string; path: string }> = [],
  exists: (p: string) => boolean = existsSync
): Array<{ label: string; path: string }> {
  const candidates = [
    { label: 'Home', path: home },
    { label: 'Videos', path: join(home, 'Videos') },
    { label: 'Movies', path: join(home, 'Movies') },
    { label: 'Downloads', path: join(home, 'Downloads') },
    { label: 'Desktop', path: join(home, 'Desktop') },
    ...extra
  ]
  const seen = new Set<string>()
  return candidates.filter(c => {
    if (seen.has(c.path) || !exists(c.path)) return false
    seen.add(c.path)
    return true
  })
}

/**
 * Where the picker should open. The folder the last film came from, if it is
 * still there; otherwise home, which always is.
 */
export function startDirectory (
  lastDir: string | null | undefined,
  home: string,
  exists: (p: string) => boolean = existsSync
): string {
  if (lastDir && exists(lastDir)) return lastDir
  return home
}

/** The path as clickable pieces, so the breadcrumb can be built from it. */
export function crumbs (dir: string): Array<{ label: string; path: string }> {
  const { root } = parse(dir)
  const out: Array<{ label: string; path: string }> = [{ label: root === '/' ? '/' : root, path: root }]
  let at = root
  for (const part of dir.slice(root.length).split(/[/\\]+/).filter(Boolean)) {
    at = join(at, part)
    out.push({ label: basename(at), path: at })
  }
  return out
}
