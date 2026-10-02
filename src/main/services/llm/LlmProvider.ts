import type { AnswerUsage } from '@shared/ipc'
import type { ModelRole } from '@shared/settings'

/** A system prompt block. `cache` marks the end of a cacheable prefix (FR-G5). */
export interface LlmSystemBlock {
  text: string
  cache?: boolean
}

export interface LlmMessage {
  role: 'user' | 'assistant'
  content: string
}

/** What the request is for; providers may tune options per purpose (e.g. reasoning effort). */
export type LlmPurpose = 'answer' | 'classify' | 'summary'

export interface LlmRequest {
  /** Model ID, or a chain of IDs ("a, b, c") tried in order. */
  model: string
  /** Lets the router pick the matching model chain when it fails over to another provider. */
  role?: ModelRole
  purpose?: LlmPurpose
  system: LlmSystemBlock[]
  messages: LlmMessage[]
  maxTokens: number
  signal?: AbortSignal
}

export interface LlmResult {
  text: string
  usage: AnswerUsage
  /** Hit max_tokens. */
  truncated: boolean
}

export interface LlmStreamHandlers {
  onText: (delta: string) => void
}

/** `exhausted`: the provider can't serve anything for a while (daily cap, no credits). */
export type LlmErrorKind = 'rate_limit' | 'overloaded' | 'exhausted' | 'auth' | 'refusal' | 'aborted' | 'network' | 'other'

export class LlmError extends Error {
  constructor(
    readonly kind: LlmErrorKind,
    message: string,
    readonly status?: number,
    readonly extra: {
      /** From a Retry-After header, when the API sent one. */
      retryAfterMs?: number
      /** `model`: only this model is affected, try the next one. `provider`: the whole account is (keys, credits, daily cap). */
      scope?: 'model' | 'provider'
    } = {}
  ) {
    super(message)
    this.name = 'LlmError'
  }

  /** 429 / 529: worth one retry, then a fallback model (PRD §9). */
  get retryable(): boolean {
    return this.kind === 'rate_limit' || this.kind === 'overloaded'
  }

  /** Worth trying another model or provider instead. */
  get failover(): boolean {
    return this.retryable || this.kind === 'exhausted' || this.kind === 'auth' || this.kind === 'network'
  }
}

/** Pluggable LLM provider (FR-G1). Implementations throw `LlmError`. */
export interface LlmProvider {
  stream(req: LlmRequest, handlers: LlmStreamHandlers): Promise<LlmResult>
  complete(req: LlmRequest): Promise<LlmResult>
  /** Write the cacheable prefix without generating output, to cut latency on the next real request. */
  prewarm(req: LlmRequest): Promise<AnswerUsage>
}
