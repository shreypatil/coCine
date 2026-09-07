// Three arms of the experiment.
//
//   stock       WebTorrent exactly as it ships: rarest-first over the whole file.
//   sequential  WebTorrent used well: a rolling critical window ahead of the
//               room playhead, driven through the public select/critical API.
//   planned     sequential, plus the thing BitTorrent cannot express -- upload
//               allocated to whoever in the room is closest to stalling.
//
// The stock -> sequential delta is what correct API usage buys you.
// The sequential -> planned delta is what writing your own policy buys you.
// That second number is the one the decision actually turns on.

const HIGH = 1

function pieceRange (torrent, fromSec, toSec, bytesPerSec) {
  const len = torrent.pieceLength
  const last = torrent.pieces.length - 1
  const a = Math.max(0, Math.min(last, Math.floor((fromSec * bytesPerSec) / len)))
  const b = Math.max(a, Math.min(last, Math.ceil((toSec * bytesPerSec) / len)))
  return [a, b]
}

export const stock = {
  name: 'stock',
  describe: 'WebTorrent defaults, untouched',
  init () {},
  tick () {}
}

export const sequential = {
  name: 'sequential',
  describe: 'rolling critical + buffer window via select()/critical()',
  init (ctx) {
    for (const p of ctx.leechers) p._win = null
  },
  tick (ctx) {
    const { room, cfg, bytesPerSec } = ctx
    for (const p of ctx.leechers) {
      if (!p.torrent || p.torrent.done) continue
      const t = room.playheadSec
      const [c0, c1] = pieceRange(p.torrent, t, t + cfg.criticalSec, bytesPerSec)
      const [, b1] = pieceRange(p.torrent, t, t + cfg.bufferSec, bytesPerSec)

      // critical() only sets flags and is idempotent; re-issue as the window moves.
      if (!p._win || p._win.c1 !== c1) p.torrent.critical(c0, c1)

      // select() accumulates, so retire the previous window before adding one.
      if (!p._win || p._win.b1 !== b1) {
        if (p._win) p.torrent.deselect(p._win.b0, p._win.b1)
        p.torrent.select(c0, b1, HIGH)
        p._win = { b0: c0, b1, c1 }
      } else {
        p._win.c1 = c1
      }
    }
  }
}

export const planned = {
  name: 'planned',
  describe: 'sequential + max-min buffer-margin upload allocation',
  init (ctx) {
    sequential.init(ctx)
    // Take the choker off WebTorrent. This is the one thing that is not
    // reachable through the public API -- it needs exactly this line.
    for (const p of ctx.all) {
      if (p.torrent) clearInterval(p.torrent._rechokeIntervalId)
    }
  },
  tick (ctx) {
    sequential.tick(ctx)
    const { cfg, peersById, swarmHasFullCopy } = ctx

    // Rank everyone who still needs bytes by how close they are to stalling.
    const needy = ctx.leechers
      .filter(p => p.joined && p.torrent && !p.torrent.done)
      .sort((a, b) => a.marginSec - b.marginSec)
    const rank = new Map(needy.map((p, i) => [p.name, i]))

    for (const up of ctx.all) {
      if (!up.torrent) continue
      // While no full copy exists anywhere but the sharer, the sharer's upload
      // is the scarcest resource in the system: spend it on the peers who will
      // re-seed it fastest rather than on whoever is most desperate.
      const superseeding = cfg.superseed && up.isSharer && !swarmHasFullCopy()

      const scored = []
      for (const wire of up.torrent.wires) {
        const target = peersById.get(wire.peerId)
        if (!target) { ctx.unmapped = (ctx.unmapped || 0) + 1; continue }
        ctx.mapped = (ctx.mapped || 0) + 1
        const score = superseeding
          ? -target.up                       // highest upload capacity first
          : (rank.has(target.name) ? rank.get(target.name) : Infinity)
        scored.push({ wire, score })
      }
      scored.sort((a, b) => a.score - b.score)

      scored.forEach(({ wire }, i) => {
        const want = i < cfg.uploadSlots
        if (want && wire.amChoking) wire.unchoke()
        else if (!want && !wire.amChoking) wire.choke()
      })
    }
  }
}

export const policies = { stock, sequential, planned }
