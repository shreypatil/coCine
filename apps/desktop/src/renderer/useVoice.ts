import { useCallback, useEffect, useRef, useState } from 'react'
import { VoiceMesh, type ConnectionLike } from '@cocine/voice'

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
    void mesh.current?.handleSignal(from, payload as never).catch(e => setError(String(e)))
  }), [])

  // The host asking someone to mute. Advisory: this client chooses to comply.
  useEffect(() => window.cocine.onModerated((by, action) => {
    setMutedState(action === 'mute')
    setError(action === 'mute' ? `${by} muted you` : null)
  }), [])

  useEffect(() => {
    if (!mesh.current) return
    void mesh.current.setMembers(memberIds).catch(e => setError(String(e)))
  }, [memberIds.join(',')])

  const join = useCallback(async () => {
    setError(null)
    try {
      const s = await navigator.mediaDevices.getUserMedia(MIC)
      stream.current = s
      for (const t of s.getAudioTracks()) t.enabled = false
      mesh.current = new VoiceMesh({
        selfId,
        send: (to, payload) => void window.cocine.sendSignal(to, payload),
        // These come from the server at welcome and may include a TURN relay.
          // With an empty list a call only ever works between peers on the same
          // network, which is the one case this app is not for.
          createConnection: () => new RTCPeerConnection({ iceServers: ice.current }) as unknown as ConnectionLike,
        onRemoteStream: (id, remote) => {
          let el = audio.current.get(id)
          if (!el) {
            el = new Audio()
            el.autoplay = true
            audio.current.set(id, el)
          }
          el.srcObject = remote as MediaStream
          el.muted = deafened
          void el.play().catch(() => { /* blocked until interaction; harmless */ })
        },
        onPeerStateChange: (id, state) => setPeers(p => ({
          ...p,
          [id]: state === 'connected' ? 'connected' : state === 'failed' || state === 'closed' ? 'failed' : 'connecting'
        }))
      })
      mesh.current.setLocalStream(s, s.getAudioTracks())
      await mesh.current.setMembers(memberIds)
      setInVoice(true)
    } catch (e) {
      setError(e instanceof Error ? `Could not use the microphone: ${e.message}` : String(e))
    }
  }, [selfId, memberIds.join(','), deafened])

  const leave = useCallback((): void => {
    mesh.current?.close()
    mesh.current = null
    for (const t of stream.current?.getTracks() ?? []) t.stop()
    stream.current = null
    for (const el of audio.current.values()) { el.pause(); el.srcObject = null }
    audio.current.clear()
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
    const down = (e: KeyboardEvent): void => { if (e.key === 'v' && !typing(e)) setTalking(true) }
    const up = (e: KeyboardEvent): void => { if (e.key === 'v') setTalking(false) }
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
    inVoice, muted, deafened, talking, pushToTalk, peers, error,
    join, leave,
    setMuted: setMutedState,
    setDeafened: setDeafenedState,
    setPushToTalk
  }
}
