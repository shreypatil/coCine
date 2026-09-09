import { describe, it, expect, vi } from 'vitest'

/**
 * The geometry that decides where mpv's native surface goes.
 *
 * Two shipped bugs came out of these few lines, and neither produced an error
 * anywhere -- both produced a black rectangle, which is indistinguishable from
 * a film that has not started.
 *
 * The first was the offset: Electron counts a Linux menu bar as part of the
 * window's *content* while the page's own coordinates start below it, so the
 * surface sat about thirty pixels too high, over the application's own top bar.
 * The second was the comparison: the self-heal checked a requested geometry in
 * parent coordinates against a reported one in screen coordinates, so they
 * differed always, and the window was reconfigured ten times a second for ever
 * -- which on a paused film leaves the picture black, because no new frame
 * arrives to paint over the reconfigure.
 *
 * Both are pure functions of numbers. There is no reason they were only ever
 * exercised through a real window.
 */

// video-window.ts reaches for Electron at import time. Neither function under
// test touches it, so a stub is enough to get the module loaded.
vi.mock('electron', () => ({
  BrowserWindow: class {},
  screen: { getDisplayMatching: () => ({ scaleFactor: 1 }) }
}))

const { chromeOffset, same } = await import('../src/main/video-window.js')

describe('finding the window chrome the page does not know about', () => {
  it('measures a menu bar rather than assuming one', () => {
    // 800 - 770 = 30 device pixels of chrome above the page's origin.
    expect(chromeOffset({ width: 1200, height: 800 }, { width: 1200, height: 770 }, 1))
      .toEqual({ x: 0, y: 30 })
  })

  it('finds no chrome where there is none', () => {
    expect(chromeOffset({ width: 1200, height: 800 }, { width: 1200, height: 800 }, 1))
      .toEqual({ x: 0, y: 0 })
  })

  it('works in device pixels on a scaled display', () => {
    // The viewport is in CSS pixels and the content bounds in device pixels, so
    // the scale has to be applied before subtracting or the offset is doubled
    // on every HiDPI screen.
    expect(chromeOffset({ width: 2400, height: 1600 }, { width: 1200, height: 785 }, 2))
      .toEqual({ x: 0, y: 30 })
  })

  it('treats a missing viewport as no offset', () => {
    // The first frames arrive before the renderer has measured anything.
    expect(chromeOffset({ width: 1200, height: 800 }, undefined, 1)).toEqual({ x: 0, y: 0 })
  })

  it('refuses a measurement too large to be window chrome', () => {
    // A bad measurement must not move the video. 400px is not a menu bar; it is
    // a viewport reported mid-layout, and trusting it would put the surface off
    // the bottom of the window.
    expect(chromeOffset({ width: 1200, height: 800 }, { width: 1200, height: 400 }, 1))
      .toEqual({ x: 0, y: 0 })
  })

  it('refuses a negative offset, which means the page is larger than the window', () => {
    expect(chromeOffset({ width: 1200, height: 700 }, { width: 1200, height: 800 }, 1))
      .toEqual({ x: 0, y: 0 })
  })

  it('refuses a viewport of zero, which is what an unlaid-out page reports', () => {
    expect(chromeOffset({ width: 1200, height: 800 }, { width: 0, height: 0 }, 1))
      .toEqual({ x: 0, y: 0 })
    expect(chromeOffset({ width: 1200, height: 800 }, { width: 1200, height: 0 }, 1))
      .toEqual({ x: 0, y: 0 })
  })

  it('measures horizontal chrome the same way, for a window that has some', () => {
    expect(chromeOffset({ width: 1210, height: 800 }, { width: 1200, height: 800 }, 1))
      .toEqual({ x: 10, y: 0 })
  })
})

describe('deciding whether the surface needs moving at all', () => {
  const r = (x: number, y: number, width: number, height: number) => ({ x, y, width, height })

  it('calls an unchanged rectangle unchanged, so nothing is reconfigured', () => {
    // The bug this prevents: every call reconfigures a native window mpv is
    // drawing into, and on a paused film the black it leaves is permanent.
    expect(same(r(0, 30, 900, 500), r(0, 30, 900, 500))).toBe(true)
  })

  it('tolerates a single pixel, which is rounding rather than movement', () => {
    expect(same(r(0, 30, 900, 500), r(1, 31, 901, 501))).toBe(true)
  })

  it('notices a real move or resize in any one dimension', () => {
    const base = r(0, 30, 900, 500)
    expect(same(base, r(2, 30, 900, 500))).toBe(false)
    expect(same(base, r(0, 32, 900, 500))).toBe(false)
    expect(same(base, r(0, 30, 902, 500))).toBe(false)
    expect(same(base, r(0, 30, 900, 502))).toBe(false)
  })

  it('treats "no geometry yet" as different from any geometry', () => {
    // Null is the state after the surface is hidden. Calling it equal to the
    // bounds it used to have would skip the reposition on the way back and
    // leave the window wherever the window manager had put it -- which is the
    // black-rectangle-in-the-wrong-place failure.
    expect(same(null, r(0, 30, 900, 500))).toBe(false)
    expect(same(r(0, 30, 900, 500), null)).toBe(false)
    expect(same(null, null)).toBe(false)
  })

  it('is symmetric, since either side may be the newer measurement', () => {
    const a = r(0, 30, 900, 500)
    const b = r(0, 400, 900, 500)
    expect(same(a, b)).toBe(same(b, a))
    expect(same(a, r(1, 30, 900, 500))).toBe(same(r(1, 30, 900, 500), a))
  })
})
