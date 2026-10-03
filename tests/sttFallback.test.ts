import { afterEach, describe, expect, it, vi } from 'vitest'
import { FallbackSttProvider } from '../src/main/services/stt/FallbackSttProvider'
import { ChunkedSttProvider, SttHttpError, cleanTranscript, isoLanguage, toWav } from '../src/main/services/stt/ChunkedSttProvider'
import { BaseSttProvider, type SttFallback } from '../src/main/services/stt/SttProvider'

class MockStt extends BaseSttProvider {
  received: Buffer[] = []
  stopped = false
  start() {}
  sendAudio(chunk: Buffer) {
    this.received.push(chunk)
  }
  async stop() {
    this.stopped = true
  }
}

function chain(n: number) {
  const made: MockStt[] = []
  const active: string[] = []
  const candidates = Array.from({ length: n }, (_, i) => ({
    id: `p${i}`,
    label: `P${i}`,
    create: () => {
      const p = new MockStt()
      made.push(p)
      return p
    }
  }))
  const stt = new FallbackSttProvider(candidates, { onActive: (id) => active.push(id) })
  const errors: [string, boolean][] = []
  const fallbacks: SttFallback[] = []
  const finals: string[] = []
  stt.on('error', (e, fatal) => errors.push([e.message, fatal]))
  stt.on('fallback', (f) => fallbacks.push(f))
  stt.on('final', (r) => finals.push(r.text))
  return { stt, made, active, errors, fallbacks, finals }
}

const result = (text: string) => ({ text, speechFinal: true, start: 0, end: 0 })

describe('FallbackSttProvider', () => {
  it('switches to the next provider on a fatal error', () => {
    const { stt, made, active, errors, fallbacks, finals } = chain(3)
    stt.start()
    made[0].emit('state', 'open')
    made[0].emit('error', new Error('Deepgram API key was rejected'), true)
    expect(made[0].stopped).toBe(true)
    expect(made).toHaveLength(2)
    expect(active).toEqual(['p0', 'p1'])
    expect(fallbacks).toEqual([{ from: 'P0', to: 'P1', reason: 'Deepgram API key was rejected' }])
    expect(errors).toEqual([])
    // Late results from the failed provider are dropped; the new one's are passed on.
    made[0].emit('final', result('old'))
    made[1].emit('final', result('new'))
    expect(finals).toEqual(['new'])
    stt.sendAudio(Buffer.from([1, 2]))
    expect(made[1].received.at(-1)).toEqual(Buffer.from([1, 2]))
  })

  it('moves on when a provider never connects, replaying the audio it missed', () => {
    const { stt, made, fallbacks } = chain(2)
    stt.start()
    stt.sendAudio(Buffer.from([7]))
    made[0].emit('state', 'reconnecting')
    expect(made).toHaveLength(1)
    made[0].emit('state', 'reconnecting')
    expect(made).toHaveLength(2)
    expect(fallbacks[0].reason).toContain("couldn't connect")
    expect(made[1].received).toEqual([Buffer.from([7])])
  })

  it('keeps retrying a provider that had connected', () => {
    const { stt, made } = chain(2)
    stt.start()
    made[0].emit('state', 'open')
    for (let i = 0; i < 5; i++) made[0].emit('state', 'reconnecting')
    expect(made).toHaveLength(1)
  })

  it('reports every failure when the last provider gives up', () => {
    const { stt, made, errors } = chain(2)
    stt.start()
    made[0].emit('error', new Error('bad key'), true)
    made[1].emit('error', new Error('no credits'), true)
    expect(errors).toEqual([['All speech-to-text providers failed — P0: bad key; P1: no credits', true]])
  })

  it('passes a single provider through unchanged', () => {
    const { stt, made, errors } = chain(1)
    stt.start()
    made[0].emit('error', new Error('bad key'), true)
    expect(errors).toEqual([['bad key', true]])
  })
})

/** Loud or silent PCM of the given length (16 kHz mono 16-bit). */
const pcm = (ms: number, loud: boolean) => {
  const b = Buffer.alloc(ms * 32)
  if (loud) for (let i = 0; i < b.length / 2; i++) b.writeInt16LE(i % 2 ? 8000 : -8000, i * 2)
  return b
}

