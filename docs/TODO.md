# coCine — outstanding work

A running list of what is deferred, blocked, or waiting on something only you can
do. Everything here was a deliberate decision to postpone, not an oversight.

Last updated after phase 6 (NAT hardening).

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

### Phase 7 — relay/server mode

The fallback for when peer-to-peer cannot deliver a film at all: an origin the
film can be fetched from, currently planned as Cloudflare R2. This is the answer
for the peers phase 6 measurement finds cannot connect.

### Phase 8 — packaging and release

Installers for Windows, macOS and Linux; code signing; an update path. Nothing
here is started.

### Phase 9 — interface overhaul

**Blocked on your list of issues from manual testing.** Not only a visual pass —
you flagged that there are several real problems visible in use. The list is the
input to this phase, and without it the phase cannot be scoped.

---

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

### IPv6 candidate preference is untested

ICE gathers and prioritises IPv6 on its own and nothing in the code suppresses
it, but no test asserts an IPv6 path is preferred where one exists, and the
loopback test environment cannot produce that situation.

### No runtime test that voice ICE reaches the peer connection

`RoomClient.ice` is covered by `apps/server/test/ice-delivery.test.ts`, and the
pass-through into `RTCPeerConnection` is type-checked. But the renderer test layer
does not assert the servers actually arrive at the constructor. This is precisely
the shape of bug that existed until phase 6 — credentials minted correctly and
then dropped on the floor — so it is worth closing properly.

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
