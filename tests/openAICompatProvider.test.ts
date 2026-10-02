import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_SETTINGS,
  OPENROUTER_PRESETS,
  SettingsSchema,
  activeModels,
  mergeSettings,
  providerOrder,
  splitModels,
  upgradeSettings,
  type CompatProviderId,
  type LlmProviderId,
  type ReasoningEffort,
  type Settings
} from '@shared/settings'
import { servedBy } from '@shared/ipc'
import { Cooldowns, cooldownMs, parseRetryAfter } from '../src/main/services/llm/Cooldowns'
import { LlmError, type LlmRequest } from '../src/main/services/llm/LlmProvider'
import { LlmRouter } from '../src/main/services/llm/LlmRouter'
import { OpenAICompatProvider, sseChunks } from '../src/main/services/llm/OpenAICompatProvider'
import { MockLlm } from './mockLlm'

const pick = ({ answerModel, fastModel }: { answerModel: string; fastModel: string }) => ({ answerModel, fastModel })

/** A streaming Response whose body arrives in the given pieces (split anywhere, like real TCP reads). */
function sse(pieces: string[], status = 200): Response {
  const enc = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const p of pieces) c.enqueue(enc.encode(p))
      c.close()
    }
  })
  return new Response(body, { status, headers: { 'Content-Type': 'text/event-stream' } })
}

