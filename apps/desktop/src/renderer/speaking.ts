/**
 * Who is talking right now.
 *
 * Measured from the audio itself rather than announced over the wire. Sending a
 * `speaking` flag through the room would broadcast full room state on every
 * utterance -- several times a second per person -- and it would also be a
 * claim rather than an observation. Reading the level of the stream you are
 * actually playing means the dot lights up when you can genuinely hear someone,
 * and stays dark when their microphone is captured but silent.
 *
 * That doubles as the only honest way to tell "the system is not letting the
 * application use the microphone" from "nobody is saying anything": your own
 * dot never lights, whatever you do.
 */

export interface GateOptions {
  /** RMS above which speech starts. */
  on?: number
  /** RMS below which it may stop. Lower than `on`, so a voice at the threshold
   *  does not strobe the indicator on every syllable. */
  off?: number
  /** How long it must stay quiet before the dot goes out. Covers the gaps
   *  between words, which are longer than they feel. */
  holdMs?: number
}

const DEFAULTS = { on: 0.02, off: 0.012, holdMs: 400 }

/**
 * Level in, speaking-or-not out. Pure and clock-injected, so the hysteresis and
 * the hold can be tested without any audio at all.
 */
export class SpeechGate {
  private speaking = false
  /** When we last actually heard them, which is what the hold runs from. Timing
   *  it from the first quiet sample instead makes the hold depend on the
   *  sampling interval rather than on the speech. */
  private lastLoudMs: number | null = null
  private readonly o: Required<GateOptions>

  constructor (o: GateOptions = {}) { this.o = { ...DEFAULTS, ...o } }

  update (level: number, nowMs: number): boolean {
    // Harder to start than to continue: a voice sitting near the threshold
    // would otherwise strobe the indicator on every syllable.
    if (level >= (this.speaking ? this.o.off : this.o.on)) {
      this.lastLoudMs = nowMs
      this.speaking = true
      return true
    }
    if (this.speaking && this.lastLoudMs !== null && nowMs - this.lastLoudMs >= this.o.holdMs) {
      this.speaking = false
    }
    return this.speaking
  }

  get isSpeaking (): boolean { return this.speaking }
}

/** Root-mean-square of a frame, which is loudness rather than peak: a single
 *  click should not light the dot, a quiet sustained voice should. */
export function rms (frame: Float32Array | number[]): number {
  if (frame.length === 0) return 0
  let sum = 0
  for (const v of frame) sum += v * v
  return Math.sqrt(sum / frame.length)
}

interface Watched {
  source: MediaStreamAudioSourceNode
  analyser: AnalyserNode
  gate: SpeechGate
  /** Explicitly backed by an ArrayBuffer: the default generic also admits
   *  SharedArrayBuffer, which getFloatTimeDomainData will not take. */
  frame: Float32Array<ArrayBuffer>
}

/**
 * Watches several streams at once and reports who is speaking.
 *
 * One AudioContext for all of them: contexts are a limited resource and
 * Chromium warns after a handful.
 */
export class SpeakingDetector {
  private ctx: AudioContext | null = null
  private readonly watched = new Map<string, Watched>()
  private timer: number | null = null

  constructor (
    private readonly onChange: (speaking: Record<string, boolean>) => void,
    private readonly now: () => number = () => performance.now()
  ) {}

  watch (id: string, stream: MediaStream): void {
    if (this.watched.has(id)) this.unwatch(id)
    // Created lazily: constructing an AudioContext before any call exists would
    // be suspended by autoplay policy and warn in the console for nothing.
    this.ctx ??= new AudioContext()
    void this.ctx.resume()
    const source = this.ctx.createMediaStreamSource(stream)
    const analyser = this.ctx.createAnalyser()
    // Small enough to react within a syllable, large enough that RMS is stable.
    analyser.fftSize = 1024
    source.connect(analyser)
    this.watched.set(id, {
      source, analyser, gate: new SpeechGate(), frame: new Float32Array(new ArrayBuffer(analyser.fftSize * 4))
    })
    this.start()
  }

  unwatch (id: string): void {
    const w = this.watched.get(id)
    if (!w) return
    try { w.source.disconnect() } catch { /* already gone */ }
    this.watched.delete(id)
    if (this.watched.size === 0) this.stop()
    // Report immediately rather than waiting for the next tick -- which, for
    // the last stream, never comes. Otherwise somebody who leaves mid-sentence
    // keeps a lit dot for as long as the panel is open.
    this.emit()
  }

  /** The current picture, without sampling: used when the set changes. */
  private emit (): void {
    const out: Record<string, boolean> = {}
    for (const [id, w] of this.watched) out[id] = w.gate.isSpeaking
    this.onChange(out)
  }

  private start (): void {
    if (this.timer !== null) return
    // A timer rather than requestAnimationFrame: this has to keep working while
    // the window is in the background, and rAF does not.
    this.timer = setInterval(() => this.tick(), 100) as unknown as number
  }

  private stop (): void {
    if (this.timer !== null) { clearInterval(this.timer); this.timer = null }
  }

  private tick (): void {
    const now = this.now()
    const out: Record<string, boolean> = {}
    for (const [id, w] of this.watched) {
      w.analyser.getFloatTimeDomainData(w.frame)
      out[id] = w.gate.update(rms(w.frame), now)
    }
    this.onChange(out)
  }

  close (): void {
    for (const id of [...this.watched.keys()]) this.unwatch(id)
    this.stop()
    void this.ctx?.close().catch(() => { /* already closed */ })
    this.ctx = null
  }
}
