import type { AnswerUsage } from '@shared/ipc'
import { LLM_PROVIDER_LABELS, MAX_MODEL_CHAIN, splitModels, type CompatProviderId, type ReasoningEffort } from '@shared/settings'
import { createLogger } from '../../logger'
import { cooldownMs, parseRetryAfter, type Cooldowns } from './Cooldowns'
import { LlmError, type LlmProvider, type LlmPurpose, type LlmRequest, type LlmResult, type LlmStreamHandlers } from './LlmProvider'

const TIMEOUT_MS = 60_000

/** OpenRouter's router over whatever free models currently have capacity. */
const FREE_ROUTER = 'openrouter/free'
const isFree = (slug: string) => slug.endsWith(':free') || slug === FREE_ROUTER

/** What differs between the OpenAI-compatible services. */
interface Flavor {
  endpoint: string
  /** Models sent per request. OpenRouter falls through up to 3 server-side (`models`); others take one. */
  modelsPerRequest: number
  /** Anthropic-style `cache_control` on system parts (OpenRouter forwards it; others may reject it). */
  cacheControl: boolean
  /** Ask for token usage in the last stream chunk (OpenRouter always sends it). */
  includeUsage: boolean
  /** Reasoning tokens count toward max_tokens on these models; leave room so the answer isn't cut off. */
  reasoningHeadroom: number
  reasoning: (model: string, effort: ReasoningEffort, purpose: LlmPurpose | undefined) => Record<string, unknown>
}

const GROQ_QWEN_EFFORTS: ReasoningEffort[] = ['none', 'default', 'low', 'medium', 'high']
const LOW_MED_HIGH: ReasoningEffort[] = ['low', 'medium', 'high']

export const FLAVORS: Record<CompatProviderId, Flavor> = {
  openrouter: {
    endpoint: 'https://openrouter.ai/api/v1/chat/completions',
    modelsPerRequest: 3,
    cacheControl: true,
    includeUsage: false,
    reasoningHeadroom: 0,
    // Answers only: sending effort to Haiku-class models would turn thinking on and slow the classifier.
    reasoning: (_m, effort, purpose) => (purpose === 'answer' && effort !== 'default' ? { reasoning: { effort, exclude: true } } : {})
  },
  groq: {
    endpoint: 'https://api.groq.com/openai/v1/chat/completions',
    modelsPerRequest: 1,
    cacheControl: false,
    includeUsage: true,
    reasoningHeadroom: 1024,
    reasoning: (model, effort, purpose) => {
      if (/gpt-oss/.test(model)) {
        // gpt-oss always reasons (low|medium|high); keep the reasoning out of the reply.
        const e = purpose === 'answer' && LOW_MED_HIGH.includes(effort) ? effort : 'low'
        return { reasoning_effort: e, include_reasoning: false }
      }
      if (/qwen/.test(model)) {
        // Qwen would otherwise put <think> text in the reply.
        const e = purpose === 'answer' ? effort : 'none'
        return { reasoning_format: 'hidden', ...(GROQ_QWEN_EFFORTS.includes(e) && e !== 'default' ? { reasoning_effort: e } : {}) }
      }
      return {}
    }
  },
  gemini: {
    endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    modelsPerRequest: 1,
    cacheControl: false,
    includeUsage: true,
    reasoningHeadroom: 1024,
    // Gemini 3 can't turn thinking off; classifier/summaries always use the fastest setting.
    reasoning: (_m, effort, purpose) => {
      const e = purpose === 'answer' ? effort : 'minimal'
      return e === 'default' ? {} : { reasoning_effort: e }
    }
  }
}

/** The subset of the OpenAI-compatible response we read. */
interface Chunk {
  model?: string
  /** OpenRouter: upstream that served the request, e.g. "Google AI Studio". */
  provider?: string
  choices?: { delta?: { content?: string | null }; message?: { content?: string | null }; finish_reason?: string | null }[]
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number }
  }
  error?: ErrorBody
}

interface ErrorBody {
  code?: number | string
  message?: string
  type?: string
  status?: string
  metadata?: { provider_name?: string; raw?: unknown; error_type?: string }
}

export interface CompatOptions {
  id: CompatProviderId
  getApiKey: () => string | null
  getReasoningEffort: () => ReasoningEffort
  cooldowns: Cooldowns
  /** Injectable for tests. */
  fetch?: typeof fetch
}

