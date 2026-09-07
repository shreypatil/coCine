import { describe, it, expect, vi } from 'vitest'
import { VoiceMesh, type ConnectionLike, type SignalPayload } from '../src/mesh.js'

interface Fake extends ConnectionLike { closed: boolean; added: unknown[]; candidates: unknown[]; remote: string | null }

function fakeConnection (): Fake {
  const f: Fake = {
    closed: false, added: [], candidates: [], remote: null,
    connectionState: 'new',
    onicecandidate: null, ontrack: null, onconnectionstatechange: null,
    createOffer: async () => ({ type: 'offer', sdp: 'OFFER' }),
    createAnswer: async () => ({ type: 'answer', sdp: 'ANSWER' }),
    setLocalDescription: async () => {},
    setRemoteDescription: async d => { f.remote = d.type },
    addIceCandidate: async c => { f.candidates.push(c) },
    addTrack: (t, s) => { f.added.push({ t, s }) },
    close: () => { f.closed = true }
  }
  return f
}

function mesh (selfId: string): {
  m: VoiceMesh
  sent: Array<{ to: string; payload: SignalPayload }>
  conns: Fake[]
  streams: Array<{ id: string; stream: unknown }>
} {
  const sent: Array<{ to: string; payload: SignalPayload }> = []
  const conns: Fake[] = []
  const streams: Array<{ id: string; stream: unknown }> = []
  const m = new VoiceMesh({
    selfId,
    send: (to, payload) => sent.push({ to, payload }),
    createConnection: () => { const c = fakeConnection(); conns.push(c); return c },
    onRemoteStream: (id, stream) => streams.push({ id, stream })
  })
  return { m, sent, conns, streams }
}

describe('deciding who offers', () => {
  it('has exactly one side of each pair start the negotiation', async () => {
    // Both offering at once collapses the negotiation. Comparing ids is
    // arbitrary but consistent, and needs no agreement between the two.
    const a = mesh('aaa')
    const b = mesh('bbb')
    await a.m.setMembers(['aaa', 'bbb'])
    await b.m.setMembers(['aaa', 'bbb'])
    expect(a.sent.filter(s => s.payload.kind === 'offer')).toHaveLength(1)
    expect(b.sent.filter(s => s.payload.kind === 'offer')).toHaveLength(0)
  })

  it('opens one connection per other person, and none to itself', async () => {
    const { m, conns } = mesh('aaa')
    await m.setMembers(['aaa', 'bbb', 'ccc', 'ddd'])
    expect(conns).toHaveLength(3)
    expect(m.connectedIds.sort()).toEqual(['bbb', 'ccc', 'ddd'])
  })
})

