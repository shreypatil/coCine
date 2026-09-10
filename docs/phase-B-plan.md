# Phase B — plan

Planning document for the work described in [`phase-B.md`](../phase-B.md). That
file states the goals; this one says how, in what order, and what was measured
rather than assumed.

Everything in the "what was measured" sections below was run on this machine
against Electron 44.2.0 (Chromium 152) before any of the plan was written, because
the whole shape of B1 depends on the answers.

---

## Recommended order

Not the numbered order, and the reasoning is about what unblocks what. The
sequencing is yours; this is a recommendation.

1. **B2 — public server.** Smallest of the four, and it is currently the last
   blocker on anyone outside this machine using coCine at all. It also unblocks
   the real-world measurements that phases 4 and 6 have been waiting on, which
   B4 can only approximate.
2. **B1 — custom player.** The largest, and the one that retires the most
   existing patchwork. Nothing else depends on it.
3. **B4 — network simulation.** Cheap once B2 exists, and it de-risks B1.3
   (transfer-aware seeking) by producing the awkward buffer states on demand.
4. **B3 — macOS.** Needs a Mac, so it is gated on hardware rather than on us.

If the goal is "friends can use it this month", B2 alone achieves more than B1
does. If the goal is "the app stops being annoying to use", B1 is the one.

---

# Phase B1 — a player of our own

## What was measured

The `<video>` element in Electron is far more capable than the earlier
assessment assumed, and the measurements change which design is correct. All of
these were run against a real range-serving HTTP origin, which is what the
existing torrent stream server already is.

**Plays, seeks, and decodes after seeking:**

| Container / codec | Result |
| --- | --- |
| `.mp4` H.264 + AAC | plays |
| `.mkv` H.264 + AAC | plays |
| `.mkv` H.264 + **AC-3** | plays |
| `.mkv` H.264 + **DTS** | plays |
| `.mp4` **HEVC** + AAC | plays |
| `.webm` VP9 + Opus | plays |
| `.avi` Xvid + MP3 | **`DEMUXER_ERROR_COULD_NOT_OPEN`** |
| `.mpg` MPEG-2 + MP2 | **`DEMUXER_ERROR_COULD_NOT_OPEN`** |

Matroska plays, which contradicts the common wisdom that Chromium cannot demux
it. So does DTS, and so does AC-3 — even though `MediaSource.isTypeSupported`
reports AC-3 as unsupported. That is not a contradiction: the `src=` path uses
Chromium's full FFmpeg demuxer, and MSE is the narrower surface. **This matters
because it means we do not need Media Source Extensions at all**, and therefore
do not need a remux pipeline in the common case.

**Sync fidelity, which is the constraint the product hinges on:**

| Property | Measured |
| --- | --- |
| `currentTime` resolution | 194 distinct values in 200 samples at 5 ms — effectively continuous |
| Drift of media clock vs wall clock over 8 s | **−0.1 ms** |
| Effect of a 5 % rate nudge over 3 s | +122.6 ms, i.e. correction works |
| Seek error, three non-keyframe targets | **0.1 ms** on all three |

The 100 ms budget is a ceiling this clears by three orders of magnitude. It is
worth being explicit: `<video>` is a *more* precise control surface than mpv over
JSON IPC, not a compromise against it — seek lands within 0.1 ms where mpv needs
`--hr-seek` to get within a frame.

**Confirmed gaps, which are what B1.4 and B1.5 exist for:**

- Embedded subtitle tracks are invisible. An MKV carrying an ASS track reports
  `textTracks.length === 0`.
- There is no `audioTracks` API, so a film with several audio tracks plays
  whichever Chromium picks and cannot be switched from script.
- AVI and MPEG-2 do not open at all.

**Not yet measured, and each is a spike in B1.0:** whether hardware decoding
engages for 4K HEVC on this hardware, and how `<video>` behaves when the stream
server blocks on a piece that has not arrived — mpv's behaviour there is known,
Chromium's is not.

