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

### Everybody in the room needs the same version

**The current release is 0.1.1**, and the
[releases page](https://github.com/shreypatil/coCine/releases/latest) is the
authority on that — this line is updated by hand and the tag is not.

coCine is **not backward compatible between versions**. The wire protocol is
shared by the app and the server and it changes as features land; older and
newer builds do not negotiate a common subset, they simply disagree. So
everyone watching together has to be on the latest release, and a self-hosted
server has to be built from the same version its guests are running.

There is nothing in the app that checks this and tells you, which is the part
worth knowing, because a version skew does not announce itself. It looks like
one specific thing not working while everything else does: a room that will not
accept a join, transfer progress that never moves, an error banner reading
*bad message*, or a control that does nothing for one person and works for
everyone else. **Before debugging anything, check that everyone is on the same
version.**

The app does not show its version on screen yet, so checking it means one of:

| where | how |
| --- | --- |
| The log | `starting` is the first line of the day's file and carries `version`. An installed build writes to `~/.config/coCine/logs/main/` on Linux, `~/Library/Application Support/coCine/logs/main/` on macOS, `%APPDATA%\coCine\logs\main\` on Windows. |
| Windows | *Settings → Apps → Installed apps*, find coCine. |
| macOS | Select `coCine.app` in *Applications* and press ⌘I. |
| Linux, `.deb` | `dpkg -l cocine` |
| Linux, AppImage | The filename. |
| A server | `curl https://<server>/health` — though it reports a build date rather than a release number. |

On Windows and Linux the app updates itself from the releases page. On macOS it
cannot — see below — so Mac users have to download each new `.dmg` by hand, which
makes them the likeliest member of the room to be out of date.

## Running it on macOS

Apple Silicon only. An Intel Mac is not supported: the build would install
happily and then fail to connect anybody, so it is deliberately not produced.

### Installing the release

1. Download `coCine-<version>-arm64.dmg` from the
   [releases page](https://github.com/shreypatil/coCine/releases/latest).
2. Open the `.dmg` and drag **coCine** into *Applications*.
3. Open it. **The first launch will be refused** — macOS says the app is damaged
   or cannot be checked for malicious software. It is neither; the build has no
   paid Developer ID certificate.
4. Go to *System Settings → Privacy & Security*, scroll to the message about
   coCine being blocked, and press **Open Anyway**. Once per install.

   Control-click → *Open* no longer works on macOS Sequoia and later. If you
   would rather use a terminal:

   ```bash
   xattr -dr com.apple.quarantine /Applications/coCine.app
   ```

5. Type a name and create a room, or paste a code into the join field. The
   shared server is the default, so there is nothing else to set up.

**Auto-update does not work on macOS and will not warn you.** Applying an update
needs a signature the build does not carry, so the app deliberately never checks
on macOS rather than downloading something that can never install. Watch the
releases page and install each new `.dmg` over the old one.

### Running it from source on a Mac

Node 20 or newer, `git`, and [Homebrew](https://brew.sh).

```bash
brew install ffmpeg                       # required: coCine shells out to it
git clone https://github.com/shreypatil/coCine
cd coCine
npm install
npm run desktop                           # builds the renderer and launches the app
```

`npm install` on the Mac pulls the correct `darwin-arm64` WebRTC binaries, so
nothing needs staging. A development build points at `ws://127.0.0.1:8787`, so
point it at the shared server or run one beside it:

```bash
COCINE_SERVER=wss://cocine.duckdns.org npm run desktop
```

`brew install mpv` is only needed if you want to try `COCINE_PLAYER=mpv`; the
`<video>` engine is the default on every platform and mpv has never been
exercised on macOS.

### Building the `.dmg`

This has to run on the Mac — `hdiutil` exists nowhere else — and ffmpeg comes
from Homebrew because no macOS build can be fetched unattended.

```bash
brew install ffmpeg
node scripts/fetch-ffmpeg.mjs mac --from "$(brew --prefix)/bin"
npm run dist:mac                          # release/coCine-<version>-arm64.dmg
```

A warning that mpv was not staged is expected. If the build ends at
*verifying the package (check-package) failed*, the dmg is already built and can
be run locally — but do not hand it to anybody until the finding printed above
that line is understood. [docs/building-macos.md](docs/building-macos.md) has
the whole runbook, including signing and what has never been exercised on a Mac.

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
run or test that engine. On a Mac, use
[Running it on macOS](#running-it-on-macos) instead — ffmpeg has to come from
Homebrew there.

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

[Running the server yourself](#running-the-server-yourself) has the whole of it
— letting other machines reach it, TURN, relay storage, and what goes wrong.

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

## Running the server yourself

Installed copies point at a shared server — `wss://cocine.duckdns.org` — so
normally there is nothing to run. **If that server is down, unreachable, or you
would rather not use it, any one person in the room can run a server and the
others point at it.** It is one Node process, it needs no database, and it never
carries a frame of film, so a laptop is enough for an evening.

### First, check whether it really is the server

The failures look alike from inside the app, and only one of them is fixed by
running your own.

```bash
curl https://cocine.duckdns.org/health
```

A JSON line with `"ok":true` means the shared server is alive and the problem is
somewhere else — most often everybody not being on the same version, which the
section at the top of this file covers. No response, a timeout, or an error is
the case this section is for.

### Starting one

Node 20 or newer, and `git`. ffmpeg and mpv are the app's dependencies, not the
server's.

```bash
git clone https://github.com/shreypatil/coCine
cd coCine
npm install
npm run server
```

That prints:

```
  coCine signalling on ws://127.0.0.1:8787
  voice relay: none -- peers behind strict NAT will fail to connect
  relay storage: none -- rooms are peer-to-peer only
  press ctrl-c to stop
```

It says `127.0.0.1` but it binds every interface, on both address families, so
other machines can reach it. Two things worth setting straight away:

```bash
PORT=9000 npm run server                      # if 8787 is taken
COCINE_LOG_DIR=~/cocine-logs npm run server   # or it tries /var/log/cocine and complains
```

The log-directory default suits the deployed server, which runs as root under
systemd. Run by hand it cannot write there and prints
`cannot write to /var/log/cocine: EACCES` on start — harmless, the server works
regardless, but it means no log file to read afterwards.

**Everyone must run the same version of coCine as the server was built from.**
A self-hosted server built from `dev` and a guest on the 0.1.1 release is a
version skew like any other; see the top of this file.

### Letting the others reach it

Nothing about the server is reachable from outside until you arrange it. Pick
whichever case matches.

**Everyone on the same network** — the same flat, the same office, the same
Wi-Fi. Find the machine's address on the LAN and hand that out:

```bash
ip -4 addr show scope global | grep inet      # Linux
ipconfig getifaddr en0                        # macOS
ipconfig                                      # Windows, "IPv4 Address"
```

Everyone else uses `ws://<that address>:8787` — note `ws://`, not `wss://`,
because there is no TLS here. Let the port through the firewall on the machine
running it:

```bash
sudo ufw allow 8787/tcp                       # Debian/Ubuntu
sudo firewall-cmd --add-port=8787/tcp         # Fedora, add --permanent to keep it
```

Windows will ask the first time you run it; allow it on private networks.

**People elsewhere, quickly** — a tunnel is the least work and needs no router
access. Anything that forwards a WebSocket works:

```bash
cloudflared tunnel --url http://localhost:8787
```

It prints an `https://….trycloudflare.com` address. Because it terminates TLS
in front of the server, the server has to be told what it looks like from
outside:

```bash
COCINE_PUBLIC_HOST=wss://<that-host> npm run server
```

Guests then use `wss://<that-host>`.

**People elsewhere, permanently** — put it behind a real domain and a real
reverse proxy. [docs/deploying.md](docs/deploying.md) is the runbook for exactly
that (Caddy, systemd, coturn, a keepalive timer), and `infra/setup.sh` does it
in one go. `npm run build:server` first produces a single `dist/server.mjs` with
no `node_modules` to copy around.

> **`COCINE_PUBLIC_HOST` is not optional behind any TLS proxy or tunnel.** The
> server derives the tracker address it hands to clients from the `Host` header,
> which behind a proxy is wrong in both scheme and port. The symptom is the most
> misleading one in this project: **chat works, voice works, and transfer
> progress never moves.** If you see that, this is the first thing to check.

### Pointing the app at it

In the app, before joining: **Which server → My own server**, then type the
address. *use the shared one* puts it back. Everyone in the room has to be on
the same server — a room code means nothing on a different one.

Running from source, the environment variable wins over everything:

```bash
COCINE_SERVER=ws://192.168.1.42:8787 npm run desktop
```

### Voice relay, and what you give up without one

Roughly one home-broadband pairing in ten cannot open a direct connection, and
behind carrier-grade NAT or a corporate firewall it is far more. Without a TURN
relay those people simply cannot hear each other; the film is unaffected, since
bulk transfer is never relayed either way.

If you have a coturn to hand, both variables are needed together — half a
configuration is refused, because it would hand out credentials nothing accepts:

```bash
COCINE_TURN_URLS=turn:relay.example:3478,turns:relay.example:443 \
COCINE_TURN_SECRET=<static-auth-secret from turnserver.conf> \
  npm run server
```

`infra/setup-turn.sh` and `infra/turnserver.conf` set one up;
`npx tsx apps/server/scripts/relay-check.ts` proves it actually allocates.

### Relay mode storage, optional

Relay mode — the sharer uploads once and everyone fetches from object storage —
is offered to the host only when the server has a bucket. All four variables are
required together. R2 is the intended target for its free egress, but any S3 API
works, including MinIO:

```bash
COCINE_R2_ENDPOINT=https://<account>.r2.cloudflarestorage.com \
COCINE_R2_BUCKET=cocine COCINE_R2_KEY_ID=… COCINE_R2_SECRET=… \
  npm run server
```

Without it the host is offered no toggle at all, rather than one that fails when
pressed.

### Checking it works

```bash
curl http://localhost:8787/health
```

`{"ok":true,"rooms":0,"members":0,"uptimeSec":…,"version":…}`. It reports counts
and never room codes or names, since it is unauthenticated and the code is the
only thing between a room and a stranger. Watch `rooms` go to 1 when somebody
creates one; if it does not, the app never reached the server.

### When it will not start

| what it prints | what it means |
| --- | --- |
| `Port 8787 is already in use` | Another server is running. Stop it, or `PORT=8788 npm run server`. |
| `Not allowed to bind port` | Ports below 1024 need elevated privileges. Use a high port and proxy to it. |
| `cannot write to /var/log/cocine: EACCES` | Harmless. Set `COCINE_LOG_DIR` to somewhere writable to keep logs. |
| Nothing, but nobody can connect | Firewall, or the wrong address. Check `/health` from another machine first. |
| Everything connects, transfer never moves | `COCINE_PUBLIC_HOST`, if there is a proxy or tunnel in front. |

### Server environment variables

| Variable | Effect |
|---|---|
| `PORT` | Listening port. Default 8787. |
| `COCINE_PUBLIC_HOST` | The address clients reach it on, e.g. `wss://your.host`. Required behind any TLS proxy or tunnel. |
| `COCINE_LOG_DIR` | Where logs go. Default `/var/log/cocine`. |
| `COCINE_LOG_KEEP_DAYS` | Days of logs to keep. Default 7. |
| `COCINE_TURN_URLS`, `COCINE_TURN_SECRET` | A TURN relay for voice. Both together or neither. |
| `COCINE_TURN_TTL_SECONDS` | Lifetime of a minted TURN credential. |
| `COCINE_R2_ENDPOINT`, `COCINE_R2_BUCKET`, `COCINE_R2_KEY_ID`, `COCINE_R2_SECRET` | Object storage for relay mode. All four or none. |
| `COCINE_R2_REGION` | Defaults to `auto`, which is what R2 wants. |
| `COCINE_VERSION` | What `/health` reports. Set by the deployment. |

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