/**
 * OpenRouter, Groq and Google Gemini over their OpenAI-compatible chat completions APIs (fetch + SSE).
 * A model field is a chain of up to 12 IDs: a model that is rate-limited, over quota or missing is
 * put on cooldown and the next one is tried, so one busy model doesn't fail the answer.
 * Account-wide failures (bad key, no credits, account daily cap) are thrown with `scope: 'provider'`
 * for the router to switch providers.
 */
export class OpenAICompatProvider implements LlmProvider {
  private readonly fetch: typeof fetch
  private readonly flavor: Flavor
  private readonly label: string
  private readonly log
  /** Models that rejected our reasoning setting (e.g. a Gemini model without "minimal"); sent without it. */
  private readonly noReasoning = new Set<string>()

  constructor(private readonly opts: CompatOptions) {
    this.fetch = opts.fetch ?? globalThis.fetch
    this.flavor = FLAVORS[opts.id]
    this.label = LLM_PROVIDER_LABELS[opts.id]
    this.log = createLogger(opts.id)
  }

  stream(req: LlmRequest, handlers: LlmStreamHandlers): Promise<LlmResult> {
    return this.chain(req, async (models, onStreamed) => {
      const res = await this.post(req, models, true)
      if (!res.body) throw new LlmError('network', `${this.label} returned an empty stream.`)
      let text = ''
      let last: Chunk = {}
      let finish: string | null = null
      try {
        for await (const chunk of sseChunks(res.body)) {
          if (chunk.error) throw this.chunkError(chunk.error)
          const choice = chunk.choices?.[0]
          const delta = choice?.delta?.content
          if (delta) {
            text += delta
            onStreamed()
            handlers.onText(delta)
          }
          if (choice?.finish_reason) finish = choice.finish_reason
          if (chunk.usage) last = { ...chunk, model: chunk.model ?? last.model, provider: chunk.provider ?? last.provider }
          else if (!last.model && (chunk.model || chunk.provider)) last = { ...last, model: chunk.model, provider: chunk.provider }
        }
      } catch (err) {
        throw this.toLlmError(err, req.signal)
      }
      return toResult(text, finish, last, models[0])
    })
  }

  complete(req: LlmRequest): Promise<LlmResult> {
    return this.chain(req, async (models) => {
      const res = await this.post(req, models, false)
      let body: Chunk
      try {
        body = (await res.json()) as Chunk
      } catch (err) {
        throw this.toLlmError(err, req.signal)
      }
      if (body.error) throw this.chunkError(body.error)
      const choice = body.choices?.[0]
      return toResult(choice?.message?.content ?? '', choice?.finish_reason ?? null, body, models[0])
    })
  }