## The decision this reverses, stated plainly

There is a locked decision on record that coCine should "integrate with
local/native players rather than relying on an in-browser HTML5 video element",
with the player engine constrained by "native player, ≤100 ms control fidelity".

This plan proposes exactly the thing that decision ruled out, so it should be a
deliberate reversal rather than a quiet drift. The case for reversing:

- The constraint behind the decision was control fidelity, and the example that
  motivated it was VLC's HTTP interface polling at roughly 1 Hz. `<video>`
  measures at 0.1 ms seek error and −0.1 ms clock drift. The constraint is met
  by a wide margin, so the rule that encoded it no longer selects correctly.
- Format support was the other implicit worry, and it is now largely answered:
  every modern container and codec a film ships in plays, with a small, named,
  fixable gap.
- Three of B1's seven requirements — single window, chat over fullscreen video,
  Wayland — are *consequences* of not embedding a foreign window. They stop
  being work and become properties.

If you would rather not reverse it, the alternative worth considering is
**libmpv's render API** (§ Alternatives) — it keeps mpv's decoding while
rendering into a surface we own. It solves the window problems and keeps the
locked decision intact, at a significantly higher engineering cost.

## Architecture

A `<video>` element in the existing renderer, pointed at the URL the torrent
stream server already serves, with everything else drawn over it in ordinary DOM.

```
  ┌─ the one BrowserWindow ─────────────────────────────┐
  │  React                                              │
  │   ├── <video src="http://127.0.0.1:PORT/…">         │  ← torrent stream server,
  │   ├── subtitle canvas   (JASSUB / libass-wasm)      │    which already blocks
  │   ├── chat overlay      (plain DOM, any mode)       │    on missing pieces and
  │   └── controls, transfer panel, member list         │    already serves ranges
  └─────────────────────────────────────────────────────┘
           │ HtmlVideoPlayer implements PlayerController
           ▼
     packages/sync — unchanged
```

Two things make this cheap rather than a rewrite:

- **`PlayerController` is already the only surface the sync engine touches.** It
  was built so "the sync engine must not be able to tell them apart". A third
  implementation alongside `ExternalMpv` and `EmbeddedMpv` is the intended
  extension point, and `packages/sync` does not change at all.
- **The stream server already exists and already does the hard part.** It serves
  byte ranges and blocks on pieces that have not arrived, which is precisely what
  `<video>` needs. The range path is confirmed working — the probe above served
  five range requests while seeking.

## Sub-phases

### B1.0 — Feasibility gate — **PASSED**

Run it with `npm run phase0:html`, `npm run phase1:html` and `npm run b1-gate`.

| Gate | Result |
| --- | --- |
| Phase 0 criteria, same harness as mpv | **pass** — 0 ms worst seek error over six seeks, command round trip p99 0.90 ms, 24.6 Hz position feed |
| Phase 1, five peers, 100 ms budget | **pass** — p99 48.7 ms, 0 of 689 samples over budget, all 10 events re-converged (p50 0.20 s) |
| 4K H.264 decode | **pass** — 0.00 % frames dropped, 1.00× real time |
| 4K HEVC decode | **pass** — 0.00 % frames dropped, 0.99× real time |
| Recovers from a missing piece | **pass** — stalled 1.5 s at the downloaded edge, then resumed, and reached 14.6 s of a 15.0 s film |

Two things worth carrying into B1.1 rather than filing as passed and forgotten.

**mpv still holds the room about twice as tightly**: p99 26.9 ms against 48.7 ms
on an identical run. The per-client deviation of roughly 35 ms is close to one
frame, which points at `currentTime` being quantised to the frame rather than at
anything about the transport — an early version of the spike timestamped
positions in the main process *after* an IPC round trip, and fixing that alone
took p99 from 66.5 ms to 48.7 ms. `requestVideoFrameCallback` reports a precise
presentation timestamp for each frame and is the obvious next improvement; it
should land in B1.1 rather than being chased here, since the budget is already
met with headroom.