const frame = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`
const ok = (text = 'ok', model = 'm') => sse([frame({ model, choices: [{ delta: { content: text }, finish_reason: 'stop' }] }), 'data: [DONE]\n\n'])
const rateLimited = (headers: Record<string, string> = {}) =>
  Response.json({ error: { code: 429, message: 'Provider returned error' } }, { status: 429, headers })

type Responder = Response | ((body: Record<string, unknown>) => Response)

function setup(
  responses: Responder | Responder[],
  opts: { id?: CompatProviderId; key?: string | null; effort?: ReasoningEffort; cooldowns?: Cooldowns } = {}
) {
  const queue = Array.isArray(responses) ? [...responses] : null
  const bodies: Record<string, unknown>[] = []
  const fetch = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string)
    bodies.push(body)
    const r = queue ? queue.shift() : (responses as Responder)
    if (!r) throw new Error('unexpected request')
    return typeof r === 'function' ? r(body) : r
  })
  const cooldowns = opts.cooldowns ?? new Cooldowns()
  const provider = new OpenAICompatProvider({
    id: opts.id ?? 'openrouter',
    cooldowns,
    getApiKey: () => (opts.key === undefined ? 'sk-test' : opts.key),
    getReasoningEffort: () => opts.effort ?? 'low',
    fetch: fetch as unknown as typeof globalThis.fetch
  })
  const sent = (i = 0) => {
    const [url, init] = fetch.mock.calls[i] as unknown as [string, RequestInit]
    return { url, headers: init.headers as Record<string, string>, body: bodies[i] }
  }
  return { provider, fetch, sent, bodies, cooldowns }
}

const req = (over: Partial<LlmRequest> = {}): LlmRequest => ({
  model: 'anthropic/claude-sonnet-5.5',
  purpose: 'answer',
  system: [{ text: 'SYSTEM', cache: true }],
  messages: [{ role: 'user', content: 'What is React?' }],
  maxTokens: 600,
  ...over
})

const noop = { onText: () => {} }

describe('OpenAICompatProvider · OpenRouter', () => {
  it('streams deltas, skips keep-alive comments and reads usage from the final chunk', async () => {
    const usage = { prompt_tokens: 1200, completion_tokens: 40, prompt_tokens_details: { cached_tokens: 1000, cache_write_tokens: 0 } }
    const first = frame({ model: 'anthropic/claude-sonnet-5.5', choices: [{ delta: { content: 'Hel' } }] })
    const { provider } = setup(
      sse([
        ': OPENROUTER PROCESSING\n\n',
        first.slice(0, 30),
        first.slice(30),
        frame({ choices: [{ delta: { content: 'lo' }, finish_reason: 'stop' }] }),
        frame({ model: 'anthropic/claude-sonnet-5.5', provider: 'Anthropic', choices: [{ delta: { content: '' }, finish_reason: 'stop' }], usage }),
        'data: [DONE]\n\n'
      ])
    )
    const deltas: string[] = []
    const res = await provider.stream(req(), { onText: (d) => deltas.push(d) })
    expect(deltas).toEqual(['Hel', 'lo'])
    expect(res).toEqual({
      text: 'Hello',
      truncated: false,
      usage: { model: 'anthropic/claude-sonnet-5.5', provider: 'Anthropic', inputTokens: 200, outputTokens: 40, cacheReadTokens: 1000, cacheWriteTokens: 0 }
    })
  })

  it('sends the system prompt with a cache breakpoint, auth header and answer reasoning effort', async () => {
    const { provider, sent } = setup(sse(['data: [DONE]\n\n']))
    await provider.stream(req(), noop)
    const { url, headers, body } = sent()
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions')
    expect(headers.Authorization).toBe('Bearer sk-test')
    expect(body).toEqual({
      model: 'anthropic/claude-sonnet-5.5',
      messages: [
        { role: 'system', content: [{ type: 'text', text: 'SYSTEM', cache_control: { type: 'ephemeral' } }] },
        { role: 'user', content: 'What is React?' }
      ],
      max_tokens: 600,
      stream: true,
      reasoning: { effort: 'low', exclude: true }
    })
  })

  it('omits reasoning for non-answer requests, for "default", and omits an empty system prompt', async () => {
    const a = setup(() => Response.json({ choices: [{ message: { content: '{}' }, finish_reason: 'stop' }] }))
    await a.provider.complete(req({ purpose: 'classify', system: [] }))
    expect(a.sent().body.reasoning).toBeUndefined()
    expect(a.sent().body.messages).toEqual([{ role: 'user', content: 'What is React?' }])
    expect(a.sent().body.stream).toBe(false)

    const b = setup(sse(['data: [DONE]\n\n']), { effort: 'default' })
    await b.provider.stream(req(), noop)
    expect(b.sent().body.reasoning).toBeUndefined()
  })

  it('complete() returns message content and flags truncation', async () => {
    const { provider } = setup(
      Response.json({ model: 'm', choices: [{ message: { content: 'summary' }, finish_reason: 'length' }], usage: { prompt_tokens: 5, completion_tokens: 2 } })
    )
    expect(await provider.complete(req())).toMatchObject({ text: 'summary', truncated: true, usage: { inputTokens: 5, outputTokens: 2 } })
  })

  it('sends a long chain 3 models per request, moving on when a group is rate-limited', async () => {
    const chain = Array.from({ length: 10 }, (_, i) => `v/m${i}:free`).join(', ')
    const { provider, bodies, cooldowns } = setup([rateLimited(), rateLimited(), ok('hi', 'v/m7:free')])
    const res = await provider.stream(req({ model: chain }), noop)
    expect(res.usage.model).toBe('v/m7:free')
    expect(bodies.map((b) => b.models)).toEqual([
      ['v/m0:free', 'v/m1:free', 'v/m2:free'],
      ['v/m3:free', 'v/m4:free', 'v/m5:free'],
      ['v/m6:free', 'v/m7:free', 'v/m8:free']
    ])
    // Failed models are skipped next time, without a request.
    expect(cooldowns.active('openrouter:v/m0:free')).toBe(true)
    expect(cooldowns.active('openrouter:v/m6:free')).toBe(false)
  })

  it('skips cooling models on the next request and says so when all are cooling', async () => {
    const cooldowns = new Cooldowns()
    cooldowns.mark('openrouter:a/x:free', 60_000)
    const { provider, bodies } = setup([ok()], { cooldowns })
    await provider.stream(req({ model: 'a/x:free, b/y:free' }), noop)
    expect(bodies[0].models).toEqual(['b/y:free', 'openrouter/free'])

    cooldowns.mark('openrouter:b/y:free', 60_000)
    cooldowns.mark('openrouter:openrouter/free', 60_000)
    const err = await provider.stream(req({ model: 'a/x:free, b/y:free' }), noop).catch((e) => e)
    expect(err).toMatchObject({ kind: 'rate_limit', message: expect.stringContaining('cooling down') })
  })

  it('uses Retry-After for the cooldown', async () => {
    let now = 0
    const cooldowns = new Cooldowns(() => now)
    const { provider } = setup([rateLimited({ 'retry-after': '120' }), ok()], { cooldowns })
    await provider.stream(req({ model: 'a/x, b/y, c/z, d/w' }), noop)
    now = 119_000
    expect(cooldowns.active('openrouter:a/x')).toBe(true)
    now = 121_000
    expect(cooldowns.active('openrouter:a/x')).toBe(false)
  })

  it.each([
    [401, 'auth'],
    [402, 'exhausted']
  ])('throws account-wide HTTP %i (%s) for the router without trying more models', async (status, kind) => {
    const { provider, fetch } = setup(Response.json({ error: { code: status, message: 'nope' } }, { status }))
    const err = await provider.stream(req({ model: 'a/x, b/y, c/z, d/w' }), noop).catch((e) => e)
    expect(err).toMatchObject({ kind, status, extra: { scope: 'provider' } })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it.each([
    [429, 'rate_limit'],
    [502, 'overloaded'],
    [503, 'overloaded'],
    [404, 'other']
  ])('treats HTTP %i (%s) as model-level and reports it once the chain runs out', async (status, kind) => {
    const { provider, fetch } = setup(() => Response.json({ error: { code: status, message: 'nope' } }, { status }))
    const err = await provider.stream(req({ model: 'a/x' }), noop).catch((e) => e)
    expect(err).toBeInstanceOf(LlmError)
    expect(err).toMatchObject({ kind, status })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('reports which upstream failed and why on provider errors', async () => {
    const raw = JSON.stringify({ error: { code: 429, message: 'Resource has been exhausted (e.g. check quota).', status: 'RESOURCE_EXHAUSTED' } })
    const { provider } = setup(
      Response.json({ error: { code: 429, message: 'Provider returned error', metadata: { provider_name: 'Google AI Studio', raw } } }, { status: 429 })
    )
    const err = await provider.stream(req(), noop).catch((e) => e)
    expect(err.message).toBe('Rate limited — Google AI Studio: Provider returned error: Resource has been exhausted (e.g. check quota).')
  })

  it('explains free-tier failures: data-policy blocks, and the account-wide daily cap', async () => {
    const blocked = setup(Response.json({ error: { code: 404, message: 'No endpoints found matching your data policy (Free model publication)' } }, { status: 404 }))
    await expect(blocked.provider.stream(req(), noop)).rejects.toMatchObject({ message: expect.stringContaining('privacy settings') })

    const daily = setup(Response.json({ error: { code: 429, message: 'Rate limit exceeded: free-models-per-day' } }, { status: 429 }))
    const err = await daily.provider.stream(req({ model: 'a/x:free, b/y:free, c/z:free, d/w:free' }), noop).catch((e) => e)
    expect(err).toMatchObject({ kind: 'exhausted', message: expect.stringContaining('daily limit'), extra: { scope: 'provider' } })
    expect(daily.fetch).toHaveBeenCalledTimes(1)
  })

  it('surfaces errors sent inside the stream after partial text, without trying another model', async () => {
    const { provider, fetch } = setup([
      sse([
        frame({ choices: [{ delta: { content: 'part' } }] }),
        frame({ error: { code: 'server_error', message: 'Provider disconnected unexpectedly' }, choices: [{ delta: { content: '' }, finish_reason: 'error' }] })
      ])
    ])
    const deltas: string[] = []
    const err = await provider.stream(req({ model: 'a/x, b/y, c/z, d/w' }), { onText: (d) => deltas.push(d) }).catch((e) => e)
    expect(deltas).toEqual(['part'])
    expect(err).toMatchObject({ kind: 'overloaded', message: 'Provider disconnected unexpectedly' })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('treats content_filter as a refusal', async () => {
    const { provider } = setup(sse([frame({ choices: [{ delta: { content: '' }, finish_reason: 'content_filter' }] }), 'data: [DONE]\n\n']))
    await expect(provider.stream(req(), noop)).rejects.toMatchObject({ kind: 'refusal' })
  })

  it('requires an API key and reports aborts as aborted', async () => {
    await expect(setup(sse([]), { key: null }).provider.stream(req(), noop)).rejects.toMatchObject({ kind: 'auth' })

    const controller = new AbortController()
    const fetch = vi.fn(async (_u: string, init: RequestInit) => {
      controller.abort()
      throw init.signal?.reason ?? new Error('aborted')
    })
    const provider = new OpenAICompatProvider({
      id: 'openrouter',
      cooldowns: new Cooldowns(),
      getApiKey: () => 'k',
      getReasoningEffort: () => 'low',
      fetch: fetch as unknown as typeof globalThis.fetch
    })
    await expect(provider.stream(req({ signal: controller.signal }), noop)).rejects.toMatchObject({ kind: 'aborted' })
  })

  it('prewarm is a no-op that makes no request', async () => {
    const { provider, fetch } = setup(sse([]))
    expect(await provider.prewarm(req({ maxTokens: 0 }))).toMatchObject({ inputTokens: 0, cacheWriteTokens: 0 })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('ends free-only chains with the free router, up to 12 models', () => {
    const { provider } = setup(sse([]))
    expect(provider.models('google/gemma-4-31b-it:free')).toEqual(['google/gemma-4-31b-it:free', 'openrouter/free'])
    expect(provider.models('a/x:free\nopenrouter/free')).toEqual(['a/x:free', 'openrouter/free'])
    expect(provider.models('a/x:free, anthropic/claude-sonnet-5.5')).toEqual(['a/x:free', 'anthropic/claude-sonnet-5.5'])
    expect(provider.models(Array.from({ length: 15 }, (_, i) => `m${i}:free`).join(','))).toHaveLength(12)
  })

  it('sseChunks ignores malformed frames', async () => {
    const out = []
    for await (const c of sseChunks(sse(['data: {oops\n\n', frame({ model: 'x' })]).body!)) out.push(c)
    expect(out).toEqual([{ model: 'x' }])
  })
})

describe('OpenAICompatProvider · Groq', () => {
  it('sends one model per request with usage and per-model reasoning fields', async () => {
    const { provider, sent } = setup([ok(), ok(), ok()], { id: 'groq', effort: 'medium' })
    await provider.stream(req({ model: 'openai/gpt-oss-120b' }), noop)
    expect(sent(0).url).toBe('https://api.groq.com/openai/v1/chat/completions')
    expect(sent(0).body).toEqual({
      model: 'openai/gpt-oss-120b',
      messages: [
        { role: 'system', content: 'SYSTEM' },
        { role: 'user', content: 'What is React?' }
      ],
      max_tokens: 600 + 1024,
      stream: true,
      stream_options: { include_usage: true },
      reasoning_effort: 'medium',
      include_reasoning: false
    })
    // Qwen hides its <think> text; the classifier turns reasoning off.
    await provider.stream(req({ model: 'qwen/qwen3.8-27b', purpose: 'classify' }), noop)
    expect(sent(1).body).toMatchObject({ reasoning_format: 'hidden', reasoning_effort: 'none' })
    // gpt-oss can't turn reasoning off: the classifier gets low.
    await provider.stream(req({ model: 'openai/gpt-oss-20b', purpose: 'classify' }), noop)
    expect(sent(2).body).toMatchObject({ reasoning_effort: 'low', include_reasoning: false })
  })

  it("falls to the next model when one model's daily quota (RPD) is used up", async () => {
    let now = 0
    const cooldowns = new Cooldowns(() => now)
    const rpd = Response.json(
      { error: { message: 'Rate limit reached for model `openai/gpt-oss-120b` on requests per day (RPD): Limit 1000, Used 1000', code: 'rate_limit_exceeded' } },
      { status: 429 }
    )
    const { provider, bodies } = setup([rpd, ok('hi', 'qwen/qwen3.8-27b')], { id: 'groq', cooldowns })
    const res = await provider.stream(req({ model: 'openai/gpt-oss-120b, qwen/qwen3.8-27b' }), noop)
    expect(res.usage.model).toBe('qwen/qwen3.8-27b')
    expect(bodies.map((b) => b.model)).toEqual(['openai/gpt-oss-120b', 'qwen/qwen3.8-27b'])
    // Daily caps cool the model for an hour, not a minute.
    now = 30 * 60_000
    expect(cooldowns.active('groq:openai/gpt-oss-120b')).toBe(true)
  })

  it('does not append the OpenRouter free router to other providers', () => {
    expect(setup(sse([]), { id: 'groq' }).provider.models('a:free')).toEqual(['a:free'])
  })
})

describe('OpenAICompatProvider · Gemini', () => {
  it('uses the OpenAI-compatible endpoint with minimal thinking and reads array-wrapped errors', async () => {
    const quota = Response.json([{ error: { code: 429, message: 'Resource has been exhausted', status: 'RESOURCE_EXHAUSTED' } }], { status: 429 })
    const { provider, sent } = setup([quota, ok('hi', 'gemini-3.1-flash-lite')], { id: 'gemini', effort: 'minimal' })
    const res = await provider.stream(req({ model: 'gemini-3.8-flash, gemini-3.1-flash-lite' }), noop)
    expect(sent(0).url).toBe('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions')
    expect(sent(0).body).toMatchObject({ model: 'gemini-3.8-flash', reasoning_effort: 'minimal', stream_options: { include_usage: true } })
    expect(res.usage.model).toBe('gemini-3.1-flash-lite')
  })
})

describe('OpenAICompatProvider · reasoning rejected', () => {
  it('retries a model that rejects the reasoning setting once, then keeps sending it without', async () => {
    const reject = Response.json([{ error: { code: 400, message: 'Thinking level MINIMAL is not supported for this model.' } }], { status: 400 })
    const { provider, bodies } = setup([reject, ok('hi'), ok('again')], { id: 'gemini', effort: 'minimal' })
    expect((await provider.stream(req({ model: 'gemini-3.8-flash' }), noop)).text).toBe('hi')
    await provider.stream(req({ model: 'gemini-3.8-flash' }), noop)
    expect(bodies.map((b) => b.reasoning_effort)).toEqual(['minimal', undefined, undefined])
  })
})

describe('Cooldowns', () => {
  it('expires entries and clears by prefix', () => {
    let now = 0
    const c = new Cooldowns(() => now)
    c.mark('groq:a', 1000)
    c.mark('provider:groq', 1000)
    expect(c.active('groq:a')).toBe(true)
    c.clear('groq:')
    expect(c.active('groq:a')).toBe(false)
    expect(c.active('provider:groq')).toBe(true)
    now = 1001
    expect(c.active('provider:groq')).toBe(false)
  })

  it('parses Retry-After and picks defaults per error kind', () => {
    expect(parseRetryAfter('30')).toBe(30_000)
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 0)).toBe(10_000)
    expect(parseRetryAfter(null)).toBeUndefined()
    expect(cooldownMs('rate_limit')).toBe(60_000)
    expect(cooldownMs('exhausted')).toBe(3_600_000)
    expect(cooldownMs('rate_limit', 5000)).toBe(5000)
    expect(cooldownMs('other', undefined, 404)).toBe(600_000)
    expect(cooldownMs('other')).toBe(0)
  })
})

describe('LlmRouter', () => {
  function router(settings: Settings, keys: LlmProviderId[], providers: Partial<Record<LlmProviderId, MockLlm>>) {
    const all = { anthropic: new MockLlm(), openrouter: new MockLlm(), groq: new MockLlm(), gemini: new MockLlm(), ...providers }
    const cooldowns = new Cooldowns()
    const r = new LlmRouter(all, { getSettings: () => settings, hasKey: (id) => keys.includes(id), cooldowns })
    return { r, all, cooldowns }
  }
  const withFallbacks = (provider: LlmProviderId, fallbackProviders: LlmProviderId[]) =>
    mergeSettings(DEFAULT_SETTINGS, { llm: { provider, fallbackProviders } })

  it("fails over to the next keyed provider, with that provider's model chain for the role", async () => {
    const openrouter = new MockLlm([new LlmError('rate_limit', 'all cooling')])
    const groq = new MockLlm([{ tokens: ['hi'] }])
    const settings = withFallbacks('openrouter', ['anthropic', 'groq'])
    const { r, all } = router(settings, ['openrouter', 'groq'], { openrouter, groq })
    const res = await r.stream(req({ role: 'answer' }), noop)
    expect(res.usage.service).toBe('Groq')
    expect(all.anthropic.requests).toHaveLength(0) // no key
    expect(groq.requests[0].model).toBe(settings.llm.groq.answerModel)
  })

  it('puts an exhausted provider on cooldown and skips it next time', async () => {
    const openrouter = new MockLlm([new LlmError('exhausted', 'daily cap', 429, { scope: 'provider' })])
    const gemini = new MockLlm([{ tokens: ['a'] }, { tokens: ['b'] }])
    const { r, cooldowns } = router(withFallbacks('openrouter', ['gemini']), ['openrouter', 'gemini'], { openrouter, gemini })
    await r.stream(req({ role: 'fast' }), noop)
    expect(cooldowns.active('provider:openrouter')).toBe(true)
    await r.stream(req({ role: 'fast' }), noop)
    expect(openrouter.requests).toHaveLength(1)
    expect(gemini.requests).toHaveLength(2)
  })

  it('does not fail over on request errors or partial answers', async () => {
    const openrouter = new MockLlm([new LlmError('other', 'bad request', 400), { tokens: ['half'], error: new LlmError('network', 'dropped') }])
    const groq = new MockLlm()
    const { r } = router(withFallbacks('openrouter', ['groq']), ['openrouter', 'groq'], { openrouter, groq })
    await expect(r.stream(req({ role: 'answer' }), noop)).rejects.toMatchObject({ kind: 'other' })
    await expect(r.stream(req({ role: 'answer' }), noop)).rejects.toMatchObject({ kind: 'network' })
    expect(groq.requests).toHaveLength(0)
  })

  it('needs at least one key, and reports when every provider is cooling down', async () => {
    const { r } = router(withFallbacks('openrouter', ['groq']), [], {})
    await expect(r.stream(req({ role: 'answer' }), noop)).rejects.toMatchObject({ kind: 'auth' })
    const keyed = router(withFallbacks('openrouter', ['groq']), ['groq'], {})
    keyed.cooldowns.mark('provider:groq', 60_000)
    await expect(keyed.r.stream(req({ role: 'answer' }), noop)).rejects.toMatchObject({ kind: 'exhausted' })
  })

  it('prewarms only the main provider', async () => {
    const { r, all } = router(withFallbacks('anthropic', ['groq']), ['anthropic', 'groq'], {})
    await r.prewarm(req())
    expect(all.anthropic.prewarms).toHaveLength(1)
    expect(all.groq.prewarms).toHaveLength(0)
  })
})

describe('provider settings', () => {
  it('defaults to Groq with OpenRouter and Gemini as backups, and keeps older saved settings valid', () => {
    expect(DEFAULT_SETTINGS.llm.provider).toBe('groq')
    expect(DEFAULT_SETTINGS.llm.fallbackProviders).toEqual(['openrouter', 'gemini'])
    const old = SettingsSchema.parse({ llm: { provider: 'anthropic', answerModel: 'claude-opus-5-5', fastModel: 'claude-haiku-4-5', maxTokens: 600, maxTokensCoding: 1500 } })
    expect(pick(old.llm.openrouter)).toEqual(pick(OPENROUTER_PRESETS.free))
    expect(activeModels(old)).toEqual({ answerModel: 'claude-opus-5-5', fastModel: 'claude-haiku-4-5' })
  })

  it('ships 10+ model free OpenRouter chains and free Groq/Gemini chains', () => {
    expect(splitModels(OPENROUTER_PRESETS.free.answerModel).length).toBeGreaterThanOrEqual(10)
    expect(splitModels(OPENROUTER_PRESETS.free.fastModel).length).toBeGreaterThanOrEqual(10)
    expect(splitModels(DEFAULT_SETTINGS.llm.groq.answerModel)[0]).toBe('openai/gpt-oss-120b')
    expect(DEFAULT_SETTINGS.llm.gemini.reasoningEffort).toBe('minimal')
  })

  it('upgrades earlier free OpenRouter presets to the current chain, and nothing else', () => {
    for (const legacy of [
      { answerModel: 'google/gemma-4-31b-it:free', fastModel: 'google/gemma-4-26b-a4b-it:free' },
      {
        answerModel: 'google/gemma-4-31b-it:free, nvidia/nemotron-3-super-120b-a12b:free, openrouter/free',
        fastModel: 'google/gemma-4-26b-a4b-it:free, nvidia/nemotron-3.5-lightning:free, openrouter/free'
      }
    ]) {
      const s = mergeSettings(DEFAULT_SETTINGS, { llm: { openrouter: { ...legacy, reasoningEffort: 'medium' } } })
      expect(upgradeSettings(s)?.llm.openrouter).toEqual({ ...pick(OPENROUTER_PRESETS.free), reasoningEffort: 'medium' })
    }
    expect(upgradeSettings(DEFAULT_SETTINGS)).toBeNull()
    const custom = mergeSettings(DEFAULT_SETTINGS, { llm: { openrouter: { answerModel: 'google/gemma-4-31b-it:free', fastModel: 'x/y:free' } } })
    expect(upgradeSettings(custom)).toBeNull()
  })

  it('orders providers main-first without duplicates and rejects unknown ones', () => {
    const s = mergeSettings(DEFAULT_SETTINGS, { llm: { provider: 'groq', fallbackProviders: ['openrouter', 'groq', 'gemini'] } })
    expect(providerOrder(s)).toEqual(['groq', 'openrouter', 'gemini'])
    expect(activeModels(s)).toEqual(pick(s.llm.groq))
    expect(() => mergeSettings(DEFAULT_SETTINGS, { llm: { provider: 'nope' } })).toThrow()
  })

  it('formats which model and service answered', () => {
    expect(servedBy({ model: 'openai/gpt-oss-120b', service: 'Groq', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })).toBe(
      'gpt-oss-120b · Groq'
    )
    expect(servedBy({ model: 'google/gemma-4-31b-it:free', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })).toBe('gemma-4-31b-it')
  })
})