  /**
   * Not supported: there is no zero-output request, and a 1-token request can't carry the same
   * reasoning settings as real answers, so it wouldn't warm the right cache entry.
   */
  async prewarm(req: LlmRequest): Promise<AnswerUsage> {
    return { model: req.model, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
  }

  /** The model chain to try; OpenRouter free-only chains end with the free router. */
  models(field: string): string[] {
    const models = splitModels(field)
    if (
      this.opts.id === 'openrouter' &&
      models.length > 0 &&
      models.length < MAX_MODEL_CHAIN &&
      models.every(isFree) &&
      !models.includes(FREE_ROUTER)
    ) {
      models.push(FREE_ROUTER)
    }
    return models
  }

  /** Try the chain's models (in groups of `modelsPerRequest`), skipping ones on cooldown. */
  private async chain(req: LlmRequest, run: (models: string[], onStreamed: () => void) => Promise<LlmResult>): Promise<LlmResult> {
    const key = (m: string) => `${this.opts.id}:${m}`
    const available = this.models(req.model).filter((m) => !this.opts.cooldowns.active(key(m)))
    if (available.length === 0) {
      throw new LlmError('rate_limit', `All ${this.label} models are cooling down after rate limits — try again shortly.`, 429)
    }
    const groups: string[][] = []
    for (let i = 0; i < available.length; i += this.flavor.modelsPerRequest) groups.push(available.slice(i, i + this.flavor.modelsPerRequest))

    let last: LlmError | null = null
    for (let i = 0; i < groups.length; i++) {
      let streamed = false
      try {
        return await run(groups[i], () => {
          streamed = true
        })
      } catch (err) {
        const e = this.toLlmError(err, req.signal)
        // Partial answers are kept by the caller; account-wide failures go to the router.
        if (e.kind === 'aborted' || streamed || e.extra.scope === 'provider') throw e
        // A model that rejects the reasoning setting: retry it once with the model default.
        const model = groups[i][0]
        if (e.status === 400 && /thinking|reasoning/i.test(e.message) && !this.noReasoning.has(model) && this.sendsReasoning(model, req)) {
          this.log.warn(`${model} rejected the reasoning setting (${e.message}); retrying with the model default`)
          this.noReasoning.add(model)
          i--
          continue
        }
        const ms = cooldownMs(e.kind, e.extra.retryAfterMs, e.status)
        if (ms === 0) throw e
        for (const m of groups[i]) this.opts.cooldowns.mark(key(m), ms)
        const next = groups[i + 1]
        this.log.warn(`${groups[i].join(', ')}: ${e.message} (skipping for ${Math.round(ms / 1000)} s)${next ? `; trying ${next.join(', ')}` : ''}`)
        last = e
      }
    }
    throw last ?? new LlmError('other', `${this.label} request failed`)
  }

  private async post(req: LlmRequest, models: string[], stream: boolean): Promise<Response> {
    const key = this.opts.getApiKey()
    if (!key) throw new LlmError('auth', `Add your ${this.label} API key in Settings.`, undefined, { scope: 'provider' })
    const signal = req.signal ? AbortSignal.any([req.signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS)
    let res: Response
    try {
      res = await this.fetch(this.flavor.endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(this.body(req, models, stream)),
        signal
      })
    } catch (err) {
      throw this.toLlmError(err, req.signal)
    }
    if (!res.ok) throw await this.httpError(res)
    return res
  }

  private body(req: LlmRequest, models: string[], stream: boolean): Record<string, unknown> {
    const f = this.flavor
    const messages: unknown[] = []
    if (req.system.length) {
      messages.push(
        f.cacheControl
          ? {
              role: 'system',
              content: req.system.map((b) => ({ type: 'text', text: b.text, ...(b.cache ? { cache_control: { type: 'ephemeral' } } : {}) }))
            }
          : { role: 'system', content: req.system.map((b) => b.text).join('\n\n') }
      )
    }
    for (const m of req.messages) messages.push({ role: m.role, content: m.content })
    return {
      // Several models: OpenRouter falls through them server-side on rate limits / downtime.
      ...(models.length > 1 ? { models } : { model: models[0] }),
      messages,
      max_tokens: req.maxTokens + f.reasoningHeadroom,
      stream,
      ...(stream && f.includeUsage ? { stream_options: { include_usage: true } } : {}),
      ...(this.noReasoning.has(models[0]) ? {} : f.reasoning(models[0], this.opts.getReasoningEffort(), req.purpose))
    }
  }

  private sendsReasoning(model: string, req: LlmRequest): boolean {
    return Object.keys(this.flavor.reasoning(model, this.opts.getReasoningEffort(), req.purpose)).length > 0
  }

  private async httpError(res: Response): Promise<LlmError> {
    let error: ErrorBody | undefined
    try {
      const body = (await res.json()) as Chunk | Chunk[]
      // Gemini wraps errors in an array.
      error = (Array.isArray(body) ? body[0] : body)?.error
      if (error) this.log.warn(`HTTP ${res.status}: ${JSON.stringify(error).slice(0, 1000)}`)
    } catch {
      // non-JSON error body
    }
    const detail = error ? describe(error) : ''
    const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'))
    const status = res.status
    const label = this.label

    if (/data policy/i.test(detail)) {
      return new LlmError(
        'other',
        "Your OpenRouter privacy settings block this model's providers. Allow free-model endpoints at openrouter.ai/settings/privacy, or pick another model.",
        status
      )
    }
    if (status === 401 || status === 403) {
      return new LlmError('auth', `${label} rejected the API key — check it in Settings.`, status, { scope: 'provider' })
    }
    if (status === 402) return new LlmError('exhausted', `${label} account is out of credits.`, status, { scope: 'provider' })
    if (status === 404) return new LlmError('other', `Model not found on ${label}${detail ? ` (${detail})` : ''}.`, status)
    if (status === 429) {
      // OpenRouter's free-model cap is account-wide (50/day without credits); Groq/Gemini daily caps are per model.
      if (this.opts.id === 'openrouter' && /per[- ]?day/i.test(detail)) {
        return new LlmError('exhausted', 'OpenRouter free-model daily limit reached (50/day without credits).', status, {
          scope: 'provider',
          retryAfterMs
        })
      }
      const daily = /per day|\bRPD\b|daily|PerDay/i.test(detail)
      return new LlmError(daily ? 'exhausted' : 'rate_limit', `Rate limited${detail ? ` — ${detail}` : ` by ${label}.`}`, status, { retryAfterMs })
    }
    if (status === 502 || status === 503 || status === 529) {
      return new LlmError('overloaded', `${label} unavailable${detail ? `: ${detail}` : ''}.`, status, { retryAfterMs })
    }
    return new LlmError('other', `${label} error ${status}${detail ? `: ${detail}` : ''}`, status)
  }

  /** Errors delivered inside the stream after a 200. */
  private chunkError(e: ErrorBody): LlmError {
    const status = typeof e.code === 'number' ? e.code : undefined
    const message = describe(e) || `${this.label} stream error`
    if (status === 429) return new LlmError('rate_limit', message, status)
    if (status === 502 || status === 503 || status === 529) return new LlmError('overloaded', message, status)
    if (status === 401 || status === 403) return new LlmError('auth', message, status, { scope: 'provider' })
    return new LlmError(/overload|unavailable|disconnect|server_error/i.test(`${e.code} ${message}`) ? 'overloaded' : 'other', message, status)
  }

  private toLlmError(err: unknown, signal?: AbortSignal): LlmError {
    if (err instanceof LlmError) return err
    if (signal?.aborted) return new LlmError('aborted', 'Canceled')
    if (err instanceof DOMException && err.name === 'TimeoutError') return new LlmError('network', `${this.label} timed out.`)
    const msg = err instanceof Error ? err.message : String(err)
    return new LlmError('network', `Could not reach ${this.label} — check your connection. (${msg})`)
  }
}

/** Parse an SSE body into JSON chunks, skipping `: keep-alive` comments and `[DONE]`. */
export async function* sseChunks(body: ReadableStream<Uint8Array>): AsyncGenerator<Chunk> {
  const decoder = new TextDecoder()
  let buf = ''
  for await (const bytes of body as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(bytes, { stream: true })
    let nl: number
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (data === '[DONE]') return
      try {
        yield JSON.parse(data) as Chunk
      } catch {
        // Ignore a malformed frame rather than failing the whole answer.
      }
    }
  }
}

