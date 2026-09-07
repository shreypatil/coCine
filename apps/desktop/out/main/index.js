import { BrowserWindow, screen, app, ipcMain, dialog } from "electron";
import { fileURLToPath } from "node:url";
import { join, basename, dirname } from "node:path";
import { rmSync, readFileSync, mkdirSync, writeFileSync, renameSync, mkdtempSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import WebSocket from "ws";
import { EventEmitter } from "node:events";
import { z } from "zod";
import polyfill from "node-datachannel/polyfill";
import { stat, mkdir, writeFile, readdir, readFile, rm, statfs } from "node:fs/promises";
import WebTorrent from "webtorrent";
import { spawn } from "node:child_process";
import { connect } from "node:net";
import { randomBytes, randomUUID } from "node:crypto";
import __cjs_mod__ from "node:module";
const __filename = import.meta.filename;
const __dirname = import.meta.dirname;
const require2 = __cjs_mod__.createRequire(import.meta.url);
class ClockSync {
  samples = [];
  windowSize;
  maxAgeMs;
  constructor(opts = {}) {
    this.windowSize = opts.windowSize ?? 16;
    this.maxAgeMs = opts.maxAgeMs ?? 12e4;
  }
  addExchange(c1, s1, s2, c2) {
    const offsetMs = (s1 - c1 + (s2 - c2)) / 2;
    const rttMs = c2 - c1 - (s2 - s1);
    const sample = { offsetMs, rttMs, atMs: c2 };
    this.samples.push(sample);
    if (this.samples.length > this.windowSize) this.samples.shift();
    return sample;
  }
  best(nowMs) {
    const lowestRtt = (acc, s) => !acc || s.rttMs < acc.rttMs ? s : acc;
    const fresh = this.samples.filter((s) => nowMs - s.atMs <= this.maxAgeMs);
    if (fresh.length > 0) return fresh.reduce(lowestRtt, null);
    return this.samples.reduce(lowestRtt, null);
  }
  /** Estimated offset to add to local time to obtain server time. */
  offsetMs(nowMs = Date.now()) {
    return this.best(nowMs)?.offsetMs ?? 0;
  }
  /** Round trip of the sample the offset came from -- the honest error bound. */
  rttMs(nowMs = Date.now()) {
    return this.best(nowMs)?.rttMs ?? 0;
  }
  /** Half the best round trip: the most this estimate should be off by. */
  uncertaintyMs(nowMs = Date.now()) {
    return this.rttMs(nowMs) / 2;
  }
  serverNow(nowMs = Date.now()) {
    return nowMs + this.offsetMs(nowMs);
  }
  get sampleCount() {
    return this.samples.length;
  }
  get ready() {
    return this.samples.length > 0;
  }
}
const PlaybackState = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("idle") }),
  z.object({ kind: z.literal("paused"), positionSec: z.number() }),
  z.object({ kind: z.literal("playing"), positionSec: z.number(), atServerMs: z.number() })
]);
const Member = z.object({
  id: z.string(),
  name: z.string(),
  isHost: z.boolean(),
  mayControl: z.boolean(),
  /** In the voice call at all. Someone can be in the room without it. */
  inVoice: z.boolean().default(false),
  muted: z.boolean().default(false),
  deafened: z.boolean().default(false)
});
const ChatMessage = z.object({
  id: z.string(),
  kind: z.enum(["said", "joined", "left", "system"]),
  memberId: z.string().nullable(),
  name: z.string(),
  text: z.string(),
  atServerMs: z.number()
});
const MAX_CHAT_LENGTH = 800;
const TorrentInfo = z.object({
  infoHash: z.string().regex(/^[0-9a-f]{40}$/i),
  magnet: z.string().min(1),
  bytes: z.number().int().positive(),
  pieceLength: z.number().int().positive()
});
const Media = z.object({
  name: z.string(),
  durationSec: z.number(),
  torrent: TorrentInfo.nullable()
});
const PeerReport = z.object({
  /** Fraction of the film held locally, 0 to 1. */
  havePct: z.number().min(0).max(1),
  /** Contiguous seconds of film available from the current playhead. */
  bufferEndSec: z.number().min(0),
  downBps: z.number().min(0),
  upBps: z.number().min(0),
  /** Swarm peers this client is connected to. */
  peers: z.number().int().min(0)
});
const PeerStatus = z.object({
  memberId: z.string(),
  name: z.string(),
  havePct: z.number(),
  bufferEndSec: z.number(),
  downBps: z.number(),
  upBps: z.number(),
  peers: z.number(),
  ready: z.boolean()
});
const RoomPhase = z.enum(["lobby", "preparing", "ready", "playing"]);
z.discriminatedUnion("t", [
  /** No code creates a room and returns one; a code joins an existing room. */
  z.object({ t: z.literal("hello"), code: z.string().nullable(), name: z.string().min(1).max(40) }),
  z.object({ t: z.literal("time.ping"), c1: z.number() }),
  z.object({
    t: z.literal("media.announce"),
    name: z.string(),
    durationSec: z.number(),
    torrent: TorrentInfo.nullable().default(null)
  }),
  z.object({
    t: z.literal("playback.request"),
    intent: z.enum(["play", "pause", "seek"]),
    positionSec: z.number().optional()
  }),
  z.object({ t: z.literal("chat.send"), text: z.string().min(1).max(MAX_CHAT_LENGTH) }),
  z.object({ t: z.literal("member.setControl"), memberId: z.string(), mayControl: z.boolean() }),
  z.object({ t: z.literal("member.transferHost"), memberId: z.string() }),
  z.object({ t: z.literal("peer.report"), report: PeerReport }),
  /** Opaque WebRTC negotiation, relayed to one other member and nobody else. */
  z.object({ t: z.literal("rtc.signal"), to: z.string(), payload: z.unknown() }),
  z.object({
    t: z.literal("voice.state"),
    inVoice: z.boolean(),
    muted: z.boolean(),
    deafened: z.boolean()
  }),
  /**
   * Host only. Advisory in a mesh: the server has no media to stop, so it can
   * only ask. Enforcement needs the SFU, which is a later phase.
   */
  z.object({ t: z.literal("voice.moderate"), memberId: z.string(), action: z.enum(["mute", "unmute"]) }),
  /** Host only: start even though somebody is not ready. */
  z.object({ t: z.literal("room.startAnyway") }),
  /** Host only: whether the room pauses when someone arrives mid-film. */
  z.object({ t: z.literal("room.setWaitForLatecomers"), wait: z.boolean() })
]);
const ServerMessage = z.discriminatedUnion("t", [
  z.object({ t: z.literal("welcome"), memberId: z.string(), code: z.string(), serverMs: z.number() }),
  /** c1 echoed back, plus the server's receive and send stamps. Four timestamps
   *  are what let a client separate clock offset from network delay. */
  z.object({ t: z.literal("time.pong"), c1: z.number(), s1: z.number(), s2: z.number() }),
  z.object({
    t: z.literal("room.state"),
    code: z.string(),
    members: z.array(Member),
    media: Media.nullable(),
    /** Where to announce, so clients do not have to guess the tracker URL. */
    trackerUrl: z.string(),
    phase: RoomPhase,
    waitForLatecomers: z.boolean()
  }),
  z.object({
    t: z.literal("transfer.status"),
    perPeer: z.array(PeerStatus),
    /** Seconds until everyone can start, from observed rates. Null while unknown. */
    etaSec: z.number().nullable(),
    /** The floor no scheduling can beat. Null until rates are known. */
    tMinSec: z.number().nullable(),
    /** Whoever the room is waiting for, by name. */
    bottleneck: z.string().nullable(),
    /** Whole copies of the film in the room, counting the sharer. */
    fullCopies: z.number(),
    /** Whether the film survives the sharer disconnecting. */
    safeForSharerToLeave: z.boolean()
  }),
  z.object({ t: z.literal("playback.schedule"), state: PlaybackState, seq: z.number() }),
  z.object({ t: z.literal("chat.message"), message: ChatMessage }),
  /** Sent once on join so a latecomer sees what was already said. */
  z.object({ t: z.literal("chat.history"), messages: z.array(ChatMessage) }),
  z.object({ t: z.literal("rtc.signal"), from: z.string(), payload: z.unknown() }),
  /** Sent to the person being asked, so their own client can comply. */
  z.object({ t: z.literal("voice.moderated"), by: z.string(), action: z.enum(["mute", "unmute"]) }),
  z.object({ t: z.literal("error"), message: z.string() })
]);
const encode = (m) => JSON.stringify(m);
const decodeServer = (raw) => ServerMessage.parse(JSON.parse(raw));
function positionAt(state2, serverMs) {
  if (state2.kind === "idle") return null;
  if (state2.kind === "paused") return state2.positionSec;
  return state2.positionSec + Math.max(0, serverMs - state2.atServerMs) / 1e3;
}
const DEFAULT_SYNC_CONFIG = {
  deadbandSec: 0.012,
  seekThresholdSec: 1,
  correctionHorizonSec: 2,
  maxRateDeviation: 0.05,
  seekLeadSec: 0.05
};
function extrapolatePosition(p, localNowMs) {
  if (p.paused) return p.positionSec;
  const elapsed = Math.max(0, localNowMs - p.observedAtMs) / 1e3;
  return p.positionSec + elapsed * p.rate;
}
function tick(input) {
  const cfg = input.config ?? DEFAULT_SYNC_CONFIG;
  const { target, serverNowMs, localNowMs, player } = input;
  const here = extrapolatePosition(player, localNowMs);
  if (target.kind === "idle") {
    return player.paused ? { type: "none" } : { type: "pause", reason: "nothing loaded" };
  }
  if (target.kind === "paused") {
    if (!player.paused) return { type: "pause", reason: "room is paused" };
    if (Math.abs(here - target.positionSec) > cfg.deadbandSec) {
      return { type: "seek", toSec: target.positionSec, reason: "aligning while paused" };
    }
    if (player.rate !== 1) return { type: "setRate", rate: 1, driftSec: 0 };
    return { type: "none" };
  }
  if (serverNowMs < target.atServerMs) {
    if (!player.paused) return { type: "pause", reason: "waiting for scheduled start" };
    if (Math.abs(here - target.positionSec) > cfg.deadbandSec) {
      return { type: "seek", toSec: target.positionSec, reason: "pre-positioning for scheduled start" };
    }
    return { type: "none" };
  }
  const expected = positionAt(target, serverNowMs);
  const drift = here - expected;
  if (Math.abs(drift) > cfg.seekThresholdSec) {
    return { type: "seek", toSec: expected + cfg.seekLeadSec, reason: `drift ${drift.toFixed(2)}s exceeds seek threshold` };
  }
  if (player.paused) return { type: "play", reason: "room is playing" };
  if (Math.abs(drift) <= cfg.deadbandSec) {
    return player.rate === 1 ? { type: "none" } : { type: "setRate", rate: 1, driftSec: drift };
  }
  const raw = 1 - drift / cfg.correctionHorizonSec;
  const rate = Math.min(1 + cfg.maxRateDeviation, Math.max(1 - cfg.maxRateDeviation, raw));
  if (Math.abs(rate - player.rate) < 2e-3) return { type: "none" };
  return { type: "setRate", rate, driftSec: drift };
}
class RoomClient extends EventEmitter {
  constructor(o) {
    super();
    this.o = o;
  }
  o;
  clock = new ClockSync();
  ws = null;
  target = { kind: "idle" };
  rate = 1;
  busy = false;
  timers = [];
  lastAction = { type: "none" };
  members = [];
  memberId = "";
  code = "";
  media = null;
  phase = "lobby";
  waitForLatecomers = true;
  transfer = null;
  /** Where the room's swarm announces. Learned from the server, never guessed. */
  trackerUrl = "";
  /** Bounded locally as well as on the server, so a long session cannot grow
   *  the renderer's state without limit. */
  messages = [];
  async connect() {
    const ws = new WebSocket(this.o.url);
    this.ws = ws;
    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    ws.on("message", (raw) => this.onMessage(String(raw)));
    this.send({ t: "hello", code: this.o.code, name: this.o.name });
    for (let i = 0; i < 8; i++) {
      this.ping();
      await new Promise((r) => setTimeout(r, 25));
    }
    await this.waitForClock();
    if (this.o.getReport) {
      this.timers.push(setInterval(() => {
        const report = this.o.getReport?.();
        if (report) this.send({ t: "peer.report", report });
      }, 1e3));
    }
    const pingMs = this.o.pingIntervalMs ?? 2e3;
    this.timers.push(setInterval(() => this.ping(), pingMs));
    const tickMs = 1e3 / (this.o.tickHz ?? 20);
    this.timers.push(setInterval(() => {
      void this.runTick();
    }, tickMs));
  }
  async waitForClock(timeoutMs = 5e3) {
    const deadline = Date.now() + timeoutMs;
    while (!this.clock.ready) {
      if (Date.now() > deadline) throw new Error("no clock samples from server");
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  ping() {
    this.send({ t: "time.ping", c1: Date.now() });
  }
  onMessage(raw) {
    const msg = decodeServer(raw);
    switch (msg.t) {
      case "time.pong":
        this.clock.addExchange(msg.c1, msg.s1, msg.s2, Date.now());
        break;
      case "welcome":
        this.memberId = msg.memberId;
        this.code = msg.code;
        this.emit("welcome", msg.code);
        break;
      case "room.state":
        this.members = msg.members;
        this.code = msg.code;
        this.trackerUrl = msg.trackerUrl;
        this.phase = msg.phase;
        this.waitForLatecomers = msg.waitForLatecomers;
        if (msg.media?.torrent?.infoHash !== this.media?.torrent?.infoHash) {
          this.media = msg.media;
          this.emit("media", msg.media);
        } else {
          this.media = msg.media;
        }
        this.emit("members", msg.members);
        break;
      case "chat.history":
        this.messages = msg.messages.slice(-200);
        this.emit("chat", this.messages);
        break;
      case "chat.message":
        this.messages = [...this.messages, msg.message].slice(-200);
        this.emit("chat", this.messages);
        break;
      case "playback.schedule":
        this.target = msg.state;
        this.emit("schedule", msg.state);
        void this.runTick();
        break;
      case "rtc.signal":
        this.emit("rtc-signal", msg.from, msg.payload);
        break;
      case "voice.moderated":
        this.emit("voice-moderated", msg.by, msg.action);
        break;
      case "transfer.status":
        this.transfer = {
          perPeer: msg.perPeer,
          etaSec: msg.etaSec,
          tMinSec: msg.tMinSec,
          bottleneck: msg.bottleneck,
          fullCopies: msg.fullCopies,
          safeForSharerToLeave: msg.safeForSharerToLeave
        };
        this.emit("transfer", this.transfer);
        break;
      case "error":
        this.emit("server-error", msg.message);
        break;
    }
  }
  async runTick() {
    if (this.busy || !this.clock.ready) return;
    const localNowMs = Date.now();
    const action = tick({
      target: this.target,
      serverNowMs: this.clock.serverNow(localNowMs),
      localNowMs,
      player: {
        positionSec: this.o.player.position(),
        observedAtMs: this.o.player.positionObservedAt(),
        paused: this.o.player.isPaused(),
        rate: this.rate
      },
      config: this.o.syncConfig ?? DEFAULT_SYNC_CONFIG
    });
    if (action.type === "none") return;
    this.busy = true;
    try {
      switch (action.type) {
        case "seek":
          await this.o.player.seek(action.toSec);
          break;
        case "play":
          await this.o.player.play();
          break;
        case "pause":
          await this.o.player.pause();
          break;
        case "setRate":
          await this.o.player.setRate(action.rate);
          this.rate = action.rate;
          break;
      }
      this.lastAction = action;
      this.emit("action", action);
    } catch (err) {
      this.emit("action-error", err);
    } finally {
      this.busy = false;
    }
  }
  /** Where the room says the film should be, right now, in seconds. */
  expectedPosition(localNowMs = Date.now()) {
    const s = this.target;
    if (s.kind === "idle") return null;
    if (s.kind === "paused") return s.positionSec;
    const serverNow = this.clock.serverNow(localNowMs);
    if (serverNow < s.atServerMs) return s.positionSec;
    return s.positionSec + (serverNow - s.atServerMs) / 1e3;
  }
  /** Where this client's film actually is, extrapolated past a stale reading. */
  actualPosition(localNowMs = Date.now()) {
    return extrapolatePosition({
      positionSec: this.o.player.position(),
      observedAtMs: this.o.player.positionObservedAt(),
      paused: this.o.player.isPaused(),
      rate: this.rate
    }, localNowMs);
  }
  currentRate() {
    return this.rate;
  }
  lastSyncAction() {
    return this.lastAction;
  }
  /** A null torrent means "everyone is expected to already have this file". */
  announceMedia(name, durationSec, torrent = null) {
    this.send({ t: "media.announce", name, durationSec, torrent });
  }
  sendChat(text) {
    const t = text.trim();
    if (t) this.send({ t: "chat.send", text: t.slice(0, 800) });
  }
  setControl(memberId, mayControl) {
    this.send({ t: "member.setControl", memberId, mayControl });
  }
  transferHost(memberId) {
    this.send({ t: "member.transferHost", memberId });
  }
  startAnyway() {
    this.send({ t: "room.startAnyway" });
  }
  sendSignal(to, payload) {
    this.send({ t: "rtc.signal", to, payload });
  }
  setVoiceState(v) {
    this.send({ t: "voice.state", ...v });
  }
  moderateVoice(memberId, action) {
    this.send({ t: "voice.moderate", memberId, action });
  }
  setWaitForLatecomers(wait) {
    this.send({ t: "room.setWaitForLatecomers", wait });
  }
  /** This client's own membership, once the room state has arrived. */
  me() {
    return this.members.find((m) => m.id === this.memberId);
  }
  requestPlay(positionSec) {
    this.send({ t: "playback.request", intent: "play", positionSec });
  }
  requestPause(positionSec) {
    this.send({ t: "playback.request", intent: "pause", positionSec });
  }
  requestSeek(positionSec) {
    this.send({ t: "playback.request", intent: "seek", positionSec });
  }
  send(m) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(encode(m));
  }
  async close() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.ws?.close();
  }
}
let installed = false;
function installWebRtc() {
  if (installed) return;
  const g = globalThis;
  if (!g.WRTC) g.WRTC = polyfill;
  installed = true;
}
const DEFAULT_ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];
class OutOfSpaceError extends Error {
  constructor(needBytes, freeBytes) {
    super(`Not enough room: this film needs ${gb(needBytes)} and only ${gb(freeBytes)} is free`);
    this.needBytes = needBytes;
    this.freeBytes = freeBytes;
    this.name = "OutOfSpaceError";
  }
  needBytes;
  freeBytes;
}
const gb = (n) => `${(n / 1024 ** 3).toFixed(1)} GB`;
class FilmStore {
  constructor(root) {
    this.root = root;
  }
  root;
  dirFor(infoHash) {
    return join(this.root, infoHash.toLowerCase());
  }
  async has(infoHash) {
    try {
      return (await stat(this.dirFor(infoHash))).isDirectory();
    } catch {
      return false;
    }
  }
  async record(m) {
    const dir = this.dirFor(m.infoHash);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "meta.json"), JSON.stringify(m, null, 2));
  }
  async list() {
    let entries;
    try {
      entries = await readdir(this.root);
    } catch {
      return [];
    }
    const films2 = [];
    for (const infoHash of entries) {
      const dir = join(this.root, infoHash);
      try {
        const meta = JSON.parse(await readFile(join(dir, "meta.json"), "utf8"));
        let onDiskBytes = 0;
        try {
          onDiskBytes = (await stat(join(dir, meta.name))).size;
        } catch {
        }
        films2.push({
          infoHash: meta.infoHash,
          name: meta.name,
          path: join(dir, meta.name),
          bytes: meta.bytes,
          onDiskBytes,
          complete: onDiskBytes >= meta.bytes,
          addedAtMs: meta.addedAtMs
        });
      } catch {
      }
    }
    return films2.sort((a, b) => b.addedAtMs - a.addedAtMs);
  }
  async remove(infoHash) {
    await rm(this.dirFor(infoHash), { recursive: true, force: true });
  }
  async totalBytes() {
    return (await this.list()).reduce((n, f) => n + f.onDiskBytes, 0);
  }
  async freeBytes() {
    await mkdir(this.root, { recursive: true });
    const s = await statfs(this.root);
    return Number(s.bsize) * Number(s.bavail);
  }
  /**
   * Refuse before starting rather than failing at ninety per cent. The margin
   * covers the filesystem's own overhead and leaves the machine usable.
   */
  async ensureRoomFor(bytes, marginBytes = 512 * 1024 * 1024) {
    const free = await this.freeBytes();
    if (free < bytes + marginBytes) throw new OutOfSpaceError(bytes + marginBytes, free);
  }
}
const DEFAULT_WINDOWS = { criticalSec: 10, bufferSec: 60 };
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
function pieceAt(positionSec, g) {
  if (g.pieceCount <= 0) return 0;
  if (!(g.durationSec > 0)) return 0;
  const fraction = clamp(positionSec / g.durationSec, 0, 1);
  return clamp(Math.floor(fraction * g.totalBytes / g.pieceLength), 0, g.pieceCount - 1);
}
function secondsToPieces(seconds, g) {
  if (!(g.durationSec > 0) || g.pieceLength <= 0) return 0;
  const bytesPerSec = g.totalBytes / g.durationSec;
  return Math.max(1, Math.ceil(seconds * bytesPerSec / g.pieceLength));
}
function windowsFor(positionSec, g, cfg = DEFAULT_WINDOWS) {
  const last = Math.max(0, g.pieceCount - 1);
  const start = pieceAt(positionSec, g);
  const criticalEnd = clamp(start + secondsToPieces(cfg.criticalSec, g), start, last);
  const bufferEnd = clamp(start + secondsToPieces(cfg.bufferSec, g), criticalEnd, last);
  return { critical: [start, criticalEnd], buffer: [start, bufferEnd] };
}
function indexRanges(g, headBytes = 2 * 1024 * 1024, tailBytes = 4 * 1024 * 1024) {
  if (g.pieceCount <= 0 || g.pieceLength <= 0) return [];
  const last = g.pieceCount - 1;
  const headEnd = clamp(Math.ceil(headBytes / g.pieceLength) - 1, 0, last);
  const tailStart = clamp(last - (Math.ceil(tailBytes / g.pieceLength) - 1), 0, last);
  if (tailStart <= headEnd + 1) return [[0, last]];
  return [[0, headEnd], [tailStart, last]];
}
function contiguousSecondsFrom(positionSec, g, has) {
  if (g.pieceCount <= 0 || !(g.durationSec > 0)) return 0;
  const start = pieceAt(positionSec, g);
  if (!has(start)) return 0;
  let end = start;
  while (end + 1 < g.pieceCount && has(end + 1)) end++;
  const bytesPerSec = g.totalBytes / g.durationSec;
  const availableTo = Math.min((end + 1) * g.pieceLength, g.totalBytes);
  return Math.max(0, availableTo / bytesPerSec - positionSec);
}
const HIGH_PRIORITY = 1;
class PieceScheduler {
  constructor(torrent, durationSec, cfg = DEFAULT_WINDOWS) {
    this.torrent = torrent;
    this.durationSec = durationSec;
    this.cfg = cfg;
  }
  torrent;
  durationSec;
  cfg;
  primed = false;
  lastCritical = null;
  lastBuffer = null;
  setDuration(seconds) {
    this.durationSec = seconds;
  }
  geometry() {
    return {
      pieceLength: this.torrent.pieceLength,
      pieceCount: this.torrent.pieces.length,
      totalBytes: this.torrent.length,
      durationSec: this.durationSec
    };
  }
  /** Fetch the container's head and tail before anything else. Once only. */
  prime() {
    if (this.primed) return [];
    this.primed = true;
    const ranges = indexRanges(this.geometry());
    for (const [a, b] of ranges) this.torrent.critical(a, b);
    return ranges;
  }
  update(positionSec) {
    const w = windowsFor(positionSec, this.geometry(), this.cfg);
    if (!this.lastCritical || this.lastCritical[0] !== w.critical[0] || this.lastCritical[1] !== w.critical[1]) {
      this.torrent.critical(w.critical[0], w.critical[1]);
      this.lastCritical = w.critical;
    }
    if (!this.lastBuffer || this.lastBuffer[0] !== w.buffer[0] || this.lastBuffer[1] !== w.buffer[1]) {
      if (this.lastBuffer) this.torrent.deselect(this.lastBuffer[0], this.lastBuffer[1]);
      this.torrent.select(w.buffer[0], w.buffer[1], HIGH_PRIORITY);
      this.lastBuffer = w.buffer;
    }
    return w;
  }
}
class TransferManager extends EventEmitter {
  constructor(o) {
    super();
    this.o = o;
    installWebRtc();
  }
  o;
  client = null;
  torrents = /* @__PURE__ */ new Map();
  schedulers = /* @__PURE__ */ new Map();
  server = null;
  serverPort = 0;
  ensureClient() {
    if (this.client) return this.client;
    this.client = new WebTorrent({
      dht: false,
      lsd: false,
      natUpnp: false,
      utp: false,
      webSeeds: false,
      ...this.o.webrtcOnly ? { tcp: false } : {},
      ...this.o.downloadLimitBps !== void 0 ? { downloadLimit: this.o.downloadLimitBps } : {},
      ...this.o.uploadLimitBps !== void 0 ? { uploadLimit: this.o.uploadLimitBps } : {},
      tracker: { rtcConfig: { iceServers: this.o.iceServers ?? DEFAULT_ICE_SERVERS } }
    });
    this.client.on("error", (err) => this.emit("error", err));
    return this.client;
  }
  /** Seed a film already on this machine. The file is not copied or moved. */
  async share(filePath) {
    const size = (await stat(filePath)).size;
    const torrent = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out hashing ${basename(filePath)}`)), 15 * 6e4);
      this.ensureClient().seed(
        filePath,
        { announce: [this.o.trackerUrl], path: dirname(filePath) },
        (t) => {
          clearTimeout(timer);
          resolve(t);
        }
      );
    });
    this.track(torrent);
    return {
      infoHash: torrent.infoHash,
      magnet: torrent.magnetURI,
      bytes: size,
      pieceLength: torrent.pieceLength
    };
  }
  /**
   * Fetch a film from the room. Resolves as soon as the torrent's metadata is
   * ready and the file has a path -- not when it has finished, because the
   * whole point is watching before it finishes.
   */
  async receive(info) {
    const existing = this.torrents.get(info.infoHash.toLowerCase());
    if (existing) return { path: existing.files[0]?.path ?? "", torrent: existing };
    await this.o.store.ensureRoomFor(info.bytes);
    await this.ensureStreamServer();
    const dir = this.o.store.dirFor(info.infoHash);
    const timeout = this.o.metadataTimeoutMs ?? 45e3;
    const attempt = async () => {
      let added = null;
      const t = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), timeout);
        added = this.ensureClient().add(info.magnet, { announce: [this.o.trackerUrl], path: dir }, (got) => {
          clearTimeout(timer);
          resolve(got);
        });
      });
      if (!t && added) {
        this.emit("warning", `no metadata for ${info.infoHash.slice(0, 8)} in ${timeout / 1e3}s; retrying`);
        await new Promise((res) => added.destroy(() => res()));
      }
      return t;
    };
    const torrent = await attempt() ?? await attempt();
    if (!torrent) throw new Error(`no metadata from the swarm for ${basename(info.magnet)} after two attempts`);
    await this.o.store.record({
      infoHash: torrent.infoHash,
      name: torrent.name,
      bytes: info.bytes,
      addedAtMs: Date.now()
    });
    this.track(torrent);
    const scheduler = new PieceScheduler(torrent, 0, this.o.windows);
    this.schedulers.set(torrent.infoHash.toLowerCase(), scheduler);
    scheduler.prime();
    return { path: `${dir}/${torrent.name}`, torrent };
  }
  track(torrent) {
    this.torrents.set(torrent.infoHash.toLowerCase(), torrent);
    torrent.on("done", () => this.emit("done", torrent.infoHash));
    torrent.on("error", (err) => this.emit("error", err));
  }
  get(infoHash) {
    return this.torrents.get(infoHash.toLowerCase());
  }
  schedulerFor(infoHash) {
    return this.schedulers.get(infoHash.toLowerCase());
  }
  /**
   * An HTTP origin that streams torrents, blocking on pieces that have not
   * arrived yet.
   *
   * This is what makes watching before the download finishes possible at all.
   * Playing the file on disk directly would read zeros wherever a piece is
   * missing, because the file is written sparsely -- so the player has to go
   * through something that knows how to wait. Byte ranges are supported, which
   * is what lets mpv seek.
   */
  async ensureStreamServer() {
    if (this.server) return this.serverPort;
    const server = this.ensureClient().createServer();
    await new Promise((res) => server.listen(0, "127.0.0.1", res));
    const addr = server.address();
    this.serverPort = typeof addr === "object" && addr ? addr.port : 0;
    this.server = server;
    return this.serverPort;
  }
  /** A URL mpv can open, or null if this film is not being handled here. */
  streamUrl(infoHash) {
    const t = this.torrents.get(infoHash.toLowerCase());
    const file = t?.files[0];
    if (!file || !this.serverPort) return null;
    return `http://127.0.0.1:${this.serverPort}${file.streamURL}`;
  }
  /**
   * What this client can tell the room about itself. Null when it is not
   * involved in this film at all.
   */
  reportFor(infoHash, positionSec, durationSec) {
    const t = this.torrents.get(infoHash.toLowerCase());
    if (!t) return null;
    const geometry = {
      pieceLength: t.pieceLength,
      pieceCount: t.pieces.length,
      totalBytes: t.length,
      durationSec
    };
    return {
      havePct: t.progress,
      bufferEndSec: t.done ? Math.max(0, durationSec - positionSec) : contiguousSecondsFrom(positionSec, geometry, (i) => t.bitfield.get(i)),
      downBps: t.downloadSpeed,
      upBps: t.uploadSpeed,
      peers: t.numPeers
    };
  }
  /**
   * Move the windows to follow playback. Called as the room's playhead moves,
   * including while the film is still arriving -- which is the whole point of
   * windowing rather than fetching in order.
   */
  updatePlayhead(infoHash, positionSec, durationSec) {
    const scheduler = this.schedulers.get(infoHash.toLowerCase());
    if (!scheduler) return;
    if (durationSec > 0) scheduler.setDuration(durationSec);
    scheduler.update(positionSec);
  }
  progress() {
    return [...this.torrents.values()].map((t) => ({
      infoHash: t.infoHash,
      name: t.name,
      progress: t.progress,
      downBps: t.downloadSpeed,
      upBps: t.uploadSpeed,
      peers: t.numPeers,
      done: t.done,
      bytes: t.length
    }));
  }
  async destroy() {
    this.torrents.clear();
    this.schedulers.clear();
    if (this.server) {
      await new Promise((res) => this.server.close(() => res()));
      this.server = null;
    }
    await new Promise((res) => this.client ? this.client.destroy(() => res()) : res());
    this.client = null;
  }
}
class MpvIpc extends EventEmitter {
  constructor(args, binary = "mpv") {
    super();
    this.args = args;
    this.binary = binary;
    const id = randomBytes(6).toString("hex");
    this.ipcPath = process.platform === "win32" ? `\\\\.\\pipe\\cocine-mpv-${id}` : join(tmpdir(), `cocine-mpv-${id}.sock`);
  }
  args;
  binary;
  proc = null;
  sock = null;
  buf = "";
  nextId = 1;
  pending = /* @__PURE__ */ new Map();
  ipcPath;
  closed = false;
  async start(timeoutMs = 1e4) {
    this.proc = spawn(this.binary, [`--input-ipc-server=${this.ipcPath}`, ...this.args], {
      stdio: ["ignore", "ignore", "pipe"]
    });
    let stderr = "";
    this.proc.stderr?.on("data", (d) => {
      stderr += String(d);
    });
    this.proc.on("exit", (code) => {
      if (!this.closed) this.emit("exit", code, stderr);
    });
    const deadline = Date.now() + timeoutMs;
    for (; ; ) {
      try {
        this.sock = await this.tryConnect();
        break;
      } catch (err) {
        if (this.proc.exitCode !== null) {
          throw new Error(`mpv exited (${this.proc.exitCode}) before accepting IPC: ${stderr.trim()}`);
        }
        if (Date.now() > deadline) throw new Error(`mpv IPC socket never appeared: ${String(err)}`);
        await new Promise((r) => setTimeout(r, 25));
      }
    }
    this.sock.setNoDelay(true);
    this.sock.on("data", (chunk) => this.onData(String(chunk)));
    this.sock.on("error", (err) => {
      if (!this.closed) this.emit("error", err);
    });
  }
  tryConnect() {
    return new Promise((resolve, reject) => {
      const s = connect(this.ipcPath);
      s.once("connect", () => {
        s.removeAllListeners("error");
        resolve(s);
      });
      s.once("error", (err) => {
        s.destroy();
        reject(err);
      });
    });
  }
  onData(chunk) {
    this.buf += chunk;
    let nl;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof msg.request_id === "number") {
        const p = this.pending.get(msg.request_id);
        if (p) {
          this.pending.delete(msg.request_id);
          if (msg.error === "success") p.resolve(msg.data);
          else p.reject(new Error(String(msg.error)));
        }
        continue;
      }
      if (typeof msg.event === "string") this.emit("mpv-event", msg);
    }
  }
  command(...parts) {
    if (!this.sock || this.closed) return Promise.reject(new Error("mpv IPC not connected"));
    const request_id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(request_id, { resolve, reject });
      this.sock.write(`${JSON.stringify({ command: parts, request_id })}
`, (err) => {
        if (err) {
          this.pending.delete(request_id);
          reject(err);
        }
      });
    });
  }
  setProperty(name, value) {
    return this.command("set_property", name, value);
  }
  getProperty(name) {
    return this.command("get_property", name);
  }
  observeProperty(id, name) {
    return this.command("observe_property", id, name);
  }
  /** Immediate, synchronous teardown for process exit. */
  kill() {
    this.closed = true;
    try {
      this.sock?.destroy();
    } catch {
    }
    try {
      this.proc?.kill("SIGKILL");
    } catch {
    }
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) p.reject(new Error("mpv IPC closing"));
    this.pending.clear();
    try {
      await this.command("quit");
    } catch {
    }
    this.sock?.destroy();
    await new Promise((res) => {
      if (!this.proc || this.proc.exitCode !== null) return res();
      const t = setTimeout(() => {
        this.proc?.kill("SIGKILL");
        res();
      }, 2e3);
      this.proc.once("exit", () => {
        clearTimeout(t);
        res();
      });
    });
    if (process.platform !== "win32") {
      try {
        rmSync(this.ipcPath, { force: true });
      } catch {
      }
    }
  }
}
const OBS_TIME = 1;
const OBS_PAUSE = 2;
const OBS_DURATION = 3;
class ExternalMpv {
  ipc;
  events = new EventEmitter();
  pos = 0;
  posAt = 0;
  paused = true;
  dur = null;
  constructor(opts = {}) {
    const args = [
      "--idle=yes",
      "--no-terminal",
      "--keep-open=yes",
      "--pause=yes",
      // Exact seeking is not optional at a 100 ms budget. Without this mpv may
      // seek to the nearest keyframe, which on a typical film is seconds away.
      "--hr-seek=yes",
      "--msg-level=all=no",
      // We draw the interface. mpv must not paint controls over its own window
      // or swallow keystrokes meant for the application.
      "--osc=no",
      "--osd-level=0",
      "--input-default-bindings=no",
      "--input-vo-keyboard=no"
    ];
    if (!opts.useUserConfig) args.push("--no-config");
    if (opts.wid) {
      args.push(`--wid=${opts.wid}`, "--force-window=yes");
    } else if (opts.headless) {
      args.push("--vo=null", "--ao=null");
    }
    if (opts.extraArgs) args.push(...opts.extraArgs);
    this.ipc = new MpvIpc(args, opts.binary ?? "mpv");
    this.ipc.setMaxListeners(64);
    this.ipc.on("mpv-event", (e) => this.onEvent(e));
    this.ipc.on("exit", (code, stderr) => this.events.emit("exit", code, stderr));
  }
  async start() {
    await this.ipc.start();
    await this.ipc.observeProperty(OBS_TIME, "time-pos");
    await this.ipc.observeProperty(OBS_PAUSE, "pause");
    await this.ipc.observeProperty(OBS_DURATION, "duration");
  }
  onEvent(e) {
    if (e.event === "property-change") {
      if (e.id === OBS_TIME && typeof e.data === "number") {
        this.pos = e.data;
        this.posAt = Date.now();
        this.events.emit("position", this.pos, this.posAt);
      } else if (e.id === OBS_PAUSE && typeof e.data === "boolean") {
        this.paused = e.data;
        this.events.emit("pause", this.paused);
      } else if (e.id === OBS_DURATION && typeof e.data === "number") {
        this.dur = e.data;
      }
    } else if (e.event === "eof-reached" || e.event === "end-file") {
      this.events.emit("eof");
    }
  }
  async load(path) {
    const loaded = new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`mpv never loaded ${path}`)), 3e4);
      const onEvent = (e) => {
        if (e.event === "file-loaded") {
          cleanup();
          resolve();
        }
        if (e.event === "end-file" && e.reason === "error") {
          cleanup();
          reject(new Error(`mpv failed to load ${path}`));
        }
      };
      const cleanup = () => {
        clearTimeout(t);
        this.ipc.off("mpv-event", onEvent);
      };
      this.ipc.on("mpv-event", onEvent);
    });
    try {
      await this.ipc.command("loadfile", path, "replace");
    } catch (err) {
      loaded.catch(() => {
      });
      throw err;
    }
    await loaded;
    await this.ipc.setProperty("pause", true);
  }
  async play() {
    await this.ipc.setProperty("pause", false);
  }
  async pause() {
    await this.ipc.setProperty("pause", true);
  }
  /**
   * mpv acknowledges a seek command immediately but performs it asynchronously,
   * so time-pos stays stale for a moment afterwards. Waiting for
   * playback-restart is what makes a seek observable -- without it the sync
   * engine reads the pre-seek position and corrects against a phantom drift.
   */
  async seek(seconds) {
    const landed = this.waitFor("playback-restart", 3e3);
    try {
      await this.ipc.command("seek", seconds, "absolute", "exact");
    } catch (err) {
      throw err;
    }
    if (!await landed) this.events.emit("warning", `seek to ${seconds.toFixed(2)}s: no playback-restart`);
  }
  /**
   * Resolves true if the event arrived, false if it timed out. Deliberately
   * never rejects: a missed event means the sync engine corrects on its next
   * tick, whereas a throw from a player primitive takes the whole client down.
   */
  waitFor(eventName, timeoutMs) {
    return new Promise((resolve) => {
      const done = (ok) => {
        clearTimeout(t);
        this.ipc.off("mpv-event", onEvent);
        resolve(ok);
      };
      const t = setTimeout(() => done(false), timeoutMs);
      const onEvent = (e) => {
        if (e.event === eventName) done(true);
      };
      this.ipc.on("mpv-event", onEvent);
    });
  }
  async setRate(rate) {
    await this.ipc.setProperty("speed", rate);
  }
  /** 0 to 100. Used to duck the film while someone is speaking. */
  async setVolume(percent) {
    await this.ipc.setProperty("volume", Math.max(0, Math.min(130, percent)));
  }
  position() {
    return this.pos;
  }
  positionObservedAt() {
    return this.posAt;
  }
  isPaused() {
    return this.paused;
  }
  duration() {
    return this.dur;
  }
  /** Authoritative position, at the cost of a round trip. Use sparingly --
   *  the observed value is what the tick loop should read. */
  async positionExact() {
    const v = await this.ipc.getProperty("time-pos");
    return typeof v === "number" ? v : this.pos;
  }
  on(event, fn) {
    this.events.on(event, fn);
  }
  async close() {
    await this.ipc.close();
  }
  /**
   * Transient text drawn by mpv over the video. This is the one thing that can
   * appear above the picture without an overlay window, so it carries feedback
   * in fullscreen where no controls are visible.
   */
  async showText(text, durationMs = 2e3) {
    await this.ipc.command("show-text", text, durationMs);
  }
  /** Kill mpv immediately, without waiting on IPC. For process teardown. */
  kill() {
    this.ipc.kill();
  }
}
function nativeHandleToWid(handle) {
  if (handle.length >= 8) return handle.readBigUInt64LE(0).toString();
  if (handle.length >= 4) return String(handle.readUInt32LE(0));
  throw new Error(`unexpected native window handle of ${handle.length} bytes`);
}
class EmbeddedMpv extends ExternalMpv {
  constructor(handle, opts = {}) {
    super({ ...opts, wid: nativeHandleToWid(handle) });
  }
}
class VideoWindow {
  constructor(parent) {
    this.parent = parent;
  }
  parent;
  win = null;
  player = null;
  slot = null;
  async start() {
    if (process.env.COCINE_HEADLESS) {
      const player2 = new ExternalMpv({ headless: true });
      await player2.start();
      this.player = player2;
      return player2;
    }
    this.win = new BrowserWindow({
      parent: this.parent,
      frame: false,
      show: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      // Keyboard belongs to the main window; this surface is pixels only.
      focusable: false,
      backgroundColor: "#000000",
      title: "coCine video",
      webPreferences: { nodeIntegration: false, contextIsolation: true }
    });
    await this.win.loadURL('data:text/html,<body style="margin:0;background:#000"></body>');
    const player = new EmbeddedMpv(this.win.getNativeWindowHandle());
    await player.start();
    this.player = player;
    const follow = () => this.reposition();
    this.parent.on("move", follow);
    this.parent.on("resize", follow);
    this.parent.on("maximize", follow);
    this.parent.on("unmaximize", follow);
    this.parent.on("enter-full-screen", follow);
    this.parent.on("leave-full-screen", follow);
    this.parent.on("minimize", () => this.win?.hide());
    this.parent.on("restore", () => {
      if (this.slot) this.win?.show();
    });
    this.parent.on("closed", () => {
      void this.close();
    });
    return player;
  }
  /** Called from the renderer whenever the video slot moves or resizes. */
  setSlot(slot) {
    this.slot = slot;
    if (this.win) this.reposition();
  }
  reposition() {
    if (!this.win || !this.slot || this.win.isDestroyed() || this.parent.isDestroyed()) return;
    const content = this.parent.getContentBounds();
    const scale = screen.getDisplayMatching(content).scaleFactor || 1;
    const bounds = {
      x: Math.round(content.x + this.slot.x * scale),
      y: Math.round(content.y + this.slot.y * scale),
      width: Math.max(1, Math.round(this.slot.width * scale)),
      height: Math.max(1, Math.round(this.slot.height * scale))
    };
    this.win.setBounds(bounds);
    if (process.env.COCINE_DEBUG) {
      const got = this.win.getBounds();
      console.log(`[video] slot=${this.slot.width}x${this.slot.height}@${this.slot.x},${this.slot.y} content=${content.width}x${content.height}@${content.x},${content.y} scale=${scale} asked=${bounds.width}x${bounds.height}@${bounds.x},${bounds.y} got=${got.width}x${got.height}@${got.x},${got.y}`);
    }
    if (!this.win.isVisible()) this.win.showInactive();
  }
  /**
   * Native child windows sit above their parent and are not affected by the
   * parent's modal dialogs, so an open-file dialog can appear *behind* the
   * video surface. Hiding it for the duration is the only reliable fix.
   */
  suspend() {
    if (this.win && !this.win.isDestroyed()) this.win.hide();
  }
  resume() {
    if (this.win && !this.win.isDestroyed() && this.slot) {
      this.reposition();
      this.win.showInactive();
    }
  }
  bounds() {
    return this.win && !this.win.isDestroyed() ? this.win.getBounds() : null;
  }
  /** Synchronous, for process exit where promises will never settle. */
  killNow() {
    this.player?.kill();
    this.player = null;
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
  }
  async close() {
    try {
      await this.player?.close();
    } catch {
    }
    this.player = null;
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
  }
}
function formatClock(seconds) {
  const t = Math.max(0, Math.floor(seconds));
  return [Math.floor(t / 3600), Math.floor(t / 60) % 60, t % 60].map((n) => String(n).padStart(2, "0")).join(":");
}
function explainConnectError(err, url) {
  const code = err?.code;
  const message = err instanceof Error ? err.message : String(err);
  if (code === "ECONNREFUSED") {
    return new Error(`Nothing is listening at ${url}. Is the server running? Check the address, or reset it to the default.`);
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return new Error(`Could not find a server at ${url}. Check the address.`);
  }
  if (code === "ETIMEDOUT" || code === "ECONNRESET") {
    return new Error(`No answer from ${url}. It may be unreachable from this network.`);
  }
  if (/Invalid URL|invalid url/i.test(message)) {
    return new Error(`${url} is not a valid address. It should look like ws://host:8787`);
  }
  return new Error(`Could not join through ${url}: ${message}`);
}
const VIDEO_EXTENSIONS = ["mkv", "mp4", "avi", "mov", "webm", "m4v", "ts", "mpg", "mpeg", "wmv", "flv", "ogv"];
function createHandlers(deps) {
  const log = deps.log ?? (() => {
  });
  const announce = async (text) => {
    if (!deps.isFullScreen()) return;
    await deps.getVideo()?.player?.showText(text, 1200).catch(() => {
    });
  };
  const loadInto = async (path) => {
    const video2 = deps.getVideo();
    if (!video2?.player) throw new Error("player not ready");
    try {
      await video2.player.load(path);
    } catch (err) {
      log(`[film] failed to load: ${String(err)}`);
      throw err instanceof Error ? err : new Error(String(err));
    }
    deps.setMediaPath(path);
    const durationSec = video2.player.duration();
    log(`[film] loaded ${basename(path)} · duration ${durationSec ?? "unknown"}`);
    let torrent = null;
    const transfer2 = deps.getTransfer();
    if (transfer2) {
      try {
        torrent = await transfer2.share(path);
        deps.setSharedInfoHash?.(torrent.infoHash);
        log(`[film] sharing as ${torrent.infoHash}`);
      } catch (err) {
        log(`[film] could not share: ${String(err)}`);
      }
    }
    deps.getRoom()?.announceMedia(basename(path), durationSec ?? 0, torrent);
    return { path, name: basename(path), durationSec, infoHash: torrent?.infoHash ?? null };
  };
  return {
    "video:slot": (slot) => {
      const video2 = deps.getVideo();
      video2?.setSlot(slot);
      return video2?.bounds() ?? null;
    },
    "file:open": async () => {
      log("[film] open requested — showing dialog");
      const win = deps.getWindow();
      if (!win) throw new Error("no window");
      const video2 = deps.getVideo();
      video2?.suspend();
      try {
        const r = await deps.showOpenDialog(win, {
          title: "Choose a film",
          properties: ["openFile"],
          filters: [
            { name: "Video", extensions: VIDEO_EXTENSIONS },
            { name: "All files", extensions: ["*"] }
          ]
        });
        if (r.canceled || !r.filePaths[0]) {
          log("[film] dialog dismissed without a selection");
          return null;
        }
        log(`[film] loading ${r.filePaths[0]}`);
        return await loadInto(r.filePaths[0]);
      } finally {
        video2?.resume();
      }
    },
    "file:openPath": async (path) => {
      log(`[film] loading (dropped) ${path}`);
      return await loadInto(path);
    },
    "identity:get": () => deps.getIdentity(),
    "films:list": async () => {
      const store = deps.getFilmStore();
      if (!store) return { films: [], usedBytes: 0, freeBytes: 0 };
      return { films: await store.list(), usedBytes: await store.totalBytes(), freeBytes: await store.freeBytes() };
    },
    "films:remove": async (infoHash) => {
      const store = deps.getFilmStore();
      if (!store) throw new Error("no film store");
      const open = deps.getMediaPath();
      const film = (await store.list()).find((f) => f.infoHash.toLowerCase() === infoHash.toLowerCase());
      if (film && open && film.path === open) throw new Error("That film is open. Close it first.");
      await store.remove(infoHash);
      log(`[films] removed ${infoHash}`);
    },
    /** Fetch a film the room is sharing that this machine does not have. */
    "film:receive": async (info) => {
      const transfer2 = deps.getTransfer();
      if (!transfer2) throw new Error("transfer not ready");
      log(`[film] receiving ${info.infoHash} (${(info.bytes / 1024 ** 3).toFixed(2)} GB)`);
      const { path } = await transfer2.receive(info);
      return { path };
    },
    /** A null code creates a room; a code joins one. */
    "room:connect": async (o) => {
      const player = deps.getVideo()?.player;
      if (!player) throw new Error("player not ready");
      await deps.getRoom()?.close();
      let room2;
      try {
        room2 = await deps.createRoom({ ...o, player });
      } catch (err) {
        throw explainConnectError(err, o.url);
      }
      deps.setRoom(room2);
      deps.saveIdentity({ name: o.name, server: o.url, lastCode: room2.code });
      const mediaPath2 = deps.getMediaPath();
      if (mediaPath2) room2.announceMedia(basename(mediaPath2), player.duration() ?? 0);
      return { memberId: room2.memberId, code: room2.code };
    },
    "chat:send": (text) => {
      const room2 = deps.getRoom();
      if (!room2) throw new Error("not in a room");
      room2.sendChat(text);
    },
    "member:setControl": (memberId, mayControl) => {
      const room2 = deps.getRoom();
      if (!room2) throw new Error("not in a room");
      if (!room2.me()?.isHost) throw new Error("only the host can change playback control");
      room2.setControl(memberId, mayControl);
    },
    "member:transferHost": (memberId) => {
      const room2 = deps.getRoom();
      if (!room2) throw new Error("not in a room");
      if (!room2.me()?.isHost) throw new Error("only the host can hand over hosting");
      room2.transferHost(memberId);
    },
    /** Start although somebody is still buffering. The host's call to make. */
    "room:startAnyway": () => {
      const room2 = deps.getRoom();
      if (!room2) throw new Error("not in a room");
      if (!room2.me()?.isHost) throw new Error("only the host can start early");
      room2.startAnyway();
    },
    /** Opaque WebRTC negotiation, relayed by the server to one member. */
    "voice:signal": (to, payload) => {
      deps.getRoom()?.sendSignal(to, payload);
    },
    "voice:state": (v) => {
      deps.getRoom()?.setVoiceState(v);
    },
    "voice:moderate": (memberId, action) => {
      const room2 = deps.getRoom();
      if (!room2) throw new Error("not in a room");
      if (!room2.me()?.isHost) throw new Error("only the host can mute other people");
      room2.moderateVoice(memberId, action);
    },
    /**
     * Quieten the film while someone is talking. Chromium's echo canceller
     * cannot hear mpv -- it removes audio Chromium itself played, and mpv plays
     * through a different path entirely -- so on speakers the film would
     * otherwise be picked up by every microphone and sent back to the room.
     */
    "voice:duck": async (ducked) => {
      const player = deps.getVideo()?.player;
      if (!player) return;
      await player.setVolume?.(ducked ? 35 : 100);
    },
    /** Whether the room pauses when someone arrives mid-film. */
    "room:setWaitForLatecomers": (wait) => {
      const room2 = deps.getRoom();
      if (!room2) throw new Error("not in a room");
      if (!room2.me()?.isHost) throw new Error("only the host can change that");
      room2.setWaitForLatecomers(wait);
    },
    "room:disconnect": async () => {
      await deps.getRoom()?.close();
      deps.setRoom(null);
    },
    // Outside a room these drive the player directly. Awaited rather than fired
    // and forgotten, so a failure reaches the interface instead of vanishing.
    "playback:play": async () => {
      const room2 = deps.getRoom();
      if (room2) room2.requestPlay();
      else await deps.getVideo()?.player?.play();
      await announce("Play");
    },
    "playback:pause": async () => {
      const room2 = deps.getRoom();
      if (room2) room2.requestPause();
      else await deps.getVideo()?.player?.pause();
      await announce("Paused");
    },
    "playback:seek": async (sec) => {
      const room2 = deps.getRoom();
      if (room2) room2.requestSeek(sec);
      else await deps.getVideo()?.player?.seek(sec);
      await announce(`→ ${formatClock(sec)}`);
    },
    "window:fullscreen": async (on) => {
      const next = on ?? !deps.isFullScreen();
      deps.setFullScreen(next);
      if (next) {
        await deps.getVideo()?.player?.showText("Space play · ← → seek · Esc exit", 2600).catch(() => {
        });
      }
      return next;
    }
  };
}
const DEFAULT_SERVER = "ws://127.0.0.1:8787";
function suggestedName() {
  try {
    const u = userInfo().username?.trim();
    if (u) return u.slice(0, 40);
  } catch {
  }
  return "me";
}
function blankIdentity() {
  return { id: randomUUID(), name: suggestedName(), server: DEFAULT_SERVER, lastCode: null };
}
class IdentityStore {
  constructor(path) {
    this.path = path;
  }
  path;
  cached = null;
  get() {
    if (this.cached) return this.cached;
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf8"));
      this.cached = {
        id: typeof raw.id === "string" && raw.id ? raw.id : randomUUID(),
        name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim().slice(0, 40) : suggestedName(),
        server: typeof raw.server === "string" && raw.server ? raw.server : DEFAULT_SERVER,
        lastCode: typeof raw.lastCode === "string" && raw.lastCode ? raw.lastCode : null
      };
    } catch {
      this.cached = blankIdentity();
    }
    return this.cached;
  }
  save(patch) {
    const next = { ...this.get(), ...patch };
    if (patch.name !== void 0) next.name = patch.name.trim().slice(0, 40) || this.get().name;
    this.cached = next;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, JSON.stringify(next, null, 2));
      renameSync(tmp, this.path);
    } catch {
    }
    return next;
  }
}
const identityPathFor = (userDataDir) => join(userDataDir, "identity.json");
const __dirname$1 = dirname(fileURLToPath(import.meta.url));
if (process.platform === "linux") {
  app.commandLine.appendSwitch("ozone-platform", "x11");
}
if (process.env.COCINE_HEADLESS) {
  app.setPath("userData", mkdtempSync(join(tmpdir(), "cocine-test-")));
}
let mainWin = null;
let video = null;
let room = null;
let mediaPath = null;
let statusTimer = null;
const identity = new IdentityStore(identityPathFor(app.getPath("userData")));
const films = new FilmStore(join(app.getPath("userData"), "films"));
let transfer = null;
let sharedInfoHash = null;
let receiving = null;
function ensureTransfer(trackerUrl) {
  if (transfer) return transfer;
  transfer = new TransferManager({ store: films, trackerUrl });
  transfer.on("error", (err) => console.error("[transfer]", err));
  return transfer;
}
const state = () => {
  const player = video?.player;
  const now = Date.now();
  const expected = room?.expectedPosition(now) ?? null;
  const actual = player ? room?.actualPosition(now) ?? player.position() : 0;
  return {
    ready: !!player,
    connected: !!room,
    members: room?.members ?? [],
    memberId: room?.memberId ?? "",
    code: room?.code ?? null,
    messages: room?.messages ?? [],
    isHost: room?.me()?.isHost ?? false,
    mayControl: room?.me()?.mayControl ?? false,
    mediaName: mediaPath ? basename(mediaPath) : null,
    durationSec: player?.duration() ?? null,
    positionSec: actual,
    expectedSec: expected,
    driftMs: expected === null ? null : (actual - expected) * 1e3,
    paused: player?.isPaused() ?? true,
    rate: room?.currentRate() ?? 1,
    clockOffsetMs: room?.clock.offsetMs() ?? null,
    rttMs: room?.clock.rttMs() ?? null,
    lastAction: room?.lastSyncAction()?.type ?? null,
    fullscreen: mainWin?.isFullScreen() ?? false,
    transfers: transfer?.progress() ?? [],
    phase: room?.phase ?? "lobby",
    waitForLatecomers: room?.waitForLatecomers ?? true,
    transferStatus: room?.transfer ?? null,
    receiving,
    roomTorrent: room?.media?.torrent ?? null
  };
};
function createWindow() {
  mainWin = new BrowserWindow({
    width: 1180,
    height: 720,
    minWidth: 900,
    minHeight: 560,
    backgroundColor: "#0d1117",
    title: "coCine",
    show: false,
    webPreferences: {
      preload: join(__dirname$1, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  mainWin.webContents.on("console-message", (e) => {
    const level = e.level === "error" ? "error" : "log";
    console[level](`[renderer] ${e.message}`);
  });
  mainWin.webContents.on("render-process-gone", (_e, d) => console.error("[renderer] gone:", d.reason));
  mainWin.on("ready-to-show", () => {
    if (!process.env.COCINE_HEADLESS) mainWin?.show();
  });
  const pushState = () => {
    if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send("state", state());
  };
  mainWin.on("enter-full-screen", pushState);
  mainWin.on("leave-full-screen", pushState);
  mainWin.on("closed", () => {
    mainWin = null;
  });
  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) void mainWin.loadURL(devUrl);
  else void mainWin.loadFile(join(__dirname$1, "../renderer/index.html"));
  video = new VideoWindow(mainWin);
  void video.start().then(async () => {
    const arg = process.argv.find((a) => a.startsWith("--film="));
    if (arg) {
      mediaPath = arg.slice("--film=".length);
      try {
        await video?.player?.load(mediaPath);
      } catch (e) {
        console.error("could not load film:", e);
      }
    }
    statusTimer = setInterval(() => {
      const t = room?.media?.torrent;
      if (t && transfer) {
        const at = room?.expectedPosition() ?? 0;
        transfer.updatePlayhead(t.infoHash, at, room?.media?.durationSec ?? 0);
      }
      if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send("state", state());
    }, 100);
  });
}
const handlers = createHandlers({
  showOpenDialog: (parent, options) => dialog.showOpenDialog(parent, options),
  getWindow: () => mainWin,
  getVideo: () => video,
  getRoom: () => room,
  setRoom: (r) => {
    room = r;
  },
  createRoom: async (o) => {
    const client = new RoomClient({
      url: o.url,
      code: o.code,
      name: o.name,
      player: o.player,
      // What this machine can honestly say about the film it is fetching.
      getReport: () => {
        const t = client.media?.torrent;
        if (!t || !transfer) return null;
        if (t.infoHash === sharedInfoHash) {
          return { havePct: 1, bufferEndSec: client.media?.durationSec ?? 0, downBps: 0, upBps: 0, peers: 0 };
        }
        return transfer.reportFor(t.infoHash, client.expectedPosition() ?? 0, client.media?.durationSec ?? 0);
      }
    });
    client.on("rtc-signal", (from, payload) => {
      mainWin?.webContents.send("voice:signal", from, payload);
    });
    client.on("voice-moderated", (by, action) => {
      mainWin?.webContents.send("voice:moderated", by, action);
    });
    client.on("media", (media) => {
      void (async () => {
        const t = media?.torrent;
        if (!t || t.infoHash === sharedInfoHash) return;
        try {
          const tm = ensureTransfer(client.trackerUrl);
          console.log(`[film] room is sharing ${media?.name}; fetching`);
          receiving = { name: media?.name ?? "", infoHash: t.infoHash };
          const { path } = await tm.receive(t);
          const url = tm.streamUrl(t.infoHash) ?? path;
          await video?.player?.load(url);
          mediaPath = path;
          receiving = null;
          console.log(`[film] streaming ${media?.name} from ${url}`);
        } catch (err) {
          receiving = null;
          console.error("[film] could not receive:", err);
        }
      })();
    });
    await client.connect();
    if (client.trackerUrl) ensureTransfer(client.trackerUrl);
    return client;
  },
  getMediaPath: () => mediaPath,
  setMediaPath: (p) => {
    mediaPath = p;
  },
  setFullScreen: (on) => mainWin?.setFullScreen(on),
  isFullScreen: () => mainWin?.isFullScreen() ?? false,
  getIdentity: () => identity.get(),
  saveIdentity: (patch) => identity.save(patch),
  getTransfer: () => transfer,
  getFilmStore: () => films,
  setSharedInfoHash: (h) => {
    sharedInfoHash = h;
  },
  log: (m) => console.log(m)
});
for (const [channel, fn] of Object.entries(handlers)) {
  ipcMain.handle(channel, (_e, ...args) => fn(...args));
}
app.whenReady().then(createWindow);
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
let shuttingDown = false;
app.on("before-quit", (event) => {
  if (shuttingDown) return;
  event.preventDefault();
  shuttingDown = true;
  void (async () => {
    if (statusTimer) {
      clearInterval(statusTimer);
      statusTimer = null;
    }
    try {
      await transfer?.destroy();
    } catch {
    }
    try {
      await room?.close();
    } catch {
    }
    try {
      await video?.close();
    } catch {
    }
    app.quit();
  })();
});
process.on("exit", () => {
  try {
    video?.killNow();
  } catch {
  }
});
