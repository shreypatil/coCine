import { existsSync, accessSync, constants, readFileSync } from 'node:fs'
import { join, delimiter } from 'node:path'

/**
 * Finding mpv.
 *
 * The application drives mpv as a separate process, so it has to exist. In
 * development it is whatever is on PATH. In a packaged build it is looked for
 * beside the application first, because someone installing from a link has no
 * reason to have installed a media player themselves.
 *
 * The three platforms differ in what is reasonable to expect:
 *
 * - **Linux** packages declare mpv as a dependency, so the package manager
 *   installs it. Nothing is bundled and PATH is the answer.
 * - **Windows and macOS** have no such mechanism, so a copy ships inside the
 *   application and is found here.
 *
 * When neither works the caller gets a message naming the platform's actual
 * install command, rather than ENOENT from a failed spawn.
 */

export interface LocateOptions {
  /** Electron's `process.resourcesPath`; absent outside a packaged build. */
  resourcesPath?: string | undefined
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
}

export class MpvNotFoundError extends Error {
  constructor (message: string, readonly howToInstall: string) {
    super(message)
    this.name = 'MpvNotFoundError'
  }
}

const executable = (platform: NodeJS.Platform): string => platform === 'win32' ? 'mpv.exe' : 'mpv'

/** Where a bundled copy sits inside a packaged application. */
export function bundledMpvPath (resourcesPath: string, platform: NodeJS.Platform): string {
  return join(resourcesPath, 'mpv', executable(platform))
}

