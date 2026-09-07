# coCine transfer harness

Answers one question with data instead of intuition:

> **To what extent should coCine use WebTorrent, and what does writing our own
> scheduling policy on top of it actually buy?**

It runs a real swarm — a real tracker, real BitTorrent wire protocol, real
token-bucket rate limits — against a simulated room playhead, and reports the
metric the product actually cares about: **does anyone stall?**

## The experimental design

Three arms, run against identical scenarios:

| Arm | What it is |
|---|---|
| `stock` | WebTorrent exactly as it ships. Rarest-first over the whole file, its own choker. |
| `sequential` | WebTorrent *used well*. A rolling critical/buffer window ahead of the room playhead, driven through the public `select()` / `critical()` API. No forking. |
| `planned` | `sequential` plus the thing BitTorrent cannot express: upload allocated to whoever in the room is closest to stalling, and super-seeding from the sharer while the swarm lacks a full copy. |

Two deltas matter, and they answer different questions:

- **`stock` → `sequential`** is what *correct API usage* buys. If this is the
  large one, the lesson is "read the WebTorrent docs", not "write a scheduler".
- **`sequential` → `planned`** is what *writing your own policy* buys. This is
  the number the build-or-not decision turns on.

`planned` needs exactly one line that the public API does not offer —
`clearInterval(torrent._rechokeIntervalId)` in `src/policies.js`, to take
WebTorrent's own choker off before driving `wire.choke()` / `wire.unchoke()`
directly. That single line is the entire "fork or patch" cost, and it is worth
knowing that up front.

## Measure variance, not speed

BitTorrent is tuned to maximise each peer's own throughput. By that measure a
room-aware policy looks like a rounding error. But coCine breaks when *one*
person stalls, because synchronised playback means that stalls everyone.

So the headline metric here is **minimum buffer margin across the room**, not
mean download rate, and the room playhead only advances when *every* peer has
data ahead of it. A change that leaves completion time identical while removing
every stall is a total win for this product and would register as nothing at all
on a conventional torrent benchmark.

## Running it

```bash
npm install
npm run suite                      # every scenario, every arm
node src/suite.js scenarios/weak-peer.json          # one scenario, all arms
node src/run.js scenarios/weak-peer.json --policy=planned   # one run, verbose
```

Results land in `results/<scenario>.<policy>.json`, including the full
per-250ms sample series so you can plot margins over time. `results/.fixtures/`
caches the generated test file between runs.

## Reading the output

| Field | Meaning |
|---|---|
| `T_min` | Kumar–Ross minimum distribution time, and its three terms. The physical floor. **If an arm lands within ~10 % of it, there is nothing left to win.** |
| `watchable live?` | Whether the three conditions for uninterrupted playback hold at all: sharer upload ≥ bitrate, aggregate upload ≥ N × bitrate, every downlink ≥ bitrate. |
| `time to first frame` | When the readiness gate opened — every peer holding `startBufferSec` of contiguous video. |
| `room stalls` | Count and total seconds where at least one peer ran dry, freezing the room. |
| `min buffer margin` | Worst-case seconds of runway any peer had. The number to optimise. |
| `× T_min` | Last peer's completion time as a multiple of the theoretical floor. |

## Scenarios

Each file carries a `note` stating the prediction it is meant to test, so a
result that contradicts it is visible rather than quietly rationalised.

- **`baseline-5`** — five comparable connections. Predicted: stock already near
  optimal; custom buys ~nothing.
- **`weak-peer`** — one 5 Mbps downlink against a 4 Mbps film. Predicted: the
  largest win for `planned`, and coCine's most common real-world failure.
- **`late-joiner`** — a peer arrives 45 s in, when the others are effectively
  seeds. Predicted: both arms fine, because BitTorrent seeds don't tit-for-tat.
- **`cold-14`** — peers outnumber BitTorrent's unchoke slots, so choker rotation
  should start costing real time.
- **`freeloader`** — good downlink, almost no upload. The textbook tit-for-tat
  starvation case, and the one most likely to justify a custom policy.
- **`realistic`** — full scale, ~25 min wall clock. Run before concluding on
  time-to-first-frame; the scaled scenarios understate it.

**See `results/FINDINGS.md` for what the first run actually showed.**

Scenarios are scaled down in wall-clock time — a 60 MB "film" over 120 virtual
seconds gives a 4 Mbps bitrate — because Kumar–Ross is scale-invariant as long
as the *ratios* between file size, bitrate and link speeds are preserved. Set
`fileMB: 4000, runtimeSec: 7200` for a true-to-life run that takes 20 minutes.

## Fidelity, and its limits

Rate limiting is **application-level**, using WebTorrent's own `speed-limiter`
token buckets, and all peers share one Node process. That is honest for
measuring *scheduling policy*, which is what this harness is for: each peer
observes realistic throughput and the wire protocol is real.

It does **not** model TCP dynamics — queueing delay, loss, competing flows,
bufferbloat. If a result looks marginal and you need to trust it, re-run under
containers with real shaping:

```bash
docker run --cap-add=NET_ADMIN ...   # then: tc qdisc add dev eth0 root tbf ...
```

Docker works without sudo on this machine; `tc` needs `NET_ADMIN` inside the
container. That path is slower to set up and slower to run, so it is the
confirmation step, not the iteration loop.

Set `NOTHROTTLE=1` to disable rate limiting entirely, which is useful for
checking that a scenario is wired up correctly before trusting its numbers.

## What this does not cover

NAT traversal, WebRTC transport, and relay fallback are all out of scope —
peers here connect over loopback TCP. Those belong in a separate connectivity
test, and none of them change the scheduling answer.
