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

The overlay draws and nothing more. It held the text field at first, and every
test passed while the feature was unusable: a window reparented into another
window is not one any window manager will focus, so the composer opened, looked
ready, and dropped every keystroke. The field is in the main window now, where
the keyboard already is and where fullscreen hides it behind the video, and the
draft is sent to the overlay to be drawn. Two safeguards came with it: the
overlay is never shown before it has actually been cut to shape, and a shaping
request that fails drops it to the corner panel rather than leaving an opaque
rectangle over the whole film.

### mpv's video output has to survive being resized

`vo=sdl` does not. With a `--wid` window resized under it — entering fullscreen,
or the sidebar moving — the surface goes pure black permanently, and no seek,
pause, `video-align-y` jiggle or filter reconfiguration repaints it; measured
directly against each of those. mpv's own probe order puts `sdl` ahead of `x11`,
so a machine whose GPU outputs are rejected lands on it. The embedded player is
given `--vo=gpu-next,gpu,xv,x11` on Linux, which changes nothing where the GPU
output works. `COCINE_MPV_ARGS` appends arguments after everything else, both as
a user escape hatch and as the way the suite drives the real output on a virtual
display (`--gpu-sw=yes`) or reproduces the failure (`--vo=sdl`).

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
4. **Pause sharing** marks the peer *paused* for the other members and stops new
   peers connecting — but see the loose end below: it does not stop a transfer
   that is already under way.
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

### IPv6 — covered on one machine now; the pairing still needs two

Previously recorded here as untested, on the reasoning that a loopback
environment cannot produce the situation. That turned out to be true only of the
last step. Everything up to "do two IPv6 peers connect" is a property of *this*
machine and is now asserted on it.

What the suite holds. `packages/client/test/ice.test.ts` gathers candidates from
a real peer connection on this machine's real interfaces and asserts that its
global IPv6 address is offered to peers, that IPv4 is offered alongside it, and
that IPv6 is ranked above IPv4 so the better path is tried first. The
address-family tests gather with no ICE servers at all, so they need no network
and cannot flake on somebody else's STUN server, and they skip where there is no
global IPv6 to offer — most CI runners — because there its absence is correct.
`apps/server/test/dual-stack.test.ts` asserts the signalling server answers both
families on one port, including a real room created over IPv6 and joined over
IPv4. Verified to discriminate: an IPv4-only bind fails three of its four tests.

What changed in the code, rather than around it:

- **The server binds `::` with `ipv6Only: false` explicitly**, falling back to
  IPv4 if that fails. It was dual-stack before by inheriting Node's default,
  which a host with `net.ipv6.bindv6only=1` silently inverts into an IPv6-only
  listener that refuses every IPv4 client while looking healthy.
- **Two STUN operators instead of one.** A STUN server can only report an
  address it is reachable over, so a single provider's broken IPv6 route does
  not degrade the connection, it deletes the IPv6 path — and for a peer behind
  carrier-grade NAT that was the only path that would have worked.
- **`nat-check` reports what the application's own stack gathers**, not only
  what raw STUN sees. The two were never connected before: the network can do
  IPv6 perfectly while the WebRTC stack offers an IPv4-only answer, and that
  failure produces no error anywhere.
- **`gatherCandidates` waits for end-of-candidates, not for
  `iceGatheringState`.** Measured against libdatachannel: the state flips to
  `complete` and the server-reflexive candidate arrives immediately *after*, in
  the same millisecond. The first version of this module resolved on the state
  and so reported a machine with working STUN as having none.

One measured finding worth keeping: **no IPv6 server-reflexive candidate is
gathered, and that is correct.** A global IPv6 host candidate already is the
address a peer would send to, so there is nothing for STUN to discover and the
stack does not ask — confirmed here, where raw STUN over IPv6 answers fine and
the stack still gathers an IPv4 srflx and no IPv6 one.

**Still needs two machines**, and it is the same list as phase 6: whether two
peers that both have IPv6 actually connect over it, and whether a pairing with
IPv6 on one side and CGNAT-only IPv4 on the other falls back correctly. Jio is
one of the largest IPv6 deployments anywhere, so for a user base on Indian ISPs
this remains plausibly the single biggest determinant of whether peer-to-peer
works at all.

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

### Pausing a transfer does not actually pause it

Found by the swarm harness rather than by using the application, which is the
first time that has happened round this way.

`setPaused` calls WebTorrent's `torrent.pause()`, and the code claimed that
stopped serving as well as fetching. It does not. WebTorrent consults `paused`
only when admitting a new peer or draining its connect queue, so every wire
already open keeps sending and receiving at full rate. Measured: a receiver
shaped to 250 kB/s still took about **thirty per cent of the film in the two and
a half seconds after being paused**. What pausing does today is stop *new* peers
connecting, which is not nothing but is not what the button says.

Closing the open wires was tried and is worse. The bytes do stop, but the peers
go with them, and `resume()` then has nothing to reconnect to until the next
tracker announce — over a minute in testing, during which the film simply does
not arrive.

A real fix has to stop the data without losing the peers: choke every wire and
drop the piece selections on pause, restore both on resume. The complication is
that `PieceScheduler` owns the selections, so the two have to be reconciled
rather than fought over — which is why this is written down rather than done.

`packages/client/test/transfer-swarm.test.ts` carries the intended behaviour as
an `it.fails` test. It is green today because the behaviour is wrong, and it
will turn red the moment somebody fixes it, which is the point.

### mpv's video output is broken here, and the test that watched it was lying

Found by using the application, then confirmed by fixing the test that should
have caught it. Under the mpv engine, on this machine:

- Entering fullscreen turns the picture black **every time**, and it stays black
  after leaving fullscreen again. Measured: a healthy surface reads 0.383
  standard deviation and 0.206 mean brightness; in fullscreen it reads
  0.002/0.000, for as long as it is watched.
- Starting a film is black perhaps half the time even windowed, reading
  0.043/0.004 — four tenths of one per cent brightness.
- Forcing `--vo=x11` is worse, not better: the picture never appears at all.
  So the GPU output works windowed and dies on the `--wid` resize, while the
  software output never draws into a reparented child at all.

The geometry is not the problem. With `COCINE_DEBUG=1` the surface is placed
exactly where it should be — `asked=1920x1080@0,0 got=1920x1080@0,0` — so mpv
simply stops painting into a window it has been given.

**The test that should have caught this was passing.** `video-output.e2e.test.ts`
read pixels with `import -window <wid>`, which asks the X server for that
window's contents — and mpv renders through OpenGL, so the X server holds no
pixels for it and returns stale or background content instead. Every assertion
passed while the screen was plainly black. It grabs the root window and crops to
the surface's rectangle now, which is the framebuffer, which is what a person
sees. The picture assertions in that file are no longer made, because they would
fail for this reason rather than for the reason that test is about;
`black-screen.e2e.test.ts` reproduces it deliberately instead:

    COCINE_PLAYER=mpv npm run test:app

**The `<video>` engine does not have this problem.** The same test against it
reads 0.381/0.202 windowed, 0.459/0.498 in fullscreen — brighter, because the
film fills the screen — and 0.381/0.202 again on the way back. Four opens and
plays in a row, no black frame anywhere. That is the practical answer today:
`COCINE_PLAYER=html`.

Whether to fix mpv's output or to make the `<video>` engine the default is the
B1.6 decision, and it now has a good deal more evidence behind it than the drift
figures alone.

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
