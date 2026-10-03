import { describe, it, expect } from 'vitest'
import { plainLogData } from '../src/renderer/log.js'

/**
 * What a renderer log record looks like by the time main writes it. Two voice
 * failures in a real session were logged as `"error":{}` -- the DOMException
 * WebRTC threw had kept its name and message as prototype getters, which
 * neither structured clone nor JSON copies.
 */
describe('renderer log data', () => {
  it('keeps the name and message of a DOMException nested in a record', () => {
    const e = new DOMException('Failed to set remote answer sdp: Called in wrong state: stable', 'InvalidStateError')
    // The defect, demonstrated: this is what was being written.
    expect(JSON.stringify({ error: e })).toBe('{"error":{}}')

    const out = JSON.parse(JSON.stringify(plainLogData({ from: 'ed9f9a8f', error: e }))) as { error: Record<string, string> }
    expect(out.error.name).toBe('InvalidStateError')
    expect(out.error.message).toContain('Called in wrong state')
  })

  it('keeps an ordinary Error, with the top of its stack', () => {
    const out = plainLogData({ error: new TypeError('nope') }) as { error: Record<string, string> }
    expect(out.error).toMatchObject({ name: 'TypeError', message: 'nope' })
    expect(out.error.stack).toContain('nope')
  })

  it('survives structured clone, which is how it crosses to main', () => {
    const out = structuredClone(plainLogData({ error: new DOMException('gone', 'NotFoundError'), n: 1, list: [1, 'a'] }))
    expect(out).toMatchObject({ error: { name: 'NotFoundError', message: 'gone' }, n: 1, list: [1, 'a'] })
  })

  it('turns what cannot be copied into a description instead of losing the line', () => {
    const cyclic: Record<string, unknown> = { a: 1 }
    cyclic.self = cyclic
    const out = plainLogData({ cyclic, fn: function named () {}, big: 10n }) as Record<string, unknown>
    expect(() => structuredClone(out)).not.toThrow()
    expect(out).toMatchObject({ cyclic: { a: 1, self: '[Circular]' }, fn: '[function named]', big: '10n' })
  })

  it('leaves plain values alone', () => {
    expect(plainLogData({ peer: 'abc', state: 'failed', n: 3, ok: true, none: null })).toEqual({ peer: 'abc', state: 'failed', n: 3, ok: true, none: null })
    expect(plainLogData('text')).toBe('text')
  })
})
