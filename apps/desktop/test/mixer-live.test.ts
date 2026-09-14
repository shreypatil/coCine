import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { chromium, type Browser } from 'playwright'
import { createServer, type Server } from 'node:http'
import { build } from 'esbuild'
import { join } from 'node:path'

/**
 * The mixer written onto real <audio> elements in a real Chromium.
 *
 * mixer.test.ts proves the arithmetic against plain objects. This proves the
 * element accepts what it is given -- `volume` is clamped and `muted` is a
 * separate control -- because "the slider moved and nothing changed" is one
 * more failure that sounds exactly like silence, and a fake element cannot
 * catch it.
 */

type Snapshot = Record<string, { volume: number; muted: boolean }>

let browser: Browser
let server: Server
let origin = ''
let js = ''

beforeAll(async () => {
  const out = await build({
    entryPoints: [join(__dirname, '../src/renderer/mixer.ts')],
    bundle: true, format: 'iife', globalName: 'Mixer', write: false, platform: 'browser'
  })
  js = out.outputFiles[0]!.text
  server = createServer((_, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<!doctype html><meta charset="utf-8"><title>mixer</title>')
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const a = server.address()
  origin = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`
  browser = await chromium.launch({ args: ['--mute-audio'] })
}, 180_000)

afterAll(async () => {
  await browser?.close()
  await new Promise<void>(r => server?.close(() => r()))
})

describe('the mixer on real elements', () => {
  it('sets each element to its own level, and undeafening restores every level', async () => {
    const page = await browser.newPage()
    await page.goto(origin)
    await page.addScriptTag({ content: js })
    const result = await page.evaluate(`(() => {
      const M = window.Mixer
      const els = new Map([['sam', new Audio()], ['dev', new Audio()]])
      for (const el of els.values()) document.body.appendChild(el)
      const read = () => Object.fromEntries([...els].map(([id, el]) => [id, { volume: el.volume, muted: el.muted }]))
      const m = { level: { sam: 40 }, muted: { dev: true } }
      M.applyMixer(els, m, false)
      const set = read()
      M.applyMixer(els, m, true)
      const deafened = read()
      M.applyMixer(els, m, false)
      const restored = read()
      return { set, deafened, restored, gain40: M.gainFor(40) }
    })()`) as { set: Snapshot; deafened: Snapshot; restored: Snapshot; gain40: number }

    expect(result.set.sam.volume).toBeCloseTo(result.gain40, 5)
    expect(result.set.sam.muted).toBe(false)
    expect(result.set.dev).toEqual({ volume: 1, muted: true })
    expect(result.deafened.sam).toEqual({ volume: result.set.sam.volume, muted: true })
    expect(result.deafened.dev.muted).toBe(true)
    expect(result.restored).toEqual(result.set)
    await page.close()
  }, 60_000)
})
