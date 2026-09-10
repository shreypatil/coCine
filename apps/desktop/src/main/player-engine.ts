/**
 * Which player the application runs, and the one place that decides.
 *
 * Phase B1 builds a `<video>`-based player to replace mpv. It cleared every
 * bar mpv clears -- exact seeking, 4K decode, recovery from a piece that has
 * not arrived -- but not by the same margin everywhere: on an identical
 * five-peer run mpv held the room to a p99 drift of 26.9 ms against 48.7 ms.
 * Both are inside the 100 ms budget and both are fine; they are not equal.
 *
 * So both stay, selectable, until they have been used rather than only
 * measured. A benchmark that passes is not the same as a thing that feels right
 * to watch a film with, and that judgement needs a person and a real film.
 *
 * The choice can also differ per platform, and quite reasonably might. The two
 * engines have entirely different weak points: mpv reparents a foreign window,
 * which is what makes Wayland impossible and fullscreen chat hard, while the
 * `<video>` path has none of those problems and holds the room slightly less
 * tightly. Nothing forces one answer everywhere.
 *
 * **This is safe precisely because `PlayerController` is the only surface the
 * sync engine touches.** Whichever side of the switch is active, the
 * synchronisation behaviour is the same code driving the same interface -- a
 * room can hold one of each and neither client can tell.
 */

export type PlayerEngine = 'mpv' | 'html'

/**
 * The default per platform.
 *
 * The `<video>` engine everywhere, decided after using both. The drift figures
 * favour mpv slightly -- 26.9 ms against 48.7 ms at five peers, both inside the
 * 100 ms budget, and level at ten -- and everything else favours this one:
 *
 * - mpv's picture is broken in ordinary use. Entering fullscreen turns it black
 *   permanently, and a film starts black about half the time. Measured, and
 *   forcing a software output is worse rather than better.
 * - Chat over the film, subtitles and the fullscreen controls all exist only
 *   because the film is in the window. None could be drawn above mpv's surface.
 * - Wayland works without forcing `--ozone-platform=x11`, which restores native
 *   fractional scaling.
 *
 * mpv stays and stays selectable: `COCINE_PLAYER=mpv`. It decodes formats this
 * engine has to convert first, which is a real answer for a library of old
 * rips, and it is the path with years of other people's use behind it.
 *
 * Still a function of platform, because the answer need not be the same
 * everywhere and the Windows and macOS builds have not been used by hand yet.
 */
export function defaultEngine (platform: NodeJS.Platform = process.platform): PlayerEngine {
  switch (platform) {
    case 'linux':
    case 'win32':
    case 'darwin':
    default:
      return 'html'
  }
}

/**
 * The engine to run.
 *
 * `COCINE_PLAYER=html` or `COCINE_PLAYER=mpv` overrides the default, which is
 * how both get compared on the same machine without a rebuild. Anything else is
 * ignored rather than being an error: a typo in an environment variable should
 * not stop the application starting, it should start the one that works.
 */
export function playerEngine (
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): PlayerEngine {
  const asked = (env.COCINE_PLAYER ?? '').trim().toLowerCase()
  if (asked === 'html' || asked === 'mpv') return asked
  return defaultEngine(platform)
}

/**
 * Whether an engine can actually be run by the application today.
 *
 * Kept as a seam rather than deleted now that both work: it is the place a
 * platform-specific limitation belongs if one turns up -- a machine with no
 * X11 for the mpv path, say -- so that asking for an engine that cannot run
 * there fails with a sentence instead of a black rectangle.
 */
export function engineAvailable (engine: PlayerEngine): { ok: boolean; why?: string } {
  // Both are wired up as of B1.1: mpv into a reparented child window, and the
  // <video> element into the main window's own renderer. Which one is better is
  // the open question; which one *works* no longer is.
  void engine
  return { ok: true }
}

/** The engine to run, falling back with a warning rather than failing to start. */
export function resolveEngine (
  log: (msg: string) => void = console.warn,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): PlayerEngine {
  const wanted = playerEngine(env, platform)
  const check = engineAvailable(wanted)
  if (check.ok) return wanted
  log(`[player] COCINE_PLAYER=${wanted} requested but ${check.why} — using mpv.`)
  return 'mpv'
}
