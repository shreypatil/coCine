import type { BrowserWindow } from 'electron'

/**
 * Updating an installed copy.
 *
 * Deliberately quiet: it checks on launch, downloads in the background, and
 * installs when the application next quits. Nothing interrupts a film, and
 * nobody is asked to decide anything mid-session.
 *
 * **What works unsigned**, which is what this ships as for now:
 *
 * - **Windows (NSIS)** — updates fine. The installer is unsigned, so SmartScreen
 *   will warn on first install; it does not block updating afterwards.
 * - **Linux (AppImage)** — updates fine. The `.deb` does not self-update; apt
 *   owns that copy, which is correct.
 * - **macOS** — **cannot** auto-update unsigned. Squirrel.Mac verifies the code
 *   signature before swapping the bundle, so an unsigned build is told about a
 *   new version and can do nothing with it. Until there is a Developer ID
 *   certificate, macOS users reinstall by hand.
 *
 * That asymmetry is why this reports what it did rather than assuming success.
 */

export interface UpdaterLike {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  checkForUpdates: () => Promise<unknown>
  on: (event: string, listener: (...args: unknown[]) => void) => unknown
}

export interface UpdateDeps {
  updater: UpdaterLike
  isPackaged: boolean
  platform: NodeJS.Platform
  log: (msg: string) => void
  notify?: (win: BrowserWindow | null, status: string) => void
  getWindow?: () => BrowserWindow | null
}

export type UpdateOutcome =
  | { checked: false; reason: string }
  | { checked: true }

/**
 * Starts the update check, or explains why it did not.
 *
 * Returns rather than throws, because failing to check for updates must never
 * be the reason someone cannot watch a film.
 */
export async function startUpdates (deps: UpdateDeps): Promise<UpdateOutcome> {
  if (!deps.isPackaged) {
    return { checked: false, reason: 'development build — updates are only checked in an installed copy' }
  }
  if (deps.platform === 'darwin') {
    // Attempting it would download an update that can never be applied, and
    // report a pending install that silently does nothing on quit.
    return { checked: false, reason: 'macOS builds are unsigned, and macOS refuses to apply an unsigned update' }
  }

  deps.updater.autoDownload = true
  deps.updater.autoInstallOnAppQuit = true

  deps.updater.on('update-available', (info: unknown) => {
    const version = (info as { version?: string })?.version ?? 'a new version'
    deps.log(`[update] ${version} is available; downloading in the background`)
  })
  deps.updater.on('update-downloaded', (info: unknown) => {
    const version = (info as { version?: string })?.version ?? 'an update'
    deps.log(`[update] ${version} will be installed when coCine next quits`)
    deps.notify?.(deps.getWindow?.() ?? null, `${version} installs when you quit`)
  })
  deps.updater.on('error', (err: unknown) => {
    deps.log(`[update] check failed, continuing without it: ${String(err)}`)
  })

  try {
    await deps.updater.checkForUpdates()
    return { checked: true }
  } catch (err) {
    return { checked: false, reason: `check failed: ${String(err)}` }
  }
}
