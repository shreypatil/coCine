# Findings — first run

Five scenarios, three arms each, WebTorrent 3.0.21, Node 25.4. Raw numbers in
`FINAL.txt`; per-run JSON with full 250 ms sample series alongside it.
Regenerate the table from saved runs at any time with `node src/restat.js`.

## Result

**No scenario in this suite showed a custom scheduling policy beating WebTorrent.**
In most, plain stock WebTorrent was already within noise of the best arm.

| Scenario | T_min | stock | sequential | planned | stalls (any arm) |
|---|---|---|---|---|---|
| `baseline-5` | 20.1s | **1.90×** | 1.97× | 1.92× | none |
| `cold-14` | 21.4s | 1.82× | 1.92× | **1.78×** | none |
| `freeloader` | 20.1s | 2.32× | **2.01×** | 2.11× | none |
| `late-joiner` | 20.1s | 2.51× | 2.52× | 2.52× | one ~2s stall, all arms |
| `weak-peer` | 100.7s | **1.01×** | 1.01× | 1.01× | none |

Spread between arms is 1–15 %, and the ordering is not stable across scenarios —
`stock` wins two, `planned` wins one, `sequential` wins one. That is noise, not
a signal.

## What each scenario actually showed

**`baseline-5` — prediction held.** Comparable connections, three arms
indistinguishable. Nothing to win.

**`weak-peer` — prediction wrong, and instructively so.** Every arm landed at
**1.01× T_min**: the theoretical floor, hit exactly. The binding term is
`S / d_min` — the weak peer's downlink — and no allocation policy can beat a
peer's own pipe. Nobody stalled either, because 5 Mbps down against a 4.2 Mbps
film still keeps up. *A weak peer is a physics problem, not a scheduling
problem.* The product answer is to detect it and say so, not to schedule around
it.

**`freeloader` — prediction wrong.** A peer with 1 Mbps upload and a healthy
downlink was expected to be starved by tit-for-tat. It wasn't. Two reasons:
the sharer is a seed and **seeds don't tit-for-tat** (BitTorrent's seed choking
is round-robin on upload rate), and in a five-peer room WebTorrent's unchoke
slots outnumber the peers, so the choker barely engages. This was the scenario
most likely to justify a custom policy, and it didn't.

**`late-joiner` — prediction held.** All three arms took one ~2s stall when Sam
joined and were otherwise identical. Seeds serve newcomers fine.

**`cold-14` — found a bug in my own policy, not in WebTorrent.** The first run
had `planned` at **3.38× T_min against stock's 1.85×** — nearly twice as slow.
Cause: a hardcoded 4 upload slots, so in a 15-peer room the max-min choker was
choking 10 of every peer's 14 wires and collapsing aggregate throughput. With
slots scaled to room size it recovered to 1.78×, marginally ahead of stock.
Worth keeping in view: **a naive max-min allocator is easy to write and easy to
make actively worse than the default.**

## Recommendation

**Do not write the scheduler. Use WebTorrent, drive `select()` and `critical()`
from the playhead, and spend the time on the sync engine and the UI instead.**

The one piece of the custom design that survives is not a scheduler at all —
it is the **readiness gate and honest reporting**: measure capacity, compute
`T_min`, show a real countdown, and name the peer who is the bottleneck. That
is where `weak-peer` says the product value is, and it needs no policy layer.

Revisit this if any of the caveats below turn out to matter.

## Caveats — read before trusting this

1. **Scale.** Scenarios use a 60 MB file over 120 virtual seconds. A 20 s start
   buffer is a *sixth* of that file, so "contiguous from byte 0" arrives fast
   under any picker — which **structurally understates what sequential selection
   buys for time-to-first-frame**. On a real 4 GB film that buffer is under one
   per cent of the file and rarest-first should look far worse. `realistic.json`
   runs the full-scale version; do that before concluding on TTFF.
2. **No latency or loss.** Peers talk over loopback. Real RTT changes how
   BitTorrent's request pipelining behaves, and it is the largest fidelity gap
   here. Re-run under Docker with `tc netem` to confirm anything marginal.
3. **No TCP dynamics.** Rate limiting is application-level token buckets, so
   queueing, congestion control interaction and bufferbloat are absent.
4. **One process.** All peers share a Node event loop.
5. **`planned` is one implementation of the idea, not the best one.** It shows
   the idea is not *free*; it does not prove no policy could win.
