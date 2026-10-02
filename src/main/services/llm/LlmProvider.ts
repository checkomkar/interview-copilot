import type { AnswerUsage } from '@shared/ipc'
import type { ModelRole } from '@shared/settings'

/** A system prompt block. `cache` marks the end of a cacheable prefix (FR-G5). */
export interface LlmSystemBlock {
  text: string
  cache?: boolean
}

/** Base64 image (screenshots are JPEG). */
export interface LlmImagePart {
  type: 'image'
  mediaType: 'image/jpeg' | 'image/png'
  data: string
}
export type LlmContentPart = { type: 'text'; text: string } | LlmImagePart

export interface LlmMessage {
  role: 'user' | 'assistant'
  content: string | LlmContentPart[]
}

/** The text of a message, ignoring images. */
export function messageText(m: LlmMessage): string {
  return typeof m.content === 'string' ? m.content : m.content.map((p) => (p.type === 'text' ? p.text : '')).join('')
}

export function hasImage(req: Pick<LlmRequest, 'messages'>): boolean {
  return imageCount(req) > 0
}

export function imageCount(req: Pick<LlmRequest, 'messages'>): number {
  return req.messages.reduce((n, m) => n + (typeof m.content === 'string' ? 0 : m.content.filter((p) => p.type === 'image').length), 0)
}

/** What the request is for; providers may tune options per purpose (e.g. reasoning effort). */
export type LlmPurpose = 'answer' | 'classify' | 'summary' | 'practice' | 'import'

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

/**
 * `exhausted`: the provider can't serve anything for a while (daily cap, no credits).
 * `empty`: the model hit max_tokens without any visible text (a reasoning model spent the whole
 * budget thinking) — another model should answer instead.
 */
export type LlmErrorKind = 'rate_limit' | 'overloaded' | 'exhausted' | 'empty' | 'auth' | 'refusal' | 'aborted' | 'network' | 'other'

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
      /** The model that actually served the request, when it differs from the one asked for (OpenRouter routing). */
      model?: string
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
    return this.retryable || this.kind === 'exhausted' || this.kind === 'empty' || this.kind === 'auth' || this.kind === 'network'
  }
}

/** Called with the usage of every request that reached a provider (cost tracking, FR-C1). */
export type UsageListener = (usage: AnswerUsage, req: LlmRequest) => void

/** Pluggable LLM provider (FR-G1). Implementations throw `LlmError`. */
export interface LlmProvider {
  stream(req: LlmRequest, handlers: LlmStreamHandlers): Promise<LlmResult>
  complete(req: LlmRequest): Promise<LlmResult>
  /** Write the cacheable prefix without generating output, to cut latency on the next real request. */
  prewarm(req: LlmRequest): Promise<AnswerUsage>
}
