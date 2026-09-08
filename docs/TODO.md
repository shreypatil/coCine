# coCine — outstanding work

A running list of what is deferred, blocked, or waiting on something only you can
do. Everything here was a deliberate decision to postpone, not an oversight.

Last updated after phase 8 (packaging).

---

## Blocked on you

These cannot be finished from this machine. They are the only things standing
between the current build and a genuine end-to-end verification.

### Phase 4 — transfer across two real machines

Everything the transfer does has been measured, but always on loopback in a
single process. That leaves the parts that only real hardware exercises:

- NAT traversal between actual hosts, rather than two peers on 127.0.0.1
- Real round-trip variance, as opposed to the simulated 40 ms ± 15 ms link
- The ten to twenty-five per cent of peer pairs that cannot connect directly
- Whether the readiness gate opens sensibly when download speeds genuinely differ

`docs/multi-machine-testing.md` is the checklist, with the seven ranked failure
modes and what to capture when one hits. The single most useful diagnostic: **if
chat works but transfer progress does not move, it is connectivity, not the
transfer code.**

### Phase 6 — connection success rate on real networks

The exit criterion for phase 6, and the reason it matters more than it sounds:
the relay carries voice but deliberately never carries bulk transfer, so the
rate at which peers fail to connect directly is exactly the rate at which someone
can hear everyone and still not receive the film.

Needs measuring across at least:

- Two home broadband connections, different ISPs
- One machine on a **mobile hotspot** — carrier-grade NAT is the hard case and
  the one most likely to fail
- Ideally one on a corporate or university network, where UDP is often blocked
  entirely and the TLS-on-443 listener is what saves the connection

Worth recording per pairing: whether voice connected, whether it needed the
relay, and whether the film transferred.

### Relay mode against a real Cloudflare R2

Relay mode is built and proven against MinIO, which speaks the same S3 API, but
has never touched R2 itself. Before relying on it:

- Create an R2 bucket and an API token, and set `COCINE_R2_ENDPOINT`,
  `COCINE_R2_BUCKET`, `COCINE_R2_KEY_ID` and `COCINE_R2_SECRET`
- Share a film through the relay and confirm the signed URLs are accepted
- Check the bill after a session against what `npm run phase7` predicted

R2 has no free-egress equivalent to guess at, so the measured figures should hold,
but they are measured against MinIO's behaviour and R2's own request accounting
may differ.

### A macOS build, which needs a Mac

Windows and Linux installers are built and verified. macOS cannot be built from
Linux at all — the `.dmg` target needs macOS. Everything is configured for it, so
on a Mac `npm run dist:mac` should work, but two parts have never run:

- bundling mpv for macOS (`node scripts/fetch-mpv.mjs mac --from "$(brew --prefix)/bin/mpv"`),
  including whether its dylib dependencies resolve inside the app bundle
- the `.dmg` itself

### The Windows installer — run once, and it failed

It has now been installed on a real Windows machine, and it did not start:

```
Error: Cannot load native addon for node-datachannel on win32 (x64).
Attempted to require "@node-datachannel/win32-x64-msvc".
```

That was one of two. The tree holds **two copies of node-datachannel** which load
their binary differently — the root one (0.33) resolves a sibling
`@node-datachannel/<platform>` package, and the copy nested under
`webrtc-polyfill` (0.32.3) requires a local `build/Release` by relative path with
no fallback. npm installs neither for a foreign platform, and `overrides` will
not collapse them. Fixing the first exposed the second:

```
Error: Cannot find module '../../../build/Release/node_datachannel.node'
```

