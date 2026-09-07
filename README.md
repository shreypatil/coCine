# coCine

Watch a film with friends, in sync, over a peer-to-peer connection.

Phases 0 and 1 of the [build plan](#status) are implemented: mpv is driven over
JSON IPC, and a room of clients holds synchronised playback inside a 100 ms
budget across seeks, pauses and a delayed network.

## Layout

```
packages/
  protocol/   wire contract — Zod schemas shared by client and server
  sync/       clock offset + drift correction — pure, no I/O, heavily tested
  player/     mpv over JSON IPC, behind the PlayerController interface
  client/     composes socket + clock + sync engine + player
apps/
  server/     signalling: rooms, authoritative playback state
harness/      transfer benchmark (WebTorrent vs custom policy) — see its README
```

`sync/` is the component the product hinges on and it touches nothing — no
socket, no player, no clock of its own. That is what lets it be driven against
simulated time and adversarial networks with nothing running.

## Running it

```bash
npm install
npm test          # unit tests + a short synchronised-playback integration test
npm run phase0    # mpv control: event rate, command latency, seek accuracy
npm run phase1    # five clients, drift measured against a 100 ms budget
```

Both phase scripts are pass/fail against the plan's exit criteria and exit
non-zero on failure, so they work as CI gates rather than as demos.

Requires `mpv` and `ffmpeg` on PATH. Test films are generated on first run and
cached in `.fixtures/`.

### Keyboard

| Key | |
|---|---|
| `Space` | play / pause |
| `←` `→` | seek ten seconds |
| `F` | toggle fullscreen |
| `Esc` | leave fullscreen |

Shortcuts are ignored while a text field has focus.

**Fullscreen has no visible controls yet.** Nothing can be drawn over the video
until the overlay window lands after phase 3, so mpv itself reports what
happened — a keyboard hint on entering, and brief confirmations for play, pause
and seek. That is the one thing that can appear above the picture today.

## Phase 1 options

```bash
npm run phase1 -- --peers=5 --film=600 --duration=300 --events=20 \
                  --latency=40 --jitter=15 --skew=37000
```

`--latency`, `--jitter` and `--skew` simulate a real network on the server side.
They matter more than they look: **loopback has no delay and no clock offset, so
without them the clock synchronisation is never exercised at all.** `--skew`
runs the server's clock deliberately wrong by that many milliseconds; every
client has to recover it from ping exchanges alone.

The full exit criterion is a two-hour film:

```bash
npm run phase1 -- --peers=5 --film=7200 --duration=7200 --events=20 --latency=40 --jitter=15
```

## How synchronisation works

**Nobody is ever told to play now.** A command arrives at different clients at
different times and so can never produce synchronised playback. Instead the
server broadcasts an *anchor* — position `p` at server time `T` — and every
client computes where the film should be from that. A client receiving it late
is still correct; a client receiving it early holds at `p` and waits.

Three pieces make it hold:

- **Clock offset** from NTP-style exchanges, keeping the sample with the
  *lowest* round trip rather than an average. That sample queued least in each
  direction and so is the least asymmetric; averaging folds in every delayed
  sample's error.
- **Position extrapolation.** mpv reports position at ~25 Hz, so a reading can
  be 40 ms stale — 40 % of the entire budget. Advancing it at the current rate
  before use costs nothing and removes that error.
- **Correction by rate, not seek.** Drift under a second is erased by nudging
  `speed` up to ±5 % over a five-second horizon, which is inaudible. Only larger
  gaps get a seek, because a seek is always visible.

Two mpv details are load-bearing and were both found by the phase 0 check:
`--hr-seek=yes`, without which absolute seeks land on the nearest keyframe and
can be seconds out; and waiting for `playback-restart` after a seek, without
which `time-pos` reads stale and the engine corrects against a phantom drift.

## Status

| Phase | | |
|---|---|---|
| 00 | Player control spike | **done** — 25 Hz position events, sub-5 ms command RTT, 30 ms seek accuracy |
| 01 | Sync engine | **done** — 5 clients, 20 events, 40 ms ± 15 ms link, 37 s server clock skew: **p99 drift 35 ms**, 0 of 2598 samples over budget, every event re-converged in 0.3 s |
| 02 | Single-window shell | **done** — Electron with mpv reparented via `--wid`; see caveat below |
| 03 | Rooms, roles, chat | |
| 04 | Transfer | |
| 05 | Voice | |
| 06 | NAT hardening | |
| 07 | Relay mode | |
| 08 | Packaging | |

## Testing

Three layers. The first two run on every commit and put nothing on screen; the
third needs a display and is opt-in.

```bash
npm test          # layers 1 and 2 — 44 tests, ~17s
npm run test:app  # layer 3 — real Electron, ~12s
```

| Layer | What it covers | How |
|---|---|---|
| **Logic** | Sync engine, clock estimation, mpv handle parsing, and every IPC handler — dialog parenting, error propagation, room routing. | Plain unit tests. `main/handlers.ts` takes its dependencies as arguments precisely so it can be tested without Electron. |
| **Renderer** | Real layout and real clicks against the built renderer, with the preload bridge stubbed. | Headless Chromium via Playwright. A DOM emulator would not do — it performs no layout, and layout is where the bug was. |
| **Application** | The whole click path: click → preload → IPC → main handler → mpv → interface. Only the native dialog is stubbed. | Playwright's Electron support under `COCINE_HEADLESS`, which swaps the reparented player for a headless one and leaves the window hidden. |

The regression that motivated the renderer layer is worth stating, because it is
the kind a person catches by eye and a test suite usually does not. Adding a
conditionally-rendered error banner to a container using positional grid rows
(`auto auto 1fr auto`) silently shifted every later child up a row when no
banner was present: the control bar took the `1fr` and the video stage collapsed
to content height. There is now a test asserting the stage occupies exactly the
space between header and controls, with and without the banner.

`COCINE_HEADLESS=1` is a test affordance on the application itself. It is worth
knowing about because it makes the real app scriptable — everything above the
player sees the same `PlayerController` either way.

## Manual testing

Three terminals. The film can be anything mpv opens, or a generated fixture from
`.fixtures/`.

```bash
npm run server                                   # 1: signalling on :8787
npm run desktop -- --film=/path/to/film.mkv      # 2: first viewer
npm run desktop -- --film=/path/to/film.mkv      # 3: second viewer
```

Open a film by dragging it onto the window, or with the **Open film** button.
In both windows: set the same room code, press **Join room**, then press
**Play** in either one. Both should start together. The **Sync** panel shows
live drift, the estimated clock offset and the last corrective action the engine
took, which is the quickest way to see whether it is working.

`--film=` is optional and just skips the file dialog.

## What the drift numbers do and do not cover

Three dimensions matter, and they are now in different states.

**Network — covered.** `--latency`, `--jitter` and `--skew` simulate a real link
on the server side. They matter more than they look: loopback has no delay and
no clock offset, so without them the clock synchronisation is never exercised at
all. `--skew` runs the server's clock deliberately wrong by that many
milliseconds and every client has to recover it from ping exchanges alone.

**Decode load — covered.** `--res=1080` gives every client a real 1080p stream.
`--vo=null` still decodes and discards frames — measured at 5.3s of CPU for a
40s clip against 0.3s with `--vid=no`, so the decoding is genuinely happening —
which means realistic load can be applied with nothing on screen.

```bash
npm run phase1:heavy    # 5 clients each decoding 1080p
```

This is a pessimistic test: one machine carries five decoders that would each be
on separate hardware in reality. It passes, but with visibly less headroom than
the cheap fixture — p99 47 ms against 35 ms, and a worst case of 97 ms that
nearly touches the budget. Worth remembering if the budget is ever tightened.

**Display presentation — not covered, and probably second-order.** Every
automated run uses `--vo=null`, so no frames are presented to a display.
mpv's `video-sync` defaults to `audio`, meaning reported playback position
follows the audio clock rather than the display refresh, so the video output
driver should have little effect on the number the sync engine reads. That is an
argument, not a measurement.

Closing it properly needs a virtual display, which on this machine needs a full
`pacman -Syu` first — the installed `xorg-server-xvfb` is built against a newer
nettle than the system has. Not worth a 1000-package upgrade for one test. The
cheaper route is manual testing with two app instances, which exercises the
embedded player with real video output on real hardware.

```bash
Xvfb :99 &                                    # once the system is current
DISPLAY=:99 npm run phase1 -- --headless=0 --peers=4 --duration=120
```

Never run `--headless=0` on your own display: it opens one video window per
client. The flag warns and pauses before doing so.

## Notes

`npm` workspaces rather than `pnpm`, because npm's global prefix here is `/usr`
and installing pnpm needs root. Switching later is a `pnpm import` away and
changes nothing structural.
