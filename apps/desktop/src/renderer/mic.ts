/**
 * Is the microphone actually delivering anything, and which devices exist.
 *
 * `getUserMedia` succeeding is not the same as sound arriving. Bluetooth
 * earbuds have two mutually exclusive modes -- A2DP, high-quality playback with
 * no microphone, and HFP, a microphone at phone quality -- and the system has
 * to switch them when an app opens the mic. When that switch loses a race or
 * is refused (a phone holding the link, typically), the "microphone" the app
 * is handed exists and is silent. Chromium reports this on the track as
 * `muted`, meaning no frames are arriving, and fires `unmute` when they start.
 *
 * Every OS has a version of this, so none of it is platform code. The remedy
 * that works in practice is the one people discover by accident -- opening a
 * second app that uses the microphone makes the first start working -- because
 * a fresh capture request gives the system another go at the switch. So a
 * silent microphone is asked for again, a few times, before giving up and
 * saying so.
 *
 * Pure and clock-injected, like the speaking gate: the decisions are tested
 * without a device, and the wiring to real tracks is a few lines in useVoice.
 */

export interface TrackLike {
  muted: boolean
  readyState?: string
  addEventListener: (type: 'mute' | 'unmute' | 'ended', cb: () => void) => void
  removeEventListener: (type: 'mute' | 'unmute' | 'ended', cb: () => void) => void
}

export type MicHealth = 'live' | 'silent' | 'ended'

export interface MicWatchOptions {
  /** How long a freshly opened track may stay muted before it counts as silent.
   *  Bluetooth profile switches take a second or so; this must outlast them. */
  graceMs?: number
  now?: () => number
  setTimeout?: (fn: () => void, ms: number) => unknown
  clearTimeout?: (h: unknown) => void
}

/**
 * Watches one track and reports when its health changes.
 *
 * `live` once frames arrive (or immediately, if they already are); `silent`
 * when the track has been muted for longer than the grace period; `ended` when
 * the device went away. Reports each change once.
 */
export class MicWatch {
  private track: TrackLike | null = null
  private timer: unknown = null
  private last: MicHealth | null = null
  private readonly graceMs: number
  private readonly setT: (fn: () => void, ms: number) => unknown
  private readonly clearT: (h: unknown) => void
  private readonly onMute = (): void => this.arm()
  private readonly onUnmute = (): void => this.report('live')
  private readonly onEnded = (): void => this.report('ended')

  constructor (private readonly onChange: (h: MicHealth) => void, o: MicWatchOptions = {}) {
    this.graceMs = o.graceMs ?? 1500
    this.setT = o.setTimeout ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearT = o.clearTimeout ?? (h => clearTimeout(h as ReturnType<typeof setTimeout>))
  }

  watch (track: TrackLike): void {
    this.unwatch()
    this.track = track
    this.last = null
    track.addEventListener('mute', this.onMute)
    track.addEventListener('unmute', this.onUnmute)
    track.addEventListener('ended', this.onEnded)
    if (track.muted) this.arm()
    else this.report('live')
  }

  unwatch (): void {
    if (this.timer) { this.clearT(this.timer); this.timer = null }
    if (this.track) {
      this.track.removeEventListener('mute', this.onMute)
      this.track.removeEventListener('unmute', this.onUnmute)
      this.track.removeEventListener('ended', this.onEnded)
      this.track = null
    }
  }

  private arm (): void {
    if (this.timer) return
    this.timer = this.setT(() => {
      this.timer = null
      // Still muted after the grace period: that is silence, not a switch.
      if (this.track?.muted) this.report('silent')
    }, this.graceMs)
  }

  private report (h: MicHealth): void {
    if (this.timer && h === 'live') { this.clearT(this.timer); this.timer = null }
    if (h === this.last) return
    this.last = h
    this.onChange(h)
  }
}

/**
 * How many times to ask for the microphone again before giving up, and how
 * long to wait between attempts. Three attempts two seconds apart covers the
 * time a headset takes to change profile, and is short enough that the
 * message, when it comes, comes while the person is still looking.
 */
export const REACQUIRE_ATTEMPTS = 3
export const REACQUIRE_DELAY_MS = 2000

export interface AudioDevice { id: string; label: string }
export interface AudioDevices { inputs: AudioDevice[]; outputs: AudioDevice[] }

/**
 * The microphones and speakers the system offers, with usable names.
 *
 * Labels are only revealed once the page has used the microphone, so this is
 * asked after `getUserMedia` and again on `devicechange`. A device with no
 * label is still listed -- picking it is better than not being able to -- but
 * named from its position.
 */
export function audioDevices (all: Array<{ kind: string; deviceId: string; label: string }>): AudioDevices {
  const name = (d: { label: string }, kind: string, i: number): string => d.label || `${kind} ${i + 1}`
  const inputs = all.filter(d => d.kind === 'audioinput' && d.deviceId)
  const outputs = all.filter(d => d.kind === 'audiooutput' && d.deviceId)
  return {
    inputs: inputs.map((d, i) => ({ id: d.deviceId, label: name(d, 'Microphone', i) })),
    outputs: outputs.map((d, i) => ({ id: d.deviceId, label: name(d, 'Speaker', i) }))
  }
}

const INPUT_KEY = 'cocine.mic'
const OUTPUT_KEY = 'cocine.speaker'

/** The remembered device choice, or null for the system default. */
export function loadDevice (storage: Pick<Storage, 'getItem'> | null, which: 'input' | 'output'): string | null {
  try { return storage?.getItem(which === 'input' ? INPUT_KEY : OUTPUT_KEY) || null } catch { return null }
}

export function saveDevice (storage: Pick<Storage, 'setItem' | 'removeItem'> | null, which: 'input' | 'output', id: string | null): void {
  const key = which === 'input' ? INPUT_KEY : OUTPUT_KEY
  try { if (id) storage?.setItem(key, id); else storage?.removeItem(key) } catch { /* a preference */ }
}

/**
 * The constraint to ask for a particular microphone with.
 *
 * `exact` rather than `ideal` on purpose: a person who chose the laptop
 * microphone because the earbuds are misbehaving must not be quietly handed
 * the earbuds again. If the chosen device has gone, the request fails with
 * OverconstrainedError and the caller falls back to the default, visibly.
 */
export function micConstraints (deviceId: string | null): MediaStreamConstraints {
  return {
    audio: {
      echoCancellation: true, noiseSuppression: true, autoGainControl: true,
      ...(deviceId ? { deviceId: { exact: deviceId } } : {})
    },
    video: false
  }
}

/** What to tell somebody whose microphone opened and stayed silent. */
export function silentMicMessage (label: string | undefined, gaveUp: boolean): string {
  const which = label && label !== 'Default' ? `"${label}"` : 'Your microphone'
  return gaveUp
    ? `${which} is not sending any sound. Bluetooth earbuds may be in music-only mode — reconnect them, or choose another microphone below.`
    : `${which} is not sending any sound yet — asking for it again…`
}
