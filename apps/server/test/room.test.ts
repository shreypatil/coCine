import { describe, it, expect } from 'vitest'
import { Room } from '../src/room.js'
import { InMemoryRoomStore } from '../src/store.js'
import { generateCode, normaliseCode, formatCode } from '@cocine/protocol'
import { randomBytes } from 'node:crypto'

describe('Room membership and roles', () => {
  it('makes the first arrival the host', () => {
    const r = new Room('ABCD1234')
    expect(r.add('a', 'anjali').isHost).toBe(true)
    expect(r.add('b', 'dev').isHost).toBe(false)
  })

  it('passes hosting to whoever has been here longest when the host leaves', () => {
    const r = new Room('ABCD1234')
    r.add('a', 'anjali'); r.add('b', 'dev'); r.add('c', 'priya')
    r.remove('a')
    expect(r.host()?.name).toBe('dev')
  })

  it('lets only the host change who may control playback', () => {
    const r = new Room('ABCD1234')
    r.add('a', 'anjali'); r.add('b', 'dev')
    expect(() => r.setControl('b', 'a', false)).toThrow(/only the host/)
    expect(r.setControl('a', 'b', false).mayControl).toBe(false)
    expect(r.setControl('a', 'b', true).mayControl).toBe(true)
  })

  it('refuses to strip control from the host', () => {
    // Otherwise a host could lock the room and leave nobody able to press play.
    const r = new Room('ABCD1234')
    r.add('a', 'anjali'); r.add('b', 'dev')
    expect(() => r.setControl('a', 'a', false)).toThrow(/always keeps control/)
  })

  it('hands hosting over, and the new host keeps control', () => {
    const r = new Room('ABCD1234')
    r.add('a', 'anjali'); const dev = r.add('b', 'dev')
    r.setControl('a', 'b', false)
    r.transferHost('a', 'b')
    expect(dev.isHost).toBe(true)
    expect(dev.mayControl).toBe(true)
    expect(r.members.get('a')!.isHost).toBe(false)
    expect(r.host()?.name).toBe('dev')
  })

  it('rejects acting on someone who is not in the room', () => {
    const r = new Room('ABCD1234')
    r.add('a', 'anjali')
    expect(() => r.setControl('a', 'ghost', true)).toThrow(/no such member/)
  })
})

describe('Room chat', () => {
  it('keeps a bounded history so a long session does not grow forever', () => {
    const r = new Room('ABCD1234')
    for (let i = 0; i < 260; i++) r.addChat('said', 'dev', `line ${i}`, 'b', i)
    expect(r.chat.length).toBe(200)
    expect(r.chat.at(-1)!.text).toBe('line 259')
    expect(r.chat[0]!.text).toBe('line 60')
  })

  it('records system entries alongside conversation', () => {
    const r = new Room('ABCD1234')
    r.addChat('joined', 'anjali', 'joined the room', 'a', 1)
    r.addChat('said', 'anjali', 'hello', 'a', 2)
    expect(r.chat.map(m => m.kind)).toEqual(['joined', 'said'])
  })
})

describe('room codes', () => {
  it('avoids the characters people confuse when reading a code aloud', () => {
    const code = generateCode(n => randomBytes(n))
    expect(code).toHaveLength(8)
    expect(code).not.toMatch(/[01OIL AEU]/)
  })

  it('normalises what someone types back to the stored form', () => {
    expect(normaliseCode('bcdf-ghjk')).toBe('BCDFGHJK')
    expect(normaliseCode(' BCDF GHJK ')).toBe('BCDFGHJK')
    expect(formatCode('BCDFGHJK')).toBe('BCDF-GHJK')
  })
})

describe('InMemoryRoomStore', () => {
  it('creates rooms with distinct codes and finds them again', () => {
    const s = new InMemoryRoomStore()
    const a = s.create(300); const b = s.create(300)
    expect(a.code).not.toBe(b.code)
    expect(s.get(a.code)).toBe(a)
    expect(s.size()).toBe(2)
  })

  it('collects rooms that have been empty long enough, and spares occupied ones', () => {
    const s = new InMemoryRoomStore()
    const empty = s.create(300)
    const busy = s.create(300)
    busy.add('a', 'anjali')
    expect(s.sweep(1000, (empty.lastEmptyAtMs ?? 0) + 5000)).toBe(1)
    expect(s.get(busy.code)).toBe(busy)
    expect(s.size()).toBe(1)
  })
})
