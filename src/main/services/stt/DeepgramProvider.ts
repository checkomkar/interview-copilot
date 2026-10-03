import type { DeepgramRegion } from '@shared/settings'
import { createLogger } from '../../logger'
import { SocketSttProvider } from './SocketSttProvider'

const log = createLogger('deepgram')

export interface DeepgramOptions {
  apiKey: string
  model: string
  language: string
  endpointingMs: number
  utteranceEndMs: number
  /** Endpoint region; default US. */
  region?: DeepgramRegion
  sampleRate?: number
  /** Label used in logs only. */
  label?: string
  /** Override for tests. */
  baseUrl?: string
  /** Override for tests. */
  connectTimeoutMs?: number
}

export type DeepgramEvent =
  | { type: 'transcript'; text: string; isFinal: boolean; speechFinal: boolean; start: number; end: number }
  | { type: 'utteranceEnd' }
  | { type: 'error'; message: string }
  | { type: 'ignored' }

/** Parse one Deepgram streaming message. Pure, for testability. */
export function parseDeepgramMessage(raw: string): DeepgramEvent {
  let msg: Record<string, unknown>
  try {
    msg = JSON.parse(raw)
  } catch {
    return { type: 'error', message: 'unparseable message from Deepgram' }
  }
  switch (msg.type) {
    case 'Results': {
      const channel = msg.channel as { alternatives?: { transcript?: string }[] } | undefined
      const start = Number(msg.start ?? 0)
      const duration = Number(msg.duration ?? 0)
      return {
        type: 'transcript',
        text: channel?.alternatives?.[0]?.transcript ?? '',
        isFinal: msg.is_final === true,
        speechFinal: msg.speech_final === true,
        start,
        end: start + duration
      }
    }
    case 'UtteranceEnd':
      return { type: 'utteranceEnd' }
    case 'Error':
      return { type: 'error', message: String(msg.description ?? msg.message ?? 'Deepgram error') }
    default:
      return { type: 'ignored' }
  }
}

const HOSTS: Record<DeepgramRegion, string> = { us: 'api.deepgram.com', eu: 'api.eu.deepgram.com' }

export function buildDeepgramUrl(o: DeepgramOptions): string {
  const params = new URLSearchParams({
    model: o.model,
    language: o.language,
    encoding: 'linear16',
    sample_rate: String(o.sampleRate ?? 16000),
    channels: '1',
    interim_results: 'true',
    smart_format: 'true',
    punctuate: 'true',
    endpointing: String(o.endpointingMs),
    utterance_end_ms: String(o.utteranceEndMs),
    vad_events: 'true'
  })
  return `${o.baseUrl ?? `wss://${HOSTS[o.region ?? 'us']}/v1/listen`}?${params.toString()}`
}

/** Deepgram streaming over a raw WebSocket (FR-S2); connection handling lives in SocketSttProvider. */
export class DeepgramProvider extends SocketSttProvider {
  protected readonly service = 'Deepgram'

  constructor(private readonly opts: DeepgramOptions) {
    super({ sampleRate: opts.sampleRate, label: opts.label, connectTimeoutMs: opts.connectTimeoutMs })
  }

  protected url(): string {
    return buildDeepgramUrl(this.opts)
  }

  protected headers(): Record<string, string> {
    return { Authorization: `Token ${this.opts.apiKey}` }
  }

  protected closeMessage(): string {
    return JSON.stringify({ type: 'CloseStream' })
  }

  protected keepAliveMessage(): string {
    return JSON.stringify({ type: 'KeepAlive' })
  }

  protected handleMessage(raw: string): void {
    const ev = parseDeepgramMessage(raw)
    switch (ev.type) {
      case 'transcript': {
        if (ev.text) this.emitLatency(ev.end)
        const result = { text: ev.text, speechFinal: ev.speechFinal, start: ev.start, end: ev.end }
        if (ev.isFinal) this.emit('final', result)
        else if (ev.text) this.emit('partial', result)
        break
      }
      case 'utteranceEnd':
        this.emit('utteranceEnd')
        break
      case 'error':
        log.error(`[${this.tag}] ${ev.message}`)
        this.emit('error', new Error(ev.message), false)
        break
    }
  }
}
