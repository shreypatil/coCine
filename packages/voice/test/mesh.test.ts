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

describe('what leaves the page', () => {
  it('sends an ICE candidate as plain data, not as the platform object', async () => {
    // The bug this exists for. RTCIceCandidate keeps its fields as prototype
    // getters, and Electron IPC -- structured clone -- silently copies it as
    // `{}`. Offers and answers are strings and crossed intact, so every kind of
    // signal was visibly sent and received on both sides while the connections
    // sat at `new` for ever, with no error anywhere, on every platform.
    class PlatformCandidate {
      constructor (private readonly fields: Record<string, unknown>) {}
      get candidate (): unknown { return this.fields.candidate }
      get sdpMid (): unknown { return this.fields.sdpMid }
      get sdpMLineIndex (): unknown { return this.fields.sdpMLineIndex }
      toJSON (): Record<string, unknown> { return { ...this.fields } }
    }
    const fields = { candidate: 'candidate:1 1 udp 2122 10.0.0.2 5000 typ host', sdpMid: '0', sdpMLineIndex: 0 }
    const { m, sent, conns } = mesh('aaa')
    await m.setMembers(['aaa', 'bbb'])
    conns[0]!.onicecandidate!({ candidate: new PlatformCandidate(fields) })

    const out = sent.find(s => s.payload.kind === 'candidate')!.payload.candidate as Record<string, unknown>
    // Own, enumerable properties -- what structured clone actually copies.
    expect({ ...out }).toEqual(fields)
    expect(structuredClone(out)).toEqual(fields)
  })

  it('leaves a candidate that is already plain data alone', async () => {
    const { m, sent, conns } = mesh('aaa')
    await m.setMembers(['aaa', 'bbb'])
    conns[0]!.onicecandidate!({ candidate: { candidate: 'x', sdpMid: '0' } })
    expect(sent.find(s => s.payload.kind === 'candidate')!.payload.candidate).toEqual({ candidate: 'x', sdpMid: '0' })
  })
})

describe('swapping the microphone under a live call', () => {
  const withSenders = (): Fake & { replaced: Array<{ from: unknown; to: unknown }> } => {
    const f = fakeConnection() as Fake & { replaced: Array<{ from: unknown; to: unknown }> }
    f.replaced = []
    f.getSenders = () => f.added.map(a => ({
      track: (a as { t: unknown }).t,
      replaceTrack: async (t: unknown) => { f.replaced.push({ from: (a as { t: unknown }).t, to: t }); (a as { t: unknown }).t = t }
    }))
    return f
  }

  it('replaces the track on every peer without renegotiating', async () => {
    // Renegotiation is what drops a call; replaceTrack keeps the sender and
    // swaps what flows through it. Used when a microphone opened silent.
    const conns: ReturnType<typeof withSenders>[] = []
    const m = new VoiceMesh({
      selfId: 'aaa', send: () => {}, onRemoteStream: () => {},
      createConnection: () => { const c = withSenders(); conns.push(c); return c }
    })
    m.setLocalStream('stream1', ['old'])
    await m.setMembers(['aaa', 'bbb', 'ccc'])
    await m.replaceLocalTrack('old', 'new', 'stream2')
    for (const c of conns) {
      expect(c.replaced).toEqual([{ from: 'old', to: 'new' }])
      expect(c.added).toHaveLength(1)
    }
    // And whoever joins next is given the new track, not the old one.
    await m.setMembers(['aaa', 'bbb', 'ccc', 'ddd'])
    expect(conns[2]!.added).toEqual([{ t: 'new', s: 'stream2' }])
  })

  it('adds the track to a peer that never had a sender for the old one', async () => {
    const conns: ReturnType<typeof withSenders>[] = []
    const m = new VoiceMesh({
      selfId: 'aaa', send: () => {}, onRemoteStream: () => {},
      createConnection: () => { const c = withSenders(); conns.push(c); return c }
    })
    await m.setMembers(['aaa', 'bbb'])       // opened before any microphone
    await m.replaceLocalTrack('old', 'new', 'stream')
    expect(conns[0]!.replaced).toEqual([])
    expect(conns[0]!.added).toEqual([{ t: 'new', s: 'stream' }])
  })
})

describe('never calling itself', () => {
  it('ignores a signal that claims to come from its own id', async () => {
    // Seen in a real log: after a rejoin the client's new member id reached a
    // mesh still holding the old one, it offered to its own new id, and the
    // server delivered that offer straight back. An offer from yourself must
    // never become a connection.
    const { m, sent, conns } = mesh('aaa')
    await m.handleSignal('aaa', { kind: 'offer', sdp: 'OFFER' })
    await m.handleSignal('aaa', { kind: 'candidate', candidate: { c: 1 } })
    expect(conns).toHaveLength(0)
    expect(sent).toEqual([])
    expect(m.connectedIds).toEqual([])
  })
})