class ScriptedHttp extends ChunkedSttProvider {
  protected readonly service = 'Test'
  calls: { model: string; bytes: number }[] = []
  constructor(
    private readonly reply: (model: string) => Promise<string>,
    models = ['m1', 'm2']
  ) {
    super({ models, language: 'en', silenceMs: 500 })
  }
  protected transcribe(wav: Buffer, model: string): Promise<string> {
    this.calls.push({ model, bytes: wav.length })
    return this.reply(model)
  }
}

function speak(p: ScriptedHttp, speechMs = 600) {
  for (let t = 0; t < speechMs; t += 100) p.sendAudio(pcm(100, true))
  for (let t = 0; t < 600; t += 100) p.sendAudio(pcm(100, false))
}

describe('ChunkedSttProvider', () => {
  afterEach(() => vi.useRealTimers())

  it('sends a phrase after a pause and emits it as final + utterance end', async () => {
    const p = new ScriptedHttp(async () => ' Tell me about yourself. ')
    const events: string[] = []
    p.on('final', (r) => events.push(`final:${r.text}`))
    p.on('utteranceEnd', () => events.push('end'))
    p.start()
    p.sendAudio(pcm(100, false))
    speak(p)
    await vi.waitFor(() => expect(events).toEqual(['final:Tell me about yourself.', 'end']))
    expect(p.calls).toHaveLength(1)
    expect(p.calls[0].model).toBe('m1')
  })

  it('ignores silence and short clicks', async () => {
    const p = new ScriptedHttp(async () => 'x')
    p.start()
    for (let i = 0; i < 20; i++) p.sendAudio(pcm(100, false))
    p.sendAudio(pcm(100, true))
    for (let i = 0; i < 10; i++) p.sendAudio(pcm(100, false))
    await p.stop()
    expect(p.calls).toHaveLength(0)
  })

  it('skips a model the service rejects and uses the next', async () => {
    const p = new ScriptedHttp(async (m) => {
      if (m === 'm1') throw new SttHttpError('HTTP 404: no such model', 404)
      return 'hello there'
    })
    const finals: string[] = []
    p.on('final', (r) => finals.push(r.text))
    p.start()
    speak(p)
    await vi.waitFor(() => expect(finals).toEqual(['hello there']))
    speak(p)
    await vi.waitFor(() => expect(finals).toHaveLength(2))
    expect(p.calls.map((c) => c.model)).toEqual(['m1', 'm2', 'm2'])
  })

  it('gives up for good on a rejected key', async () => {
    const p = new ScriptedHttp(async () => {
      throw new SttHttpError('HTTP 401: invalid key', 401)
    })
    const errors: [string, boolean][] = []
    p.on('error', (e, fatal) => errors.push([e.message, fatal]))
    p.start()
    speak(p)
    await vi.waitFor(() => expect(errors).toEqual([['Test API key was rejected', true]]))
  })

  it('gives up after repeated failures', async () => {
    const p = new ScriptedHttp(async () => {
      throw new SttHttpError('HTTP 503: down', 503)
    }, ['m1'])
    const errors: [string, boolean][] = []
    p.on('error', (e, fatal) => errors.push([e.message, fatal]))
    p.start()
    for (let i = 0; i < 3; i++) {
      speak(p)
      await vi.waitFor(() => expect(errors.length).toBe(i + 1))
    }
    expect(errors.map((e) => e[1])).toEqual([false, false, true])
  })

  it('flushes speech in progress on stop', async () => {
    const p = new ScriptedHttp(async () => 'last words')
    const finals: string[] = []
    p.on('final', (r) => finals.push(r.text))
    p.start()
    for (let t = 0; t < 600; t += 100) p.sendAudio(pcm(100, true))
    await p.stop()
    expect(finals).toEqual(['last words'])
  })
})

describe('chunked STT helpers', () => {
  it('drops Whisper noise phrases only on short segments', () => {
    expect(cleanTranscript(' Thank you. ', 800)).toBe('')
    expect(cleanTranscript('Thank you.', 3000)).toBe('Thank you.')
    expect(cleanTranscript('Thank you for joining', 800)).toBe('Thank you for joining')
  })

  it('maps language settings to ISO codes', () => {
    expect(isoLanguage('en')).toBe('en')
    expect(isoLanguage('en-US')).toBe('en')
    expect(isoLanguage('multi')).toBeUndefined()
  })

  it('writes a valid WAV header', () => {
    const wav = toWav(Buffer.alloc(320), 16000)
    expect(wav.length).toBe(364)
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF')
    expect(wav.readUInt32LE(24)).toBe(16000)
    expect(wav.readUInt32LE(40)).toBe(320)
  })
})
