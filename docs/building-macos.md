# Building for macOS

Apple Silicon only, deliberately: an Intel dmg would need a `darwin-x64` WebRTC
addon that `scripts/fetch-native.mjs` does not stage, and would install happily
and then fail to connect anybody.

Everything here has to run **on the Mac**. The `dmg` target needs `hdiutil`,
which exists only on macOS, so this cannot be cross-built from Linux.

---

## Before you sit down at it

- macOS on an M-series machine.
- [Homebrew](https://brew.sh). ffmpeg cannot be fetched unattended for macOS —
  no published build can be downloaded without agreeing to terms — so it comes
  from `brew` and is copied in.
- Node 20 or newer, and `git`.

## The build

```bash
git clone <this repo> && cd coCine
npm ci

brew install ffmpeg
node scripts/fetch-ffmpeg.mjs mac --from "$(brew --prefix)/bin"

npm run dist:mac
```

The result is `release/coCine-<version>-arm64.dmg`.

`npm ci` on the Mac installs the correct `darwin-arm64` binaries, so nothing is
staged or swapped — `dist.mjs` notices it is building for the machine it is on
and says so. (It used to assume a Mac build was always foreign, and would have
fetched arm64 binaries over the correct ones already there.)

A warning that mpv is not staged is expected and fine. The `<video>` engine has
been the default on every platform since B1.6; mpv is reached only by someone
setting `COCINE_PLAYER=mpv` deliberately.

## Running it

Built locally and opened from `release/`, it just runs. Nothing downloaded it,
so it carries no quarantine attribute and Gatekeeper has no opinion.

---

## Signing: what you get away with, and what you do not

Two separate mechanisms, and only the second is optional.

### Apple Silicon requires *a* signature

Unlike Intel, arm64 macOS will not execute a binary with no valid signature at
all — the kernel kills it, usually reported as "damaged and can't be opened",
which sounds like a corrupt download and is not. An **ad-hoc** signature
satisfies this. It is free, needs no certificate and no Apple account.

electron-builder is configured with `identity: null`, which stops it picking a
random keychain certificate. Check what came out:

```bash
codesign -dv --verbose=2 "release/mac-arm64/coCine.app" 2>&1 | head -5
```

`Signature=adhoc` is fine. If it reports the app is unsigned, ad-hoc sign it:

```bash
codesign --force --deep --sign - "release/mac-arm64/coCine.app"
```

### Gatekeeper is the part you are skipping

A Developer ID certificate plus notarisation is what stops macOS warning about
an app somebody downloaded. Without it:

- **A friend who downloads the dmg will be blocked on first open.** On macOS
  Sequoia and later the old Control-click → Open shortcut no longer works; they
  go to **System Settings → Privacy & Security**, find the message about coCine
  being blocked, and press **Open Anyway**. Once per install.
- Or, faster if they are comfortable in a terminal:
  ```bash
  xattr -dr com.apple.quarantine /Applications/coCine.app
  ```
- **Auto-update does not work at all.** macOS refuses to apply an unsigned
  update, so `updates.ts` deliberately does not check on darwin — it would
  download something that can never be installed and report a pending update
  that silently does nothing. Mac users update by downloading a new dmg.

None of that blocks the friends-and-family case, which is what the project is
scoped to. It becomes worth $99 a year when strangers install it, or when
updating by hand becomes the thing that stops people running a current version.

`electron-builder.yml` already carries the stanza: set `notarize: true`, give
`identity` a Developer ID, and export `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`
and `APPLE_TEAM_ID`.

---

## What has never run on a Mac

Worth watching on the first launch, in rough order of likelihood.

**Fullscreen.** macOS fullscreen uses Spaces and behaves unlike X11. The
controls and chat are ordinary DOM under the `<video>` engine, which is far
safer than the reparenting the mpv engine needs, but nobody has seen it.

**The chat overlay window is not used** — `index.ts:305` never shows it under
the `<video>` engine, because the film is the window and chat is drawn over it.
That matters because `chat-overlay.ts` takes an untested path off Linux: it
assumes transparency works and skips shaping entirely. If you ever run
`COCINE_PLAYER=mpv` on macOS, that is the first thing to suspect.

**File paths and the picker.** `browse.ts` exists because the system dialog
cannot be trusted on Linux; macOS should use the native dialog.

**ffmpeg's identity.** The Homebrew build is copied in, not a published
redistributable. Fine for friends; check the licence terms of what you bundle
before shipping it to strangers.