**Decoding 4K is not a concern.** Both codecs played at real time with no
dropped frames at all, which answers the question the plan flagged as most
likely to force a retreat to libmpv.

---

The original scope of this gate, for reference:

A spike, not a foundation. Answer the three things that would invalidate the
rest, and stop if any of them fails.

- Drive the existing phase 0 and phase 1 harnesses against a throwaway
  `HtmlVideoPlayer`, so the 100 ms budget is proven by the same tests that prove
  it for mpv rather than by a new measurement that flatters itself.
- Play a real 4K HEVC film and check whether hardware decode engages, and what
  CPU it costs if it does not.
- Point `<video>` at the torrent stream server mid-transfer and watch what it
  does when it reaches a piece that has not arrived. Recovering is required;
  stalling permanently is a blocker.

**Exit:** drift within 100 ms across five simulated peers, a 4K file that plays
without dropping frames, and a stream that recovers from a missing piece. All
three met; see the table above.

### B1.1 — The player, behind a flag — **DONE**

`HtmlVideoPlayer` implementing `PlayerController`, selected by an environment
variable so mpv stays the default until it is better. Playback, pause, exact
seek, rate, volume, duration, and the `position`/`pause`/`eof` events.

Runs in the existing two-window layout. Nothing is deleted yet, which keeps this
step revertible.

**Exit:** a film plays in a room, in sync, with the sync tests passing against
both implementations.

### B1.2 — One window, alongside the other one — **DONE**

**Revised: nothing is deleted.** The earlier version of this step removed the
second `BrowserWindow`, `x11-embed.ts`, the SHAPE overlay machinery and the
`--wid` path outright. That was wrong to write down as a consequence of the new
player working. The gate answered "can it?" and not "is it better?", and on the
one number where they differ mpv is ahead — p99 drift 26.9 ms against 48.7 ms,
both inside budget. Which one ships is a judgement to make after watching a film
with each, and it may not be the same answer on every platform.

So this step *adds* a single-window path beside the existing one, selected by
`COCINE_PLAYER` (see `apps/desktop/src/main/player-engine.ts`):

- `COCINE_PLAYER=mpv` — today's behaviour, unchanged: a child window with mpv
  reparented into it, and the shaped overlay for chat.
- `COCINE_PLAYER=html` — a `<video>` in the main window, with chat, subtitles
  and controls as ordinary DOM above it.

Everything the mpv path needs stays exactly where it is. The X11 machinery is
not touched, so the choice stays reversible for as long as it needs to be.

What the `html` side gets for free is still worth stating, because it is the
case for eventually preferring it: chat over fullscreen video becomes a `div`
with a `z-index`; Wayland works without forcing `--ozone-platform=x11`, which
restores native fractional scaling; and the class of bug that produced the black
screen cannot occur, because there is no second window to place, no geometry to
self-heal and no foreign surface to keep in position.

**Exit:** a film plays in a room under either engine, chosen at launch, with the
existing overlay and video-output suites still passing on the mpv path.

### B1.3 — Transfer-aware seeking — **DONE**

Requirement 3, and the one that is genuinely new rather than a repair.

- **Forward** is clamped to the least-buffered participant, which the room
  already knows: every client reports `bufferEndSec` and a 64-bucket piece map
  once a second, and `transfer.status` already carries the room's minimum.
- **Backward** is clamped to what the seeker holds, which the piece map answers,
  so a late joiner cannot seek into a stretch they never downloaded.
- The seek bar should *show* this rather than only enforce it — the reachable
  span drawn against the whole film, so a blocked seek is visibly a property of
  the room rather than a bug.
- Enforce on the **server**, not only in the renderer. A clamp that lives in the
  client is a courtesy, and `playback.request` is already permission-checked
  there, so this belongs beside that check.

**Exit:** a test with a deliberately lagging peer proves the clamp holds, and a
late joiner cannot seek backwards past what they hold.

### B1.4 — Subtitles — **DONE**

