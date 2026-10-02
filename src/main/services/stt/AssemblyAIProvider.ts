import { createLogger } from '../../logger'
import { SocketSttProvider } from './SocketSttProvider'

const log = createLogger('assemblyai')

export interface AssemblyAIOptions {
  apiKey: string
  /** e.g. `universal-streaming-english`, `universal-streaming-multilingual`, `universal-3-6-pro`. */
  model: string
  language: string
  /** Silence before an end-of-turn check (our `endpointingMs`). */
  minTurnSilenceMs: number
  /** Silence that always ends the turn (our `utteranceEndMs`). */
  maxTurnSilenceMs: number
  sampleRate?: number
  label?: string
  /** Override for tests. */
  baseUrl?: string
}

/** A formatted turn normally follows the unformatted one within a few hundred ms. */
const FORMAT_WAIT_MS = 1500

export type AssemblyAIEvent =
  | { type: 'turn'; order: number; text: string; endOfTurn: boolean; formatted: boolean; endSec: number }
  | { type: 'error'; message: string }
  | { type: 'ignored' }

interface Word {
  text?: string
  end?: number
}

/** Parse one AssemblyAI v3 streaming message. Pure, for testability. */
export function parseAssemblyAIMessage(raw: string): AssemblyAIEvent {
  let msg: Record<string, unknown>
  try {
    msg = JSON.parse(raw)
  } catch {
    return { type: 'error', message: 'unparseable message from AssemblyAI' }
  }
  if (msg.type === 'Turn') {
    const words = Array.isArray(msg.words) ? (msg.words as Word[]) : []
    const endOfTurn = msg.end_of_turn === true
    // Partial turns: `transcript` holds only the finalized words; the words list has them all.
    const spoken = words.map((w) => w.text ?? '').filter(Boolean).join(' ')
    const transcript = String(msg.transcript ?? '')
    const text = endOfTurn ? String(msg.utterance || transcript || spoken) : spoken || transcript
    const lastEnd = words.length ? Number(words[words.length - 1].end ?? 0) : 0
    return {
      type: 'turn',
      order: Number(msg.turn_order ?? 0),
      text: text.trim(),
      endOfTurn,
      formatted: msg.turn_is_formatted === true,
      endSec: lastEnd / 1000
    }
  }
  if (msg.type === 'Error' || typeof msg.error === 'string') {
    return { type: 'error', message: String(msg.error ?? msg.message ?? 'AssemblyAI error') }
  }
  return { type: 'ignored' }
}

/** Universal-Streaming models format turns only when asked; Universal-3 Pro always does. */
function formatsOnRequest(model: string): boolean {
  return model.startsWith('universal-streaming')
}

export function buildAssemblyAIUrl(o: AssemblyAIOptions): string {
  const params = new URLSearchParams({
    speech_model: o.model,
    encoding: 'pcm_s16le',
    sample_rate: String(o.sampleRate ?? 16000),
    min_turn_silence: String(Math.max(50, o.minTurnSilenceMs)),
    max_turn_silence: String(o.maxTurnSilenceMs)
  })
  if (formatsOnRequest(o.model)) params.set('format_turns', 'true')
  const lang = o.language.trim()
  if (lang && lang !== 'en' && !o.model.endsWith('-english')) params.set('language_codes', JSON.stringify([lang]))
  return `${o.baseUrl ?? 'wss://streaming.assemblyai.com/v3/ws'}?${params.toString()}`
}

/**
 * AssemblyAI Universal-Streaming (v3) over a raw WebSocket (FR-S3). A turn grows as partials
 * and ends with `end_of_turn`; with formatting on, the punctuated version follows and is the one
 * kept. Each finished turn is emitted as one final segment followed by `utteranceEnd`.
 */
export class AssemblyAIProvider extends SocketSttProvider {
  protected readonly service = 'AssemblyAI'
  /** An unformatted end of turn waiting for its formatted version. */
  private awaiting: { order: number; text: string; timer: NodeJS.Timeout } | null = null
  /** Turns already emitted, so a late formatted copy isn't emitted twice. */
  private lastEmittedOrder = -1

  constructor(private readonly opts: AssemblyAIOptions) {
    super({ sampleRate: opts.sampleRate, label: opts.label })
  }

  protected url(): string {
    return buildAssemblyAIUrl(this.opts)
  }

  protected headers(): Record<string, string> {
    return { Authorization: this.opts.apiKey }
  }

  protected closeMessage(): string {
    return JSON.stringify({ type: 'Terminate' })
  }

  protected keepAliveMessage(): string {
    return JSON.stringify({ type: 'KeepAlive' })
  }

  override async stop(): Promise<void> {
    await super.stop()
    // Whatever was still waiting for formatting is final now.
    if (this.awaiting) this.endTurn(this.awaiting.order, this.awaiting.text)
  }

  /** Turn numbers restart with each connection. */
  protected override onOpen(): void {
    if (this.awaiting) this.endTurn(this.awaiting.order, this.awaiting.text)
    this.lastEmittedOrder = -1
  }

  /** Auth and billing problems arrive as policy closes after the handshake. */
  protected override onClose(code: number, reason: string): boolean {
    if (code === 1008 || (code >= 4000 && code < 4010) || code === 3005) {
      this.fail(`AssemblyAI closed the stream: ${reason || `code ${code}`} — check the API key and account balance`)
      return true
    }
    return false
  }

  protected handleMessage(raw: string): void {
    const ev = parseAssemblyAIMessage(raw)
    if (ev.type === 'error') {
      log.error(`[${this.tag}] ${ev.message}`)
      this.emit('error', new Error(ev.message), false)
      return
    }
    if (ev.type !== 'turn' || ev.order <= this.lastEmittedOrder) return
    if (ev.text && ev.endSec > 0) this.emitLatency(ev.endSec)
    const result = (text: string) => ({ text, speechFinal: ev.endOfTurn, start: 0, end: ev.endSec })
    if (!ev.endOfTurn) {
      if (ev.text) this.emit('partial', result(ev.text))
      return
    }
    if (ev.formatted || !formatsOnRequest(this.opts.model)) {
      this.endTurn(ev.order, ev.text)
      return
    }
    // Unformatted end of turn: show it, then wait briefly for the punctuated copy.
    if (ev.text) this.emit('partial', result(ev.text))
    if (this.awaiting) clearTimeout(this.awaiting.timer)
    const order = ev.order
    this.awaiting = { order, text: ev.text, timer: setTimeout(() => this.endTurn(order, ev.text), FORMAT_WAIT_MS) }
  }

  private endTurn(order: number, text: string): void {
    if (this.awaiting) {
      clearTimeout(this.awaiting.timer)
      this.awaiting = null
    }
    if (order <= this.lastEmittedOrder) return
    this.lastEmittedOrder = order
    this.emit('final', { text, speechFinal: true, start: 0, end: 0 })
    this.emit('utteranceEnd')
  }
}
