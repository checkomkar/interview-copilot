import WebSocket from 'ws'
import { createLogger } from '../../logger'
import { BaseSttProvider } from './SttProvider'

const log = createLogger('deepgram')

export interface DeepgramOptions {
  apiKey: string
  model: string
  language: string
  endpointingMs: number
  utteranceEndMs: number
  sampleRate?: number
  /** Label used in logs only. */
  label?: string
  /** Override for tests. */
  baseUrl?: string
}

const MAX_RETRIES = 5
const BUFFER_SECONDS = 5
const KEEPALIVE_INTERVAL_MS = 3000
const KEEPALIVE_AFTER_IDLE_MS = 5000
const CLOSE_TIMEOUT_MS = 1500

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
  return `${o.baseUrl ?? 'wss://api.deepgram.com/v1/listen'}?${params.toString()}`
}

/**
 * Deepgram streaming over a raw WebSocket (FR-S2). Reconnects with exponential
 * backoff (FR-S4), buffers up to 5 s of audio while disconnected, and sends
 * KeepAlive messages while no audio flows (FR-S5).
 */
export class DeepgramProvider extends BaseSttProvider {
  private ws: WebSocket | null = null
  private stopping = false
  private retries = 0
  private retryTimer: NodeJS.Timeout | null = null
  private keepAliveTimer: NodeJS.Timeout | null = null
  private lastSendAt = 0
  /** Bytes of audio sent on the current connection, for latency estimation. */
  private bytesSentThisConn = 0
  private pending: Buffer[] = []
  private pendingBytes = 0
  private readonly maxPendingBytes: number
  private readonly bytesPerSecond: number

  constructor(private readonly opts: DeepgramOptions) {
    super()
    this.bytesPerSecond = (opts.sampleRate ?? 16000) * 2
    this.maxPendingBytes = this.bytesPerSecond * BUFFER_SECONDS
  }

  private get tag(): string {
    return this.opts.label ?? 'stt'
  }

  start(): void {
    this.stopping = false
    this.retries = 0
    this.connect()
    this.keepAliveTimer = setInterval(() => this.keepAlive(), KEEPALIVE_INTERVAL_MS)
  }

  sendAudio(chunk: Buffer): void {
    if (this.stopping) return
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(chunk)
      this.bytesSentThisConn += chunk.length
      this.lastSendAt = Date.now()
      return
    }
    this.pending.push(chunk)
    this.pendingBytes += chunk.length
    while (this.pendingBytes > this.maxPendingBytes && this.pending.length > 0) {
      this.pendingBytes -= this.pending.shift()!.length
    }
  }

  async stop(): Promise<void> {
    this.stopping = true
    if (this.retryTimer) clearTimeout(this.retryTimer)
    if (this.keepAliveTimer) clearInterval(this.keepAliveTimer)
    this.retryTimer = this.keepAliveTimer = null
    this.pending = []
    this.pendingBytes = 0
    const ws = this.ws
    this.ws = null
    if (!ws) {
      this.emit('state', 'closed')
      return
    }
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(() => {
        ws.terminate()
        resolve()
      }, CLOSE_TIMEOUT_MS)
      ws.once('close', done)
      if (ws.readyState === WebSocket.OPEN) {
        // Ask Deepgram to flush final results, then close.
        ws.send(JSON.stringify({ type: 'CloseStream' }))
      } else {
        ws.terminate()
      }
    })
    this.emit('state', 'closed')
  }

  private connect(): void {
    this.emit('state', this.retries === 0 ? 'connecting' : 'reconnecting')
    const ws = new WebSocket(buildDeepgramUrl(this.opts), {
      headers: { Authorization: `Token ${this.opts.apiKey}` }
    })
    this.ws = ws
    this.bytesSentThisConn = 0

    ws.on('open', () => {
      if (this.ws !== ws) return
      log.info(`[${this.tag}] connected`)
      this.retries = 0
      this.emit('state', 'open')
      this.flushPending()
    })

    ws.on('message', (data, isBinary) => {
      if (isBinary || this.ws !== ws) return
      this.handleMessage(data.toString())
    })

    ws.on('unexpected-response', (_req, res) => {
      const status = res.statusCode ?? 0
      const fatal = status === 401 || status === 403 || status === 400
      const reason = res.headers['dg-error'] ?? res.statusMessage ?? ''
      log.error(`[${this.tag}] handshake rejected: HTTP ${status} ${reason}`)
      if (fatal) {
        this.stopping = true
        this.emit(
          'error',
          new Error(status === 400 ? `Deepgram rejected the request (${reason || 'check model/language'})` : 'Deepgram API key was rejected'),
          true
        )
      }
      ws.terminate()
    })

    ws.on('error', (err) => {
      log.warn(`[${this.tag}] socket error: ${err.message}`)
    })

    ws.on('close', (code, reason) => {
      if (this.ws !== ws) return
      this.ws = null
      if (this.stopping) return
      log.warn(`[${this.tag}] closed code=${code} ${reason.toString()}`)
      this.scheduleReconnect()
    })
  }

  private scheduleReconnect(): void {
    if (this.retries >= MAX_RETRIES) {
      this.emit('error', new Error(`Lost connection to Deepgram after ${MAX_RETRIES} retries`), true)
      this.emit('state', 'closed')
      return
    }
    const delay = Math.min(500 * 2 ** this.retries, 8000)
    this.retries += 1
    this.emit('state', 'reconnecting')
    this.emit('error', new Error(`Deepgram disconnected; retry ${this.retries}/${MAX_RETRIES} in ${delay} ms`), false)
    this.retryTimer = setTimeout(() => this.connect(), delay)
  }

  private flushPending(): void {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    for (const chunk of this.pending) {
      ws.send(chunk)
      this.bytesSentThisConn += chunk.length
    }
    this.pending = []
    this.pendingBytes = 0
    this.lastSendAt = Date.now()
  }

  private keepAlive(): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return
    if (Date.now() - this.lastSendAt < KEEPALIVE_AFTER_IDLE_MS) return
    this.ws.send(JSON.stringify({ type: 'KeepAlive' }))
    this.lastSendAt = Date.now()
  }

  private handleMessage(raw: string): void {
    const ev = parseDeepgramMessage(raw)
    switch (ev.type) {
      case 'transcript': {
        const sentSec = this.bytesSentThisConn / this.bytesPerSecond
        if (ev.text) this.emit('latency', Math.max(0, Math.round((sentSec - ev.end) * 1000)))
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
