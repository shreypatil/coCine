import { positionAt, type PlaybackState } from '@cocine/protocol'

export interface SyncConfig {
  /** Drift we do not bother correcting. Below this, correcting costs more
   *  audible disturbance than it removes. */
  deadbandSec: number
  /** Above this, a rate nudge would take too long to converge; seek instead. */
  seekThresholdSec: number
  /** Seconds over which a rate nudge should erase the drift. */
  correctionHorizonSec: number
  /** Largest rate deviation from 1.0. Five per cent is inaudible on speech
   *  and invisible on video; beyond that people notice pitch. */
  maxRateDeviation: number
  /** Lead added when seeking to catch up, to cover the seek itself. */
  seekLeadSec: number
}

/**
 * Tuned against the phase 1 drift test, not guessed.
 *
 * The deadband is the binding constraint and it is easy to get wrong: every
 * client is allowed to rest anywhere inside it, so the *room* spread can reach
 * twice the deadband before the engine does anything at all. A 30 ms deadband
 * against a 100 ms room budget measured p99 134 ms across five clients — over
 * budget purely from clients resting at opposite edges. Size it against each
 * client's share of the budget, not the whole of it.
 *
 * The horizon then has to come down with it: correcting a 30 ms error over a
 * five-second horizon asks for a 0.6 % rate change, which is slower than the
 * players drift apart, so the controller never catches up.
 */
export const DEFAULT_SYNC_CONFIG: SyncConfig = {
  deadbandSec: 0.012,
  seekThresholdSec: 1.0,
  correctionHorizonSec: 2,
  maxRateDeviation: 0.05,
  seekLeadSec: 0.05
}

export type SyncAction =
  | { type: 'none' }
  | { type: 'seek'; toSec: number; reason: string }
  | { type: 'play'; reason: string }
  | { type: 'pause'; reason: string }
  | { type: 'setRate'; rate: number; driftSec: number }

export interface PlayerSnapshot {
  positionSec: number
  /** Local ms at which positionSec was observed. */
  observedAtMs: number
  paused: boolean
  rate: number
}

export interface TickInput {
  target: PlaybackState
  /** Estimated server time now. */
  serverNowMs: number
  /** Local time now, for extrapolating a stale position reading. */
  localNowMs: number
  player: PlayerSnapshot
  config?: SyncConfig
}

/**
 * A position observation can be up to a frame old -- 40 ms at 25 fps, which is
 * 40 % of the entire sync budget. Extrapolating it forward at the current rate
 * costs nothing and removes that error before it reaches the controller.
 */
export function extrapolatePosition (p: PlayerSnapshot, localNowMs: number): number {
  if (p.paused) return p.positionSec
  const elapsed = Math.max(0, localNowMs - p.observedAtMs) / 1000
  return p.positionSec + elapsed * p.rate
}

/**
 * The whole sync decision, as one pure function of state. No clock of its own,
 * no player, no socket -- which is what lets it be tested against simulated
 * time and adversarial network conditions with nothing running.
 */
export function tick (input: TickInput): SyncAction {
  const cfg = input.config ?? DEFAULT_SYNC_CONFIG
  const { target, serverNowMs, localNowMs, player } = input
  const here = extrapolatePosition(player, localNowMs)

  if (target.kind === 'idle') {
    return player.paused ? { type: 'none' } : { type: 'pause', reason: 'nothing loaded' }
  }

  if (target.kind === 'paused') {
    if (!player.paused) return { type: 'pause', reason: 'room is paused' }
    if (Math.abs(here - target.positionSec) > cfg.deadbandSec) {
      return { type: 'seek', toSec: target.positionSec, reason: 'aligning while paused' }
    }
    if (player.rate !== 1) return { type: 'setRate', rate: 1, driftSec: 0 }
    return { type: 'none' }
  }

  // Scheduled start that has not arrived yet: sit at the anchor position,
  // paused, and wait. Arriving early is not a reason to start early.
  if (serverNowMs < target.atServerMs) {
    if (!player.paused) return { type: 'pause', reason: 'waiting for scheduled start' }
    if (Math.abs(here - target.positionSec) > cfg.deadbandSec) {
      return { type: 'seek', toSec: target.positionSec, reason: 'pre-positioning for scheduled start' }
    }
    return { type: 'none' }
  }

  const expected = positionAt(target, serverNowMs)!
  const drift = here - expected

  if (Math.abs(drift) > cfg.seekThresholdSec) {
    return { type: 'seek', toSec: expected + cfg.seekLeadSec, reason: `drift ${drift.toFixed(2)}s exceeds seek threshold` }
  }

  if (player.paused) return { type: 'play', reason: 'room is playing' }

  if (Math.abs(drift) <= cfg.deadbandSec) {
    return player.rate === 1 ? { type: 'none' } : { type: 'setRate', rate: 1, driftSec: drift }
  }

  // Ahead of the room -> slow down; behind -> speed up. Erase the gap over the
  // correction horizon rather than instantly, so the change stays imperceptible.
  const raw = 1 - drift / cfg.correctionHorizonSec
  const rate = Math.min(1 + cfg.maxRateDeviation, Math.max(1 - cfg.maxRateDeviation, raw))
  if (Math.abs(rate - player.rate) < 0.002) return { type: 'none' }
  return { type: 'setRate', rate, driftSec: drift }
}