function toResult(text: string, finish: string | null, chunk: Chunk, requestedModel: string): LlmResult {
  if (finish === 'content_filter') throw new LlmError('refusal', 'The model declined to answer this one.')
  const u = chunk.usage ?? {}
  const cacheRead = u.prompt_tokens_details?.cached_tokens ?? 0
  const cacheWrite = u.prompt_tokens_details?.cache_write_tokens ?? 0
  return {
    text,
    truncated: finish === 'length',
    usage: {
      model: chunk.model ?? requestedModel,
      ...(chunk.provider ? { provider: chunk.provider } : {}),
      // OpenAI-style prompt_tokens includes cached tokens; report them separately like Anthropic does.
      inputTokens: Math.max(0, (u.prompt_tokens ?? 0) - cacheRead - cacheWrite),
      outputTokens: u.completion_tokens ?? 0,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite
    }
  }
}

/** "Provider returned error" alone says nothing; add which upstream failed and why. */
function describe(e: ErrorBody): string {
  const provider = e.metadata?.provider_name
  const raw = typeof e.metadata?.raw === 'string' ? e.metadata.raw : e.metadata?.raw ? JSON.stringify(e.metadata.raw) : ''
  const reason = raw ? (extractMessage(raw) ?? raw).replace(/\s+/g, ' ').slice(0, 200) : ''
  const message = e.message?.replace(/\s+/g, ' ').slice(0, 300)
  return [provider, message, reason && reason !== message ? reason : ''].filter(Boolean).join(': ')
}

/** Pull `error.message` / `message` out of a provider's raw JSON payload, if it is JSON. */
function extractMessage(raw: string): string | undefined {
  try {
    const j = JSON.parse(raw) as { error?: { message?: string } | string; message?: string }
    return typeof j.error === 'string' ? j.error : (j.error?.message ?? j.message)
  } catch {
    return undefined
  }
}
