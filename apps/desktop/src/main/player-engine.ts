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
 * The default per platform, for when nothing has been chosen explicitly.
 *
 * mpv everywhere for now. It is the shipped, exercised path, and B1 has not yet
 * wired the `<video>` player into the renderer -- see `engineAvailable`. When
 * that lands and both have been tried by hand, this is the line to change, and
 * it is deliberately a function of platform so the answer can differ.
 */
export function defaultEngine (platform: NodeJS.Platform = process.platform): PlayerEngine {
  switch (platform) {
    case 'linux':
    case 'win32':
    case 'darwin':
    default:
      return 'mpv'
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
 * The `<video>` player exists and is proven -- `npm run phase0:html`,
 * `npm run phase1:html` and `npm run b1-gate` all drive it -- but through its
 * own hidden host process, which has no surface anybody can see. Putting it on
 * screen means rendering it in the main window, which is B1.1.
 *
 * Reported rather than assumed so that asking for it before then fails with a
 * sentence instead of a black rectangle.
 */
export function engineAvailable (engine: PlayerEngine): { ok: boolean; why?: string } {
  if (engine === 'mpv') return { ok: true }
  return {
    ok: false,
    why: 'the <video> player is not wired into the window yet (phase B1.1). ' +
      'It can be driven headlessly today: npm run phase0:html, npm run phase1:html, npm run b1-gate.'
  }
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
