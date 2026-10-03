import { createLogger } from '../../logger'
import { BaseSttProvider, type SttConnectionState, type SttProvider } from './SttProvider'

const log = createLogger('stt-fallback')

/** Failed connection attempts (before ever connecting) that move on to the next provider. */
const CONNECT_ATTEMPTS = 2
/** Audio replayed to the next provider when the failed one never connected. */
const REPLAY_SECONDS = 5

export interface SttCandidate {
  id: string
  /** Shown in notices, e.g. "Deepgram". */
  label: string
  create: () => SttProvider
}

export interface FallbackSttOptions {
  sampleRate?: number
  /** A candidate became the active provider (cost tracking). */
  onActive?: (id: string) => void
}

/**
 * Runs the first STT provider and moves to the next one when it gives up (bad key, out of
 * credits, lost connection) or can't connect at all — e.g. a network that blocks its
 * WebSocket. Never moves back within a session.
 */
export class FallbackSttProvider extends BaseSttProvider {
  private index = -1
  private current: SttProvider | null = null
  private opened = false
  private connectFailures = 0
  private stopped = false
  private readonly failures: string[] = []
  /** Recent audio, replayed to the next provider if the failed one never transcribed it. */
  private recent: Buffer[] = []
  private recentBytes = 0
  private readonly maxRecentBytes: number

  constructor(
    private readonly candidates: SttCandidate[],
    private readonly opts: FallbackSttOptions = {}
  ) {
    super()
    if (candidates.length === 0) throw new Error('No speech-to-text provider configured')
    this.maxRecentBytes = (opts.sampleRate ?? 16000) * 2 * REPLAY_SECONDS
  }

  /** The provider in use, e.g. "deepgram". */
  activeId(): string | null {
    return this.candidates[this.index]?.id ?? null
  }

  start(): void {
    this.stopped = false
    this.activate(0)
  }

  sendAudio(chunk: Buffer): void {
    if (this.stopped) return
    this.current?.sendAudio(chunk)
    if (this.opened) return
    this.recent.push(chunk)
    this.recentBytes += chunk.length
    while (this.recentBytes > this.maxRecentBytes && this.recent.length > 0) this.recentBytes -= this.recent.shift()!.length
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.recent = []
    this.recentBytes = 0
    const p = this.current
    if (p) await p.stop()
    else this.emit('state', 'closed')
  }

  private activate(index: number): void {
    const candidate = this.candidates[index]
    this.index = index
    this.opened = false
    this.connectFailures = 0
    const p = candidate.create()
    this.current = p
    const live = () => this.current === p && !this.stopped

    p.on('partial', (r) => live() && this.emit('partial', r))
    p.on('final', (r) => {
      // Results flushed while stopping still count.
      if (this.current === p) this.emit('final', r)
    })
    p.on('utteranceEnd', () => {
      if (this.current === p) this.emit('utteranceEnd')
    })
    p.on('latency', (ms) => live() && this.emit('latency', ms))
    p.on('state', (s: SttConnectionState) => {
      if (this.current !== p) return
      if (s === 'open') {
        this.opened = true
        this.recent = []
        this.recentBytes = 0
      } else if (s === 'reconnecting' && !this.opened && !this.stopped) {
        this.connectFailures += 1
        if (this.connectFailures >= CONNECT_ATTEMPTS && this.hasNext()) {
          this.failOver(`couldn't connect to ${candidate.label}`)
          return
        }
      } else if (s === 'closed' && !this.stopped) {
        // A provider that gave up reports it through `error`; the fallback takes over there.
        if (this.hasNext()) return
      }
      this.emit('state', s)
    })
    p.on('error', (err, fatal) => {
      if (!live()) return
      if (fatal && this.hasNext()) {
        this.failOver(err.message)
        return
      }
      if (fatal && this.failures.length > 0) {
        this.failures.push(`${candidate.label}: ${err.message}`)
        this.emit('error', new Error(`All speech-to-text providers failed — ${this.failures.join('; ')}`), true)
        return
      }
      this.emit('error', err, fatal)
    })

    log.info(`using ${candidate.label}`)
    this.opts.onActive?.(candidate.id)
    p.start()
  }

  private hasNext(): boolean {
    return this.index + 1 < this.candidates.length
  }

  private failOver(reason: string): void {
    const from = this.candidates[this.index]
    const to = this.candidates[this.index + 1]
    const old = this.current
    const replay = this.opened ? [] : this.recent
    this.failures.push(`${from.label}: ${reason}`)
    log.warn(`${from.label} failed (${reason}); switching to ${to.label}`)
    this.current = null
    void old?.stop().catch(() => {})
    this.emit('fallback', { from: from.label, to: to.label, reason })
    this.activate(this.index + 1)
    for (const chunk of replay) this.current!.sendAudio(chunk)
  }
}
