/**
 * An Electron process that hosts <video> elements and speaks a line protocol.
 *
 * This is the B1.0 spike's stand-in for mpv, and it is deliberately shaped like
 * mpv: a separate process, a socket, newline-delimited JSON, unsolicited events
 * for position and pause. That shape is not nostalgia. It is what lets
 * HtmlVideoPlayer satisfy `PlayerController` with a *synchronous* `position()`
 * -- the sync engine runs on a tick and cannot await a round trip -- and it is
 * what lets the existing phase 0 and phase 1 harnesses drive this without
 * knowing anything has changed. A gate that needed its own measurement code
 * would be measuring itself.
 *
 * One process, one hidden window, N video elements addressed by id. Five
 * Electron processes would cost a gigabyte to prove nothing extra.
 *
 * Nothing is ever shown. The window is created with `show: false`, so no test
 * run puts a window on anybody's desktop. `backgroundThrottling: false` matters
 * just as much: Chromium throttles timers in windows it thinks nobody is
 * looking at, and a throttled position feed would read as drift that is not
 * there.
 */
const { app, BrowserWindow } = require('electron')
const net = require('node:net')
const http = require('node:http')
const fs = require('node:fs')

// Software rendering would make the 4K decode gate meaningless, and forcing x11
// keeps this identical to how the app runs today.
app.commandLine.appendSwitch('ozone-platform', 'x11')
// Chromium pauses media in occluded windows. The window is never visible here,
// so without this nothing would ever play.
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

const SOCKET = process.argv.find(a => a.startsWith('--socket='))?.slice('--socket='.length)
if (!SOCKET) { process.stderr.write('html-video-host: no --socket=\n'); process.exit(2) }

/** How often the renderer reports where each player is. mpv observes at ~10 Hz;
 *  25 Hz here costs nothing and gives the sync engine a fresher reading. */
const REPORT_HZ = 25

let win = null
const sockets = new Set()

const broadcast = obj => {
  const line = `${JSON.stringify(obj)}\n`
  for (const s of sockets) { try { s.write(line) } catch { /* going away */ } }
}

const PAGE = `
<!doctype html><html><head><meta charset="utf-8"><style>
  html,body { margin:0; background:#000; overflow:hidden }
  video { position:absolute; width:320px; height:180px; opacity:0 }
</style></head><body><script>
  const players = new Map()

  window.__create = (id, opts) => {
    if (players.has(id)) return true
    const v = document.createElement('video')
    v.muted = opts && opts.muted !== false
    v.preload = 'auto'
    v.playsInline = true
    // Never autoplay: the sync engine decides when a film starts, and a player
    // that started on its own would be a peer nobody scheduled.
    v.autoplay = false
    document.body.appendChild(v)
    players.set(id, v)
    v.addEventListener('ended', () => window.__push({ event: 'eof', player: id }))
    v.addEventListener('pause', () => window.__push({ event: 'pause', player: id, paused: true }))
    v.addEventListener('play',  () => window.__push({ event: 'pause', player: id, paused: false }))
    v.addEventListener('error', () => window.__push({
      event: 'mediaerror', player: id,
      message: (v.error && (v.error.message || ('code ' + v.error.code))) || 'unknown'
    }))
    return true
  }

  window.__get = id => players.get(id)

  window.__load = (id, src) => new Promise(resolve => {
    const v = players.get(id); if (!v) return resolve({ error: 'no such player' })
    const done = r => { v.onloadedmetadata = null; v.onerror = null; clearTimeout(t); resolve(r) }
    const t = setTimeout(() => done({ error: 'timed out loading ' + src }), 60000)
    v.onloadedmetadata = () => done({ duration: v.duration })
    v.onerror = () => done({ error: (v.error && (v.error.message || v.error.code)) || 'load failed' })
    v.src = src
    v.load()
  })

  window.__seek = (id, sec) => new Promise(resolve => {
    const v = players.get(id); if (!v) return resolve({ error: 'no such player' })
    const done = r => { clearTimeout(t); v.onseeked = null; resolve(r) }
    const t = setTimeout(() => done({ error: 'seek timed out' }), 30000)
    v.onseeked = () => done({ position: v.currentTime })
    v.currentTime = sec
  })

  /** Everything the Node side caches, so position() can stay synchronous. */
  window.__snapshot = () => {
    // Stamped here, beside the reading, rather than in the main process when
    // the reply arrives. The snapshot crosses a process boundary, so a
    // timestamp taken on the far side is later than the moment currentTime was
    // read -- and the sync engine extrapolates from exactly that pair, so the
    // lag becomes drift it cannot see. timeOrigin + now() is wall-clock
    // milliseconds on the same scale as Date.now().
    const at = performance.timeOrigin + performance.now()
    const out = []
    for (const [id, v] of players) {
      out.push({
        player: id,
        at,
        pos: v.currentTime,
        paused: v.paused,
        duration: Number.isFinite(v.duration) ? v.duration : null,
        rate: v.playbackRate,
        readyState: v.readyState,
        // Dropped frames are how the 4K gate decides whether decode kept up.
        quality: v.getVideoPlaybackQuality ? (() => {
          const q = v.getVideoPlaybackQuality()
          return { total: q.totalVideoFrames, dropped: q.droppedVideoFrames }
        })() : null,
        buffered: v.buffered.length ? v.buffered.end(v.buffered.length - 1) : 0
      })
    }
    return out
  }
</script></body></html>`