- External `.srt` and `.ass` alongside the film, and drag-and-drop.
- Embedded tracks: `textTracks` is empty, so they have to be extracted. FFmpeg
  can list and dump them without touching the video stream.
- Render ASS with **JASSUB** (libass compiled to WebAssembly) on a canvas over
  the video. That gives real ASS rendering — positioning, karaoke, styling —
  rather than the approximation a `<track>` element would manage.
- Controls for colour, size, position and delay, which requirement 6 asks for
  and which libass supports directly.

### B1.5 — The formats Chromium refuses — **DONE**

Only AVI and MPEG-2 among the things tested, so this is a fallback path rather
than a pipeline everything goes through.

- Probe the file on load. Direct-play when Chromium can (the common case).
- Otherwise remux with FFmpeg into MKV, which is nearly free when the codecs are
  already acceptable, and transcode only when they are not.
- FFmpeg has to be bundled, which is the same packaging problem `fetch-mpv.mjs`
  already solves for mpv and can be adapted from.

### B1.6 — Decided: the `<video>` engine ships, mpv stays selectable

**The `<video>` engine is the default on every platform.** `COCINE_PLAYER=mpv`
still selects the other one, and nothing about it was removed.

The drift figures alone would have favoured mpv -- p99 26.9 ms against 48.7 ms
at five peers, level at ten, both well inside the 100 ms budget. Everything else
favoured the new engine, and one thing decided it:

- **mpv's picture is broken in ordinary use.** Entering fullscreen turns it
  black permanently and a film starts black about half the time, measured
  rather than inferred, and forcing a software output makes it worse. The
  `<video>` engine shows no black frame at any point in the same test.
- Chat over the film, subtitles and the fullscreen controls exist *only*
  because the film is in the window; none could be drawn above mpv's surface.
- Wayland works without forcing `--ozone-platform=x11`.

mpv earns its place still: it decodes natively what this engine has to convert
first, which is the better answer for a library of old rips, and it is the path
with years of other people's use behind it.

**Both gaps are closed.** Advanced SubStation is rendered by libass compiled to
WebAssembly, and subtitle tracks *inside* a film -- which the media element never
reports -- are listed with ffprobe and extracted with ffmpeg. ffmpeg itself now
ships for every platform, Linux included: the `.deb` can declare a dependency
but an AppImage cannot, and the AppImage is what a stranger downloads.

### B1.6 — the original scope


**Revised: a decision, not a removal.** This was "retire mpv from the shipped
app". It is now the point at which both engines have been used by hand, on each
platform that matters, and a choice is made — possibly a different one per
operating system, which `defaultEngine()` is written to express.

The trade is not close to symmetric, which is why the answer may differ:

- mpv holds the room measurably tighter, and is the path that has actually been
  shipped and run by people.
- The `<video>` path cannot produce the black-screen or fullscreen-chat classes
  of bug at all, works on Wayland, and drops the "requires mpv on PATH" caveat
  along with mpv from the installers.

Whatever is decided, **`ExternalMpv` and `MpvIpc` stay regardless.** The comment
in `external-mpv.ts` gives the reason and it remains true: "you cannot point
five embedded players at one machine, but you can point five of these." The
drift tests depend on it, and it costs nothing to keep once it is no longer the
thing on screen.

Only if mpv is dropped on a platform does its packaging come off there —
`fetch-mpv.mjs`, `locate.ts` and the "install mpv" messaging are per-platform
concerns and can go one platform at a time.

## What else becomes easy

Requirement 7 asks what is newly possible. The largest one is not on the list:

- **The echo-cancellation problem may finally be fixable.** It is recorded as
  having no real fix: "Chromium removes only audio it played itself, and mpv
  plays through an entirely separate path, so on speakers every microphone picks
  up the film and sends it back." With the film playing *through Chromium*, its
  audio is on the same path as the call for the first time — routing it through
  Web Audio should let the echo canceller see it. That would retire push-to-talk
  as a workaround rather than a preference. Worth a spike of its own; it is the
  single biggest quality-of-life win available here.