describe('a fresh offer from someone already connected', () => {
  it('starts a new connection rather than renegotiating the old one', async () => {
    // The other side rebuilt its end -- after a failure, or a rejoin -- and
    // offered again. The old connection is dead weight; the answer must come
    // from a new one.
    const { m, sent, conns } = mesh('zzz')
    await m.handleSignal('aaa', { kind: 'offer', sdp: 'OFFER' })
    await m.handleSignal('aaa', { kind: 'offer', sdp: 'OFFER' })
    expect(conns).toHaveLength(2)
    expect(conns[0]!.closed).toBe(true)
    expect(conns[1]!.remote).toBe('offer')
    expect(sent.filter(s => s.payload.kind === 'answer')).toHaveLength(2)
    expect(m.connectedIds).toEqual(['aaa'])
  })

  it('keeps the connection when the second offer arrives before any description', async () => {
    // Candidates first, then the first offer: that is one connection, not two.
    const { m, conns } = mesh('zzz')
    await m.handleSignal('aaa', { kind: 'candidate', candidate: { c: 1 } })
    await m.handleSignal('aaa', { kind: 'offer', sdp: 'OFFER' })
    expect(conns).toHaveLength(1)
    expect(conns[0]!.closed).toBe(false)
  })
})

describe('a connection that fails', () => {
  /** A mesh whose retry timers are run by hand. */
  function withTimers (selfId: string, delays = [10, 20]): ReturnType<typeof mesh> & {
    timers: Array<{ fn: () => void; ms: number; cleared: boolean }>
    fire: () => Promise<void>
    states: Array<[string, string]>
  } {
    const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = []
    const sent: Array<{ to: string; payload: SignalPayload }> = []
    const conns: Fake[] = []
    const streams: Array<{ id: string; stream: unknown }> = []
    const states: Array<[string, string]> = []
    const m = new VoiceMesh({
      selfId,
      send: (to, payload) => sent.push({ to, payload }),
      createConnection: () => { const c = fakeConnection(); conns.push(c); return c },
      onRemoteStream: (id, stream) => streams.push({ id, stream }),
      onPeerStateChange: (id, st) => states.push([id, st]),
      retryDelaysMs: delays,
      setTimeout: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t },
      clearTimeout: h => { (h as { cleared: boolean }).cleared = true }
    })
    const fire = async (): Promise<void> => {
      const t = timers.find(x => !x.cleared && !(x as { ran?: boolean }).ran)
      if (!t) throw new Error('no timer pending')
      ;(t as { ran?: boolean }).ran = true
      t.fn()
      await new Promise(r => setTimeout(r, 0))
    }
    return { m, sent, conns, streams, timers, fire, states }
  }

  const fail = (c: Fake): void => { c.connectionState = 'failed'; c.onconnectionstatechange?.() }
  const connect = (c: Fake): void => { c.connectionState = 'connected'; c.onconnectionstatechange?.() }

  it('is replaced by a new connection and a new offer from the side that offers', async () => {
    const { m, sent, conns, timers, fire, states } = withTimers('aaa')
    await m.setMembers(['aaa', 'bbb'])
    expect(sent.filter(s => s.payload.kind === 'offer')).toHaveLength(1)

    fail(conns[0]!)
    expect(timers).toHaveLength(1)
    expect(timers[0]!.ms).toBe(10)
    await fire()

    expect(conns).toHaveLength(2)
    expect(conns[0]!.closed).toBe(true)
    expect(sent.filter(s => s.payload.kind === 'offer' && s.to === 'bbb')).toHaveLength(2)
    expect(m.connectedIds).toEqual(['bbb'])
    // The interface hears it is being tried again, not that it is still failed.
    expect(states.at(-1)).toEqual(['bbb', 'connecting'])
  })

  it('is left to the other side to restart when this side does not offer', async () => {
    // Both sides restarting at once would collide exactly as two first offers do.
    const { m, conns, timers } = withTimers('zzz')
    await m.handleSignal('aaa', { kind: 'offer', sdp: 'OFFER' })
    fail(conns[0]!)
    expect(timers).toHaveLength(0)
    expect(m.connectedIds).toEqual(['aaa'])
  })

  it('backs off between attempts and gives up when they run out', async () => {
    const { m, conns, timers, fire } = withTimers('aaa', [10, 20])
    await m.setMembers(['aaa', 'bbb'])
    fail(conns[0]!)
    await fire()
    fail(conns[1]!)
    expect(timers[1]!.ms).toBe(20)
    await fire()
    fail(conns[2]!)
    expect(timers).toHaveLength(2)
    expect(conns).toHaveLength(3)
  })

  it('starts the back-off again once a retry connects', async () => {
    const { m, conns, timers, fire } = withTimers('aaa', [10, 20])
    await m.setMembers(['aaa', 'bbb'])
    fail(conns[0]!)
    await fire()
    connect(conns[1]!)
    fail(conns[1]!)
    expect(timers[1]!.ms).toBe(10)
  })

  it('stops retrying someone who has left', async () => {
    const { m, conns, timers } = withTimers('aaa')
    await m.setMembers(['aaa', 'bbb'])
    fail(conns[0]!)
    await m.setMembers(['aaa'])
    expect(timers[0]!.cleared).toBe(true)
    expect(m.connectedIds).toEqual([])
  })

  it('stops retrying when the call is closed', async () => {
    const { m, conns, timers } = withTimers('aaa')
    await m.setMembers(['aaa', 'bbb'])
    fail(conns[0]!)
    m.close()
    expect(timers[0]!.cleared).toBe(true)
  })

  it('does not schedule a second retry while one is pending', async () => {
    const { m, conns, timers } = withTimers('aaa')
    await m.setMembers(['aaa', 'bbb'])
    fail(conns[0]!)
    fail(conns[0]!)
    expect(timers).toHaveLength(1)
  })
})
