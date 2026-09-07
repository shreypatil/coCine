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

### Peers that cannot connect — very likely, and expected before phase 6

Ten to twenty-five per cent of peer pairs cannot reach each other directly. Both
behind symmetric NAT or carrier-grade NAT — common on mobile networks — and
there is no path without a relay. **coturn is phase 6 and does not exist yet.**

*Looks like:* transfer progress stays at 0 %, **peers** stays at 0, the room
never leaves *preparing*. Chat and playback control still work perfectly,
because those go through the server rather than peer to peer.

*How to be sure:* if chat works and progress does not move, it is connectivity,
not the transfer code. Both machines on the same LAN should always work; if the
LAN works and across-the-internet does not, that is exactly this.

*Not a bug to report.* It is the gap phase 6 fills.

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
