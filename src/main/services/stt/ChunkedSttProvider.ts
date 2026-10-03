import { createLogger } from '../../logger'
import { BaseSttProvider } from './SttProvider'

const log = createLogger('stt-http')

/** Normalized RMS above this counts as speech. */
const SPEECH_RMS = 0.01
/** Audio kept from before speech starts, so the first syllable isn't clipped. */
const PREROLL_MS = 300
/** Shorter bursts (clicks, coughs) are dropped. */
const MIN_SPEECH_MS = 250
/** A long monologue is sent in pieces of at most this length. */
const MAX_SEGMENT_MS = 12_000
const REQUEST_TIMEOUT_MS = 20_000
/** Consecutive failed requests before the provider gives up (and a fallback takes over). */
const MAX_FAILURES = 3
/** Segments waiting beyond this are dropped: transcripts that late are no use live. */
const MAX_QUEUE = 4
const STOP_WAIT_MS = 5000

/** Whisper's usual output for noise; dropped when the segment was short. */
const HALLUCINATIONS = new Set(['thank you', 'thanks for watching', 'thank you for watching', 'you', 'bye', 'so', 'okay'])

export class SttHttpError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message)
  }
}

export interface ChunkedSttOptions {
  /** Models tried in order; one the service rejects is skipped for the rest of the session. */
  models: string[]
  language: string
  /** Silence that ends a phrase and sends it. */
  silenceMs: number
  sampleRate?: number
  /** Label used in logs only. */
  label?: string
}

interface Segment {
  pcm: Buffer
  speechMs: number
  endsUtterance: boolean
  endedAt: number
}

/**
 * Speech-to-text over a plain HTTPS transcription API. Audio is cut into phrases at pauses
 * (energy-based), each phrase is sent as a WAV file and comes back as one final segment.
 * Slower than streaming, but needs no WebSocket and works with any Whisper-style endpoint.
 */
export abstract class ChunkedSttProvider extends BaseSttProvider {
  /** Shown in errors, e.g. "OpenRouter". */
  protected abstract readonly service: string
  /** Transcribe one WAV file; throws `SttHttpError` for HTTP failures. */
  protected abstract transcribe(wav: Buffer, model: string, signal: AbortSignal): Promise<string>

  private readonly bytesPerMs: number
  private stopped = true
  private preroll: Buffer[] = []
  private prerollBytes = 0
  private segment: Buffer[] = []
  private segmentBytes = 0
  private inSpeech = false
  private speechMs = 0
  private silentMs = 0
  private queue: Segment[] = []
  private draining: Promise<void> | null = null
  private failures = 0
  private badModels = new Set<string>()
  private abort = new AbortController()

  constructor(protected readonly opts: ChunkedSttOptions) {
    super()
    this.bytesPerMs = ((opts.sampleRate ?? 16000) * 2) / 1000
  }

  protected get tag(): string {
    return `${this.service.toLowerCase()}:${this.opts.label ?? 'stt'}`
  }

  start(): void {
    this.stopped = false
    this.abort = new AbortController()
    this.emit('state', 'connecting')
    // Nothing to connect to; a bad key shows up on the first phrase.
    this.emit('state', 'open')
  }

  sendAudio(chunk: Buffer): void {
    if (this.stopped) return
    const ms = chunk.length / this.bytesPerMs
    const loud = rms(chunk) > SPEECH_RMS
    if (!this.inSpeech) {
      if (!loud) {
        this.pushPreroll(chunk)
        return
      }
      this.inSpeech = true
      this.segment = this.preroll
      this.segmentBytes = this.prerollBytes
      this.preroll = []
      this.prerollBytes = 0
      this.speechMs = 0
      this.silentMs = 0
    }
    this.segment.push(chunk)
    this.segmentBytes += chunk.length
    if (loud) {
      this.speechMs += ms
      this.silentMs = 0
    } else {
      this.silentMs += ms
    }
    if (this.silentMs >= this.opts.silenceMs) this.cut(true)
    else if (this.segmentBytes / this.bytesPerMs >= MAX_SEGMENT_MS) this.cut(false)
  }

