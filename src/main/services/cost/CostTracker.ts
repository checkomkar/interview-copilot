import { EventEmitter } from 'node:events'
import type { AnswerUsage, CostStatus, CostUpdate } from '@shared/ipc'
import type { Settings } from '@shared/settings'
import { createLogger } from '../../logger'
import { priceLlm, priceStt, type Pricing } from './pricing'

const log = createLogger('cost')

/** FR-C4: warn at this share of the cap. */
const WARN_AT = 0.8
/** STT accrues ~10×/s per lane; push updates at most this often. */
const STT_EMIT_MS = 1000

export interface CostTrackerDeps {
  getPricing: () => Pricing
  getSettings: () => Settings
  now?: () => number
}

export interface CostEvents {
  update: [CostUpdate]
  /** The cap status changed to `warn` or `capped` (for a one-off notice). */
  status: [CostStatus, CostUpdate]
}

/**
 * Running cost of the current history session (FR-C1..C4): LLM tokens priced from pricing.json
 * (or the API's own figure), plus streamed STT audio.
 */
export class CostTracker extends EventEmitter {
  private llmUsd = 0
  private sttUsd = 0
  private sttSeconds = 0
  private tokens = { input: 0, output: 0, cacheRead: 0 }
  private unpriced = new Set<string>()
  private status: CostStatus = 'ok'
  private lastSttEmit = Number.NEGATIVE_INFINITY
  private readonly now: () => number

  constructor(private readonly deps: CostTrackerDeps) {
    super()
    this.now = deps.now ?? Date.now
  }

  override emit<E extends keyof CostEvents>(event: E, ...args: CostEvents[E]): boolean {
    return super.emit(event, ...args)
  }
  override on<E extends keyof CostEvents>(event: E, listener: (...args: CostEvents[E]) => void): this {
    return super.on(event, listener as (...a: unknown[]) => void)
  }

  reset(): void {
    this.llmUsd = 0
    this.sttUsd = 0
    this.sttSeconds = 0
    this.tokens = { input: 0, output: 0, cacheRead: 0 }
    this.unpriced.clear()
    this.status = 'ok'
    this.emit('update', this.snapshot())
  }

  /** Records one LLM request; returns its cost (0 when unpriced). */
  addLlm(usage: AnswerUsage): number {
    const usd = priceLlm(this.deps.getPricing(), usage)
    if (usd === null) {
      const name = `${usage.service ?? '?'} ${usage.model}`
      if (!this.unpriced.has(name)) log.warn(`no price for ${name} in pricing.json; counting it as $0`)
      this.unpriced.add(name)
    }
    this.llmUsd += usd ?? 0
    this.tokens.input += usage.inputTokens + usage.cacheWriteTokens
    this.tokens.output += usage.outputTokens
    this.tokens.cacheRead += usage.cacheReadTokens
    this.changed(true)
    return usd ?? 0
  }

  addStt(provider: string, model: string, seconds: number): void {
    this.sttSeconds += seconds
    const usd = priceStt(this.deps.getPricing(), provider, model, seconds)
    if (usd === null) this.unpriced.add(`${provider} ${model}`)
    this.sttUsd += usd ?? 0
    const now = this.now()
    const due = now - this.lastSttEmit >= STT_EMIT_MS
    if (due) this.lastSttEmit = now
    this.changed(due)
  }

  /** Re-evaluate the cap (after it changes in Settings). */
  refresh(): void {
    this.changed(true)
  }

  total(): number {
    return this.llmUsd + this.sttUsd
  }

  /** Over the cap: answers switch to the fast models. */
  isCapped(): boolean {
    return this.status === 'capped'
  }

  snapshot(): CostUpdate {
    return {
      usd: this.total(),
      capUsd: this.deps.getSettings().cost.sessionCapUsd,
      status: this.status,
      sttSeconds: Math.round(this.sttSeconds),
      inputTokens: this.tokens.input,
      outputTokens: this.tokens.output,
      cacheReadTokens: this.tokens.cacheRead,
      unpriced: [...this.unpriced]
    }
  }

  private changed(emit: boolean): void {
    const cap = this.deps.getSettings().cost.sessionCapUsd
    const total = this.total()
    const status: CostStatus = cap <= 0 ? 'ok' : total >= cap ? 'capped' : total >= cap * WARN_AT ? 'warn' : 'ok'
    if (status !== this.status) {
      const rising = rank(status) > rank(this.status)
      this.status = status
      const snap = this.snapshot()
      this.emit('update', snap)
      if (rising) {
        log.warn(`session cost $${total.toFixed(2)} of $${cap.toFixed(2)} cap: ${status}`)
        this.emit('status', status, snap)
      }
      return
    }
    if (emit) this.emit('update', this.snapshot())
  }
}

function rank(s: CostStatus): number {
  return s === 'ok' ? 0 : s === 'warn' ? 1 : 2
}
