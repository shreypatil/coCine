# Phase B4 — network simulation

Planning document for the fourth part of [phase B](../phase-B.md): *"there are
many network situations that we have technically accounted for but have not
tested, and might never be able to test due to the lack of devices. I want to
simulate these the best we can and test the app on it."*

Everything in **What was measured** below was run on this machine on
20 September 2026, before any of the plan was written, because the shape of the
whole phase depends on the answers — the same way B1 was planned.

---

## The problem this phase exists for

Every automated test in the project runs on loopback, in one process. The seven
ranked failure modes in [`multi-machine-testing.md`](multi-machine-testing.md)
are, today, **hypotheses**. The first of them is also the most consequential
thing nobody knows about coCine:

> Ten to twenty-five per cent of peer pairs cannot reach each other directly.

That figure is quoted from the literature, not measured here, and it decides
whether the product works at all — the TURN relay carries voice but deliberately
never carries film, so a pair that cannot connect directly is a pair where one
person hears everyone and never receives the movie.

Phases 4 and 6 have been waiting on two real machines on two real networks since
September. B4 is the way to stop waiting: reproduce the networks in the kernel
instead of the world.

---

## What was measured

### The simulator needs no root at all

This was the gating question, and the answer is better than expected.

`kernel.unprivileged_userns_clone = 1` on this machine, so
`unshare --user --map-root-user --net --mount` yields a process holding
`CAP_NET_ADMIN` **over its own private network namespace**. Everything the phase
needs works inside it:

| capability | verified by |
| --- | --- |
| Network namespaces | five created, `ip netns` after mounting a tmpfs over `/run` |
| veth pairs and bridges | a 5-namespace topology with a bridged "internet" segment |
| `tc netem` | `delay 40ms 10ms` on a veth; ping reported 33/53/83 ms min/avg/max |
| `nftables` NAT and filter | `masquerade` and `ct state` rules, per-namespace |
| The real WebRTC stack | `node-datachannel` gathered `192.168.1.10` — the namespace's address — **and nothing belonging to the host** |

That last row is the one that matters. The shipping WebRTC stack runs inside the
simulated network and cannot see around it, so tests exercise the real code
against a fake world rather than a fake stack against the real one.

**No `sudo`, and nothing to install.** `ip`, `tc`, `nft` and the `sch_netem`
module are all present. A developer who clones the repo can run this.

### Nothing can outlive the run

Adding `--pid --fork --mount-proc` makes the simulator's shell PID 1 of a
private PID namespace, and **every process inside is reaped when it exits** —
verified against a deliberately orphaned background process. Namespaces,
interfaces, qdiscs and rules all disappear with it, because they only ever
existed inside it.

This is a requirement, not a nicety. Two builds of the probe leaked a stray
STUN server onto the machine before the PID namespace went in.

### The simulator discriminates — cone connects, symmetric does not

The topology: two homes, each behind its own NAT router, both routers on a
bridged segment standing in for the internet, with a minimal STUN responder on
it.

| | raw UDP punch | coCine's WebRTC stack |
| --- | --- | --- |
| **Cone NAT** both sides | 49 and 50 packets through | **connected**, data channel open 0.4 s after the SDP exchange |
| **Symmetric NAT** both sides | **0 packets**, both directions | **failed**, stuck at `checking` for 25 s |

The symmetric run also reproduces the diagnostic signature exactly: the
reflexive candidate's port differs from the local port
(`host:192.168.20.2:44068` against `srflx:203.0.113.6:43564`), because the
mapping to the STUN server is not the mapping to the peer. Under cone NAT the
two ports are identical.

So failure mode #1 is now reproducible on demand, in about thirteen seconds,
with no hardware.

### Two things that would have made the simulator lie

Both produced *false failures* — the worst defect a test rig can have, because
the rig "proves" the application is broken when it is not. Recorded because
anyone rebuilding this will hit them.

**Two WAN links must not share a subnet.** With `203.0.113.0/24` on both
router-to-internet links, the internet namespace had ambiguous routes and one
peer silently gathered no reflexive candidate at all — no error, just a missing
candidate and a connection that never formed. The internet segment has to be a
real bridge both routers attach to.

**Linux conntrack records unsolicited inbound UDP, and that state poisons the
punch.** An inbound packet arriving before any outbound one creates an
`[UNREPLIED]` entry whose reply tuple occupies the external port. The subsequent
outbound punch then cannot have that port, `masquerade` reallocates
(`41000` became `16455` in the measurement), and the peer's replies arrive at a
port nothing is listening on. **A cone NAT built this way behaves like a
symmetric one.**