  async stop(): Promise<void> {
    if (this.stopped) return
    if (this.inSpeech) this.cut(true)
    this.stopped = true
    const draining = this.draining
    if (draining) {
      const timer = setTimeout(() => this.abort.abort(), STOP_WAIT_MS)
      await draining
      clearTimeout(timer)
    }
    this.queue = []
    this.emit('state', 'closed')
  }

  private pushPreroll(chunk: Buffer): void {
    this.preroll.push(chunk)
    this.prerollBytes += chunk.length
    while (this.preroll.length > 1 && this.prerollBytes - this.preroll[0].length >= PREROLL_MS * this.bytesPerMs) {
      this.prerollBytes -= this.preroll.shift()!.length
    }
  }

  /** Close the current phrase; `endsUtterance` when the speaker paused (not a length cut). */
  private cut(endsUtterance: boolean): void {
    const pcm = Buffer.concat(this.segment)
    const speechMs = this.speechMs
    this.segment = []
    this.segmentBytes = 0
    this.speechMs = 0
    this.silentMs = 0
    // A length cut keeps listening to the same utterance.
    this.inSpeech = !endsUtterance
    if (speechMs < MIN_SPEECH_MS && endsUtterance) return
    if (this.queue.length >= MAX_QUEUE) {
      log.warn(`[${this.tag}] falling behind; dropped a phrase`)
      this.queue.shift()
    }
    this.queue.push({ pcm, speechMs, endsUtterance, endedAt: Date.now() })
    if (!this.draining) this.draining = this.drain().finally(() => (this.draining = null))
  }

  /** Phrases are sent one at a time so transcripts arrive in order. */
  private async drain(): Promise<void> {
    while (this.queue.length > 0) {
      const seg = this.queue.shift()!
      const text = await this.transcribeSegment(seg)
      if (text === null) {
        if (this.stopped && this.abort.signal.aborted) return
        continue
      }
      this.emit('latency', Date.now() - seg.endedAt)
      if (text) this.emit('final', { text, speechFinal: seg.endsUtterance, start: 0, end: 0 })
      if (seg.endsUtterance) this.emit('utteranceEnd')
    }
  }

  /** The phrase's text, or null when every model failed. */
  private async transcribeSegment(seg: Segment): Promise<string | null> {
    const wav = toWav(seg.pcm, this.opts.sampleRate ?? 16000)
    const models = this.opts.models.filter((m) => !this.badModels.has(m))
    let last: unknown = null
    for (const model of models) {
      try {
        const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
        const text = cleanTranscript(await this.transcribe(wav, model, signal), seg.speechMs)
        this.failures = 0
        return text
      } catch (err) {
        last = err
        if (this.abort.signal.aborted) return null
        const status = err instanceof SttHttpError ? err.status : 0
        log.warn(`[${this.tag}] ${model} failed: ${err instanceof Error ? err.message : String(err)}`)
        if (status === 401 || status === 403) return this.giveUp(`${this.service} API key was rejected`)
        if (status === 402) return this.giveUp(`${this.service} account is out of credits`)
        // The model doesn't exist or doesn't take this audio: skip it from now on.
        if (status === 400 || status === 404 || status === 422) this.badModels.add(model)
        // Rate limits and outages: the next model may be served elsewhere.
      }
    }
    if (models.length === 0 || this.badModels.size >= this.opts.models.length) {
      return this.giveUp(`${this.service} rejected every transcription model (${errMessage(last)})`)
    }
    this.failures += 1
    if (this.failures >= MAX_FAILURES) return this.giveUp(`${this.service} transcription keeps failing (${errMessage(last)})`)
    this.emit('error', new Error(`${this.service} transcription failed: ${errMessage(last)}`), false)
    return null
  }