describe('negotiation', () => {
  it('answers an offer', async () => {
    const { m, sent, conns } = mesh('zzz')
    await m.handleSignal('aaa', { kind: 'offer', sdp: 'OFFER' })
    expect(conns[0]!.remote).toBe('offer')
    expect(sent).toContainEqual({ to: 'aaa', payload: { kind: 'answer', sdp: 'ANSWER' } })
  })

  it('accepts an offer from someone it had not noticed joining yet', async () => {
    // The signal can beat the room state that says they are here.
    const { m, conns } = mesh('zzz')
    await m.handleSignal('newcomer', { kind: 'offer', sdp: 'OFFER' })
    expect(conns).toHaveLength(1)
    expect(m.connectedIds).toEqual(['newcomer'])
  })

  it('holds candidates that arrive before the description they belong to', async () => {
    // Adding a candidate with no remote description set is an error, and ICE
    // routinely arrives first.
    const { m, conns } = mesh('zzz')
    await m.handleSignal('aaa', { kind: 'candidate', candidate: { c: 1 } })
    await m.handleSignal('aaa', { kind: 'candidate', candidate: { c: 2 } })
    expect(conns[0]!.candidates).toHaveLength(0)

    await m.handleSignal('aaa', { kind: 'offer', sdp: 'OFFER' })
    expect(conns[0]!.candidates).toEqual([{ c: 1 }, { c: 2 }])
  })

  it('adds candidates directly once the description is in place', async () => {
    const { m, conns } = mesh('zzz')
    await m.handleSignal('aaa', { kind: 'offer', sdp: 'OFFER' })
    await m.handleSignal('aaa', { kind: 'candidate', candidate: { c: 9 } })
    expect(conns[0]!.candidates).toEqual([{ c: 9 }])
  })

  it('completes the offering side when the answer comes back', async () => {
    const { m, conns } = mesh('aaa')
    await m.setMembers(['aaa', 'bbb'])
    await m.handleSignal('bbb', { kind: 'answer', sdp: 'ANSWER' })
    expect(conns[0]!.remote).toBe('answer')
  })

  it('forwards its own candidates to the right person only', async () => {
    const { m, sent, conns } = mesh('aaa')
    await m.setMembers(['aaa', 'bbb', 'ccc'])
    conns[0]!.onicecandidate?.({ candidate: { mine: true } })
    const candidates = sent.filter(s => s.payload.kind === 'candidate')
    expect(candidates).toHaveLength(1)
    expect(['bbb', 'ccc']).toContain(candidates[0]!.to)
  })
})

describe('audio', () => {
  it('attaches local tracks to connections opened later', async () => {
    const { m, conns } = mesh('aaa')
    m.setLocalStream({ s: 1 }, [{ track: 'mic' }])
    await m.setMembers(['aaa', 'bbb'])
    expect(conns[0]!.added).toHaveLength(1)
  })

  it('attaches local tracks to connections that already exist', async () => {
    const { m, conns } = mesh('aaa')
    await m.setMembers(['aaa', 'bbb'])
    expect(conns[0]!.added).toHaveLength(0)
    m.setLocalStream({ s: 1 }, [{ track: 'mic' }])
    expect(conns[0]!.added).toHaveLength(1)
  })

  it('surfaces a remote stream against the person it came from', async () => {
    const { m, conns, streams } = mesh('zzz')
    await m.handleSignal('aaa', { kind: 'offer', sdp: 'OFFER' })
    conns[0]!.ontrack?.({ streams: [{ remote: true }] })
    expect(streams).toEqual([{ id: 'aaa', stream: { remote: true } }])
  })
})

describe('people coming and going', () => {
  it('closes the connection to someone who leaves', async () => {
    const { m, conns } = mesh('aaa')
    await m.setMembers(['aaa', 'bbb', 'ccc'])
    await m.setMembers(['aaa', 'ccc'])
    expect(conns[0]!.closed).toBe(true)
    expect(m.connectedIds).toEqual(['ccc'])
  })

  it('does not reopen a connection it already has', async () => {
    const { m, conns } = mesh('aaa')
    await m.setMembers(['aaa', 'bbb'])
    await m.setMembers(['aaa', 'bbb'])
    await m.setMembers(['aaa', 'bbb'])
    expect(conns).toHaveLength(1)
  })

  it('closes everything and detaches handlers on shutdown', async () => {
    const { m, conns } = mesh('aaa')
    await m.setMembers(['aaa', 'bbb', 'ccc'])
    m.close()
    expect(conns.every(c => c.closed)).toBe(true)
    expect(conns.every(c => c.onicecandidate === null)).toBe(true)
    expect(m.connectedIds).toEqual([])
  })

  it('reports connection state changes against the person', async () => {
    const seen: Array<[string, string]> = []
    const m = new VoiceMesh({
      selfId: 'aaa',
      send: () => {},
      createConnection: () => { const c = fakeConnection(); c.connectionState = 'connected'; return c },
      onRemoteStream: () => {},
      onPeerStateChange: (id, st) => seen.push([id, st])
    })
    await m.setMembers(['aaa', 'bbb'])
    expect(seen).toEqual([])
  })
})
