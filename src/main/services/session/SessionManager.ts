import { EventEmitter } from 'node:events'
import type {
  AudioChunk,
  AudioLevel,
  AudioSource,
  CaptureMicPayload,
  CaptureStartPayload,
  CaptureStatus,
  LatencySample,
  SessionStartResult,
  SessionState,
  TranscriptUpdate
} from '@shared/ipc'
import type { Settings } from '@shared/settings'
import { createLogger } from '../../logger'
import type { SttProvider } from '../stt/SttProvider'
import { TranscriptAssembler } from '../stt/TranscriptAssembler'

const log = createLogger('session')

/** Loopback RMS above this counts as "audio present". */
const SILENCE_RMS = 0.005
const NO_AUDIO_HINT_MS = 20_000
const TICK_MS = 1000

export interface SessionDeps {
  getSettings: () => Settings
  getSttApiKey: () => string | null
  createStt: (source: AudioSource, apiKey: string, settings: Settings) => SttProvider
  startCapture: (payload: CaptureStartPayload) => void
  stopCapture: () => void
  /** Start/stop only the mic while a session runs (voice questions). */
  setMic: (payload: CaptureMicPayload) => void
  now?: () => number
}

export interface SessionEvents {
  state: [SessionState]
  transcript: [TranscriptUpdate]
  /** An utterance closed (FR-Q1 hook for Phase 2). */
  utteranceEnd: [TranscriptUpdate]
  latency: [LatencySample]
}

interface Lane {
  stt: SttProvider
  assembler: TranscriptAssembler
}

/** Orchestrates a listening session: capture -> STT -> transcripts. */
export class SessionManager extends EventEmitter {
  private state: SessionState = { status: 'idle', elapsed: 0, cost: 0 }
  private lanes = new Map<AudioSource, Lane>()
  private startedAt = 0
  private lastLoopbackAudioAt = 0
  private ticker: NodeJS.Timeout | null = null
  private stopping = false
  /** Mic lane opened only for voice questions (not the "Me" transcript setting); closed with them. */
  private micForVoiceOnly = false
  private readonly now: () => number

  constructor(private readonly deps: SessionDeps) {
    super()
    this.now = deps.now ?? Date.now
  }

  override emit<E extends keyof SessionEvents>(event: E, ...args: SessionEvents[E]): boolean {
    return super.emit(event, ...args)
  }
  override on<E extends keyof SessionEvents>(event: E, listener: (...args: SessionEvents[E]) => void): this {
    return super.on(event, listener as (...a: unknown[]) => void)
  }

  getState(): SessionState {
    return this.state
  }

  isActive(): boolean {
    return this.state.status !== 'idle' && this.state.status !== 'error'
  }

  start(): SessionStartResult {
    if (this.stopping) return { ok: false, error: 'Previous session is still stopping — try again.' }
    if (this.isActive()) return { ok: true }
    const apiKey = this.deps.getSttApiKey()
    if (!apiKey) {
      return { ok: false, error: 'Add your Deepgram API key in Settings to start a session.', navigate: 'settings' }
    }
    const settings = this.deps.getSettings()
    const sources: AudioSource[] = settings.audio.micEnabled ? ['loopback', 'mic'] : ['loopback']

    this.startedAt = this.now()
    this.lastLoopbackAudioAt = this.startedAt
    this.micForVoiceOnly = false
    this.setState({ status: 'starting', elapsed: 0, cost: 0, message: undefined, hint: undefined, voiceAsk: false })

    for (const source of sources) this.openLane(source, apiKey, settings)

    this.deps.startCapture({ mic: settings.audio.micEnabled, micDeviceId: settings.audio.micDeviceId })
    this.ticker = setInterval(() => this.tick(), TICK_MS)
    log.info(`session started (sources: ${sources.join(', ')})`)
    return { ok: true }
  }

  /**
   * Voice questions on/off. Needs an active session; opens a mic lane if the "Me" transcript
   * setting hasn't already, and closes it again when turned off.
   */
  setVoiceAsk(on: boolean): SessionStartResult {
    if (!this.isActive()) return { ok: false, error: 'Start a session first.' }
    if (on === Boolean(this.state.voiceAsk)) return { ok: true }
    const settings = this.deps.getSettings()
    if (on && !this.lanes.has('mic')) {
      const apiKey = this.deps.getSttApiKey()
      if (!apiKey) return { ok: false, error: 'Add your Deepgram API key in Settings.', navigate: 'settings' }
      this.openLane('mic', apiKey, settings)
      this.deps.setMic({ on: true, deviceId: settings.audio.micDeviceId })
      this.micForVoiceOnly = true
    } else if (!on && this.micForVoiceOnly) {
      this.closeMicLane()
    }
    this.setState({ ...this.state, voiceAsk: on, message: undefined })
    log.info(`voice questions ${on ? 'on' : 'off'}`)
    return { ok: true }
  }

