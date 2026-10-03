import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AudioSource, SessionState, TranscriptUpdate } from '@shared/ipc'
import { DEFAULT_SETTINGS, mergeSettings, type Settings } from '@shared/settings'
import { SessionManager } from '../src/main/services/session/SessionManager'
import { BaseSttProvider } from '../src/main/services/stt/SttProvider'

/** Scripted STT provider: tests drive its events directly. */
class MockStt extends BaseSttProvider {
  started = false
  stopped = false
  received: Buffer[] = []
  start() {
    this.started = true
    this.emit('state', 'open')
  }
  sendAudio(chunk: Buffer) {
    this.received.push(chunk)
  }
  async stop() {
    this.stopped = true
  }
}

function setup(opts: { apiKey?: string | null; settings?: Settings; onAudioSent?: (source: AudioSource, seconds: number) => void; getCost?: () => number; checkAccess?: (sources: AudioSource[]) => string | null } = {}) {
  const providers = new Map<AudioSource, MockStt>()
  const captureStart = vi.fn()
  const captureStop = vi.fn()
  const setMic = vi.fn()
  const mgr = new SessionManager({
    getSettings: () => opts.settings ?? DEFAULT_SETTINGS,
    getSttApiKey: () => (opts.apiKey === undefined ? 'key' : opts.apiKey),
    createStt: (source) => {
      const p = new MockStt()
      providers.set(source, p)
      return p
    },
    startCapture: captureStart,
    stopCapture: captureStop,
    setMic,
    onAudioSent: opts.onAudioSent,
    getCost: opts.getCost,
    checkAccess: opts.checkAccess,
    now: () => Date.now()
  })
  const states: SessionState[] = []
  const transcripts: TranscriptUpdate[] = []
  const ended: TranscriptUpdate[] = []
  mgr.on('state', (s) => states.push(s))
  mgr.on('transcript', (u) => transcripts.push(u))
  mgr.on('utteranceEnd', (u) => ended.push(u))
  return { mgr, providers, captureStart, captureStop, setMic, states, transcripts, ended }
}

