import { describe, expect, it, vi } from 'vitest'
import { EMPTY_PROFILE } from '@shared/profile'
import { DEFAULT_SETTINGS, OPENROUTER_PRESETS, mergeSettings, type LlmProviderId, type Settings } from '@shared/settings'
import type { AnswerUsage } from '@shared/ipc'
import { AnswerService } from '../src/main/services/answer/AnswerService'
import { Cooldowns } from '../src/main/services/llm/Cooldowns'
import { LlmError, hasImage, messageText, type LlmImagePart, type LlmRequest } from '../src/main/services/llm/LlmProvider'
import { LlmRouter } from '../src/main/services/llm/LlmRouter'
import { OpenAICompatProvider } from '../src/main/services/llm/OpenAICompatProvider'
import { answerMaxTokens, buildAnswerMessages } from '../src/main/services/llm/prompts'
import { MockLlm } from './mockLlm'

const IMAGE: LlmImagePart = { type: 'image', mediaType: 'image/jpeg', data: 'QUJD' }
const noop = { onText: () => {} }

const req = (over: Partial<LlmRequest> = {}): LlmRequest => ({
  model: 'x',
  purpose: 'answer',
  system: [{ text: 'SYSTEM', cache: true }],
  messages: [{ role: 'user', content: [IMAGE, { type: 'text', text: 'Solve this' }] }],
  maxTokens: 600,
  ...over
})

describe('screenshot prompts', () => {
  it('puts the image before the question text and adds the screenshot note', () => {
    const [msg] = buildAnswerMessages({ question: 'Solve it', type: 'technical', style: 'auto', transcript: [], images: [IMAGE] })
    expect(Array.isArray(msg.content)).toBe(true)
    const parts = msg.content as Exclude<typeof msg.content, string>
    expect(parts[0]).toEqual(IMAGE)
    expect(messageText(msg)).toContain('<question type="technical">Solve it</question>')
    expect(messageText(msg)).toContain('screenshot of my screen is attached')
    expect(hasImage({ messages: [msg] })).toBe(true)
  })

  it('sends several screenshots in order and asks for one combined answer', () => {
    const second: LlmImagePart = { ...IMAGE, data: 'REVG' }
    const [msg] = buildAnswerMessages({ question: 'Solve it', type: 'coding', style: 'auto', transcript: [], images: [IMAGE, second] })
    const parts = msg.content as Exclude<typeof msg.content, string>
    expect(parts.slice(0, 2)).toEqual([IMAGE, second])
    expect(messageText(msg)).toContain('2 screenshots of my screen are attached, in order')
    expect(messageText(msg)).toContain('give one answer')
  })

  it('keeps plain text messages when there is no screenshot', () => {
    const [msg] = buildAnswerMessages({ question: 'Q', type: 'technical', style: 'auto', transcript: [] })
    expect(typeof msg.content).toBe('string')
    expect(msg.content).not.toContain('screenshot')
  })

  it('gives screenshots the coding token budget', () => {
    expect(answerMaxTokens('technical', 'auto', DEFAULT_SETTINGS, true)).toBe(DEFAULT_SETTINGS.llm.maxTokensCoding)
    expect(answerMaxTokens('technical', 'auto', DEFAULT_SETTINGS)).toBe(DEFAULT_SETTINGS.llm.maxTokens)
  })
})

describe('vision model settings', () => {
  it('defaults each provider to models that accept images', () => {
    expect(DEFAULT_SETTINGS.llm.groq.visionModel).toBe('qwen/qwen3.8-27b')
    expect(DEFAULT_SETTINGS.llm.openrouter.visionModel).toBe(OPENROUTER_PRESETS.free.visionModel)
    expect(DEFAULT_SETTINGS.llm.visionModel).toBe('claude-sonnet-5-5')
    expect(DEFAULT_SETTINGS.llm.gemini.visionModel).toContain('gemini-3.8-flash')
  })

  it('allows an empty vision chain (provider skipped for screenshots)', () => {
    expect(mergeSettings(DEFAULT_SETTINGS, { llm: { groq: { visionModel: '' } } }).llm.groq.visionModel).toBe('')
  })
})

