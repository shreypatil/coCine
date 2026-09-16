import { useCallback, useEffect, useRef, useState } from 'react'
import { VoiceMesh, type ConnectionLike } from '@cocine/voice'
import { SpeakingDetector } from './speaking.js'
import { logger } from './log.js'
import { EMPTY, applyMixer, loadDucking, micState, prune, saveDucking, type Levels } from './mixer.js'
import {
  MicWatch, REACQUIRE_ATTEMPTS, REACQUIRE_DELAY_MS, audioDevices, loadDevice, micConstraints, saveDevice,
  silentMicMessage, type AudioDevices, type MicHealth
} from './mic.js'

/**
 * The voice call, from the renderer's side.
 *
 * Push-to-talk is the default rather than an option, and the film ducks while
 * your microphone is live. Both exist for the same reason: **Chromium's echo
 * canceller cannot hear the film.** It removes audio Chromium itself played,
 * and mpv plays through an entirely separate path, so on speakers every
 * microphone picks the film up and sends it back to the room. No WebRTC setting
 * fixes that. Headphones fix it; these two make it survivable without -- and
 * somebody wearing them can turn the ducking off, since for them it only takes
 * the film away.
 *
 * Each person in the call also has a volume of their own here, and can be
 * muted for this listener alone. See mixer.ts for why that is local and per
 * session.
 *
 * The microphone is watched after it opens, because opening is not the same
 * as delivering: Bluetooth earbuds left in music-only mode hand over a device
 * that exists and is silent. A silent microphone is asked for again, a few
 * times, and the new track is swapped into the live call; see mic.ts. The
 * same swap is how a different microphone is chosen mid-call.
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
  /** Whether the film quietens while this microphone is live. Per machine. */
  ducking: boolean
  /** How loud each person is for me, 0-100, and whom I have muted for myself. */
  mixer: Levels
  join: () => Promise<void>
  leave: () => void
  setMuted: (m: boolean) => void
  setDeafened: (d: boolean) => void
  setPushToTalk: (p: boolean) => void
  setDucking: (d: boolean) => void
  setLevel: (memberId: string, level: number) => void
  setMutedForMe: (memberId: string, muted: boolean) => void
  /** Whether the microphone is delivering sound, once it has been opened. */
  micHealth: MicHealth | null
  /** What to tell the person about their microphone, when something is off. */
  micNote: string | null
  /** Microphones and speakers on offer. Labels appear once the mic has been used. */
  devices: AudioDevices
  /** Chosen device ids; null means the system default. Remembered per machine. */
  inputId: string | null
  outputId: string | null
  setInput: (id: string | null) => void
  setOutput: (id: string | null) => void
}

/**
 * Voice fails silently and symmetrically: both ends see "nobody else is in
 * voice", neither sees an error, and nothing in the code reads wrong. Every
 * step of setup is written down so the next failure leaves evidence.
 */
const log = logger('voice')