  private giveUp(message: string): null {
    log.error(`[${this.tag}] ${message}`)
    this.stopped = true
    this.queue = []
    this.emit('error', new Error(message), true)
    return null
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err ?? 'unknown error')
}

/** Trim and drop Whisper's stock phrases for noise on short segments. */
export function cleanTranscript(raw: string, speechMs: number): string {
  const text = raw.trim()
  const key = text.toLowerCase().replace(/[^a-z ]/g, '').trim()
  if (speechMs < 1500 && HALLUCINATIONS.has(key)) return ''
  return text
}

/** Normalized RMS of 16-bit little-endian PCM. */
export function rms(pcm: Buffer): number {
  const n = Math.floor(pcm.length / 2)
  if (n === 0) return 0
  let sum = 0
  for (let i = 0; i < n; i++) {
    const v = pcm.readInt16LE(i * 2) / 32768
    sum += v * v
  }
  return Math.sqrt(sum / n)
}

/** 16-bit mono PCM wrapped in a WAV header. */
export function toWav(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

/** ISO-639-1 code for the APIs, or undefined to let them detect it (e.g. Deepgram's `multi`). */
export function isoLanguage(language: string): string | undefined {
  const code = language.trim().toLowerCase().split(/[-_]/)[0]
  return /^[a-z]{2}$/.test(code) ? code : undefined
}

async function readError(res: Response): Promise<string> {
  const body = await res.text().catch(() => '')
  try {
    const j = JSON.parse(body) as { error?: { message?: string } | string; message?: string }
    const msg = typeof j.error === 'string' ? j.error : (j.error?.message ?? j.message)
    if (msg) return msg
  } catch {
    // not JSON
  }
  return body.slice(0, 200) || res.statusText
}

export interface HttpSttOptions extends ChunkedSttOptions {
  apiKey: string
  /** Override for tests. */
  endpoint?: string
}

/** OpenRouter `/audio/transcriptions`: JSON body with base64 audio (not OpenAI's multipart). */
export class OpenRouterSttProvider extends ChunkedSttProvider {
  protected readonly service = 'OpenRouter'

  constructor(private readonly http: HttpSttOptions) {
    super(http)
  }

  protected async transcribe(wav: Buffer, model: string, signal: AbortSignal): Promise<string> {
    const res = await fetch(this.http.endpoint ?? 'https://openrouter.ai/api/v1/audio/transcriptions', {
      method: 'POST',
      signal,
      headers: {
        Authorization: `Bearer ${this.http.apiKey}`,
        'Content-Type': 'application/json',
        'X-Title': 'Cue'
      },
      body: JSON.stringify({
        model,
        input_audio: { data: wav.toString('base64'), format: 'wav' },
        language: isoLanguage(this.http.language),
        temperature: 0
      })
    })
    if (!res.ok) throw new SttHttpError(`HTTP ${res.status}: ${await readError(res)}`, res.status)
    const j = (await res.json()) as { text?: string }
    return j.text ?? ''
  }
}

/** Groq's OpenAI-compatible Whisper endpoint (multipart upload). */
export class GroqSttProvider extends ChunkedSttProvider {
  protected readonly service = 'Groq'

  constructor(private readonly http: HttpSttOptions) {
    super(http)
  }

  protected async transcribe(wav: Buffer, model: string, signal: AbortSignal): Promise<string> {
    const form = new FormData()
    form.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'audio.wav')
    form.append('model', model)
    form.append('response_format', 'json')
    form.append('temperature', '0')
    const lang = isoLanguage(this.http.language)
    if (lang) form.append('language', lang)
    const res = await fetch(this.http.endpoint ?? 'https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      signal,
      headers: { Authorization: `Bearer ${this.http.apiKey}` },
      body: form
    })
    if (!res.ok) throw new SttHttpError(`HTTP ${res.status}: ${await readError(res)}`, res.status)
    const j = (await res.json()) as { text?: string }
    return j.text ?? ''
  }
}