describe('AnswerService with a screenshot', () => {
  function setup(llm: MockLlm, opts: { capped?: boolean } = {}) {
    const svc = new AnswerService({
      provider: llm,
      getSettings: () => DEFAULT_SETTINGS,
      getProfile: () => EMPTY_PROFILE,
      isCapped: () => Boolean(opts.capped),
      sleep: async () => {}
    })
    const run = (image?: LlmImagePart) =>
      svc.generate({
        question: 'Solve',
        type: 'technical',
        style: 'auto',
        transcript: [],
        images: image ? [image] : undefined,
        signal: new AbortController().signal,
        onText: () => {}
      })
    return run
  }

  it('asks the vision models, retrying once, never the text-only fast models', async () => {
    const llm = new MockLlm([new LlmError('rate_limit', '429'), new LlmError('rate_limit', '429')])
    await expect(setup(llm)(IMAGE)).rejects.toMatchObject({ kind: 'rate_limit' })
    expect(llm.requests.map((r) => r.role)).toEqual(['vision', 'vision'])
    expect(llm.requests[0].model).toBe(DEFAULT_SETTINGS.llm.groq.visionModel)
    expect(llm.requests[0].maxTokens).toBe(DEFAULT_SETTINGS.llm.maxTokensCoding)
    expect(hasImage(llm.requests[0])).toBe(true)
  })

  it('answers with the fast models once the cost cap is reached', async () => {
    const llm = new MockLlm([{ tokens: ['ok'] }])
    await setup(llm, { capped: true })()
    expect(llm.requests[0]).toMatchObject({ role: 'fast', model: DEFAULT_SETTINGS.llm.groq.fastModel })
  })
})

describe('LlmRouter · vision and usage', () => {
  function router(settings: Settings, keys: LlmProviderId[], providers: Partial<Record<LlmProviderId, MockLlm>>) {
    const all = { anthropic: new MockLlm(), openrouter: new MockLlm(), groq: new MockLlm(), gemini: new MockLlm(), ...providers }
    const usage: { usage: AnswerUsage; purpose?: string }[] = []
    const r = new LlmRouter(all, {
      getSettings: () => settings,
      hasKey: (id) => keys.includes(id),
      cooldowns: new Cooldowns(),
      onUsage: (u, rq) => usage.push({ usage: { ...u }, purpose: rq.purpose })
    })
    return { r, all, usage }
  }

  it("sends screenshots to each provider's vision chain and skips providers without one", async () => {
    const settings = mergeSettings(DEFAULT_SETTINGS, {
      llm: { provider: 'groq', fallbackProviders: ['openrouter', 'gemini'], openrouter: { visionModel: '' } }
    })
    const groq = new MockLlm([new LlmError('rate_limit', 'busy')])
    const gemini = new MockLlm([{ tokens: ['seen'] }])
    const { r, all } = router(settings, ['groq', 'openrouter', 'gemini'], { groq, gemini })
    const res = await r.stream(req({ role: 'vision' }), noop)
    expect(res.usage.service).toBe('Google Gemini')
    expect(groq.requests[0].model).toBe('qwen/qwen3.8-27b')
    expect(all.openrouter.requests).toHaveLength(0)
    expect(gemini.requests[0].model).toBe(settings.llm.gemini.visionModel)
  })

  it('explains when no provider has a screenshot model', async () => {
    const settings = mergeSettings(DEFAULT_SETTINGS, { llm: { provider: 'groq', fallbackProviders: [], groq: { visionModel: '' } } })
    const { r } = router(settings, ['groq'], {})
    await expect(r.stream(req({ role: 'vision' }), noop)).rejects.toThrow(/screenshot-capable model/)
  })

  it('reports usage of every successful request, labelled with the service', async () => {
    const { r, usage } = router(DEFAULT_SETTINGS, ['groq'], { groq: new MockLlm([{ tokens: ['a'] }]) })
    await r.stream(req({ role: 'answer', messages: [{ role: 'user', content: 'Q' }] }), noop)
    await r.complete(req({ role: 'fast', purpose: 'classify', messages: [{ role: 'user', content: 'Q' }] }))
    expect(usage.map((u) => [u.usage.service, u.purpose])).toEqual([
      ['Groq', 'answer'],
      ['Groq', 'classify']
    ])
  })

  it('reports prewarm cache writes but not empty prewarms', async () => {
    const settings = mergeSettings(DEFAULT_SETTINGS, { llm: { provider: 'anthropic' } })
    const anthropic = new MockLlm()
    const { r, usage } = router(settings, ['anthropic'], { anthropic })
    await r.prewarm(req({ messages: [{ role: 'user', content: 'Ready.' }] }))
    expect(usage).toHaveLength(1)
    expect(usage[0].usage.service).toBe('Anthropic')
  })
})

