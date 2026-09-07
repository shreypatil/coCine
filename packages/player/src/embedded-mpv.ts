import { ExternalMpv } from './external-mpv.js'
import type { PlayerOptions } from './types.js'

/**
 * Electron hands out a native window handle as a Buffer whose contents are
 * platform-specific: an X11 XID on Linux, an HWND on Windows, an NSView pointer
 * on macOS. mpv's --wid wants that same value as a decimal integer, so the only
 * thing that varies is the width to read.
 */
export function nativeHandleToWid (handle: Buffer): string {
  if (handle.length >= 8) return handle.readBigUInt64LE(0).toString()
  if (handle.length >= 4) return String(handle.readUInt32LE(0))
  throw new Error(`unexpected native window handle of ${handle.length} bytes`)
}

/**
 * mpv reparented into a window the application owns, so there is one window on
 * screen rather than two.
 *
 * Deliberately a thin subclass of ExternalMpv rather than a reimplementation:
 * every behaviour the sync engine depends on -- exact seeks, awaiting
 * playback-restart, property observation -- is shared, so a drift test that
 * passes against one implementation means something about the other.
 */
export class EmbeddedMpv extends ExternalMpv {
  constructor (handle: Buffer, opts: Omit<PlayerOptions, 'wid' | 'headless'> = {}) {
    super({ ...opts, wid: nativeHandleToWid(handle) })
  }
}
