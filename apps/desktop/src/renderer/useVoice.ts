import { useCallback, useEffect, useRef, useState } from 'react'
import { VoiceMesh, type ConnectionLike } from '@cocine/voice'
import { SpeakingDetector } from './speaking.js'
import { logger } from './log.js'

/**
 * The voice call, from the renderer's side.
 *
 * Push-to-talk is the default rather than an option, and the film ducks while
 * anyone is speaking. Both exist for the same reason: **Chromium's echo
 * canceller cannot hear the film.** It removes audio Chromium itself played,
 * and mpv plays through an entirely separate path, so on speakers every
 * microphone picks the film up and sends it back to the room. No WebRTC setting
 * fixes that. Headphones fix it; these two make it survivable without.
 */

export interface VoiceApi {
  inVoice: boolean
  /** Who is audibly talking right now, by member id, including you. Measured
   *  from the audio rather than announced, so it also answers "is the
   *  microphone reaching the application at all". */
  speaking: Record<string, boolean>
  muted: boolean
  deafened: boolean
  talking: boolean
  pushToTalk: boolean
  peers: Record<string, 'connecting' | 'connected' | 'failed'>
  error: string | null
  join: () => Promise<void>
  leave: () => void
  setMuted: (m: boolean) => void
  setDeafened: (d: boolean) => void
  setPushToTalk: (p: boolean) => void
}

/**
 * Voice fails silently and symmetrically: both ends see "nobody else is in
 * voice", neither sees an error, and nothing in the code reads wrong. Every
 * step of setup is written down so the next failure leaves evidence.
 */
const log = logger('voice')

const MIC: MediaStreamConstraints = {
  audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  video: false
}