describe('OpenAICompatProvider · images and cost', () => {
  function provider(response: Response) {
    const bodies: Record<string, unknown>[] = []
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string))
      return response
    })
    const p = new OpenAICompatProvider({
      id: 'openrouter',
      cooldowns: new Cooldowns(),
      getApiKey: () => 'sk-test',
      getReasoningEffort: () => 'default',
      fetch: fetch as unknown as typeof globalThis.fetch
    })
    return { p, bodies }
  }

  it('sends screenshots as image_url data URLs', async () => {
    const { p, bodies } = provider(Response.json({ model: 'm', choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }))
    await p.complete(req({ model: 'google/gemma-4-31b-it:free' }))
    const messages = bodies[0].messages as { role: string; content: unknown }[]
    expect(messages[1].content).toEqual([
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,QUJD' } },
      { type: 'text', text: 'Solve this' }
    ])
  })

  it("reads OpenRouter's reported cost", async () => {
    const { p } = provider(
      Response.json({
        model: 'anthropic/claude-sonnet-5.5',
        choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 10, cost: 0.0123 }
      })
    )
    const res = await p.complete(req({ model: 'anthropic/claude-sonnet-5.5', messages: [{ role: 'user', content: 'Q' }] }))
    expect(res.usage.costUsd).toBe(0.0123)
  })
})

describe('reasoning models that return nothing', () => {
  function provider(id: 'groq' | 'openrouter', responses: Response[]) {
    const bodies: Record<string, unknown>[] = []
    const queue = [...responses]
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string))
      const r = queue.shift()
      if (!r) throw new Error('unexpected request')
      return r
    })
    const cooldowns = new Cooldowns()
    const p = new OpenAICompatProvider({ id, cooldowns, getApiKey: () => 'k', getReasoningEffort: () => 'low', fetch: fetch as unknown as typeof globalThis.fetch })
    return { p, bodies, cooldowns }
  }
  const reply = (content: string, finish: string, model = 'm') =>
    Response.json({ model, choices: [{ message: { content }, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 3000 } })

  it("turns Groq qwen's thinking off for screenshots but keeps the effort setting for text answers", async () => {
    const { p, bodies } = provider('groq', [reply('a', 'stop'), reply('b', 'stop')])
    await p.complete(req({ model: 'qwen/qwen3.8-27b', role: 'vision' }))
    await p.complete(req({ model: 'qwen/qwen3.8-27b', role: 'answer', messages: [{ role: 'user', content: 'Q' }] }))
    expect(bodies[0]).toMatchObject({ reasoning_effort: 'none', reasoning_format: 'hidden' })
    expect(bodies[1]).toMatchObject({ reasoning_effort: 'low' })
  })

  it('treats a cut-off answer with no text as a failure and tries the next model, benching only that one', async () => {
    const { p, cooldowns } = provider('groq', [reply('', 'length', 'qwen/qwen3.8-27b'), reply('answer', 'stop', 'openai/gpt-oss-120b')])
    const res = await p.complete(req({ model: 'qwen/qwen3.8-27b, openai/gpt-oss-120b', role: 'answer' }))
    expect(res.text).toBe('answer')
    expect(cooldowns.active('groq:qwen/qwen3.8-27b')).toBe(true)
    expect(cooldowns.active('groq:openai/gpt-oss-120b')).toBe(false)
  })

  it("blames OpenRouter's free router when the model it picked returned nothing", async () => {
    const { p, cooldowns } = provider('openrouter', [reply('', 'length', 'dots-studio/dots-3-note-preview:free')])
    await expect(p.complete(req({ model: 'a/x:free, b/y:free, openrouter/free', role: 'vision' }))).rejects.toMatchObject({ kind: 'empty' })
    expect(cooldowns.active('openrouter:openrouter/free')).toBe(true)
    expect(cooldowns.active('openrouter:a/x:free')).toBe(false)
  })

  it('fails over to the next provider when the main one returns nothing', async () => {
    const groq = new MockLlm([new LlmError('empty', 'thought too long')])
    const gemini = new MockLlm([{ tokens: ['solved'] }])
    const settings = mergeSettings(DEFAULT_SETTINGS, { llm: { provider: 'groq', fallbackProviders: ['gemini'] } })
    const r = new LlmRouter(
      { anthropic: new MockLlm(), openrouter: new MockLlm(), groq, gemini },
      { getSettings: () => settings, hasKey: () => true, cooldowns: new Cooldowns() }
    )
    const res = await r.stream(req({ role: 'vision' }), noop)
    expect(res.usage.service).toBe('Google Gemini')
  })
})