app.whenReady().then(async () => {
  win = new BrowserWindow({
    show: false,
    width: 640,
    height: 480,
    webPreferences: {
      backgroundThrottling: false,
      nodeIntegration: false,
      contextIsolation: false
    }
  })
  // A real origin rather than a data: URL, for two reasons. Opaque origins are
  // not secure contexts, which silently removes half of what a media page can
  // do -- the codec probe that started this phase read WebCodecs as absent for
  // exactly that reason. And a page on a data: URL may not load file:// media
  // at all: Chromium rejects it as a "URL safety check", which is what this
  // hit first.
  //
  // Serving local files over HTTP with range support is also what the shipped
  // app already does -- the torrent stream server is exactly this -- so the
  // spike exercises the same path rather than a privileged one.
  const origin = await new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1')
      if (url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        return res.end(PAGE)
      }
      if (url.pathname === '/local') {
        const file = Buffer.from(url.searchParams.get('p') || '', 'base64').toString('utf8')
        if (!file || !fs.existsSync(file)) { res.writeHead(404); return res.end() }
        const size = fs.statSync(file).size
        const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '')
        if (m) {
          const start = +m[1]
          const end = m[2] ? +m[2] : size - 1
          res.writeHead(206, {
            'Content-Range': `bytes ${start}-${end}/${size}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': end - start + 1
          })
          return fs.createReadStream(file, { start, end }).pipe(res)
        }
        res.writeHead(200, { 'Content-Length': size, 'Accept-Ranges': 'bytes' })
        return fs.createReadStream(file).pipe(res)
      }
      res.writeHead(404); res.end()
    })
    srv.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${srv.address().port}`))
  })
  await win.loadURL(`${origin}/`)

  await win.webContents.executeJavaScript(`
    window.__push = msg => { console.log('__EVENT__' + JSON.stringify(msg)) }; true
  `)
  // Events come back over the console channel, which needs no preload script
  // and no IPC wiring for a spike.
  win.webContents.on('console-message', (...args) => {
    // Electron changed this signature; accept both shapes.
    const text = typeof args[1] === 'string' ? args[1] : (args[0] && args[0].message) || ''
    if (typeof text === 'string' && text.startsWith('__EVENT__')) {
      try { broadcast(JSON.parse(text.slice('__EVENT__'.length))) } catch { /* not ours */ }
    }
  })

  const js = async code => win.webContents.executeJavaScript(code)

  const handle = async msg => {
    const p = JSON.stringify(msg.player ?? '')
    switch (msg.cmd) {
      case 'create':   return js(`window.__create(${p}, ${JSON.stringify(msg.opts ?? {})})`)
      case 'load': {
        // http(s) sources -- the torrent stream server -- are used as given.
        // Anything else is a local path, served through the origin above.
        const src = /^https?:\/\//i.test(msg.src)
          ? msg.src
          : `${origin}/local?p=${Buffer.from(String(msg.src).replace(/^file:\/\//, ''), 'utf8').toString('base64')}`
        return js(`window.__load(${p}, ${JSON.stringify(src)})`)
      }
      case 'play':     return js(`(async () => { const v = window.__get(${p}); try { await v.play(); return { ok: true } } catch (e) { return { error: e.name + ': ' + e.message } } })()`)
      case 'pause':    return js(`(() => { window.__get(${p}).pause(); return { ok: true } })()`)
      case 'seek':     return js(`window.__seek(${p}, ${Number(msg.arg)})`)
      case 'rate':     return js(`(() => { window.__get(${p}).playbackRate = ${Number(msg.arg)}; return { ok: true } })()`)
      case 'volume':   return js(`(() => { const v = window.__get(${p}); v.volume = ${Number(msg.arg)}; v.muted = ${Number(msg.arg)} === 0; return { ok: true } })()`)
      case 'unload':   return js(`(() => { const v = window.__get(${p}); v.removeAttribute('src'); v.load(); return { ok: true } })()`)
      case 'snapshot': return js('window.__snapshot()')
      case 'quit':     setTimeout(() => app.exit(0), 20); return { ok: true }
      default:         return { error: `unknown command ${msg.cmd}` }
    }
  }

  const server = net.createServer(sock => {
    sockets.add(sock)
    sock.setNoDelay(true)
    let buf = ''
    sock.on('data', async chunk => {
      buf += String(chunk)
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line) continue
        let msg
        try { msg = JSON.parse(line) } catch { continue }
        try {
          const data = await handle(msg)
          sock.write(`${JSON.stringify({ request_id: msg.request_id, data })}\n`)
        } catch (err) {
          sock.write(`${JSON.stringify({ request_id: msg.request_id, error: String(err && err.message || err) })}\n`)
        }
      }
    })
    sock.on('error', () => { /* the client went away */ })
    sock.on('close', () => sockets.delete(sock))
  })

  server.listen(SOCKET, () => {
    // The Node side waits for this before connecting.
    process.stdout.write('READY\n')
  })

  // The position feed. Pushed rather than polled for the same reason mpv
  // observes properties rather than being asked: the sync engine reads a cache.
  setInterval(async () => {
    if (!win || win.isDestroyed() || sockets.size === 0) return
    try {
      const snap = await js('window.__snapshot()')
      // `at` comes from the snapshot itself; spreading it last would replace a
      // timestamp taken beside the reading with one taken after the round trip.
      for (const s of snap) broadcast({ event: 'position', ...s })
    } catch { /* the window is going away */ }
  }, Math.round(1000 / REPORT_HZ))
})

app.on('window-all-closed', () => app.exit(0))
