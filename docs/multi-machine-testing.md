# Testing coCine across real machines

Everything automated so far runs on **loopback, in one process**. That is a real
limitation, not a formality: it means the swarm has never crossed a NAT, never
seen a variable round trip, and never had a peer it simply could not reach.

This is what to try once you have two machines, what is most likely to break,
and how to tell one failure from another.

> Do this **after phase 6**. Phase 6 adds coturn, and roughly one peer pair in
> five cannot connect without a relay. Before then, a failure to connect is
> expected behaviour rather than a bug — see *Peers that cannot connect*.

---

## Setup

The server must be reachable from both machines. On a LAN, running it on one of
them is enough.

```bash
# on the machine that will host the server
npm run server                     # listens on :8787, all interfaces

# on each machine
npm run desktop
```

In the app, set **Server** to `ws://<server-machine-ip>:8787` rather than
`127.0.0.1`. One person presses **Create a room** and reads out the code; the
other types it in and presses **Join**.

Then one person opens a film. The other should start fetching it automatically.

### Check each machine's network first

```bash
npm run nat-check
```

Thirty seconds per machine, and it says what that network will do to a peer
connection: whether IPv6 works, whether the IPv4 NAT keeps one mapping per socket
(punchable) or a different one per destination (not), and whether the line is
behind carrier-grade NAT. Run it on both machines before a session and compare —
**connectivity is a property of the pair**, so neither result means much alone.

It is also the cheapest way to feed the phase 6 connection-success-rate
measurement: record both outputs alongside whether the film actually transferred.

### Adding a relay (optional on a LAN, needed across the internet)

Voice between two people whose routers both refuse direct connections needs a
relay. Roughly one home pairing in ten needs one; on mobile networks it is most
of them. Run coturn next to the signalling server:

```bash
# edit infra/turnserver.conf and replace static-auth-secret with a long random
# string -- a relay with a guessable secret is found and abused within days
docker run -d --name cocine-turn --network host \
  -v "$PWD/infra/turnserver.conf:/etc/coturn/turnserver.conf:ro" \
  coturn/coturn:latest -c /etc/coturn/turnserver.conf

# then start the signalling server pointing at it, with the same secret
COCINE_TURN_URLS="turn:<relay-ip>:3478,turns:<relay-host>:443" \
COCINE_TURN_SECRET="<the same long random string>" \
  npm run server
```

The server prints which relay it is handing out at startup, so a typo shows up
immediately rather than as voice that mysteriously fails for one pair of people.

Open UDP/TCP 3478, TCP 443, and UDP 49160-49200 to the relay. The 443 listener
matters more than it looks: it is what gets through networks that block UDP and
non-standard ports, which is most corporate ones.

**The TURN relay carries voice only.** Bulk film transfer is never given these
credentials, by design — a relayed film crosses the server twice, in and out,
for every viewer who needs it. Someone on a hopeless connection will hear
everyone and still fail to receive the film. That is the intended trade, not a
bug: relaying films through TURN would put the whole cost of the app on whoever
runs it.

### Relay mode, for the room the swarm cannot serve

Separate mechanism, separate decision. If a pairing turns out to have no workable
peer connection, the host can switch the room to relay mode from the Film panel:
the sharer uploads the film once to object storage and everyone fetches from
there. It needs storage configured on the server:

```bash
COCINE_R2_ENDPOINT=https://<account>.r2.cloudflarestorage.com \
COCINE_R2_BUCKET=cocine COCINE_R2_KEY_ID=... COCINE_R2_SECRET=... \
  npm run server
```

Without it the host sees no toggle at all. **This is the case worth testing
deliberately** once you find a pairing that cannot connect: switch to relay mode
and confirm the film arrives and plays in sync. Switching clears the current
film — it has to be shared again, because its bytes live where only the other
transport can reach them.

Keep the terminal running `npm run desktop` visible on both machines. It carries
the main-process log, which is where the useful detail is.

---

## What to actually test

Roughly in order of how much it would hurt to have wrong.

### 1. Two peers on the same LAN

The easy case, and the one most likely to work. Establishes that nothing is
broken in the basics before adding NAT to the picture.

- [ ] Both join the same room, and each sees the other in **Watching**
- [ ] Chat passes both ways
- [ ] The receiver's film progress climbs, and **peers** is 1 or more
- [ ] Playback starts before the transfer completes
- [ ] Drift stays under 100 ms — the badge beside the room code
- [ ] Pause, play and seek from either machine move both

### 2. Two peers on different networks

The real test. One machine on home wifi, another on a phone hotspot or a
different building.

- [ ] They can connect at all — watch **peers** in the sync panel
- [ ] Drift over a real link with real jitter, not loopback's zero
- [ ] Transfer rate is plausible for the slower uplink
- [ ] The countdown resembles reality

### 3. Three or more

- [ ] A third joins mid-transfer and catches up
- [ ] The gate waits for everyone
- [ ] **Start anyway** leaves the named person behind and the rest play in sync
- [ ] Someone joining *after* playback starts fetches from the playhead, not
      from the beginning