export function useVoice (selfId: string, memberIds: string[], iceServers: RTCIceServer[] = []): VoiceApi {
  const [inVoice, setInVoice] = useState(false)
  const [muted, setMutedState] = useState(false)
  const [deafened, setDeafenedState] = useState(false)
  const [pushToTalk, setPushToTalk] = useState(true)
  const [talking, setTalking] = useState(false)
  const [peers, setPeers] = useState<Record<string, 'connecting' | 'connected' | 'failed'>>({})
  const [error, setError] = useState<string | null>(null)
  const [ducking, setDuckingState] = useState(() => loadDucking(typeof localStorage === 'undefined' ? null : localStorage))
  const [mixer, setMixer] = useState<Levels>(EMPTY)
  const storage = typeof localStorage === 'undefined' ? null : localStorage
  const [micHealth, setMicHealth] = useState<MicHealth | null>(null)
  const [micNote, setMicNote] = useState<string | null>(null)
  const [devices, setDevices] = useState<AudioDevices>({ inputs: [], outputs: [] })
  const [inputId, setInputId] = useState<string | null>(() => loadDevice(storage, 'input'))
  const [outputId, setOutputId] = useState<string | null>(() => loadDevice(storage, 'output'))
  const inputRef = useRef(inputId)
  const outputRef = useRef(outputId)
  inputRef.current = inputId
  outputRef.current = outputId

  // Held in a ref so a re-issued credential reaches the next connection without
  // rebuilding the mesh and dropping the call in progress.
  const ice = useRef<RTCIceServer[]>(iceServers)
  ice.current = iceServers

  const [speaking, setSpeaking] = useState<Record<string, boolean>>({})
  const detector = useRef<SpeakingDetector | null>(null)
  const mesh = useRef<VoiceMesh | null>(null)
  const stream = useRef<MediaStream | null>(null)
  const audio = useRef<Map<string, HTMLAudioElement>>(new Map())
  const micWatch = useRef<MicWatch | null>(null)
  /** Silent-microphone retries so far; reset the moment sound arrives. */
  const retries = useRef(0)
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** The latest "microphone should be live" answer, for a track opened mid-call. */
  const micOn = useRef(false)

  /** The single place the microphone is actually on or off. */
  const applyMic = useCallback((): void => {
    const { mic, duck } = micState({ inVoice, muted, pushToTalk, talking, ducking })
    micOn.current = mic
    for (const t of stream.current?.getAudioTracks() ?? []) t.enabled = mic
    void window.cocine.duckFilm(duck)
  }, [inVoice, muted, pushToTalk, talking, ducking])

  useEffect(applyMic, [applyMic])

  // The mixer, written onto every element whenever anything it depends on
  // changes. Held in refs as well so an element created mid-call by the mesh
  // (whose callbacks were bound at join) starts at the right level.
  const mixerRef = useRef<Levels>(mixer)
  const deafenedRef = useRef(deafened)
  mixerRef.current = mixer
  deafenedRef.current = deafened
  useEffect(() => {
    applyMixer(audio.current, mixer, deafened)
  }, [mixer, deafened])

  const setDucking = useCallback((d: boolean): void => {
    setDuckingState(d)
    saveDucking(typeof localStorage === 'undefined' ? null : localStorage, d)
    log.info('ducking', { on: d })
  }, [])
  const setLevel = useCallback((memberId: string, level: number): void => {
    setMixer(m => ({ ...m, level: { ...m.level, [memberId]: Math.min(100, Math.max(0, Math.round(level))) } }))
  }, [])
  const setMutedForMe = useCallback((memberId: string, on: boolean): void => {
    log.info('muted for me', { peer: memberId.slice(0, 8), on })
    setMixer(m => ({ ...m, muted: { ...m.muted, [memberId]: on } }))
  }, [])

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
    setMixer(m => prune(m, here))
    setSpeaking(prev => {
      const next: Record<string, boolean> = {}
      for (const id of Object.keys(prev)) if (here.has(id)) next[id] = prev[id]!
      return next
    })
  }, [memberIds.join(','), selfId])

  // ------------------------------------------------------------- devices

  const refreshDevices = useCallback(async (): Promise<void> => {
    try {
      const all = await navigator.mediaDevices.enumerateDevices()
      setDevices(audioDevices(all))
    } catch (e) { log.warn('could not list audio devices', e) }
  }, [])

  useEffect(() => {
    void refreshDevices()
    const md = navigator.mediaDevices as MediaDevices | undefined
    md?.addEventListener?.('devicechange', refreshDevices)
    return () => md?.removeEventListener?.('devicechange', refreshDevices)
  }, [refreshDevices])

  /** Route one element's playback to the chosen speaker. Default when null. */
  const routeOutput = useCallback((el: HTMLMediaElement, id: string | null): void => {
    const sink = el as HTMLMediaElement & { setSinkId?: (id: string) => Promise<void> }
    if (!sink.setSinkId) return
    sink.setSinkId(id ?? '').catch((e: unknown) => {
      log.warn('could not route audio to the chosen speaker', { id, error: e })
      setMicNote('The chosen speaker is unavailable; using the default.')
      saveDevice(storage, 'output', null)
      setOutputId(null)
    })
  }, [storage])

  useEffect(() => {
    for (const el of audio.current.values()) routeOutput(el, outputId)
  }, [outputId, routeOutput])

  const setOutput = useCallback((id: string | null): void => {
    log.info('speaker chosen', { id: id?.slice(0, 8) ?? 'default' })
    saveDevice(storage, 'output', id)
    setOutputId(id)
  }, [storage])

  // --------------------------------------------------------- the microphone

  /**
   * Open the microphone -- the chosen one, or the default -- and hand the
   * stream back. A chosen device that has gone is reported and replaced by the
   * default rather than failing the whole call over a setting.
   */
  const acquire = useCallback(async (): Promise<MediaStream> => {
    const wanted = inputRef.current
    try {
      return await navigator.mediaDevices.getUserMedia(micConstraints(wanted))
    } catch (e) {
      const name = (e as Error)?.name
      if (wanted && (name === 'OverconstrainedError' || name === 'NotFoundError' || name === 'NotReadableError')) {
        log.warn('chosen microphone unavailable; falling back to the default', { id: wanted.slice(0, 8), name })
        setMicNote('The chosen microphone is unavailable; using the default.')
        saveDevice(storage, 'input', null)
        setInputId(null)
        inputRef.current = null
        return await navigator.mediaDevices.getUserMedia(micConstraints(null))
      }
      throw e
    }
  }, [storage])

  /**
   * Make a stream the one this client sends: watched for speech, watched for
   * silence, and at whatever the microphone should currently be.
   */
  const adopt = useCallback((s: MediaStream, selfIdNow: string): void => {
    stream.current = s
    for (const t of s.getAudioTracks()) t.enabled = micOn.current
    detector.current?.watch(selfIdNow, s)
    const track = s.getAudioTracks()[0]
    if (track) micWatch.current?.watch(track)
    log.info('microphone open', {
      tracks: s.getAudioTracks().map(t => ({ label: t.label, enabled: t.enabled, muted: t.muted }))
    })
  }, [])

  /**
   * Ask for the microphone again and swap it into the live call.
   *
   * This is the remedy people find by accident -- opening a second application
   * that uses the microphone makes the first start working -- done on purpose:
   * a fresh request gives the system another go at switching the earbuds. It
   * is also how a different device is chosen without leaving voice.
   */
  const reacquire = useCallback(async (why: string): Promise<void> => {
    if (!mesh.current) return
    const old = stream.current
    const oldTrack = old?.getAudioTracks()[0]
    log.info('reacquiring the microphone', { why, attempt: retries.current, device: inputRef.current?.slice(0, 8) ?? 'default' })
    try {
      const s = await acquire()
      const track = s.getAudioTracks()[0]
      if (track) await mesh.current.replaceLocalTrack(oldTrack, track, s)
      oldTrack?.stop()
      adopt(s, selfId)
    } catch (e) {
      log.error('reacquiring the microphone failed', { name: (e as Error)?.name, error: e })
      setMicNote(`Could not reopen the microphone: ${e instanceof Error ? e.message : String(e)}`)
    }
  }, [acquire, adopt, selfId])

  // What happens as the microphone's health changes. Held in a ref so the
  // MicWatch created at join always calls the current version.
  const onMicHealth = useRef<(h: MicHealth) => void>(() => {})
  onMicHealth.current = (h: MicHealth): void => {
    setMicHealth(h)
    const label = stream.current?.getAudioTracks()[0]?.label
    if (h === 'live') {
      if (retries.current > 0) log.info('microphone delivering after retry', { retries: retries.current })
      retries.current = 0
      if (retryTimer.current) { clearTimeout(retryTimer.current); retryTimer.current = null }
      setMicNote(null)
      return
    }
    if (h === 'ended') {
      log.warn('microphone ended', { label })
      setMicNote('The microphone was disconnected — asking for another…')
      retries.current = 0
      void reacquire('ended')
      return
    }
    // Silent. The track opened, or went quiet, and no frames are arriving.
    if (retries.current < REACQUIRE_ATTEMPTS) {
      retries.current += 1
      log.warn('microphone silent; will ask again', { label, attempt: retries.current, of: REACQUIRE_ATTEMPTS })
      setMicNote(silentMicMessage(label, false))
      retryTimer.current = setTimeout(() => { retryTimer.current = null; void reacquire('silent') }, REACQUIRE_DELAY_MS)
    } else {
      log.error('microphone silent after retries; giving up', { label, retries: retries.current })
      setMicNote(silentMicMessage(label, true))
    }
  }

  const setInput = useCallback((id: string | null): void => {
    log.info('microphone chosen', { id: id?.slice(0, 8) ?? 'default' })
    saveDevice(storage, 'input', id)
    setInputId(id)
    inputRef.current = id
    setMicNote(null)
    retries.current = 0
    if (mesh.current) void reacquire('chosen')
  }, [storage, reacquire])

  const join = useCallback(async () => {
    setError(null)
    setMicNote(null)
    log.info('join requested', { self: selfId.slice(0, 8), members: memberIds.map(i => i.slice(0, 8)), iceServers: ice.current.length })
    try {
      // macOS gates the microphone per application. Asked from main first, the
      // prompt is ours and a refusal is an answer rather than a Chromium error.
      const access = await window.cocine.micAccess?.().catch(() => 'not-applicable' as const) ?? 'not-applicable'
      if (access === 'denied') {
        log.error('join failed', { name: 'SystemDenied' })
        setError('macOS has blocked coCine\'s microphone. Allow it under System Settings → Privacy & Security → Microphone, then start coCine again.')
        return
      }
      const s = await acquire()
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
            routeOutput(el, outputRef.current)
          }
          el.srcObject = remote as MediaStream
          detector.current?.watch(id, remote as MediaStream)
          log.info('remote stream', {
            peer: id.slice(0, 8),
            tracks: (remote as MediaStream).getAudioTracks().map(t => ({ enabled: t.enabled, muted: t.muted }))
          })
          // At whatever this listener already set for them, not full: a stream
          // re-established mid-call should not come back at full volume.
          applyMixer([[id, el]], mixerRef.current, deafenedRef.current)
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
      micWatch.current ??= new MicWatch(h => onMicHealth.current(h))
      retries.current = 0
      mesh.current.setLocalStream(s, s.getAudioTracks())
      adopt(s, selfId)
      // Labels are only revealed once the microphone has been used.
      void refreshDevices()
      await mesh.current.setMembers(memberIds)
      log.info('mesh members set', { peers: mesh.current.connectedIds.map(i => i.slice(0, 8)) })
      setInVoice(true)
    } catch (e) {
      // The name matters: NotAllowedError is the system refusing, which is a
      // different problem from a device that is missing or in use elsewhere.
      const name = (e as Error)?.name
      log.error('join failed', { name, error: e })
      setError(name === 'NotAllowedError'
        ? 'The system did not allow coCine to use the microphone. Check the microphone permission for coCine in your system settings.'
        : name === 'NotFoundError'
          ? 'No microphone was found. Plug one in, or connect your headset, and try again.'
          : e instanceof Error ? `Could not use the microphone: ${e.message}` : String(e))
    }
  }, [selfId, memberIds.join(','), acquire, adopt, refreshDevices, routeOutput])

  const leave = useCallback((): void => {
    mesh.current?.close()
    mesh.current = null
    micWatch.current?.unwatch()
    if (retryTimer.current) { clearTimeout(retryTimer.current); retryTimer.current = null }
    retries.current = 0
    setMicHealth(null)
    setMicNote(null)
    for (const t of stream.current?.getTracks() ?? []) t.stop()
    stream.current = null
    for (const el of audio.current.values()) { el.pause(); el.srcObject = null; el.remove() }
    audio.current.clear()
    detector.current?.close()
    detector.current = null
    setSpeaking({})
    setPeers({})
    setMixer(EMPTY)
    setInVoice(false)
    setTalking(false)
    void window.cocine.duckFilm(false)
    void window.cocine.setVoiceState({ inVoice: false, muted: false, deafened: false })
  }, [])

  // Push to talk. Held, not toggled, and ignored while typing.
  useEffect(() => {
    if (!inVoice || !pushToTalk) { setTalking(false); return }
    // Text fields only. A checkbox or a slider is an <input> too and keeps
    // focus after a click, and "I ticked a box and then V stopped working" is
    // not a rule anybody would guess.
    const typing = (e: KeyboardEvent): boolean => {
      const el = e.target as HTMLElement | null
      if (!el) return false
      if (el.tagName === 'TEXTAREA') return true
      if (el.tagName !== 'INPUT') return false
      return !['checkbox', 'radio', 'range', 'button', 'submit'].includes((el as HTMLInputElement).type)
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
    ducking, mixer,
    join, leave,
    setMuted: setMutedState,
    setDeafened: setDeafenedState,
    setPushToTalk,
    setDucking, setLevel, setMutedForMe,
    micHealth, micNote, devices, inputId, outputId, setInput, setOutput
  }
}