function isRunnable (path: string): boolean {
  try {
    if (!existsSync(path)) return false
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Walks PATH by hand rather than shelling out, which would need a shell. */
function onPath (platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string | null {
  const name = executable(platform)
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    const candidate = join(dir, name)
    if (isRunnable(candidate)) return candidate
  }
  return null
}

export const INSTALL_HINTS: Record<string, string> = {
  darwin: 'brew install mpv',
  win32: 'download it from https://mpv.io/installation/',
  linux: 'sudo apt install mpv     # or dnf, pacman, zypper — whichever your system uses'
}

/**
 * The command for *this* Linux, not a list of three to choose between.
 *
 * Whoever reads this is the least technical person in the room -- they followed
 * a link, and now they need a terminal command they did not write. Naming the
 * wrong package manager makes it useless, so it is read from /etc/os-release
 * rather than guessed.
 */
export function linuxInstallHint (osRelease: string | null): string {
  const field = (name: string): string => {
    const m = osRelease?.match(new RegExp(`^${name}=\\"?([^\\"\n]*)\\"?`, 'm'))
    return (m?.[1] ?? '').toLowerCase()
  }
  const family = `${field('ID')} ${field('ID_LIKE')}`
  if (/\b(debian|ubuntu|linuxmint|pop|elementary|raspbian)\b/.test(family)) return 'sudo apt install mpv'
  if (/\b(fedora|rhel|centos|almalinux|rocky)\b/.test(family)) return 'sudo dnf install mpv'
  if (/\b(arch|manjaro|endeavouros|garuda)\b/.test(family)) return 'sudo pacman -S mpv'
  if (/\b(opensuse|suse|sles)\b/.test(family)) return 'sudo zypper install mpv'
  if (/\b(alpine)\b/.test(family)) return 'sudo apk add mpv'
  return INSTALL_HINTS.linux!
}

/**
 * The mpv to run, or an error explaining how to get one.
 *
 * `COCINE_MPV` overrides everything, which is what makes an unusual install
 * location or a locally built mpv usable without a rebuild.
 */
export function locateMpv (opts: LocateOptions = {}): string {
  const platform = opts.platform ?? process.platform
  const env = opts.env ?? process.env

  const override = env.COCINE_MPV
  if (override) {
    if (isRunnable(override)) return override
    throw new MpvNotFoundError(
      `COCINE_MPV points at ${override}, which is not an executable file.`,
      'Correct COCINE_MPV, or unset it to search normally.'
    )
  }

  if (opts.resourcesPath) {
    const bundled = bundledMpvPath(opts.resourcesPath, platform)
    if (isRunnable(bundled)) return bundled
  }

  const found = onPath(platform, env)
  if (found) return found

  let hint = INSTALL_HINTS[platform] ?? INSTALL_HINTS.linux!
  if (platform === 'linux') {
    let osRelease: string | null = null
    try { osRelease = readFileSync('/etc/os-release', 'utf8') } catch { /* not every Linux has one */ }
    hint = linuxInstallHint(osRelease)
  }
  throw new MpvNotFoundError(
    'coCine needs the mpv media player, and could not find it.',
    hint
  )
}


/* ---------------------------------------------------------------- ffmpeg */

/**
 * Finding ffmpeg and ffprobe.
 *
 * The `<video>` engine cannot open every container -- AVI and MPEG-2 do not
 * demux -- so those are converted first, and that needs ffmpeg. Found the same
 * way mpv is, and for the same reason: somebody who installed from a link has
 * no reason to have a media toolchain, so a copy ships beside the application
 * and is preferred over whatever is on PATH.
 *
 * Unlike mpv this is *optional*. Most films need no conversion at all, and
 * refusing to play them because a tool they do not use is missing would be
 * absurd -- so the caller gets null rather than an exception, and decides.
 */
export class FfmpegNotFoundError extends Error {
  constructor (message: string, readonly howToInstall: string) {
    super(message)
    this.name = 'FfmpegNotFoundError'
  }
}

const ffExecutable = (tool: 'ffmpeg' | 'ffprobe', platform: NodeJS.Platform): string =>
  platform === 'win32' ? `${tool}.exe` : tool

/** Where a bundled copy sits inside a packaged application. */
export function bundledFfmpegPath (
  resourcesPath: string, tool: 'ffmpeg' | 'ffprobe', platform: NodeJS.Platform
): string {
  return join(resourcesPath, 'ffmpeg', ffExecutable(tool, platform))
}

/** Walks PATH for a named tool. */
function toolOnPath (name: string, env: NodeJS.ProcessEnv): string | null {
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    const candidate = join(dir, name)
    if (isRunnable(candidate)) return candidate
  }
  return null
}

export const FFMPEG_INSTALL_HINTS: Record<string, string> = {
  darwin: 'brew install ffmpeg',
  win32: 'download it from https://ffmpeg.org/download.html',
  linux: 'sudo apt install ffmpeg     # or dnf, pacman, zypper — whichever your system uses'
}

/** The command for *this* Linux, as with mpv. */
export function linuxFfmpegHint (osRelease: string | null): string {
  const field = (name: string): string => {
    const m = osRelease?.match(new RegExp(`^${name}=\\"?([^\\"\n]*)\\"?`, 'm'))
    return (m?.[1] ?? '').toLowerCase()
  }
  const family = `${field('ID')} ${field('ID_LIKE')}`
  if (/\b(debian|ubuntu|linuxmint|pop|elementary|raspbian)\b/.test(family)) return 'sudo apt install ffmpeg'
  if (/\b(fedora|rhel|centos|almalinux|rocky)\b/.test(family)) return 'sudo dnf install ffmpeg'
  if (/\b(arch|manjaro|endeavouros|garuda)\b/.test(family)) return 'sudo pacman -S ffmpeg'
  if (/\b(opensuse|suse|sles)\b/.test(family)) return 'sudo zypper install ffmpeg'
  if (/\b(alpine)\b/.test(family)) return 'sudo apk add ffmpeg'
  return FFMPEG_INSTALL_HINTS.linux!
}

/**
 * ffmpeg or ffprobe, or null when there is none.
 *
 * `COCINE_FFMPEG` points at a directory holding both, which is the escape hatch
 * for an unusual install or a locally built copy.
 */
export function locateFfTool (
  tool: 'ffmpeg' | 'ffprobe', opts: LocateOptions = {}
): string | null {
  const platform = opts.platform ?? process.platform
  const env = opts.env ?? process.env
  const name = ffExecutable(tool, platform)

  const dir = env.COCINE_FFMPEG
  if (dir) {
    const candidate = join(dir, name)
    if (isRunnable(candidate)) return candidate
    // Deliberately not fatal: an override that is wrong should not stop films
    // that need no conversion from playing.
  }

  if (opts.resourcesPath) {
    const bundled = bundledFfmpegPath(opts.resourcesPath, tool, platform)
    if (isRunnable(bundled)) return bundled
  }

  return toolOnPath(name, env)
}

/** Both tools, or null if either is missing -- one without the other is no use. */
export function locateFfmpeg (opts: LocateOptions = {}): { ffmpeg: string; ffprobe: string } | null {
  const ffmpeg = locateFfTool('ffmpeg', opts)
  const ffprobe = locateFfTool('ffprobe', opts)
  return ffmpeg && ffprobe ? { ffmpeg, ffprobe } : null
}

/** What to tell somebody who needs it and has not got it. */
export function ffmpegInstallHint (platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'linux') return FFMPEG_INSTALL_HINTS[platform] ?? FFMPEG_INSTALL_HINTS.linux!
  let osRelease: string | null = null
  try { osRelease = readFileSync('/etc/os-release', 'utf8') } catch { /* not every Linux has one */ }
  return linuxFfmpegHint(osRelease)
}
