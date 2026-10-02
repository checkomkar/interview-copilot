import Anthropic from '@anthropic-ai/sdk'
import type { AnswerUsage } from '@shared/ipc'
import { LlmError, type LlmProvider, type LlmRequest, type LlmResult, type LlmStreamHandlers } from './LlmProvider'

type CreateParams = Anthropic.Beta.MessageCreateParamsNonStreaming

/** Server-side refusal fallback; Anthropic picks the substitute model by refusal category. */
const FALLBACK_BETA = 'server-side-fallback-2026-07-01'
const FALLBACK_MODELS = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5'])

/** Models that reject `output_config.effort`. */
const NO_EFFORT = /haiku|claude-3|claude-sonnet-4-5|claude-sonnet-4-2025|claude-opus-4-2025|claude-opus-4-1/

/**
 * Per-model request options tuned for latency. Model IDs are user-editable strings,
 * so this has to cope with any of them:
 * - Sonnet 5.5 can't disable thinking; `between_tools` is its no-thinking setting.
 * - Opus 5.5 / Fable can't disable thinking at all; low effort keeps it short.
 * - Haiku 4.5 and older thinks only when asked and rejects `effort`.
 */
export function modelOptions(model: string): Pick<CreateParams, 'thinking' | 'output_config' | 'fallbacks' | 'betas'> {
  const opts: Pick<CreateParams, 'thinking' | 'output_config' | 'fallbacks' | 'betas'> = {}
  if (model === 'claude-sonnet-5-5') opts.thinking = { type: 'between_tools' }
  if (!NO_EFFORT.test(model)) opts.output_config = { effort: 'low' }
  if (FALLBACK_MODELS.has(model)) {
    opts.fallbacks = 'default'
    opts.betas = [FALLBACK_BETA]
  }
  return opts
}

export class AnthropicProvider implements LlmProvider {
  private client: Anthropic | null = null
  private clientKey: string | null = null

  /** `getApiKey` is read per request so a key change in Settings applies immediately. */
  constructor(private readonly getApiKey: () => string | null) {}

  async stream(req: LlmRequest, handlers: LlmStreamHandlers): Promise<LlmResult> {
    const client = this.getClient()
    try {
      const stream = client.beta.messages.stream(this.params(req), { signal: req.signal })
      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') handlers.onText(event.delta.text)
      }
      return toResult(await stream.finalMessage())
    } catch (err) {
      throw toLlmError(err, req.signal)
    }
  }

  async complete(req: LlmRequest): Promise<LlmResult> {
    const client = this.getClient()
    try {
      return toResult(await client.beta.messages.create(this.params(req), { signal: req.signal }))
    } catch (err) {
      throw toLlmError(err, req.signal)
    }
  }

  async prewarm(req: LlmRequest): Promise<AnswerUsage> {
    const client = this.getClient()
    try {
      // max_tokens 0 writes the cache at the breakpoint and returns no content.
      const msg = await client.beta.messages.create({ ...this.params(req), max_tokens: 0 }, { signal: req.signal })
      return toUsage(msg)
    } catch (err) {
      throw toLlmError(err, req.signal)
    }
  }

  private params(req: LlmRequest): CreateParams {
    return {
      model: req.model,
      max_tokens: req.maxTokens,
      ...(req.system.length
        ? {
            system: req.system.map((b) => ({
              type: 'text' as const,
              text: b.text,
              ...(b.cache ? { cache_control: { type: 'ephemeral' as const } } : {})
            }))
          }
        : {}),
      messages: req.messages.map((m) => ({
        role: m.role,
        content:
          typeof m.content === 'string'
            ? m.content
            : m.content.map((p) =>
                p.type === 'text'
                  ? { type: 'text' as const, text: p.text }
                  : { type: 'image' as const, source: { type: 'base64' as const, media_type: p.mediaType, data: p.data } }
              )
      })),
      ...modelOptions(req.model)
    }
  }

  private getClient(): Anthropic {
    const key = this.getApiKey()
    if (!key) throw new LlmError('auth', 'Add your Anthropic API key in Settings.')
    if (!this.client || this.clientKey !== key) {
      // Retries are handled by AnswerService so they stay within the latency budget (PRD §9).
      this.client = new Anthropic({ apiKey: key, maxRetries: 0, timeout: 60_000 })
      this.clientKey = key
    }
    return this.client
  }
}

function toUsage(msg: Anthropic.Beta.BetaMessage): AnswerUsage {
  return {
    model: msg.model,
    inputTokens: msg.usage.input_tokens,
    outputTokens: msg.usage.output_tokens,
    cacheReadTokens: msg.usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: msg.usage.cache_creation_input_tokens ?? 0
  }
}

function toResult(msg: Anthropic.Beta.BetaMessage): LlmResult {
  if (msg.stop_reason === 'refusal') {
    throw new LlmError('refusal', 'The model declined to answer this one.')
  }
  const text = msg.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
  return { text, usage: toUsage(msg), truncated: msg.stop_reason === 'max_tokens' }
}

/** The API's own message (e.g. "Your credit balance is too low…") instead of the raw "400 {json}". */
function apiMessage(err: InstanceType<typeof Anthropic.APIError>): string {
  const body = err.error as { error?: { message?: unknown } } | undefined
  return typeof body?.error?.message === 'string' ? body.error.message : err.message
}

function toLlmError(err: unknown, signal?: AbortSignal): LlmError {
  if (err instanceof LlmError) return err
  if (signal?.aborted || err instanceof Anthropic.APIUserAbortError) return new LlmError('aborted', 'Canceled')
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return new LlmError('auth', 'Anthropic rejected the API key — check it in Settings.', err.status, { scope: 'provider' })
  }
  if (err instanceof Anthropic.RateLimitError) return new LlmError('rate_limit', 'Rate limited by Anthropic.', 429)
  if (err instanceof Anthropic.NotFoundError) {
    return new LlmError('other', 'Model not found — check the model IDs in Settings.', 404)
  }
  if (err instanceof Anthropic.BadRequestError) {
    const message = apiMessage(err)
    // Out of credits is account-wide: let the router switch to a fallback provider.
    if (/credit balance/i.test(message)) return new LlmError('exhausted', message, 400, { scope: 'provider' })
    return new LlmError('other', message, 400)
  }
  if (err instanceof Anthropic.APIConnectionError) return new LlmError('network', 'Could not reach Anthropic — check your connection.')
  if (err instanceof Anthropic.APIError) {
    if (err.status === 529 || err.status === 503) return new LlmError('overloaded', 'Anthropic is overloaded.', err.status)
    return new LlmError('other', `Anthropic error ${err.status ?? ''}: ${apiMessage(err)}`.replace(/\s+:/, ':'), err.status)
  }
  // Errors surfaced mid-stream (e.g. an `overloaded_error` SSE event) may not carry a status.
  const msg = err instanceof Error ? err.message : String(err)
  if (/overloaded/i.test(msg)) return new LlmError('overloaded', 'Anthropic is overloaded.')
  return new LlmError('other', msg)
}
