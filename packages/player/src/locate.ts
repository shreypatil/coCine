import { existsSync, accessSync, constants } from 'node:fs'
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
  linux: 'install the mpv package — apt install mpv, dnf install mpv, or pacman -S mpv'
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

  const hint = INSTALL_HINTS[platform] ?? INSTALL_HINTS.linux!
  throw new MpvNotFoundError(
    'coCine needs the mpv media player, and could not find it.',
    hint
  )
}