Real home routers drop unsolicited inbound rather than answering it, so the fix
is also the more faithful model:

```
chain forward { type filter hook forward priority 0; policy accept;
  iifname $wan ct state { new, invalid } drop; }
chain input   { type filter hook input   priority 0; policy accept;
  iifname $wan ct state { new, invalid } drop; }
```

**Both chains are required.** Covering only `forward` leaves the hole: a packet
addressed to the router's own WAN address goes to `input`, and conntrack records
it there just the same. With only `forward` covered, the punch still failed.

---

## Architecture

Two pieces, matching how the project already separates them.

- **`packages/netsim/`** — the simulator. Builds a topology from a scenario
  description, runs a command inside it, tears everything down. Knows nothing
  about coCine.

  It lives under `packages/` rather than `tools/`, which is where this document
  first put it, because `vitest.config.ts` and `tsconfig.json` both look at
  `packages/*` and at neither `tools/*` nor the repository root. A simulator
  whose own correctness is the thing every later measurement rests on has to be
  tested and typechecked by the ordinary commands, not by a special one.
- **`apps/server/scripts/`** — the gates, alongside `drift-test.ts` and
  `transfer-test.ts`, following their conventions: `--key=value` arguments, a
  printed table, `PASS`/`FAIL`, and a non-zero exit when a target is missed.

A scenario names namespaces, the links between them, the NAT behaviour of each
router, and the shaping on each link. The existing application-level knobs
(`--latency`, `--jitter` on `drift-test`) stay: they are faster and they are the
right tool for testing the sync algorithm. The simulator is for the questions
those knobs cannot reach — NAT, real queueing, loss, reordering, and a link that
goes away.

### NAT behaviours to model

| behaviour | how | what it stands for |
| --- | --- | --- |
| Endpoint-independent ("cone") | `masquerade` + the inbound drop | most home broadband |
| Symmetric | `masquerade random` | corporate, and some ISPs |
| Carrier-grade NAT | two routers in series | mobile networks, Jio |
| UDP blocked | drop UDP on the WAN | corporate and university networks |
| IPv6 both sides, IPv4 CGNAT one side | dual-stack topology | the Indian ISP case |

---

## Sub-phases

### B4.0 — Feasibility gate — **PASSED**

Everything under *What was measured*. The scratch probes are throwaway; B4.1 is
where they become a tool.

### B4.1 — The simulator — **DONE**

`packages/netsim/` builds a topology from a declarative scenario and runs
workloads in named namespaces. A scenario names *sites* — a machine and whatever
sits between it and the internet — rather than namespaces and veth pairs:

```ts
await runScenario({
  sites: [
    { name: 'alice', nat: ['cone'], link: { delayMs: 40, jitterMs: 8, rateMbit: 16 } },
    { name: 'phone', nat: ['cone', 'symmetric'] },   // carrier-grade NAT
    { name: 'office', nat: ['cone'], udpBlocked: true },
    { name: 'server' }                                // straight onto the internet
  ]
}, [{ name: 'probe', ns: 'alice', argv: [...] }])
```

`planScenario` is a pure function from that to the list of commands, which is
the part worth testing hardest: every defect that made the prototype lie was a
defect in the plan, and none of them needed a namespace to catch.

**What it delivers.** NAT layers, endpoint-independent and symmetric mappings,
carrier-grade NAT as two layers in series, UDP blocked at the edge, and
per-direction `netem` shaping for delay, jitter, loss, reordering and rate.
Teardown is guaranteed by the PID namespace rather than by remembering to clean
up. `netsimSupport()` reports why it cannot run, and the tests skip on that
rather than failing.

**Its tests.** Twenty-two pure assertions on the plan, which run anywhere, and
nine against a real kernel, which skip where namespaces are unavailable. Both
were verified to discriminate by deliberately removing the conntrack drop rule:
the pure test for it fails, and — the one that matters — the real-kernel test
*"lets two endpoint-independent NATs punch through to each other"* fails too,
while the other eight still pass. So the rig detects the exact defect that would
otherwise make it report every pairing as unreachable.

