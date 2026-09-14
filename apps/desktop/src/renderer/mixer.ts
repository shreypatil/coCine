/**
 * The local mixer: how loud each person in the call is, on this machine.
 *
 * Everything here is local state applied to element properties. Nothing is
 * sent anywhere -- turning somebody down is your business, not the room's --
 * and it is per session on purpose: member ids are minted per connection, so
 * a setting keyed by one would not survive a rejoin anyway, and keying by name
 * misbehaves for two people called sam.
 *
 * Gain stays at or below one. Boosting a quiet person mostly amplifies their
 * room and, on a marginal speakers-and-microphone setup, can tip the echo the
 * canceller cannot hear into feedback. Somebody too quiet is fixed at their
 * end.
 */

export const FULL = 100

export interface Levels {
  /** Slider position per member, 0-100. Absent means full. */
  level: Record<string, number>
  /** Muted for me alone -- distinct from the host asking them to mute, which
   *  is advisory and theirs to obey. This one is local and absolute. */
  muted: Record<string, boolean>
}

export const EMPTY: Levels = { level: {}, muted: {} }

/** What the interface shows for someone: their slider, full if untouched. */
export function levelOf (m: Levels, id: string): number {
  return m.level[id] ?? FULL
}

/**
 * A slider position as an element volume.
 *
 * Squared rather than linear: loudness is perceived roughly logarithmically,
 * and a straight map puts most of the useful range in the bottom quarter of
 * the slider. Half way sounds about half as loud this way.
 */
export function gainFor (level: number): number {
  const l = Math.min(FULL, Math.max(0, level)) / FULL
  return l * l
}

/**
 * What one element should be set to, all things considered.
 *
 * Composed in one place because two writers to one control is exactly the bug
 * the film's volume once had: deafen wrote `muted`, the slider wrote `volume`,
 * and whichever came last decided. Here deafening and a local mute both leave
 * the slider where it was, so undeafening restores each person's own level
 * rather than resetting everybody.
 */
export function outputFor (m: Levels, id: string, deafened: boolean): { volume: number; muted: boolean } {
  return { volume: gainFor(levelOf(m, id)), muted: deafened || !!m.muted[id] }
}

/** The two properties this touches on an <audio> element. */
export interface Output { volume: number; muted: boolean }

/** Write the mixer onto every element. Idempotent, so it can run on any change. */
export function applyMixer (elements: Iterable<[string, Output]>, m: Levels, deafened: boolean): void {
  for (const [id, el] of elements) {
    const o = outputFor(m, id, deafened)
    if (el.volume !== o.volume) el.volume = o.volume
    if (el.muted !== o.muted) el.muted = o.muted
  }
}

/** Forget people who are no longer here. */
export function prune (m: Levels, present: Iterable<string>): Levels {
  const keep = new Set(present)
  const level: Record<string, number> = {}
  const muted: Record<string, boolean> = {}
  for (const [id, v] of Object.entries(m.level)) if (keep.has(id)) level[id] = v
  for (const [id, v] of Object.entries(m.muted)) if (keep.has(id)) muted[id] = v
  return { level, muted }
}

/**
 * Whether the microphone is live and whether the film should duck, from the
 * controls as they stand. One function so the two can never disagree: the film
 * ducks only while the microphone is actually sending, and only for people who
 * want it to.
 */
export function micState (o: {
  inVoice: boolean; muted: boolean; pushToTalk: boolean; talking: boolean; ducking: boolean
}): { mic: boolean; duck: boolean } {
  const mic = o.inVoice && !o.muted && (!o.pushToTalk || o.talking)
  return { mic, duck: mic && o.ducking }
}

const DUCKING_KEY = 'cocine.ducking'

/** The per-machine ducking preference. On unless somebody turned it off. */
export function loadDucking (storage: Pick<Storage, 'getItem'> | null): boolean {
  try { return storage?.getItem(DUCKING_KEY) !== 'off' } catch { return true }
}

export function saveDucking (storage: Pick<Storage, 'setItem'> | null, on: boolean): void {
  try { storage?.setItem(DUCKING_KEY, on ? 'on' : 'off') } catch { /* a preference, not a fact */ }
}
