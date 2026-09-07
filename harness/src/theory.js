// Kumar-Ross minimum distribution time, and the weaker conditions for
// uninterrupted playback. This is the yardstick the harness measures against:
// if stock WebTorrent already sits near T_min there is nothing left to win.

export function bitsFromMB (mb) { return mb * 1024 * 1024 * 8 }
export function mbps (x) { return x * 1000 * 1000 }

/**
 * @param {object} s scenario
 * @returns {{tMin:number, terms:object, bitrate:number, watchable:object}}
 */
export function analyse (s) {
  const S = bitsFromMB(s.fileMB)                 // bits
  const r = S / s.runtimeSec                     // bits/sec the film consumes
  const us = mbps(s.sharer.up)
  const leechers = s.peers
  const N = leechers.length
  const sumU = leechers.reduce((a, p) => a + mbps(p.up), 0)
  const dMin = Math.min(...leechers.map(p => mbps(p.down)))

  const terms = {
    sharerUpload: S / us,
    slowestDownload: S / dMin,
    aggregateUpload: (N * S) / (us + sumU)
  }
  const tMin = Math.max(...Object.values(terms))

  // The three conditions for watching live rather than waiting for completion.
  const watchable = {
    sharerAboveBitrate: { ok: us >= r, have: us / 1e6, need: r / 1e6 },
    aggregateAboveRoom: { ok: (us + sumU) >= N * r, have: (us + sumU) / 1e6, need: (N * r) / 1e6 },
    everyDownlinkAboveBitrate: { ok: dMin >= r, have: dMin / 1e6, need: r / 1e6 }
  }
  watchable.all = Object.values(watchable).every(v => v.ok !== false)

  return { tMin, terms, bitrate: r, N, aggregate: us + sumU, watchable }
}
