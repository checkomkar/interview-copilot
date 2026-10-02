import WebSocket from 'ws'
import { createLogger } from '../../logger'
import { BaseSttProvider } from './SttProvider'

const log = createLogger('stt')

/**
 * Retries with exponential backoff (0.5, 1, 2, 4, 8, 8, 8, 8 s): together ~40 s, so a network drop
 * of up to 30 s resumes on its own (FR-S4, NFR reliability).
 */
export const MAX_RETRIES = 8
const BUFFER_SECONDS = 5
const KEEPALIVE_INTERVAL_MS = 3000
const KEEPALIVE_AFTER_IDLE_MS = 5000
const CLOSE_TIMEOUT_MS = 1500

export interface SocketSttOptions {
  sampleRate?: number
  /** Label used in logs only. */
  label?: string
}

/**
 * Shared WebSocket plumbing for streaming STT providers: reconnects with exponential backoff
 * (FR-S4), buffers up to 5 s of audio while disconnected, sends keep-alives while no audio
 * flows (FR-S5) and flushes final results on stop. Subclasses supply the URL, auth and the
 * message format.
 */
export abstract class SocketSttProvider extends BaseSttProvider {
  /** Shown in errors, e.g. "Deepgram". */
  protected abstract readonly service: string
  protected abstract url(): string
  protected abstract headers(): Record<string, string>
  /** One text message from the service. */
  protected abstract handleMessage(raw: string): void
  /** Asks the service to flush final results and close. */
  protected abstract closeMessage(): string
  protected abstract keepAliveMessage(): string

  private ws: WebSocket | null = null
  /** The socket being closed by `stop()`; its flushed final results are still handled. */
  private closingWs: WebSocket | null = null
  private stopping = false
  private retries = 0
  private retryTimer: NodeJS.Timeout | null = null
  private keepAliveTimer: NodeJS.Timeout | null = null
  private lastSendAt = 0
  /** Bytes of audio sent on the current connection, for latency estimation. */
  protected bytesSentThisConn = 0
  private pending: Buffer[] = []
  private pendingBytes = 0
  private readonly maxPendingBytes: number
  protected readonly bytesPerSecond: number

  constructor(private readonly socketOpts: SocketSttOptions) {
    super()
    this.bytesPerSecond = (socketOpts.sampleRate ?? 16000) * 2
    this.maxPendingBytes = this.bytesPerSecond * BUFFER_SECONDS
  }

  protected get tag(): string {
    return `${this.service.toLowerCase()}:${this.socketOpts.label ?? 'stt'}`
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
    // Results flushed after the close request still arrive on this socket.
    this.closingWs = ws
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
      if (ws.readyState === WebSocket.OPEN) ws.send(this.closeMessage())
      else ws.terminate()
    })
    this.closingWs = null
    this.emit('state', 'closed')
  }

  /** The service rejected the request for good (bad key, bad parameters): stop and report. */
  protected fail(message: string): void {
    this.stopping = true
    this.emit('error', new Error(message), true)
    this.ws?.terminate()
  }

  /** Handshake rejected with an HTTP status. 400/401/403 are fatal; anything else is retried. */
  protected rejectionMessage(status: number, reason: string): string | null {
    if (status === 401 || status === 403) return `${this.service} API key was rejected`
    if (status === 400) return `${this.service} rejected the request (${reason || 'check model/language'})`
    return null
  }

  private connect(): void {
    this.emit('state', this.retries === 0 ? 'connecting' : 'reconnecting')
    const ws = new WebSocket(this.url(), { headers: this.headers() })
    this.ws = ws
    this.bytesSentThisConn = 0

    ws.on('open', () => {
      if (this.ws !== ws) return
      log.info(`[${this.tag}] connected`)
      this.retries = 0
      this.onOpen()
      this.emit('state', 'open')
      this.flushPending()
    })

    ws.on('message', (data, isBinary) => {
      if (isBinary || (this.ws !== ws && this.closingWs !== ws)) return
      this.handleMessage(data.toString())
    })

    ws.on('unexpected-response', (_req, res) => {
      const status = res.statusCode ?? 0
      const header = res.headers['dg-error'] ?? res.headers['x-error']
      const reason = (Array.isArray(header) ? header[0] : header) ?? res.statusMessage ?? ''
      log.error(`[${this.tag}] handshake rejected: HTTP ${status} ${reason}`)
      const fatal = this.rejectionMessage(status, reason)
      if (fatal) {
        this.stopping = true
        this.emit('error', new Error(fatal), true)
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
      if (this.onClose(code, reason.toString())) return
      this.scheduleReconnect()
    })
  }

  /** A new connection opened (per-connection counters restart). */
  protected onOpen(): void {}

  /** A close the subclass treats as final (returns true after calling `fail`). */
  protected onClose(_code: number, _reason: string): boolean {
    return false
  }

  private scheduleReconnect(): void {
    if (this.retries >= MAX_RETRIES) {
      this.emit('error', new Error(`Lost connection to ${this.service} after ${MAX_RETRIES} retries`), true)
      this.emit('state', 'closed')
      return
    }
    const delay = Math.min(500 * 2 ** this.retries, 8000)
    this.retries += 1
    this.emit('state', 'reconnecting')
    this.emit('error', new Error(`${this.service} disconnected; retry ${this.retries}/${MAX_RETRIES} in ${delay} ms`), false)
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
    this.ws.send(this.keepAliveMessage())
    this.lastSendAt = Date.now()
  }

  /** How far transcription trails the audio sent, given a result's end time in seconds. */
  protected emitLatency(endSec: number): void {
    const sentSec = this.bytesSentThisConn / this.bytesPerSecond
    this.emit('latency', Math.max(0, Math.round((sentSec - endSec) * 1000)))
  }
}
