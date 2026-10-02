import { EventEmitter } from 'node:events'

export interface SttResult {
  text: string
  /** Provider says the speaker paused (end of a phrase); utterance may continue. */
  speechFinal: boolean
  /** Seconds from start of the provider connection. */
  start: number
  end: number
}

export type SttConnectionState = 'connecting' | 'open' | 'reconnecting' | 'closed'

export interface SttEvents {
  /** Interim, non-final hypothesis for the current segment. */
  partial: [SttResult]
  /** Finalized segment text; will not change. */
  final: [SttResult]
  /** Silence long enough to treat the utterance as finished. */
  utteranceEnd: []
  state: [SttConnectionState]
  /** Audio streamed but not yet transcribed, in ms. */
  latency: [number]
  /** `fatal` means the provider gave up and must be restarted. */
  error: [Error, boolean]
}

/** Pluggable streaming STT provider (FR-S1). */
export interface SttProvider {
  start(): void
  /** 16 kHz mono linear16 PCM. */
  sendAudio(chunk: Buffer): void
  stop(): Promise<void>
  on<E extends keyof SttEvents>(event: E, listener: (...args: SttEvents[E]) => void): this
  off<E extends keyof SttEvents>(event: E, listener: (...args: SttEvents[E]) => void): this
}

/** Typed EventEmitter base for providers. */
export abstract class BaseSttProvider extends EventEmitter implements SttProvider {
  abstract start(): void
  abstract sendAudio(chunk: Buffer): void
  abstract stop(): Promise<void>

  override on<E extends keyof SttEvents>(event: E, listener: (...args: SttEvents[E]) => void): this {
    return super.on(event, listener as (...a: unknown[]) => void)
  }
  override off<E extends keyof SttEvents>(event: E, listener: (...args: SttEvents[E]) => void): this {
    return super.off(event, listener as (...a: unknown[]) => void)
  }
  override emit<E extends keyof SttEvents>(event: E, ...args: SttEvents[E]): boolean {
    return super.emit(event, ...args)
  }
}