describe('paid OpenRouter for screenshots', () => {
  it('tries the chosen screenshot provider first, with text answers keeping the usual order', async () => {
    const settings = mergeSettings(DEFAULT_SETTINGS, {
      llm: { provider: 'groq', fallbackProviders: ['gemini'], visionProvider: 'openrouter', openrouter: { ...OPENROUTER_PRESETS.paid } }
    })
    const openrouter = new MockLlm([{ tokens: ['seen'] }])
    const groq = new MockLlm([{ tokens: ['text'] }])
    const r = new LlmRouter(
      { anthropic: new MockLlm(), openrouter, groq, gemini: new MockLlm() },
      { getSettings: () => settings, hasKey: () => true, cooldowns: new Cooldowns() }
    )
    expect((await r.stream(req({ role: 'vision' }), noop)).usage.service).toBe('OpenRouter')
    expect(openrouter.requests[0].model).toBe(OPENROUTER_PRESETS.paid.visionModel)
    expect((await r.stream(req({ role: 'answer', messages: [{ role: 'user', content: 'Q' }] }), noop)).usage.service).toBe('Groq')
  })

  it('ignores a screenshot provider without a key', async () => {
    const settings = mergeSettings(DEFAULT_SETTINGS, { llm: { provider: 'groq', visionProvider: 'anthropic' } })
    const groq = new MockLlm([{ tokens: ['seen'] }])
    const r = new LlmRouter(
      { anthropic: new MockLlm(), openrouter: new MockLlm(), groq, gemini: new MockLlm() },
      { getSettings: () => settings, hasKey: (id) => id !== 'anthropic', cooldowns: new Cooldowns() }
    )
    expect((await r.stream(req({ role: 'vision' }), noop)).usage.service).toBe('Groq')
  })

  it('sends the paid chain as-is (no free router) with thinking off for screenshots', async () => {
    const bodies: Record<string, unknown>[] = []
    const fetch = vi.fn(async (_u: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string))
      return Response.json({ model: 'qwen/qwen3.8-27b', choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] })
    })
    const p = new OpenAICompatProvider({
      id: 'openrouter',
      cooldowns: new Cooldowns(),
      getApiKey: () => 'k',
      getReasoningEffort: () => 'low',
      fetch: fetch as unknown as typeof globalThis.fetch
    })
    expect(p.models(OPENROUTER_PRESETS.paid.visionModel)).toEqual(['qwen/qwen3.8-27b:nitro', 'google/gemini-3.1-flash-lite', 'meta-llama/llama-4-scout'])
    await p.complete(req({ model: OPENROUTER_PRESETS.paid.visionModel, role: 'vision' }))
    expect(bodies[0]).toMatchObject({ models: ['qwen/qwen3.8-27b:nitro', 'google/gemini-3.1-flash-lite', 'meta-llama/llama-4-scout'], reasoning: { enabled: false } })
  })
})

describe('more screenshots than Groq takes', () => {
  const four = req({ role: 'vision', messages: [{ role: 'user', content: [IMAGE, IMAGE, IMAGE, IMAGE, { type: 'text', text: 'Solve' }] }] })
  const router = (settings: Settings, providers: Partial<Record<LlmProviderId, MockLlm>>) =>
    new LlmRouter(
      { anthropic: new MockLlm(), openrouter: new MockLlm(), groq: new MockLlm(), gemini: new MockLlm(), ...providers },
      { getSettings: () => settings, hasKey: () => true, cooldowns: new Cooldowns() }
    )

  it('skips Groq for more than 3 images and uses the next provider', async () => {
    const groq = new MockLlm([{ tokens: ['x'] }])
    const gemini = new MockLlm([{ tokens: ['seen'] }])
    const s = mergeSettings(DEFAULT_SETTINGS, { llm: { provider: 'groq', fallbackProviders: ['gemini'] } })
    expect((await router(s, { groq, gemini }).stream(four, noop)).usage.service).toBe('Google Gemini')
    expect(groq.requests).toHaveLength(0)
  })

  it('explains when only Groq is set up for screenshots', async () => {
    const s = mergeSettings(DEFAULT_SETTINGS, { llm: { provider: 'groq', fallbackProviders: [] } })
    await expect(router(s, {}).stream(four, noop)).rejects.toThrow(/Groq takes at most 3 screenshots/)
  })
})