  async stop(reason?: { error: string }): Promise<void> {
    if (this.state.status === 'idle' || this.stopping) return
    this.stopping = true
    this.deps.stopCapture()
    if (this.ticker) clearInterval(this.ticker)
    this.ticker = null
    // Lanes stay registered while closing so results flushed by the provider still land.
    const lanes = [...this.lanes.entries()]
    await Promise.all(
      lanes.map(async ([source, lane]) => {
        await lane.stt.stop()
        const last = lane.assembler.onUtteranceEnd()
        if (last) this.emitTranscript(source, last, true)
        if (this.lanes.get(source) === lane) this.lanes.delete(source)
      })
    )
    this.stopping = false
    this.setState({
      status: reason ? 'error' : 'idle',
      elapsed: this.elapsed(),
      cost: this.state.cost,
      message: reason?.error,
      hint: undefined,
      voiceAsk: false
    })
    this.micForVoiceOnly = false
    log.info(`session stopped${reason ? `: ${reason.error}` : ''}`)
  }

  handleAudioChunk(chunk: AudioChunk): void {
    const lane = this.lanes.get(chunk.source)
    if (!lane) return
    const buf = chunk.pcm instanceof ArrayBuffer ? Buffer.from(chunk.pcm) : Buffer.from(chunk.pcm.buffer, chunk.pcm.byteOffset, chunk.pcm.byteLength)
    lane.stt.sendAudio(buf)
  }

  handleAudioLevel(level: AudioLevel): void {
    if (level.source === 'loopback' && level.rms > SILENCE_RMS) {
      this.lastLoopbackAudioAt = this.now()
      if (this.state.hint) this.setState({ ...this.state, hint: undefined })
    }
  }

  handleCaptureStatus(status: CaptureStatus): void {
    if (!this.isActive()) return
    if (status.state === 'error') {
      const what = status.source === 'loopback' ? 'System audio capture' : 'Microphone capture'
      const message = `${what} failed: ${status.message ?? 'unknown error'}`
      if (status.source === 'loopback') {
        void this.stop({ error: message })
      } else {
        // Mic is optional; keep the session alive without it.
        const lane = this.lanes.get('mic')
        this.lanes.delete('mic')
        void lane?.stt.stop()
        this.micForVoiceOnly = false
        this.setState({ ...this.state, message, voiceAsk: false })
      }
    }
  }

  private openLane(source: AudioSource, apiKey: string, settings: Settings): void {
    const stt = this.deps.createStt(source, apiKey, settings)
    const lane: Lane = { stt, assembler: new TranscriptAssembler(source, this.now) }
    this.wireLane(source, lane)
    this.lanes.set(source, lane)
    stt.start()
  }

  private closeMicLane(): void {
    const lane = this.lanes.get('mic')
    this.lanes.delete('mic')
    this.deps.setMic({ on: false, deviceId: null })
    this.micForVoiceOnly = false
    if (!lane) return
    // Flush what was said before the toggle went off.
    void lane.stt.stop().then(() => {
      const last = lane.assembler.onUtteranceEnd()
      if (last) this.emitTranscript('mic', last, true)
    })
  }

  private wireLane(source: AudioSource, lane: Lane): void {
    const { stt, assembler } = lane
    const current = () => this.lanes.get(source) === lane
    stt.on('partial', (r) => {
      if (!current()) return
      const u = assembler.onPartial(r.text)
      if (u) this.emitTranscript(source, u, false)
    })
    stt.on('final', (r) => {
      if (!current()) return
      const u = assembler.onFinal(r.text)
      if (u) this.emitTranscript(source, u, false)
    })
    stt.on('utteranceEnd', () => {
      if (!current()) return
      const u = assembler.onUtteranceEnd()
      if (u) this.emitTranscript(source, u, true)
    })
    stt.on('latency', (ms) => {
      if (current()) this.emit('latency', { stage: 'stt', source, ms, ts: this.now() })
    })
    stt.on('state', (s) => {
      if (!current() || source !== 'loopback') return
      if (s === 'open') this.setState({ ...this.state, status: 'listening', message: undefined })
      else if (s === 'reconnecting') this.setState({ ...this.state, status: 'reconnecting', message: 'Reconnecting to speech service…' })
    })
    stt.on('error', (err, fatal) => {
      if (!current()) return
      log.warn(`[${source}] stt error (fatal=${fatal}): ${err.message}`)
      if (fatal) void this.stop({ error: err.message })
    })
  }

  private emitTranscript(_source: AudioSource, update: TranscriptUpdate, ended: boolean): void {
    this.emit('transcript', update)
    if (ended) this.emit('utteranceEnd', update)
  }

  private tick(): void {
    const silentFor = this.now() - this.lastLoopbackAudioAt
    const hint =
      this.state.status === 'listening' && silentFor >= NO_AUDIO_HINT_MS
        ? 'No system audio detected — check your output device.'
        : undefined
    this.setState({ ...this.state, elapsed: this.elapsed(), hint })
  }

  private elapsed(): number {
    return this.startedAt ? this.now() - this.startedAt : 0
  }

  private setState(next: SessionState): void {
    this.state = next
    this.emit('state', next)
  }
}