- Per-user volume and film ducking, precisely, via Web Audio rather than by
  setting a percentage on a foreign process.
- Scrub-bar thumbnail previews, generated locally from what is already held.
- Buffering and readiness drawn *on* the video instead of beside it.
- Picture-in-picture, for free.
- Reactions and emotes over the film, now that anything can be drawn over it.
- Brightness, contrast and aspect controls in CSS or a shader.

## Alternatives considered

- **libmpv render API.** mpv rendering into an OpenGL surface we own. Keeps the
  locked decision and mpv's decoding breadth, and solves the window problems.
  Rejected as the default because it needs a native addon per platform sharing a
  GL context with Chromium — considerably harder than everything above, for
  advantages the measurements say we do not need. Worth revisiting only if B1.0
  fails on hardware decoding.
- **WebCodecs with a hand-written demuxer.** `VideoDecoder` is available and
  supports H.264, HEVC and AV1 (confirmed, in a secure context — it is absent
  from opaque origins such as `data:` URLs, which is worth knowing before anyone
  tests it the way I first did). Rejected because it means owning demuxing and
  the A/V clock for no gain over `<video>`, which already gives frame-accurate
  control.
- **MSE with an FFmpeg remux pipeline.** The Jellyfin model. Rejected because
  the direct `src=` path is strictly more capable here — AC-3 and DTS play
  through it and not through MSE.

## Risks

| Risk | Mitigation |
| --- | --- |
| No hardware decode → 4K unplayable on modest machines | Measured first, in B1.0. Fall back to libmpv render API if it fails. |
| `<video>` stalls permanently on a missing piece | Measured in B1.0; the scheduler can prioritise differently, and the player can be nudged with a re-seek. |
| Multi-track audio cannot be switched | Known now. Either accept the default track, or select the track during a remux in B1.5. |
| B1.2 deletes the X11 machinery and something regresses | It is sequenced after B1.1 proves the player works, and the two windows are what the deleted code exists for. |

---

# Phases B2 to B4 — outline

Sketched rather than planned; each deserves its own pass before it starts.

## B2 — A publicly reachable server

The load genuinely is tiny: one small Node process holding room state in memory,
websockets carrying kilobits, and a BitTorrent tracker that only introduces
peers. Cold starts are acceptable, as noted.

The constraint that decides this is **not** CPU or bandwidth — it is that the
signalling server holds long-lived WebSocket connections and keeps room state in
process memory. Most free tiers either sleep aggressively, cap connection
duration, or run several instances behind a load balancer, and any of those
breaks a room. Worth evaluating against those three criteria specifically rather
than against price alone.

Note the interaction with a decision already recorded: room state lives in
memory precisely because there is one process. Anything that scales to more than
one instance makes Redis a prerequisite rather than a deferred nicety, and
`InMemoryRoomStore` sits behind `RoomStore` for exactly this swap.

Separately, coturn is its own problem — a TURN relay needs UDP and a port range,
which almost no free platform offers. Voice may need a different host from
signalling, or a cheap VPS.

## B3 — macOS

Mostly configured already. The parts that have never run are bundling mpv for
macOS and the `.dmg` build. If B1.6 lands first, **the mpv half of this
disappears entirely**, which is an argument for ordering B1 before B3.

Code signing is the other half, and it has lead times: without a Developer ID
certificate macOS cannot auto-update at all.

## B4 — Network simulation

Simulate what cannot be reproduced with the hardware to hand. Linux `tc netem`
covers delay, jitter, loss and reordering; network namespaces plus `nftables`
can imitate the NAT behaviours that actually decide whether coCine works —
symmetric NAT, carrier-grade NAT, and UDP blocked entirely.

The seven ranked failure modes in `docs/multi-machine-testing.md` are the list to
work from; each is currently a hypothesis. This also produces the awkward buffer
states B1.3 needs on demand, rather than waiting for one to occur naturally.