describe('SessionManager', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('blocks start without an STT key and points to Settings', () => {
    const { mgr, captureStart } = setup({ apiKey: null })
    expect(mgr.start()).toEqual({ ok: false, error: expect.stringContaining('Deepgram'), navigate: 'settings' })
    expect(captureStart).not.toHaveBeenCalled()
    expect(mgr.getState().status).toBe('idle')
  })

  it('blocks start when the OS refuses capture access (macOS privacy)', () => {
    const checkAccess = vi.fn(() => 'macOS is blocking Cue')
    const { mgr, captureStart, providers } = setup({ checkAccess })
    expect(mgr.start()).toEqual({ ok: false, error: 'macOS is blocking Cue' })
    expect(checkAccess).toHaveBeenCalledWith(['loopback'])
    expect(captureStart).not.toHaveBeenCalled()
    expect(providers.size).toBe(0)
    expect(mgr.isActive()).toBe(false)
  })

  it('starts loopback only by default and reaches listening', () => {
    const { mgr, providers, captureStart } = setup()
    expect(mgr.start()).toEqual({ ok: true })
    expect([...providers.keys()]).toEqual(['loopback'])
    expect(providers.get('loopback')!.started).toBe(true)
    expect(captureStart).toHaveBeenCalledWith({ loopback: true, mic: false, micDeviceId: null })
    expect(mgr.getState().status).toBe('listening')
  })

  it('starts a mic lane when enabled', () => {
    const settings = mergeSettings(DEFAULT_SETTINGS, { audio: { micEnabled: true, micDeviceId: 'abc' } })
    const { mgr, providers, captureStart } = setup({ settings })
    mgr.start()
    expect([...providers.keys()].sort()).toEqual(['loopback', 'mic'])
    expect(captureStart).toHaveBeenCalledWith({ loopback: true, mic: true, micDeviceId: 'abc' })
  })

  it('routes audio chunks to the matching provider', () => {
    const { mgr, providers } = setup()
    mgr.start()
    mgr.handleAudioChunk({ source: 'loopback', pcm: new Uint8Array([1, 2, 3, 4]).buffer, ts: 0 })
    mgr.handleAudioChunk({ source: 'mic', pcm: new Uint8Array([9]), ts: 0 }) // no mic lane: dropped
    const got = providers.get('loopback')!.received
    expect(got).toHaveLength(1)
    expect([...got[0]]).toEqual([1, 2, 3, 4])
  })

  it('meters seconds of audio streamed per lane and reports the running cost', () => {
    const sent: [AudioSource, number][] = []
    const { mgr } = setup({ onAudioSent: (source, seconds) => sent.push([source, seconds]), getCost: () => 0.12 })
    mgr.start()
    mgr.handleAudioChunk({ source: 'loopback', pcm: new ArrayBuffer(3200), ts: 0 })
    mgr.handleAudioChunk({ source: 'mic', pcm: new ArrayBuffer(3200), ts: 0 })
    expect(sent).toEqual([['loopback', 0.1]])
    expect(mgr.getState().cost).toBe(0.12)
  })

  it('turns provider events into transcript updates and utterance ends', () => {
    const { mgr, providers, transcripts, ended } = setup()
    mgr.start()
    const stt = providers.get('loopback')!
    stt.emit('partial', { text: 'how would', speechFinal: false, start: 0, end: 1 })
    stt.emit('final', { text: 'How would you design', speechFinal: false, start: 0, end: 1.5 })
    stt.emit('final', { text: 'a rate limiter?', speechFinal: true, start: 1.5, end: 2.5 })
    stt.emit('utteranceEnd')
    expect(transcripts.map((t) => t.text)).toEqual([
      'how would',
      'How would you design',
      'How would you design a rate limiter?',
      'How would you design a rate limiter?'
    ])
    expect(new Set(transcripts.map((t) => t.id)).size).toBe(1)
    expect(ended).toHaveLength(1)
    expect(ended[0]).toMatchObject({ isFinal: true, source: 'loopback', text: 'How would you design a rate limiter?' })
  })

  it('reflects reconnecting state and recovers', () => {
    const { mgr, providers } = setup()
    mgr.start()
    providers.get('loopback')!.emit('state', 'reconnecting')
    expect(mgr.getState().status).toBe('reconnecting')
    providers.get('loopback')!.emit('state', 'open')
    expect(mgr.getState().status).toBe('listening')
  })

  it('stops with an error on a fatal STT error', async () => {
    const { mgr, providers, captureStop } = setup()
    mgr.start()
    providers.get('loopback')!.emit('error', new Error('Deepgram API key was rejected'), true)
    await vi.runAllTimersAsync()
    expect(captureStop).toHaveBeenCalled()
    expect(providers.get('loopback')!.stopped).toBe(true)
    expect(mgr.getState()).toMatchObject({ status: 'error', message: 'Deepgram API key was rejected' })
  })

  it('flushes an open utterance on stop', async () => {
    const { mgr, providers, ended } = setup()
    mgr.start()
    providers.get('loopback')!.emit('final', { text: 'Walk me through', speechFinal: false, start: 0, end: 1 })
    await mgr.stop()
    expect(ended.map((u) => u.text)).toEqual(['Walk me through'])
    expect(mgr.getState().status).toBe('idle')
  })

  it('tracks elapsed time and hints when loopback is silent for 20 s', () => {
    const { mgr } = setup()
    mgr.start()
    vi.advanceTimersByTime(19_000)
    expect(mgr.getState().hint).toBeUndefined()
    expect(mgr.getState().elapsed).toBeGreaterThanOrEqual(19_000)
    vi.advanceTimersByTime(2_000)
    expect(mgr.getState().hint).toMatch(/No system audio/)
    mgr.handleAudioLevel({ source: 'loopback', rms: 0.2 })
    expect(mgr.getState().hint).toBeUndefined()
  })

  it('keeps the session alive when only the mic fails', () => {
    const settings = mergeSettings(DEFAULT_SETTINGS, { audio: { micEnabled: true } })
    const { mgr, providers } = setup({ settings })
    mgr.start()
    mgr.handleCaptureStatus({ source: 'mic', state: 'error', message: 'NotAllowedError' })
    expect(providers.get('mic')!.stopped).toBe(true)
    expect(mgr.getState().status).toBe('listening')
    expect(mgr.getState().message).toMatch(/Microphone capture failed/)
  })

  it('stops the session when loopback capture fails', async () => {
    const { mgr } = setup()
    mgr.start()
    mgr.handleCaptureStatus({ source: 'loopback', state: 'error', message: 'Permission denied' })
    await vi.runAllTimersAsync()
    expect(mgr.getState()).toMatchObject({ status: 'error', message: expect.stringContaining('System audio capture failed') })
  })

  describe('voice questions', () => {
    it('needs an active session', () => {
      const { mgr } = setup()
      expect(mgr.setVoiceAsk(true)).toEqual({ ok: false, error: 'Start a session first.' })
    })

    it('opens a mic lane on demand and closes it when turned off', async () => {
      const { mgr, providers, setMic, ended } = setup()
      mgr.start()
      expect(mgr.setVoiceAsk(true)).toEqual({ ok: true })
      expect(mgr.getState().voiceAsk).toBe(true)
      expect(setMic).toHaveBeenLastCalledWith({ on: true, deviceId: null })
      const mic = providers.get('mic')!
      expect(mic.started).toBe(true)

      // Speech still being transcribed when the toggle goes off is flushed, not lost.
      mic.emit('final', { text: 'what is a closure', speechFinal: false, start: 0, end: 1 })
      mgr.setVoiceAsk(false)
      await vi.advanceTimersByTimeAsync(0)
      expect(setMic).toHaveBeenLastCalledWith({ on: false, deviceId: null })
      expect(mic.stopped).toBe(true)
      expect(ended.at(-1)).toMatchObject({ source: 'mic', text: 'what is a closure' })
      expect(mgr.getState().voiceAsk).toBe(false)
    })

    it('reuses the "Me" mic lane when the mic setting is on, and leaves it running', () => {
      const settings = mergeSettings(DEFAULT_SETTINGS, { audio: { micEnabled: true } })
      const { mgr, providers, setMic } = setup({ settings })
      mgr.start()
      const mic = providers.get('mic')!
      mgr.setVoiceAsk(true)
      mgr.setVoiceAsk(false)
      expect(setMic).not.toHaveBeenCalled()
      expect(providers.get('mic')).toBe(mic)
      expect(mic.stopped).toBe(false)
    })

    it('turns off when the session stops or the mic fails', async () => {
      const { mgr } = setup()
      mgr.start()
      mgr.setVoiceAsk(true)
      mgr.handleCaptureStatus({ source: 'mic', state: 'error', message: 'Permission denied' })
      expect(mgr.getState()).toMatchObject({ voiceAsk: false, message: expect.stringContaining('Microphone capture failed') })
      mgr.setVoiceAsk(true)
      await mgr.stop()
      expect(mgr.getState().voiceAsk).toBe(false)
    })
  })

  it('practice: a mic-only session reaches listening on the mic lane, with no system-audio hint', () => {
    const providers = new Map<AudioSource, MockStt>()
    const captureStart = vi.fn()
    const mgr = new SessionManager({
      getSettings: () => DEFAULT_SETTINGS,
      getSttApiKey: () => 'key',
      sources: () => ['mic'],
      createStt: (source) => {
        const p = new MockStt()
        providers.set(source, p)
        return p
      },
      startCapture: captureStart,
      stopCapture: vi.fn(),
      setMic: vi.fn()
    })
    expect(mgr.start()).toEqual({ ok: true })
    expect([...providers.keys()]).toEqual(['mic'])
    expect(captureStart).toHaveBeenCalledWith({ loopback: false, mic: true, micDeviceId: null })
    expect(mgr.getState().status).toBe('listening')
    // A mic capture failure ends a mic-only session.
    mgr.handleCaptureStatus({ source: 'mic', state: 'error', message: 'device lost' })
    return vi.waitFor(() => expect(mgr.getState()).toMatchObject({ status: 'error', message: 'Microphone capture failed: device lost' }))
  })

  it('tells the user once the speech service has dropped 3 times in a row', () => {
    const { mgr, providers } = setup()
    const notices: string[] = []
    mgr.on('notice', (m) => notices.push(m))
    mgr.start()
    const stt = providers.get('loopback')!
    stt.emit('state', 'reconnecting')
    stt.emit('state', 'reconnecting')
    expect(notices).toEqual([])
    stt.emit('state', 'reconnecting')
    stt.emit('state', 'reconnecting')
    expect(notices).toEqual([expect.stringContaining('keeps disconnecting')])
    stt.emit('state', 'open')
    expect(notices[1]).toBe('Speech-to-text reconnected.')
    expect(mgr.getState().status).toBe('listening')
  })

  it('names the selected STT provider when its key is missing', () => {
    const settings = mergeSettings(DEFAULT_SETTINGS, { stt: { provider: 'assemblyai' } })
    const { mgr } = setup({ apiKey: null, settings })
    expect(mgr.start()).toMatchObject({ ok: false, error: expect.stringContaining('AssemblyAI') })
  })
})
