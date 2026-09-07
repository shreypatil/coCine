/**
 * NTP-style clock offset estimation over the existing WebSocket.
 *
 * Four timestamps per exchange: c1 (client send), s1 (server receive),
 * s2 (server send), c2 (client receive). From those,
 *
 *   offset = ((s1 - c1) + (s2 - c2)) / 2
 *   rtt    = (c2 - c1) - (s2 - s1)
 *
 * The offset estimate is only as good as the symmetry of the path, so rather
 * than averaging we keep the sample with the *lowest* round trip in a sliding
 * window. That one queued the least in each direction and is therefore the
 * least asymmetric -- averaging would fold every delayed sample's error in.
 */
export interface ClockSample { offsetMs: number; rttMs: number; atMs: number }

export interface ClockSyncOptions {
  /** How many recent samples to choose the best from. */
  windowSize?: number
  /** Samples older than this are dropped even if they were the best. */
  maxAgeMs?: number
}

export class ClockSync {
  private samples: ClockSample[] = []
  private readonly windowSize: number
  private readonly maxAgeMs: number

  constructor (opts: ClockSyncOptions = {}) {
    this.windowSize = opts.windowSize ?? 16
    this.maxAgeMs = opts.maxAgeMs ?? 120_000
  }

  addExchange (c1: number, s1: number, s2: number, c2: number): ClockSample {
    const offsetMs = ((s1 - c1) + (s2 - c2)) / 2
    const rttMs = (c2 - c1) - (s2 - s1)
    const sample: ClockSample = { offsetMs, rttMs, atMs: c2 }
    this.samples.push(sample)
    if (this.samples.length > this.windowSize) this.samples.shift()
    return sample
  }

  private best (nowMs: number): ClockSample | null {
    const lowestRtt = (acc: ClockSample | null, s: ClockSample): ClockSample =>
      !acc || s.rttMs < acc.rttMs ? s : acc
    const fresh = this.samples.filter(s => nowMs - s.atMs <= this.maxAgeMs)
    if (fresh.length > 0) return fresh.reduce(lowestRtt, null)
    // Everything has aged out. Still prefer the cleanest sample rather than the
    // newest: clock offset drifts at parts per million, so a stale estimate is
    // barely wrong, whereas a congested sample was wrong the moment it was taken.
    return this.samples.reduce(lowestRtt, null)
  }

  /** Estimated offset to add to local time to obtain server time. */
  offsetMs (nowMs = Date.now()): number { return this.best(nowMs)?.offsetMs ?? 0 }

  /** Round trip of the sample the offset came from -- the honest error bound. */
  rttMs (nowMs = Date.now()): number { return this.best(nowMs)?.rttMs ?? 0 }

  /** Half the best round trip: the most this estimate should be off by. */
  uncertaintyMs (nowMs = Date.now()): number { return this.rttMs(nowMs) / 2 }

  serverNow (nowMs = Date.now()): number { return nowMs + this.offsetMs(nowMs) }

  get sampleCount (): number { return this.samples.length }
  get ready (): boolean { return this.samples.length > 0 }
}