One measurement worth keeping: an unshaped link in the simulator has a minimum
round trip of **0.6 ms**, and the same probe across a link shaped to 40 ms each
way reads **80.4 ms**. The assertions use the *minimum* round trip rather than
the median, because the first samples carry Node's own startup and read as
hundreds of milliseconds however idle the link is — which is the same reason the
sync engine's clock estimator keeps the lowest round trip in its window.

### B4.2 — The connectivity matrix — **DONE**

`npm run b4-matrix` runs every pairing of network positions through coCine's own
ICE configuration, over the real WebRTC stack, against real kernel NATs.

```
npm run b4-matrix                      every pairing, once each
npm run b4-matrix -- --quick           the five decisive ones
npm run b4-matrix -- --repeat=5        each cell five times, for flakiness
npm run b4-matrix -- --only=open,cone  one pairing
npm run b4-matrix -- --verbose         the candidate kinds behind each cell
```

Five positions: **open** (a machine on the internet, which is what a server is),
**cone** (an ordinary home router, endpoint-independent mapping), **symmetric**,
**cgnat** (a home router behind a carrier's symmetric NAT — the mobile case) and
**udp-blocked** (corporate and university networks).

**It runs coCine's policy, not a copy of it.** `iceServersFor` is imported from
the signalling server, so the thing measured is the shipping decision — voice
may relay, bulk transfer never may — and only the STUN address is substituted,
since the public servers are unreachable from a namespace with no route off this
machine. If someone ever gave the film transport a relay, this would say so.

#### What it measured

Three attempts per cell, on 21 September 2026. `✓` means a film would arrive;
`✗` means it would not, and relay mode is the only way that pairing watches
anything together.

|             | open | cone | symmetric | cgnat | udp-blocked |
| ---         | :-:  | :-:  | :-:       | :-:   | :-:         |
| **open**        | ✓ | ✓ | ✓ | ✓ | ✗ |
| **cone**        | ✓ | ✓ | ✗ | ✗ | ✗ |
| **symmetric**   | ✓ | ✗ | ✗ | ✗ | ✗ |
| **cgnat**       | ✓ | ✗ | ✗ | ✗ | ✗ |
| **udp-blocked** | ✗ | ✗ | ✗ | ✗ | ✗ |

**Five of fifteen pairings carry a film**, and only two mechanisms produce them:
one end being publicly reachable, or two ordinary home routers punching to each
other. Every symmetric NAT fails against every peer that is not public, and
`cgnat` inherits that because its outer layer is symmetric.

**There is no middle ground.** A pairing that connects does so in 0.0-0.2
seconds; there is no case that is slow but workable. It works at once or not at
all — which is worth knowing for any interface that wants to show progress
while a connection is being established, because there is nothing to show.

This is a harsher picture than the quoted ten to twenty-five per cent, but it is
not directly comparable and must not be read as replacing it: this says what
happens *given* a pairing, and the quoted figure is about how often the bad
pairings occur. Multiplying the two together needs the second number, which is a
property of people's ISPs and still wants real machines. What can be said now is
that the cases coCine survives are narrower than the phrase "most peers connect"
suggests, and that `open` — a participant with a public address — rescues every
pairing it is part of except a blocked one.

#### It is a gate, not just a report

Each cell carries an expectation derived from first principles rather than from
what it did last time, or a regression would quietly become the new baseline.
A machine on the internet has a host candidate anyone can reach, so it pairs
with anything allowed to send UDP. Two endpoint-independent NATs both present
the port STUN reported, so a punch lands. A symmetric NAT presents a different
port to the peer than it did to STUN, and the port-restricted filtering on the
other side drops what arrives from an unexpected source — so it fails, and so
does carrier-grade NAT, whose outer layer is symmetric.

The run exits non-zero when a cell disagrees with that, when a cell connects
only sometimes, or when the film transport is ever offered a relay. Verified to
discriminate: flipping one expectation turns `PASS` into
`FAIL — 1 cell disagreed with the design` and the exit code to 1.

`apps/server/test/nat-traversal.test.ts` keeps the two decisive cases in the
ordinary test run, so the matrix cannot rot between phase runs.

#### What is measured and what is not

**Flakiness is reported rather than hidden, and then it was fixed.** A cell that
connects two times in three is not the finding a bare *yes* or *no* would
suggest, and reporting either would have been wrong.

`open ↔ cgnat` came out 2/3 in two consecutive full runs while passing 10/10
when run alone. Two identical results looked like evidence of a real
probabilistic property — a pairing that depends on peer-reflexive discovery
winning a race — and that reading was wrong. It was load, and the coincidence
was just a coincidence.

The cause was worth finding rather than retrying around. The two peers started
ICE on a fixed 250 ms delay and assumed the STUN responder had finished binding
by then; under the load of ninety consecutive scenario builds it sometimes had
not, the peer gathered host candidates only, and a pairing that always works was
reported as failing. `ice-peer.mjs` now sends raw STUN binding requests until
one is answered before creating the peer connection, so the wait is on the
server actually responding rather than on a guess about how long it takes to
start. The cell has been 3/3 since.

**A measurement tool that is less reliable than the thing it measures is worse
than no tool**, because its false negatives are indistinguishable from
discoveries. That is the reason `--repeat` exists and the reason a partial
result fails the gate rather than being rounded to the nearest verdict.

**Both ends are read.** ICE is symmetric and the two should always agree, so a
disagreement is either a harness bug or a genuinely surprising path. Reporting
whichever end happened to be asked would average it away.

**The relay arm is not measured, and the table says so.** A TURN server cannot
be borrowed from Docker for this: a container lives in a network namespace the
daemon owns, and there is no way to attach it to one an unprivileged process
made. With no `turnserver` binary installed, voice is offered exactly the ICE
the film is, so the two columns agree by construction and the voice column says
nothing about relaying. The script detects this and prints it rather than
letting the column be misread. Installing coturn would complete the arm.

**How common each pairing is remains unknown.** The matrix says what happens
given a pairing. What fraction of real pairings are symmetric-to-symmetric is a
property of people's ISPs, and still needs real machines on real networks.

#### A finding about the application, not the simulator

**libdatachannel never declares the connection failed.** A pairing with no
possible path was left for forty seconds and the peer connection stayed in
`checking` throughout; `connectionState` reached `failed` neither then nor at
twelve seconds. Every "cannot connect" cell in the matrix is therefore
necessarily budget-limited rather than ICE-confirmed, which is why the report
says so rather than claiming more than it knows.

That property belongs to the shipping application as much as to this harness,
and it explains a symptom `multi-machine-testing.md` already describes from the
other end:

> transfer progress stays at 0 %, **peers** stays at 0, the room never leaves
> *preparing*

There is no event to hang an error on. A peer whose network cannot work does not
report a failure; it waits, indefinitely and silently, looking identical to a
peer that is merely slow. Anything in the interface that wants to say *"this
connection is not going to happen, switch to relay mode"* has to decide that for
itself on a timer, because the WebRTC stack will not volunteer it.

Worth deciding separately from this phase: what that timeout should be, and
whether the room should suggest relay mode when it expires.

### B4.3 — Sync and transfer on real links

Run the existing phase 1 and phase 4 gates inside the simulator, with kernel
shaping instead of injected delay. First contact with real jitter, real loss,
real reordering and real queueing for:

- the clock estimator, which keeps the lowest round trip in a sliding window
  specifically to survive jitter that it has never met (failure modes 4 and 5)
- the readiness gate, against genuinely unequal download speeds
- transfer stalls and playback stalling at a hole (failure modes 6 and 7)

### B4.4 — Deliberate breakage

The things a second machine would let you do by hand: a link dropped mid-film
and restored, the sharer vanishing, wildly asymmetric uplinks, a late joiner on
a slow line. This also produces the awkward buffer states B1.3's transfer-aware
seeking needs on demand, rather than waiting for one to occur naturally.

### B4.5 — Wiring in

An opt-in gate, the way `test:app` is opt-in, plus a documented run in
`multi-machine-testing.md` saying which of the seven failure modes are now
covered by a machine and which still need two.

---

## What this phase cannot do

Worth stating plainly, so the results are not over-read.

- **It cannot measure how common a NAT behaviour is.** The matrix says what
  happens for each pairing; what fraction of real pairings fall into each cell
  is a property of the world, and still needs real machines on real ISPs.
- **`masquerade random` is a model of symmetric NAT, not a symmetric NAT.**
  Real implementations vary, particularly in their mapping lifetimes.
- **No radio.** Mobile networks are not only CGNAT: they have variable loss,
  handover and deep buffers. `netem` approximates those; it does not reproduce
  them.
- **It is one kernel.** Everything here is Linux. Windows and macOS peers behave
  differently at the edges, and that is unchanged by this phase.