### 4. Things going wrong on purpose

- [ ] The sharer closes their laptop mid-film. Does playback continue? The
      interface claims to know — check it was telling the truth
- [ ] Pull the network cable on one machine for thirty seconds, then restore
- [ ] Quit a receiver mid-transfer and reopen it. Does it resume, or start over?
- [ ] Seek backwards to a part nobody has fetched yet

### 5. A long sitting

Nothing has ever run for more than about two minutes.

- [ ] Watch a real film end to end. Drift at the end, not just the start
- [ ] Memory of the app and of mpv after two hours

---

## Likely points of failure

Ordered by how likely I think they are.

### Peers that cannot connect — likely, and the main thing to measure

Ten to twenty-five per cent of peer pairs cannot reach each other directly. Both
behind symmetric NAT or carrier-grade NAT — common on mobile networks — and
there is no direct path at all.

Voice now has a way out of this, if a relay is configured (see Setup). **Bulk
transfer deliberately does not**, so a peer that cannot be reached directly by
anyone cannot receive the film, and this is the case to actually measure: how
often it happens on real connections.

*Looks like:* transfer progress stays at 0 %, **peers** stays at 0, the room
never leaves *preparing*. Chat and playback control still work perfectly,
because those go through the server rather than peer to peer. If a relay is
running, voice works while the transfer does not — which is itself the
diagnosis.

*How to be sure:* if chat works and progress does not move, it is connectivity,
not the transfer code. Both machines on the same LAN should always work; if the
LAN works and across-the-internet does not, that is exactly this.

*Worth reporting* with the network each machine was on — home broadband, office,
phone hotspot. The point of this round of testing is to find out how common it
is, which cannot be worked out from here.

### Voice failing while everything else works — possible

If voice is the only thing broken, it is the relay: either not configured, the
secret not matching between `turnserver.conf` and `COCINE_TURN_SECRET`, or its
ports closed.

*Check:* the signalling server's startup line says which relay it hands out, or
`none` if it has none. `docker logs cocine-turn` shows `ALLOCATE processed,
success` when credentials are accepted and `401: Unauthorized` when the secret
does not match.

### The server not actually reachable — likely, and boring

`npm run server` binds to all interfaces, but a host firewall may not let 8787
in, and some networks isolate clients from each other.

*Looks like:* joining fails immediately with a connection error in the red
banner.

*Check:* `curl -v telnet://<server-ip>:8787` from the other machine, or simply
whether the join succeeds at all.

### Clock offset larger than anything tested — possible

The sync engine recovers a server clock offset from ping exchanges. It has been
tested against a deliberate 37-second skew, but only with a simulated network.
Two machines with genuinely unsynchronised clocks and real jitter are new.

*Looks like:* **clock offset** in the sync panel reads something implausible, or
drift is large and does not settle.

*Worth capturing:* the clock offset and round trip values from both machines.

### Real round-trip variance — possible

Loopback round trips are effectively zero. The estimator keeps the *lowest*
round trip in a sliding window specifically to survive jitter, but that has
never faced real jitter.

*Looks like:* drift creeping up rather than settling, or the correction visibly
hunting — playback speeding up and slowing down.

### Transfer stalling part way — possible

Metadata arrives from a peer rather than from the tracker, and that occasionally
did not happen first time even on loopback. It retries once. Across a real
network the failure modes are wider.

*Looks like:* progress stops and does not resume; the log shows
`no metadata from the swarm` or nothing at all after `[film] receiving`.

### Playback stalling at a hole — possible

Playback streams through WebTorrent rather than reading the file, so it blocks
on pieces that have not arrived. If the piece windows cannot keep ahead of the
playhead, mpv waits.

*Looks like:* picture freezes while the room's clock keeps moving; drift climbs
because one player has stopped.

*Distinguishing it:* transfer progress is still climbing, and the person who
froze recovers on their own after a few seconds.

### Firewall blocking the tracker — less likely

The tracker shares the signalling port, so if joining works the tracker is
reachable. Mentioned only to rule it out.

---

## What to capture when something breaks

Enough to diagnose without you having to reproduce it on demand:

1. **Both terminals.** The `npm run desktop` output on each machine — it carries
   `[film]`, `[renderer]` and `[transfer]` lines.
2. **The sync panel numbers** from both: drift, clock offset, round trip, peers.
3. **Which machine was which** — who shared, who joined, who was on what network.
4. **Whether chat kept working.** This one line separates "cannot connect to each
   other" from "the transfer is broken", and it is the most useful single fact.

---

## What is already known to work, so you can skip it

Verified on this machine and not worth re-testing by hand:

- Sync holds at 35 ms p99 across five clients with a simulated 40 ms link and a
  37-second server clock skew
- A film transfers over WebRTC with TCP and uTP disabled, byte-identical
- Playback starts at under 3 % downloaded with the room in sync at 10 ms p99
- The readiness gate, the countdown, host controls and durability reporting
- Rooms, codes, chat, roles, and the interface itself — 211 automated tests

What none of that touches is **two machines and a real network**. That is the
whole of what is left to find out.