export function useVoice (selfId: string, memberIds: string[], iceServers: RTCIceServer[] = []): VoiceApi {
  const [inVoice, setInVoice] = useState(false)
  const [muted, setMutedState] = useState(false)
  const [deafened, setDeafenedState] = useState(false)
  const [pushToTalk, setPushToTalk] = useState(true)
  const [talking, setTalking] = useState(false)
  const [peers, setPeers] = useState<Record<string, 'connecting' | 'connected' | 'failed'>>({})
  const [error, setError] = useState<string | null>(null)

  // Held in a ref so a re-issued credential reaches the next connection without
  // rebuilding the mesh and dropping the call in progress.
  const ice = useRef<RTCIceServer[]>(iceServers)
  ice.current = iceServers

  const [speaking, setSpeaking] = useState<Record<string, boolean>>({})
  const detector = useRef<SpeakingDetector | null>(null)
  const mesh = useRef<VoiceMesh | null>(null)
  const stream = useRef<MediaStream | null>(null)
  const audio = useRef<Map<string, HTMLAudioElement>>(new Map())

  /** The single place the microphone is actually on or off. */
  const applyMic = useCallback((): void => {
    const on = inVoice && !muted && (!pushToTalk || talking)
    for (const t of stream.current?.getAudioTracks() ?? []) t.enabled = on
    void window.cocine.duckFilm(on)
  }, [inVoice, muted, pushToTalk, talking])

  useEffect(applyMic, [applyMic])

  useEffect(() => {
    for (const el of audio.current.values()) el.muted = deafened
  }, [deafened])

  // Report to the room so everyone's indicators agree.
  useEffect(() => {
    if (inVoice) void window.cocine.setVoiceState({ inVoice, muted, deafened })
  }, [inVoice, muted, deafened])

  useEffect(() => window.cocine.onSignal((from, payload) => {
    const p = payload as { kind?: string } | undefined
    log.info('signal in', { from: from.slice(0, 8), kind: p?.kind ?? 'candidate', haveMesh: !!mesh.current })
    if (!mesh.current) {
      // Arriving before join() is not a bug in itself -- the other side may
      // have got there first -- but it is dropped, and that is worth knowing.
      log.warn('signal arrived before this client joined voice; dropped', { from: from.slice(0, 8) })
      return
    }
    void mesh.current.handleSignal(from, payload as never).catch(e => {
      log.error('handleSignal failed', { from: from.slice(0, 8), error: e })
      setError(String(e))
    })
  }), [])

  // The host asking someone to mute. Advisory: this client chooses to comply.
  useEffect(() => window.cocine.onModerated((by, action) => {
    setMutedState(action === 'mute')
    setError(action === 'mute' ? `${by} muted you` : null)
  }), [])

  useEffect(() => {
    // Logged even when there is no mesh: "the room says two people are in
    // voice but the mesh was never told" is a real failure and would otherwise
    // leave no trace at all.
    log.info('members changed', {
      self: selfId.slice(0, 8),
      members: memberIds.map(id => id.slice(0, 8)),
      haveMesh: !!mesh.current
    })
    if (!mesh.current) return
    void mesh.current.setMembers(memberIds).catch(e => {
      log.error('setMembers failed', e)
      setError(String(e))
    })
    // Somebody who left keeps neither an analyser nor a lit dot. Without this
    // the indicator freezes on whatever they were doing when they dropped.
    const here = new Set([...memberIds, selfId])
    for (const el of audio.current.keys()) if (!here.has(el)) detector.current?.unwatch(el)
    setSpeaking(prev => {
      const next: Record<string, boolean> = {}
      for (const id of Object.keys(prev)) if (here.has(id)) next[id] = prev[id]!
      return next
    })
  }, [memberIds.join(','), selfId])

  const join = useCallback(async () => {
    setError(null)
    log.info('join requested', { self: selfId.slice(0, 8), members: memberIds.map(i => i.slice(0, 8)), iceServers: ice.current.length })
    try {
      const s = await navigator.mediaDevices.getUserMedia(MIC)
      stream.current = s
      for (const t of s.getAudioTracks()) t.enabled = false
      mesh.current = new VoiceMesh({
        selfId,
        send: (to, payload) => {
          const p = payload as { kind?: string; sdp?: string } | undefined
          log.info('signal out', { to: to.slice(0, 8), kind: p?.kind ?? 'candidate', sdpBytes: p?.sdp?.length })
          void window.cocine.sendSignal(to, payload)
        },
        // These come from the server at welcome and may include a TURN relay.
          // With an empty list a call only ever works between peers on the same
          // network, which is the one case this app is not for.
          createConnection: () => new RTCPeerConnection({ iceServers: ice.current }) as unknown as ConnectionLike,
        onRemoteStream: (id, remote) => {
          let el = audio.current.get(id)
          if (!el) {
            el = new Audio()
            el.autoplay = true
            // Attached to the document on purpose. A detached <audio> with a
            // MediaStream in srcObject is not reliably played by Chromium --
            // it can sit there silently with no error at all, which is
            // indistinguishable from a call that never connected. Hidden, so it
            // changes nothing on screen.
            el.style.display = 'none'
            document.body.appendChild(el)
            audio.current.set(id, el)
          }
          el.srcObject = remote as MediaStream
          detector.current?.watch(id, remote as MediaStream)
          log.info('remote stream', {
            peer: id.slice(0, 8),
            tracks: (remote as MediaStream).getAudioTracks().map(t => ({ enabled: t.enabled, muted: t.muted }))
          })
          el.muted = deafened
          // And if it still will not play, say so rather than being quietly
          // silent: "we both joined and heard nothing" needs a reason.
          void el.play().catch((e: unknown) => {
            setError(`Could not play audio from the room: ${e instanceof Error ? e.message : String(e)}`)
          })
        },
        onPeerStateChange: (id, state) => {
          log.info('peer state', { peer: id.slice(0, 8), state })
          return setPeers(p => ({
          ...p,
          [id]: state === 'connected' ? 'connected' : state === 'failed' || state === 'closed' ? 'failed' : 'connecting'
          }))
        }
      })
      // Your own voice, from the same stream that is being sent. A muted or
      // un-held push-to-talk track emits silence, so the dot correctly reflects
      // what the room can actually hear rather than what the microphone picks
      // up.
      detector.current ??= new SpeakingDetector(setSpeaking)
      detector.current.watch(selfId, s)
      mesh.current.setLocalStream(s, s.getAudioTracks())
      log.info('microphone open', {
        tracks: s.getAudioTracks().map(t => ({ label: t.label, enabled: t.enabled, muted: t.muted }))
      })
      await mesh.current.setMembers(memberIds)
      log.info('mesh members set', { peers: mesh.current.connectedIds.map(i => i.slice(0, 8)) })
      setInVoice(true)
    } catch (e) {
      // The name matters: NotAllowedError is the system refusing, which is a
      // different problem from a device that is missing or in use elsewhere.
      log.error('join failed', { name: (e as Error)?.name, error: e })
      setError(e instanceof Error ? `Could not use the microphone: ${e.message}` : String(e))
    }
  }, [selfId, memberIds.join(','), deafened])

  const leave = useCallback((): void => {
    mesh.current?.close()
    mesh.current = null
    for (const t of stream.current?.getTracks() ?? []) t.stop()
    stream.current = null
    for (const el of audio.current.values()) { el.pause(); el.srcObject = null; el.remove() }
    audio.current.clear()
    detector.current?.close()
    detector.current = null
    setSpeaking({})
    setPeers({})
    setInVoice(false)
    setTalking(false)
    void window.cocine.duckFilm(false)
    void window.cocine.setVoiceState({ inVoice: false, muted: false, deafened: false })
  }, [])

  // Push to talk. Held, not toggled, and ignored while typing.
  useEffect(() => {
    if (!inVoice || !pushToTalk) { setTalking(false); return }
    const typing = (e: KeyboardEvent): boolean => {
      const el = e.target as HTMLElement | null
      return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')
    }
    // `code`, not `key`: with Caps Lock on, or Shift held, `key` is "V" and the
    // microphone silently never opened while the interface went on saying
    // "Hold V to talk". `code` is the physical key, whatever modifiers are on.
    const isTalkKey = (e: KeyboardEvent): boolean => e.code === 'KeyV' || e.key.toLowerCase() === 'v'
    const down = (e: KeyboardEvent): void => { if (isTalkKey(e) && !typing(e)) setTalking(true) }
    const up = (e: KeyboardEvent): void => { if (isTalkKey(e)) setTalking(false) }
    const blur = (): void => setTalking(false)
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', blur)
    }
  }, [inVoice, pushToTalk])

  return {
    inVoice,
    speaking, muted, deafened, talking, pushToTalk, peers, error,
    join, leave,
    setMuted: setMutedState,
    setDeafened: setDeafenedState,
    setPushToTalk
  }
}
