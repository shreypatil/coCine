import { describe, it, expect } from 'vitest'
import { nativeHandleToWid, EmbeddedMpv } from '../src/index.js'
import { ExternalMpv } from '../src/external-mpv.js'

describe('nativeHandleToWid', () => {
  it('reads a 32-bit X11 window id', () => {
    const b = Buffer.alloc(4); b.writeUInt32LE(0x1e00007, 0)
    expect(nativeHandleToWid(b)).toBe('31457287')
  })

  it('reads a 64-bit pointer handle without losing precision', () => {
    const b = Buffer.alloc(8); b.writeBigUInt64LE(0x7f9c_1234_5678n, 0)
    expect(nativeHandleToWid(b)).toBe('140308297045624')
  })

  it('rejects a handle it cannot interpret', () => {
    expect(() => nativeHandleToWid(Buffer.alloc(2))).toThrow(/2 bytes/)
  })
})

describe('EmbeddedMpv', () => {
  it('is an ExternalMpv, so the sync engine cannot tell them apart', () => {
    // Structural, not behavioural: proves the two implementations share the
    // exact-seek and playback-restart handling the 100 ms budget depends on.
    expect(EmbeddedMpv.prototype).toBeInstanceOf(ExternalMpv)
    for (const m of ['load', 'play', 'pause', 'seek', 'setRate', 'position', 'isPaused', 'positionObservedAt', 'close']) {
      expect(typeof (EmbeddedMpv.prototype as unknown as Record<string, unknown>)[m]).toBe('function')
    }
  })
})
