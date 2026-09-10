# coCine

Watch a film with friends, in sync, over a peer-to-peer connection.

Phases 0 through 8 of the [build plan](#status) are implemented: mpv is driven
over JSON IPC inside an Electron shell, a room of clients holds synchronised
playback inside a 100 ms budget, the film is distributed peer to peer over
BitTorrent while it plays, voice runs as a WebRTC mesh, voice falls back to a
TURN relay where a direct connection is impossible, and a room that cannot use
the swarm at all can fall back to fetching the film from object storage.

What remains is in [docs/TODO.md](docs/TODO.md). The largest item is not code:
everything so far has been verified on one machine, and the peer-to-peer parts
need two real machines on two real networks to be meaningfully tested.

## Layout

```
packages/
  protocol/   wire contract — Zod schemas shared by client and server
  sync/       clock offset + drift correction — pure, no I/O, heavily tested
  player/     mpv over JSON IPC, behind the PlayerController interface
  client/     composes socket + clock + sync engine + player + transfer
  voice/      WebRTC mesh state machine — pure, driven with fake connections
apps/
  server/     signalling: rooms, playback authority, tracker, readiness, TURN
  desktop/    Electron main + preload + React renderer
harness/      transfer benchmark (WebTorrent vs custom policy) — see its README
infra/        coturn configuration for the voice relay
docs/         testing checklist and the outstanding-work list
types/        ambient declarations for webtorrent and bittorrent-tracker
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
npm run phase4    # a swarm fetching a film: readiness gate, sync during transfer
npm run phase7    # relay mode carrying a film, and what a session actually costs
npm run nat-check # what this machine's network will do to a peer connection
```

Building installers:

```bash
node scripts/fetch-mpv.mjs win      # mpv; only Windows and macOS need it
node scripts/fetch-ffmpeg.mjs linux # ffmpeg; every platform needs it
COCINE_DEFAULT_SERVER=wss://your-server npm run dist:linux
COCINE_DEFAULT_SERVER=wss://your-server npm run dist:win
```

`npm run audit-native` lists every shipped dependency with native code and how
each finds its binary — the check that answers "what else could break on another
platform?". Each `dist:*` goes through `scripts/dist.mjs`, which stages the target platform's
native WebRTC binaries (`fetch-native.mjs`), swaps in the one that cannot be
injected, builds, restores the tree, and then reads the finished artifact
(`check-package.mjs`) — refusing to ship a package whose addons are missing,
built for the wrong platform, or stuck inside `app.asar`. All of it exists
because a Windows installer built on Linux shipped twice without a working
WebRTC binary and died on launch both times; the details are in
[docs/TODO.md](docs/TODO.md).

The phase scripts are pass/fail against the plan's exit criteria and exit
non-zero on failure, so they work as CI gates rather than as demos.

A packaged build ships both mpv and ffmpeg, so an installed copy needs nothing
else. Running from source uses whatever is on PATH; test films are generated on
first run and cached in `.fixtures/`.

**Documentation** lives in [`docs/`](docs/) and is published with GitHub Pages
straight from `main` — a guide for [people using it](docs/using.html), an
explanation of [how it works](docs/how-it-works.html), and a
[contributor's guide](docs/contributing.html).

Two other documents are worth knowing about: **[docs/TODO.md](docs/TODO.md)** for
what is deferred or blocked, and
**[docs/multi-machine-testing.md](docs/multi-machine-testing.md)** for testing
across real machines, which is where the remaining uncertainty lives.

### Transfer (phase 4)

The signalling server now hosts a **private BitTorrent tracker on its own port**
at `/announce`, alongside the WebSocket signalling on `/`. It answers only for
info hashes a room has announced, so it cannot be used as a public tracker for
arbitrary torrents — the info hash is a capability that only reaches you by
being in the room.

It has to be a *WebSocket* tracker rather than HTTP: WebRTC peers exchange
offers and answers to connect at all, and that exchange is what the tracker's
websocket protocol carries.

**One line stands between working and a bug that only appears on real
networks.** WebTorrent looks for a WebRTC implementation on `globalThis.WRTC`
and Node has none. Call `installWebRtc()` from `@cocine/client` before
constructing any client, or you get a TCP-only swarm that works flawlessly on a
LAN and fails for everyone behind a NAT, with no error — falling back to TCP is
not a failure as far as WebTorrent is concerned. There is a test asserting the
global is present.

### Sharing and receiving

Opening a film while in a room hashes it and shares it — **seeded in place, never
copied**, which matters at four gigabytes. Hashing was measured at roughly
780 MB/s with worst-case event-loop lag of 1.0 ms, because WebTorrent streams
and hashes in chunks; it does not need a worker thread, which was checked before
the design was settled rather than assumed.

Films you receive are kept under `films/` in the user-data directory, laid out
as `<infoHash>/<name>` so two films with the same name cannot collide. The
**Films** button in the title bar lists what is stored with sizes and a delete
button, and shows space used and free — keeping films without a way to see or
remove them fills a drive silently.

A transfer that will not fit is refused before it starts, with a message in
gigabytes, rather than failing at ninety per cent.

**Native modules must stay external to the Electron bundle.** `node-datachannel`
is native, and electron-vite will happily bundle it, which breaks the relative
path to its `.node` binary and stops the app booting with
`Cannot find module '../../../build/Release/node_datachannel.node'`. The fix is
to declare it in `apps/desktop`'s dependencies so `externalizeDepsPlugin` can
see it. The same applies to `webtorrent`.

**Local WebRTC tests use no ICE servers.** Loopback peers connect on host
candidates; reaching a public STUN server made the suite slow and intermittently
flaky. STUN is for real networks, and belongs in phase 6 alongside coturn.

### Which pieces get fetched

Rarest-first is right for swarm health and wrong for watching — it optimises for
the file eventually existing, not for the next ten seconds being ready. Strict
sequential is wrong too: it starves the swarm of piece diversity and quietly
makes everyone slower. So the file is split into zones that move with the room's
playhead, and only the zones near it override the default.

- **critical** — about ten seconds ahead, fetched as soon as possible
- **buffer** — about sixty seconds ahead, ahead of the bulk but not urgent
- everything else keeps WebTorrent's own rarest-first behaviour

Windows follow the *room's* position rather than the local player's, because
while a film is still arriving the local player may not have opened it yet.

**The container index comes before the first frame.** Matroska keeps its Cues —
the seek index — at the *end* of the file, and mpv cannot seek without them.
Fetch sequentially from the start and seeking appears broken for the whole
session, which reads as a broken application rather than a partial download. So
both ends of the file are fetched first. MP4 has the same problem whenever the
moov atom was never moved to the front.

Two WebTorrent details shape `PieceScheduler`. `critical()` only ever sets flags
— there is no way to clear one — so a range is re-issued only when it actually
changes. `select()` *accumulates* rather than replacing, so the previous window
must be deselected first, or the selection list grows until every range is
equally important, which is the same as having no windows at all.

### The readiness gate

Every client reports once a second what it actually has: fraction of the film,
**contiguous seconds available from the playhead**, observed rates, peer count.
The room holds in `preparing` until everyone has a lead buffer, then moves to
`ready`. That second number is the one the gate turns on — not how much of the
file exists, but how long it can play before hitting a hole.

The sidebar shows every peer's progress, a countdown from observed rates, and
the name of whoever the room is waiting for. It also shows **T_min**, the
Kumar–Ross floor no scheduling can beat, so a long wait is explicable rather
than just slow. When rates are not yet known it says so instead of inventing a
number.

Two controls belong to the host, both decisions about other people's time:
**start without whoever is behind** (which names them), and whether the room
pauses when someone arrives mid-film.

Announcing a different film clears the reports as well as the override. Without
that, a room where nobody has the new film still reads as ready, because
everyone's report describes the *previous* one.

### Surviving the sharer leaving

The room reports how many whole copies exist and whether it is safe for the
sharer to disconnect. This counts **whole copies rather than per-piece
coverage**, which would need bitfields on the wire — so a room whose peers
collectively hold every piece in fragments reads as unsafe. That is deliberate:
a wrong "yes" loses the film, so the error leans toward "not yet".

### Watching before it arrives

Playback goes through WebTorrent's streaming server, not the file on disk. The
file is written **sparsely**, so reading it directly returns zeros wherever a
piece has not arrived; the stream blocks on missing pieces instead, and supports
byte ranges so mpv can still seek.

### The phase 4 check

```bash
npm run phase4                       # three receivers, shaped links
npm run phase4 -- --gb=4 --peers=4   # full scale, slow
npm run phase4 -- --down=6 --up=3    # a worse connection
```

Every participant is a real `RoomClient` with a real headless mpv, so the sync
engine, readiness gate, piece scheduler and transfer are all shipping code.

**Links are shaped on purpose.** Loopback is far faster than any real
connection, and unshaped the transfer finishes before the readiness gate has
anything to gate — which proves nothing about watching while a film arrives.

Most recent run — 3 receivers, ~0.6 GB, 20 Mbps down / 10 Mbps up each:

```
gate opened after 70.3s — slowest receiver had 2.9% of the film
watchable before complete    yes (2.9% at the gate)
still arriving while playing yes
sync during transfer         p99 10.0 ms · worst 11.0 ms
```

### What phase 4 has not shown

**Two real machines on two real networks.** Everything above runs on loopback in
one process. That leaves untested: NAT traversal between actual hosts, real
round-trip variance, and the ten to twenty-five per cent of peer pairs that
cannot connect directly.

Phase 6 added a relay, but only for voice — bulk transfer is never relayed, by
design. So this gap is narrowed rather than closed, and measuring how often it
bites on real connections is the open question. See
[docs/TODO.md](docs/TODO.md).

To try it yourself, run the server somewhere both machines can reach, then on
each machine set that address in the join panel. One person opens a film, the
other joins with the code.

## Voice

A full mesh of peer connections, one per other person, with no media passing
through any server. That stops scaling somewhere around eight people, where
everyone is encoding a separate stream for everyone else and the cost is CPU
rather than bandwidth. An SFU is a later phase.

Negotiation is relayed by the signalling server, which never reads the payload
and never joins the call. Only one side of each pair offers — whoever has the
lexicographically smaller member id — because both offering at once collapses
the negotiation.

### Why push-to-talk is the default

**Chromium's echo canceller cannot hear the film.** It removes audio Chromium
itself played, and mpv plays through an entirely separate path, so on speakers
every microphone picks the film up and sends it back to the room. No WebRTC
setting fixes this.

Headphones fix it. Push-to-talk and ducking the film while anyone speaks make it
survivable without. Both are on by default and both are visible in the
interface, so nobody has to discover the problem the hard way.

### Host mute is advisory, and says so

In a mesh the server carries no audio, so it cannot stop anyone talking — it can
only ask, and a modified client could decline. The request is recorded in the
room log so it is visible that it happened. Real enforcement needs the SFU,
where the server is in the media path and can simply stop forwarding.

## The voice relay, and why films never use it

Roughly one pairing in ten on home connections cannot establish a direct peer
connection; behind carrier-grade NAT, as on most mobile networks, it is most of
them. A TURN relay is the only way through, and coCine runs one — for voice.

**Bulk film transfer is never given relay credentials.** The enforcement is
omission rather than a check: `iceServersFor('bulk', ...)` returns STUN only, so
there is nothing to fall back to. The reason is arithmetic. A relayed film
crosses the relay twice, in and out, for every viewer who needs it — an 8 GB
round trip per peer, paid by whoever runs the server. Voice is kilobits and worth
relaying; films are not.

The visible consequence is worth stating plainly, because it will look like a
bug: someone on a hopeless connection will hear everyone perfectly and still fail
to receive the film. [Relay mode](#relay-mode) is the answer for that room — a
different mechanism entirely, and one the host has to choose.

Credentials are minted per connection as an HMAC over an expiry timestamp, so no
account list exists and nothing needs provisioning. A relay left open, or one with
a fixed password, is found and abused by strangers within days, and every relayed
byte is billed to its operator.

```bash
COCINE_TURN_URLS="turn:relay.example:3478,turns:relay.example:443" \
COCINE_TURN_SECRET="<same as static-auth-secret in turnserver.conf>" \
  npm run server
```

`infra/turnserver.conf` is the coturn side, with private ranges denied so the
relay cannot be used to reach whatever else the host can route to. Setup and
firewall ports are in [docs/multi-machine-testing.md](docs/multi-machine-testing.md).

Without a relay configured the server says so at startup rather than failing
quietly, and voice simply requires a direct connection.

## Relay mode

Peer to peer is the product, and it fails for some rooms. Nobody able to connect
directly, or a sharer whose uplink cannot feed even one viewer, and the swarm has
nothing to offer. Relay mode is the honest answer: the sharer uploads once to
object storage and everyone fetches from there, so nobody depends on anybody else
being reachable.

The host chooses it, per room, from the Film panel — it is never automatic,
because switching means re-uploading the film and only a person can judge whether
that is worth it. Changing mode clears the room's film for the same reason: its
bytes live where only the other transport can reach them.

Everything above the transport stays the same. Both are implementations of one
`MediaTransport` interface, so the readiness gate, the progress display, resume
after a crash, and playing before the download finishes all work identically. The
origin path fetches byte ranges where the swarm fetches pieces, ahead of the
playhead first and backfilling afterwards, so a late joiner still gets the part
being watched rather than the opening titles.

### Credentials never leave the server

Clients hold no bucket credentials. The server signs a URL scoped to one method,
one key and a few hours, and hands that over — the same shape as the TURN
credentials, for the same reason. A client never names a key either: for an
upload the server derives it from the room's own code, and for a download it
comes from the room's media, so one room cannot address another's objects.

Signature Version 4 is implemented directly rather than by pulling in the AWS
SDK. It is checked against MinIO in the tests, which is the only authority worth
having — a signature that agrees with another copy of the same arithmetic proves
nothing.

### What it costs

Cloudflare R2 is the intended target because its egress is free, and that is the
entire difference. Measured by `npm run phase7` and extrapolated to a 4 GB film
with three viewers:

| | R2 | S3 |
|---|---|---|
| One movie night | **$0.02** | $1.11 |

Twelve gigabytes of downloads costs $1.08 on S3 and nothing on R2. Storage is the
only recurring part on R2, at roughly $0.06 per film per month if a film is kept
that long.

```bash
COCINE_R2_ENDPOINT=https://<account>.r2.cloudflarestorage.com \
COCINE_R2_BUCKET=cocine COCINE_R2_KEY_ID=... COCINE_R2_SECRET=... \
  npm run server
```

Without these the server says so at startup and the host is offered no toggle at
all, rather than one that fails when pressed.

## Installing it

Three targets, built with electron-builder into `release/`.

| Platform | Artifact | mpv |
|---|---|---|
| Linux | `.deb`, AppImage | **not bundled** — the `.deb` declares `Depends: mpv`; the AppImage relies on PATH |
| Windows | NSIS `.exe` | bundled, ~120 MB, fetched by `scripts/fetch-mpv.mjs` |
| macOS | `.dmg` | bundled — but the build needs an actual Mac |

The asymmetry is deliberate. On Linux the package manager installs mpv better
than we can, and shipping a second copy would be both larger and wrong. Windows
and macOS have no such mechanism, so a copy travels with the application.

When mpv is nowhere to be found the application says so and names the install
command for that platform, instead of failing with a spawn error against a
window that never appears. `COCINE_MPV` overrides the search for an unusual
install.

### The server address is baked in

`COCINE_DEFAULT_SERVER` at build time decides where an installed copy looks for
rooms, so a friend needs no setup at all. It is a default, not a lock: the
settings field still overrides it, and `COCINE_SERVER` overrides it at runtime.
Leave it unset and you get a development build pointing at localhost.

### Updates

Checked on launch, downloaded in the background, installed on quit — nothing
interrupts a film. What that actually does differs by platform, because these
builds are unsigned:

- **Windows** and the **Linux AppImage** update normally. SmartScreen warns on
  first install; it does not interfere afterwards.
- The **`.deb`** does not self-update. `apt` owns that copy, which is correct.
- **macOS cannot update unsigned at all** — Squirrel.Mac verifies the signature
  before swapping the bundle, so the check is skipped rather than downloading
  something that can never be applied. macOS users reinstall by hand until there
  is a Developer ID certificate.

Signing is deferred deliberately: among friends an unsigned build is tolerable,
and certificates have lead times better spent once strangers are installing it.
The `mac` and `win` sections of `electron-builder.yml` are where that switches on.

## Keyboard

| Key | |
|---|---|
| `Space` | play / pause |
| `←` `→` | seek ten seconds |
| `F` | toggle fullscreen |
| `Esc` | leave fullscreen |
| `V` (hold) | talk, while push-to-talk is on |

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
| 03 | Rooms, roles, chat | **done** — invite codes, chat, host controls, local persistent identity |
| 04 | Transfer | **done on this machine** — one part needs a second machine, see below |
| 05 | Voice | **done** — mesh, push-to-talk, mute/deafen, advisory host mute |
| 06 | NAT hardening | **done on this machine** — TURN credentials, plane split, forced-relay test; success rate needs real networks |
| 07 | Relay mode | **done on this machine** — host toggle, signed URLs, film delivered with no peer connection; measured $0.02 a session on R2 |
| 08 | Packaging | **done for Windows and Linux** — installers, bundled mpv, background updates; macOS needs a Mac to build |
| 09 | Interface overhaul | not started — **blocked on your list of issues from manual testing** |

Deferred work, and the two things that need a second machine, are listed in
[docs/TODO.md](docs/TODO.md).

## Testing

Three layers. The first two run on every commit and put nothing on screen; the
third needs a display, or Docker, and is opt-in. The tests that stand a real
coturn and a real MinIO up in containers live in that third layer, and skip
themselves where Docker is absent.

```bash
npm test          # layers 1 and 2 — 290 tests, ~40s
npm run test:app  # layer 3 — real Electron and Docker, 21 tests, ~60s
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
In the first window press **Create a room**; it shows a code like `4HTC-4M56` in
the title bar, which copies on click. Paste that into the second window and
press **Join**. Then press **Play** in either — both start together, and the
badge beside the code shows how far apart the two screens are.

`--film=` is optional and just skips the file dialog.

### Who you are

Your name, server address and last room code are remembered between launches in
`identity.json` under Electron's user-data directory, alongside a locally
generated id. The join panel comes back filled in rather than asking the same
three questions every time.

Deliberately local: nothing is sent to an identity provider, and the id has not
reached the wire protocol yet. That covers the visible benefit of an account
without needing OAuth, which only becomes necessary when this has to follow you
to a second machine. Details are only written once a connection succeeds, so a
typo in the server address is not what greets you next launch.

Tests launch the real application, so `COCINE_HEADLESS` also redirects
user-data to a throwaway directory rather than writing into your own config.

### Rooms

A room code is the only credential: eight characters from an alphabet with the
confusable ones removed, so it survives being read aloud. No code creates a
room; a code joins one. Rooms are held in memory and collected ten minutes after
the last person leaves.

The first person in is the host. Hosts can take playback control from anyone and
hand hosting over, from the hover controls on each row of the member list. **The
server enforces both** — an interface check is only a suggestion, since anyone
can send the message directly.

Chat doubles as the room's log: joining, leaving and "anjali put on dune.mkv"
appear in the same column as conversation, so there is one place to look when
you wonder what just happened. New arrivals get the backlog.

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
