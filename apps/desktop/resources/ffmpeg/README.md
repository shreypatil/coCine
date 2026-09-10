# Bundled ffmpeg

Fetched per platform by `scripts/fetch-ffmpeg.mjs`, and deliberately not in git —
these are ~150 MB per platform and have no business in a history.

```bash
node scripts/fetch-ffmpeg.mjs linux
node scripts/fetch-ffmpeg.mjs win
node scripts/fetch-ffmpeg.mjs mac --from "$(brew --prefix)/bin"
```

Linux and Windows fetch published builds unattended. **macOS cannot**: there is
no build that can be downloaded without a click-through, so it takes `--from`
naming a directory that already holds both tools, and you are responsible for
their dylib dependencies resolving inside the app bundle — the same caveat that
applies to bundling mpv there.

`dist:*` will build without these present. The application simply falls back to
whatever is on PATH, and a film needing conversion then says so rather than
failing silently — which is right for a development run and wrong for something
a stranger installs, so check the directory is populated before shipping.