Now: the addon is loaded lazily so its absence is survivable at all,
`scripts/fetch-native.mjs` stages both binaries for the target,
`scripts/dist.mjs` injects one and swaps the other in for the build (restoring
the host's afterwards), and `scripts/check-package.mjs` reads the finished
artifact — inside `app.asar` as well as beside it — and refuses to ship unless
every copy can find a loadable binary of the right format.

**Still unproven on Windows beyond those two failures.** The next install there is
the real check: whether WebRTC now initialises, whether the bundled `mpv.exe`
starts, and whether `--wid` reparenting works on Windows at all, which is a
different windowing path from X11.

### The old note, still true of the rest of Windows

`coCine-0.1.0-x64.exe` builds cleanly under wine and carries mpv, but no Windows
machine has executed it. Untested there: whether the bundled `mpv.exe` starts,
whether `--wid` reparenting works on Windows at all (it is a different windowing
path from X11), and whether SmartScreen's warning is as tolerable as assumed.

The Linux artifacts, by contrast, were run: the AppImage boots, finds mpv, and
reports properly when mpv is missing.

### Xvfb on this machine is broken

`Xvfb` fails with `libnettle.so.9: cannot open shared object file` — a
rolling-release library mismatch, not anything to do with coCine. It means the
virtual-display path for headless GUI testing is unavailable, and Electron tests
currently run on the real display with `COCINE_HEADLESS=1` (which never shows a
window). Reinstalling `xorg-server-xvfb` should fix it.

### A public signalling server for the default build — now the last blocker

Everything else needed for a stranger to install and use coCine is in place: the
`.deb` pulls mpv in through apt, the AppImage names the exact install command for
the distribution it finds itself on, the picker no longer depends on the desktop's
dialog, and the installers are built. What is missing is somewhere to point them.


An installed copy points at whatever `COCINE_DEFAULT_SERVER` was set to at build
time. Until an instance is running somewhere your friends can reach, a release
build has nowhere to point, and the phase 8 exit criterion — a friend installs
from a link and joins a room without being told anything — cannot be met however
good the installer is.

The pieces are all configurable and none of them are hard-coded; what is missing
is a host.

---

## Decisions waiting on you

### How long films stay in the bucket

Nothing currently deletes an uploaded film, so storage accrues for every film
ever shared through the relay — roughly $0.06 per 4 GB film per month on R2, for
as long as it sits there. That is small per film and unbounded over time.

The obvious options, none of them chosen:

- **A bucket lifecycle rule** deleting objects after some days. Simplest, costs
  nothing to run, and means a rewatch next month re-uploads.
- **Delete when the room ends.** Cheapest, but a room that reconvenes the next
  evening pays the upload again.
- **Keep them and accept the bill.** Fine at friends-and-family scale; the cost
  is real but tiny.

My recommendation is a lifecycle rule at seven days: it matches how people
actually rewatch, needs no code, and bounds the bill. But it is a standing cost
decision rather than a technical one, so it is yours.

---

## Deferred by decision

Postponed deliberately, with the reasoning, so the choice can be revisited rather
than rediscovered.

### Redis — deferred, not cancelled

Room state lives in memory in a single server process. Redis becomes necessary
when there is more than one server process holding rooms, which is a scaling
concern and not a correctness one today. `InMemoryRoomStore` sits behind the
`RoomStore` interface precisely so this swap does not touch anything else.

### OAuth and real accounts

Local persistent identity is built: a stable member id and display name, stored
per machine. Accounts proper — the same identity across devices, and a friends
list — are a later phase. Rooms stay anonymous invite codes regardless; accounts
are additive.

### An SFU for voice

Voice is a full mesh, which stops scaling somewhere around eight people, where
everyone encodes a separate stream for everyone else. Two things wait on this:

- Scaling past roughly eight participants
- **Enforceable host mute.** Today it is advisory: the server carries no audio, so
  a muted client is one that chose to comply. The interface says so rather than
  implying otherwise, which is the honest version of a mesh.

### Wayland

mpv cannot reparent into a Wayland surface — there is no embedding path at all,
so the app forces `--ozone-platform=x11` and runs under XWayland on a Wayland
desktop. The cost is native fractional scaling. A real fix needs either a
different embedding strategy or rendering frames through the app itself.

### Chat in fullscreen — done, by shaping the window rather than stacking it

Previously recorded here as impossible: nothing could be stacked above the mpv
surface, and raising the overlay, lowering the video, `setAlwaysOnTop`,
`moveTop`, `xdotool windowraise` and a direct X `ConfigureWindow` all failed.

What works is the X SHAPE extension. The overlay window covers the whole video
and is then cut down to exactly the message bubbles the renderer measures, so
the film is untouched everywhere else and clicks outside a bubble reach the film.
It needs no compositing manager, which matters on a bare i3 session where a
translucent window paints black. Windows and macOS use an ordinary transparent
window instead; an X server without SHAPE falls back to the old opaque panel.

`apps/desktop/test/overlay-window.e2e.test.ts` asserts it against a real X
server: the overlay is a child of the main window, covers nothing while the room
is quiet, and covers only the bubble once somebody speaks.

### Phase 9 — interface overhaul

Waiting on your list of issues from using it. What follows is what a read of the
frontend turned up, to go alongside it.

**Broken, in rough order of severity**

1. **Films received through relay mode are invisible and undeletable.**
   `OriginTransfer.receive` never calls `store.record()`, so no `meta.json` is
   written and `FilmStore.list()` skips the directory. Gigabytes accumulate with
   no way to see or remove them from the app — which is exactly what the films-
   on-disk view was required to prevent.
2. **"Use default" resets a packaged build to `ws://127.0.0.1:8787`.** The
   renderer holds its own copy of the default server address, which stopped being
   true when the real default became a build-time value. The button also shows
   permanently for every packaged user, since their address never equals the
   hard-coded one.
3. **The durability line lies in relay mode**, saying the film "needs the sharer"
   when the origin holds it and the sharer is irrelevant.
4. ~~**There is no chat in fullscreen.**~~ Done: bubbles over the film, with the
   composer opening on Enter. See the section above.
5. **Push-to-talk only binds lowercase `v`.** Holding Shift, or Caps Lock being
   on, silently stops the microphone opening while the interface still says
   "Hold V to talk".
6. ~~**A stray `console.log('open film clicked')`**~~ Gone.

**Robustness**

7. ~~**A dropped connection is never noticed.**~~ Done: the client reconnects by
   room code with backoff, and the interface says *reconnecting* while it does.
8. **Keyboard shortcuts ignore permissions.** Space and the arrow keys call
   playback for someone without control, who gets an error banner rather than the
   keypress doing nothing.
9. **One global `busy` flag disables every control** during any operation, so a
   slow request freezes unrelated buttons.
10. **The error banner is transient local state**, cleared by the next action
    whether or not it was related, and inserting it shifts the video stage — which
    moves the native mpv window underneath.
11. **No text overflow handling anywhere.** Long names and filenames have nothing
    to clip them inside a 276px sidebar.

**Design and information architecture**

12. ~~The readiness gate renders below the chat.~~ Done: it sits directly under
    the member list, and has grown into a full transfer panel — per-peer rates,
    buffers, who is furthest behind, and a piece map showing which parts of the
    film each person holds.
13. Every heading is an `<h4>`; there is no `<h1>`, and the video stage is an
    empty `<div>` with nothing for assistive technology.
14. ~~The per-member actions are four ambiguous words.~~ Done: they are spelled
    out — *give control*, *take control*, *make host*, *ask to mute*.
15. Two unrelated things are both called relaying: the TURN relay for voice and
    origin mode for films. The interface says "through the server" for one of
    them and nothing for the other.

---

## Findings worth keeping

### Electron's own file dialog cannot open a film on Linux

Reproduced in a twelve-line Electron application, so it is neither this
project's code nor its window handling: on a desktop with **no
`xdg-desktop-portal` installed**, Electron falls back to its own GTK file
chooser, and there an *activate* gesture is reported to the application as a
cancellation.

| gesture | result |
| --- | --- |
| double-click a file | `{ canceled: true, filePaths: [] }` |
| select, then Enter | `{ canceled: true, filePaths: [] }` |
| select, then click **Open** | works |

Double-click is how almost everyone picks a file, so "Open film" silently did
nothing on i3, and the log filled with `dialog dismissed without a selection`.

The fix is `apps/desktop/src/main/browse.ts` and `renderer/FilmPicker.tsx`: on
Linux the application browses for itself, with the same look as the rest of the
interface and no dependency on what the desktop has installed. Windows and macOS
keep their native dialogs, which people know and which work. `COCINE_NATIVE_DIALOG=1`
forces the system dialog back on for anyone who prefers it.

### The film flow, as it now stands

Reworked after manual testing, because opening a film and sharing it looked like
two unrelated features when they are one pipeline:

1. A room comes first. **Open film** is disabled until there is one.
2. Opening a film loads it into mpv on that machine only — no hashing, nothing
   announced, nothing on the wire.
3. **Start sharing** hashes it, announces it, and the room begins fetching.
4. **Pause sharing** stops serving as well as fetching, and other members see the
   peer marked *paused*.
5. **Unload film** closes it, and takes it off the room (`media.clear`) when this
   machine is the one that put it there.

Each client also reports a 64-digit **piece map** with its once-a-second report,
so the room can show which parts of the film each person holds rather than only
how much. Relay mode fetches byte ranges rather than pieces and reports none, so
the interface falls back to a plain progress bar there.

## Smaller loose ends

Real, small, and none of them blocking.

### TURN HMAC credentials are unverified against a real coturn

The credential minting is unit tested against the documented coturn REST scheme,
and the forced-relay test proves a relayed connection genuinely carries data. But
those two do not meet: the `coturn/coturn:latest` image available here reports
version `4.17.2 'Gorst'`, which is not an upstream release, and its REST-auth path
is simply absent — it ignores `use-auth-secret` and falls through to a user
database lookup. Both base64 and hex digests were rejected identically, without
coturn ever computing one, so this is the image and not the implementation.

The end-to-end relay test therefore uses static credentials. **When you deploy a
real coturn, confirm the minted credentials are accepted:** `docker logs` should
show `ALLOCATE processed, success` rather than `401: Unauthorized`.

### IPv6 is untested, and probably matters more than "loose end" suggests

ICE gathers and prioritises IPv6 on its own and nothing in the code suppresses
it, but no test asserts an IPv6 path is actually used where one exists, and a
loopback test environment cannot produce that situation.

Worth raising in priority: `npm run nat-check` shows this machine has native
IPv6 with no NAT on that path, and Jio is one of the largest IPv6 deployments
anywhere. For a user base on Indian ISPs, IPv6 is plausibly the single biggest
determinant of whether peer-to-peer works at all — and it is the part with no
coverage.

### No runtime test that voice ICE reaches the peer connection

`RoomClient.ice` is covered by `apps/server/test/ice-delivery.test.ts`, and the
pass-through into `RTCPeerConnection` is type-checked. But the renderer test layer
does not assert the servers actually arrive at the constructor. This is precisely
the shape of bug that existed until phase 6 — credentials minted correctly and
then dropped on the floor — so it is worth closing properly.

### The packages declare no licence

The built `.deb` carries `License: unknown`, because the repository has no
licence file. Worth settling before anything is distributed, and it interacts
with bundling mpv: mpv is GPLv2+, and while shipping it as a separate executable
that coCine talks to over a socket is aggregation rather than a derived work,
the choice of licence for coCine itself is still yours to make.

### Code signing is deferred, and macOS updates depend on it

Per the plan, both certificates wait until strangers are installing it. Two
consequences to remember when that changes: Windows SmartScreen warns on first
install, and macOS cannot auto-update at all until there is a Developer ID
certificate. Both certificates have lead times, so start them before they are
urgent.

### Relay mode has no cost ceiling or quota

Any host in a room on a server with storage configured can upload a film, as
often as they like, and the person running the server pays. There is no per-room
quota, no size cap beyond what the bucket allows, and no accounting per user.
At friends-and-family scale this is fine and deliberately unbuilt; it would need
addressing before anyone outside that circle could use the server.

### The origin transport assumes a constant bitrate

Readiness in relay mode converts held bytes into seconds of film by dividing by
the average, which is wrong for any real encode — a high-motion scene occupies
more bytes per second than a static one. It decides when playback may start, so
being approximate costs a slightly early or late gate rather than a wrong
picture. The swarm path has the same approximation.

### Piece scheduler measured no better than stock WebTorrent

The harness found no scenario where a custom scheduling policy beat stock
WebTorrent, and one naive allocator was twice as slow as doing nothing. The
three-zone scheduler is retained because it makes streaming-before-complete work,
not because it distributes faster. Worth re-measuring once real peers with real
asymmetric uplinks exist, since the harness simulated those.

### Chromium's echo canceller cannot hear the film

Chromium removes only audio it played itself, and mpv plays through an entirely
separate path, so on speakers every microphone picks up the film and sends it
back. No WebRTC setting fixes it. Push-to-talk by default, film ducking, and a
headphones hint make it survivable. A real fix needs the film's audio routed
through the same path as the call.
