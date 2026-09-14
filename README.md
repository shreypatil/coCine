# coCine

Watch a film with friends, in sync, from your own machines.

One person opens a film. Everybody else in the room receives it from them,
peer to peer, and it plays in step on every screen — within 100 ms — with voice
and chat alongside. Nothing is uploaded anywhere first, and nobody needs a copy
of their own. Windows, Linux and macOS (Apple Silicon).

**The full documentation is the site:** <https://shreypatil.github.io/coCine/>
— a [guide for using it](https://shreypatil.github.io/coCine/using.html), an
explanation of [how it works](https://shreypatil.github.io/coCine/how-it-works.html)
with the measurements behind it, and a
[contributor's guide](https://shreypatil.github.io/coCine/contributing.html).
This file is the short version, plus everything about running the code.

## Installing it

Installers are on the [releases page](https://github.com/shreypatil/coCine/releases/latest):
a Windows `.exe`, a `.deb` for Debian and Ubuntu, an AppImage for other Linux,
and a `.dmg` for Apple Silicon Macs. Installed copies point at a shared server,
so there is nothing to set up: open it, type a name, create a room or paste a
code.

The installers are not code-signed yet. Windows shows a SmartScreen warning on
first install (*More info → Run anyway*); macOS refuses the first launch until
you allow it under *System Settings → Privacy & Security*. Both are the absence
of a paid certificate, not a fault in the build.

## How it works, briefly

Two kinds of process: a desktop application per person, and one small
signalling server for the room. The server is a meeting point and a referee —
it carries chat, keeps everyone's clocks in step, brokers connections and
decides what "now" is — and it never carries a frame of film.

- **Playback is anchored, never commanded.** The server broadcasts *"the film
  was at 1240.5 s at this server time"*; every client computes where the film
  should be and closes the gap by running a fraction faster or slower, which is
  inaudible. A seek is used only for gaps too large to close that way.
- **The film is a BitTorrent swarm** over WebRTC data channels, announced to a
  tracker the signalling server also runs. Everyone who receives a piece starts
  passing it on. Pieces near the playhead are fetched first, so watching starts
  once everybody has a head start — usually a few per cent of the film.
- **Voice is a WebRTC mesh**, one connection per pair, with a TURN relay
  beside the server for the pairs that cannot connect directly. The relay
  carries voice only; a film that cannot travel peer to peer is not silently
  routed through the server.
- **Relay mode** is the honest fallback for a room the swarm cannot serve: the
  sharer uploads once to object storage and everyone fetches from there. The
  host chooses it, per room.
- **The player is a `<video>` element** in the application's window, with
  ffmpeg converting the few containers it cannot read. mpv is kept as a second
  engine behind `COCINE_PLAYER=mpv`; both sit behind one `PlayerController`
  interface, so the synchronisation engine cannot tell them apart.

The [how it works](https://shreypatil.github.io/coCine/how-it-works.html) page
has the wire protocol, the constants, and the numbers each claim was measured
with.

### Layout

```
packages/
  protocol/   the wire contract — Zod schemas shared by client and server
  sync/       clock offset and drift correction — pure, no I/O
  player/     both engines behind PlayerController; ffmpeg conversion; subtitles
  client/     composes socket + clock + sync + player + transfer
  voice/      the WebRTC mesh state machine
  logging/    per-channel, per-day log files for the server and the desktop
apps/
  server/     signalling: rooms, playback authority, tracker, readiness, TURN, signed URLs
  desktop/    Electron main + preload + React renderer
harness/      the transfer benchmark (see its README)
infra/        the shared server: systemd units, Caddy, coturn, setup scripts
scripts/      building installers, and the checks that keep them shippable
docs/         the GitHub Pages site, the deployment runbook, the outstanding-work list
```

## Running it from source

You need Node 20 or newer and `ffmpeg` on your `PATH`. `mpv` is only needed to
run or test that engine.

```bash
git clone https://github.com/shreypatil/coCine
cd coCine
npm install
npm run desktop                   # builds the renderer and launches the app
```

A development build points at `ws://127.0.0.1:8787`, so either run a server
beside it or point it at the shared one:

```bash
npm run server                    # a signalling server on :8787, all interfaces
COCINE_SERVER=wss://cocine.duckdns.org npm run desktop
```

To watch two copies talk to each other on one machine, start the server and
two apps; `--film=` skips the file dialog:

```bash
npm run server
npm run desktop -- --film=/path/to/film.mkv
npm run desktop -- --film=/path/to/film.mkv
```

Create a room in one, paste the code into the other, press *Start sharing*,
then play. `npm run desktop:dev` runs the renderer with hot reload instead.

### Environment variables

| Variable | Effect |
|---|---|
| `COCINE_SERVER` | Server address, overriding everything else. |
| `COCINE_PLAYER` | `html` (default) or `mpv`. |
| `COCINE_LOG_LEVEL` | `error`, `warn`, `info`, `debug` or `trace`. Development runs default to `debug`. |
| `COCINE_MPV`, `COCINE_FFMPEG` | Path to an mpv binary / a directory holding `ffmpeg` and `ffprobe`, for unusual installs. |
| `COCINE_MPV_ARGS` | Extra arguments appended to mpv, e.g. `--vo=x11`. |
| `COCINE_NATIVE_DIALOG=1` | Use the system file dialog on Linux instead of coCine's own picker. |
| `COCINE_HEADLESS=1` | Never show a window; what the test suite uses. |
| `COCINE_DEBUG=1` | Log native window placement (mpv engine). |

Logs land under the user-data directory — `~/.config/@cocine/desktop/logs/`
for a development run on Linux — one directory per channel, one file per day.
`renderer.voice/` is the one to read when a call misbehaves.

### Tests

```bash
npm test            # unit + integration + renderer layout in headless Chromium; no window
npm run typecheck   # three tsconfigs: node, main, renderer
npm run test:app    # the whole application under Playwright's Electron driver; needs a display
```

`npm test` puts nothing on screen; `test:app` runs the real app hidden under
`COCINE_HEADLESS=1`, and a few of its files drive a real X server. Tests that
need Docker (a real coturn, a real MinIO) skip themselves where it is absent.

The measurement scripts are pass/fail against the design's targets and exit
non-zero when they miss, so they double as gates:

```bash
npm run phase0       # player control: event rate, command latency, seek accuracy
npm run phase1       # five clients, drift against the 100 ms budget, on a simulated 40 ms link
npm run phase4       # a swarm fetching a film while it plays, on shaped links
npm run phase7       # relay mode, and what a session costs
npm run b1-gate      # the <video> engine's feasibility gate (4K decode)
npm run nat-check    # what this machine's network will do to a peer connection
npx tsx apps/server/scripts/relay-check.ts   # does the deployed TURN relay actually allocate?
npx tsx apps/server/scripts/voice-sim.ts     # two people join voice, for real, without the desktop
```

`phase0` and `phase1` take `:html` variants for the default engine.

### Building installers

```bash
node scripts/fetch-ffmpeg.mjs linux      # ffmpeg ships on every platform (win | linux | mac)
node scripts/fetch-mpv.mjs win           # mpv ships only on Windows and macOS
npm run dist:linux                       # .deb + AppImage, into release/
npm run dist:win                         # NSIS .exe, cross-built from Linux
npm run dist:mac                         # .dmg — has to run on a Mac; see docs/building-macos.md
```

Each `dist:*` stages the target's native WebRTC binaries, builds, restores the
tree, then reads the finished package and refuses to ship one whose native
addons are missing or built for the wrong platform — a Windows installer once
shipped twice without a working WebRTC binary. `COCINE_DEFAULT_SERVER=wss://…`
at build time changes which server the installer points at.

Releases are cut from `main` and published as GitHub Releases, which is also
where installed copies look for updates.

### Running your own server

The shared server is enough for friends. To run one anyway:

```bash
npm run server                                        # :8787; PORT= to change
COCINE_TURN_URLS=turn:relay.example:3478 COCINE_TURN_SECRET=… npm run server   # with a voice relay
COCINE_R2_ENDPOINT=… COCINE_R2_BUCKET=… COCINE_R2_KEY_ID=… COCINE_R2_SECRET=… npm run server  # with relay mode
```

Behind a TLS-terminating proxy set `COCINE_PUBLIC_HOST=wss://your.host`, or the
tracker address handed to clients will be wrong. `npm run build:server`
produces a single `dist/server.mjs`; [docs/deploying.md](docs/deploying.md) is
the full runbook for the deployment the shared server runs on, and
`infra/setup.sh` does it.

## Contributing

Two branches matter:

- **`main`** is what has been tested by hand and released. Nothing is committed
  to it directly.
- **`dev`** is where all work lands. Branch from `dev`, keep the branch to one
  change, and open a pull request **against `dev`**. `main` is updated by
  merging `dev` into it after manual testing, which the maintainer does.

`npm test` and `npm run typecheck` must pass, and a change that touches native
windows should pass `npm run test:app` too. Add the test with the fix, and let
it describe the failure it prevents. The
[contributor's guide](https://shreypatil.github.io/coCine/contributing.html)
has the code map, the decisions behind it and why, and the list of what is
known not to work — read that before planning anything larger than a fix.

## Licence

MIT. coCine ships ffmpeg beside it and can drive mpv; both are separate
programs under their own licences.
