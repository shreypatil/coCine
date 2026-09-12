/// <reference lib="dom" />
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { chromium, type Browser } from 'playwright'
import { createServer, type Server } from 'node:http'
import { build } from 'esbuild'
import { join } from 'node:path'

/**
 * The Web Audio half of the speaking indicator.
 *
 * speaking.test.ts covers the gate, which is pure arithmetic. This covers the
 * part that could silently do nothing: an AudioContext that never leaves
 * `suspended`, an analyser wired to a source that produces no samples, a frame
 * of the wrong type. Those all fail by reporting permanent silence -- which is
 * indistinguishable from a microphone the system is blocking, and is exactly
 * the confusion this indicator exists to remove.
 *
 * Driven with an oscillator rather than a microphone, so it needs no hardware
 * and the level is known rather than hoped for.
 */

let browser: Browser
let server: Server
let origin = ''
let js = ''

beforeAll(async () => {
  const out = await build({
    entryPoints: [join(__dirname, '../src/renderer/speaking.ts')],
    bundle: true, format: 'iife', globalName: 'Speaking', write: false, platform: 'browser'
  })
  js = out.outputFiles[0]!.text
  server = createServer((_, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<!doctype html><meta charset="utf-8"><title>speaking</title>')
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const a = server.address()
  origin = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`
  browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] })
}, 180_000)

afterAll(async () => {
  await browser?.close()
  await new Promise<void>(r => server?.close(() => r()))
})

describe('watching a real audio stream', () => {
  it('reports speaking for a live tone and silence for a silent one', async () => {
    const page = await browser.newPage()
    await page.goto(origin)
    await page.addScriptTag({ content: js })

    const seen = await page.evaluate(async () => {
      const w = window as any
      const ctx = new AudioContext()
      await ctx.resume()

      /** A stream carrying a tone at a chosen amplitude. */
      const toneStream = (gainValue: number): MediaStream => {
        const osc = ctx.createOscillator()
        osc.frequency.value = 220
        const gain = ctx.createGain()
        gain.gain.value = gainValue
        const dest = ctx.createMediaStreamDestination()
        osc.connect(gain).connect(dest)
        osc.start()
        return dest.stream
      }

      const results: Record<string, boolean[]> = { loud: [], quiet: [] }
      const det = new w.Speaking.SpeakingDetector((s: Record<string, boolean>) => {
        if ('loud' in s) results.loud.push(s.loud)
        if ('quiet' in s) results.quiet.push(s.quiet)
      })
      det.watch('loud', toneStream(0.3))
      det.watch('quiet', toneStream(0))
      await new Promise(r => setTimeout(r, 1200))
      det.close()
      return results
    })

    // A loud tone is heard...
    expect(seen.loud.some(v => v), 'a loud tone should register as speaking').toBe(true)
    // ...and silence never is, which is the case that matters for diagnosing a
    // microphone the system has blocked.
    expect(seen.quiet.every(v => !v), 'silence should never register').toBe(true)
    await page.close()
  }, 120_000)

  it('stops reporting a stream once it is unwatched', async () => {
    // A member who leaves must not keep a lit dot.
    const page = await browser.newPage()
    await page.goto(origin)
    await page.addScriptTag({ content: js })
    const after = await page.evaluate(async () => {
      const w = window as any
      const ctx = new AudioContext()
      await ctx.resume()
      const osc = ctx.createOscillator()
      const gain = ctx.createGain(); gain.gain.value = 0.3
      const dest = ctx.createMediaStreamDestination()
      osc.connect(gain).connect(dest); osc.start()

      let last: Record<string, boolean> = {}
      const det = new w.Speaking.SpeakingDetector((s: Record<string, boolean>) => { last = s })
      det.watch('gone', dest.stream)
      await new Promise(r => setTimeout(r, 500))
      det.unwatch('gone')
      await new Promise(r => setTimeout(r, 300))
      det.close()
      return last
    })
    expect(after).not.toHaveProperty('gone')
    await page.close()
  }, 120_000)
})
