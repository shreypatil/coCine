import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { chromium, type Browser } from 'playwright'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * Can the renderer actually load a film?
 *
 * The existing renderer tests serve the page over http, so `'self'` resolves to
 * an http origin and everything the application really does -- `loadFile`, and
 * therefore a `file://` document -- goes untested. Under `file://` an origin is
 * opaque, so `'self'` matches nothing at all, and a Content-Security-Policy
 * with no `media-src` blocks the film.
 *
 * Both ways a film reaches the element are covered here because both are real:
 * a host opens one off disk, and somebody receiving one plays it from the
 * transfer's stream server on 127.0.0.1 while it is still arriving.
 */

let browser: Browser
let server: Server
let port = 0
let dir = ''

/** The policy the application actually ships, read from the page itself. */
const shippedCsp = (): string => {
  const html = readFileSync(join(__dirname, '../src/renderer/index.html'), 'utf8')
  const m = /content="([^"]*)"/.exec(html)
  return m?.[1] ?? ''
}

/** A document under that policy, loaded from file:// exactly as Electron does. */
const pageFor = (csp: string): string => {
  const file = join(dir, 'page.html')
  writeFileSync(file, `<meta http-equiv="Content-Security-Policy" content="${csp}">
<video id="v"></video>`)
  return pathToFileURL(file).href
}

/** Does setting src trip CSP? Reports the violation rather than the load error,
 *  so a missing file cannot be mistaken for a blocked one. */
const blocked = async (csp: string, src: string): Promise<boolean> => {
  const page = await browser.newPage()
  try {
    await page.goto(pageFor(csp))
    return await page.evaluate(async (s: string) => await new Promise<boolean>(resolve => {
      const t = setTimeout(() => resolve(false), 3000)
      document.addEventListener('securitypolicyviolation', e => {
        if (e.violatedDirective.startsWith('media-src') || e.violatedDirective.startsWith('default-src')) {
          clearTimeout(t); resolve(true)
        }
      })
      const v = document.getElementById('v') as HTMLVideoElement
      v.src = s
      v.load()
    }), src)
  } finally { await page.close() }
}

beforeAll(async () => {
  browser = await chromium.launch()
  dir = mkdtempSync(join(tmpdir(), 'cocine-csp-'))
  writeFileSync(join(dir, 'film.mp4'), Buffer.alloc(1024))
  // Stands in for the transfer's stream server, which listens on 127.0.0.1 on
  // a port chosen at runtime.
  server = createServer((_, res) => { res.writeHead(200, { 'content-type': 'video/mp4' }); res.end(Buffer.alloc(1024)) })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const a = server.address()
  port = typeof a === 'object' && a ? a.port : 0
}, 120_000)

afterAll(async () => {
  await browser?.close()
  await new Promise<void>(r => server?.close(() => r()))
  if (dir) rmSync(dir, { recursive: true, force: true })
})

describe('loading a film under the shipped policy', () => {
  it('allows a film opened off disk', async () => {
    // What the host does. The renderer turns a path into a file:// URL.
    const src = pathToFileURL(join(dir, 'film.mp4')).href
    expect(await blocked(shippedCsp(), src)).toBe(false)
  }, 60_000)

  it('allows a film streamed from the transfer server', async () => {
    // What everybody else does. The film is written sparsely while it arrives,
    // so it has to be read through the stream server rather than off disk.
    expect(await blocked(shippedCsp(), `http://127.0.0.1:${port}/webtorrent/abc/film.mp4`)).toBe(false)
  }, 60_000)

  it('still refuses media from somewhere else entirely', async () => {
    // The policy is not simply switched off: an arbitrary remote origin stays
    // blocked, which is the point of having one.
    expect(await blocked(shippedCsp(), 'http://example.com/film.mp4')).toBe(true)
  }, 60_000)
})
