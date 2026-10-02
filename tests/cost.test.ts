import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AnswerUsage, CostStatus } from '@shared/ipc'
import { DEFAULT_SETTINGS, mergeSettings, type Settings } from '@shared/settings'
import { CostTracker } from '../src/main/services/cost/CostTracker'
import { lookup, priceLlm, priceStt, readPricing, type Pricing } from '../src/main/services/cost/pricing'

const BUNDLED = join(__dirname, '..', 'config', 'pricing.json')

const usage = (over: Partial<AnswerUsage> = {}): AnswerUsage => ({
  model: 'claude-sonnet-5-5',
  service: 'Anthropic',
  inputTokens: 1_000_000,
  outputTokens: 100_000,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  ...over
})

describe('pricing', () => {
  const pricing = readPricing(BUNDLED)

  it('reads the bundled table and ignores notes and parked prices', () => {
    expect(Object.keys(pricing.llm.gemini)).toEqual(['*'])
    expect(pricing.stt.deepgram['*'].perMinute).toBeGreaterThan(0)
  })

  it('prefers exact keys, then the most specific pattern', () => {
    const table = { '*': 1, 'claude-*': 2, 'claude-haiku-4-5*': 3, 'claude-x': 4 }
    expect(lookup(table, 'claude-x')).toBe(4)
    expect(lookup(table, 'claude-haiku-4-5-20251001')).toBe(3)
    expect(lookup(table, 'claude-sonnet-5-5')).toBe(2)
    expect(lookup(table, 'gpt')).toBe(1)
    expect(lookup({ 'a.b': 1 }, 'aXb')).toBeUndefined()
  })

  it('prices Anthropic tokens including cache reads and writes', () => {
    // Sonnet 5.5: $2 in, $10 out, $0.2 cache read, $2.5 cache write per 1M.
    expect(priceLlm(pricing, usage())).toBeCloseTo(2 + 1)
    expect(priceLlm(pricing, usage({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000 }))).toBeCloseTo(2.7)
    expect(priceLlm(pricing, usage({ model: 'claude-haiku-4-5-20251001' }))).toBeCloseTo(1 + 0.5)
  })

  it('counts free tiers as $0 and uses the API-reported cost when present', () => {
    expect(priceLlm(pricing, usage({ service: 'Groq', model: 'openai/gpt-oss-120b' }))).toBe(0)
    expect(priceLlm(pricing, usage({ service: 'Google Gemini', model: 'models/gemini-3.8-flash' }))).toBe(0)
    expect(priceLlm(pricing, usage({ service: 'OpenRouter', model: 'google/gemma-4-31b-it:free' }))).toBe(0)
    expect(priceLlm(pricing, usage({ service: 'OpenRouter', model: 'anything', costUsd: 0.42 }))).toBe(0.42)
  })

  it('returns null for unpriced models', () => {
    expect(priceLlm(pricing, usage({ service: 'OpenRouter', model: 'some/paid-model' }))).toBeNull()
    expect(priceLlm(pricing, usage({ service: undefined }))).toBeNull()
  })

  it('prices streamed audio per minute', () => {
    expect(priceStt(pricing, 'deepgram', 'nova-3', 120)).toBeCloseTo(2 * pricing.stt.deepgram['*'].perMinute)
    expect(priceStt(pricing, 'other', 'x', 60)).toBeNull()
  })

  describe('user files', () => {
    let dir: string
    afterEach(() => rmSync(dir, { recursive: true, force: true }))

    it('rejects invalid prices with a readable message', () => {
      dir = mkdtempSync(join(tmpdir(), 'pricing-'))
      const path = join(dir, 'pricing.json')
      writeFileSync(path, JSON.stringify({ llm: { groq: { '*': { input: 'free' } } } }))
      expect(() => readPricing(path)).toThrow(/invalid price for "\*"/)
    })
  })
})

describe('CostTracker', () => {
  const pricing: Pricing = {
    stt: { deepgram: { '*': { perMinute: 0.6 } } },
    llm: { anthropic: { 'claude-*': { input: 1, output: 1 } } }
  }
  function setup(cap = 1) {
    let settings: Settings = mergeSettings(DEFAULT_SETTINGS, { cost: { sessionCapUsd: cap } })
    let now = 0
    const t = new CostTracker({ getPricing: () => pricing, getSettings: () => settings, now: () => now })
    const updates: number[] = []
    const statuses: CostStatus[] = []
    t.on('update', (u) => updates.push(u.usd))
    t.on('status', (s) => statuses.push(s))
    return {
      t,
      updates,
      statuses,
      tick: (ms: number) => (now += ms),
      setCap: (c: number) => (settings = mergeSettings(settings, { cost: { sessionCapUsd: c } }))
    }
  }
  const tokens = (n: number) => usage({ inputTokens: n, outputTokens: 0 })

  it('adds up LLM and STT costs and token counts', () => {
    const { t } = setup(0)
    t.addLlm(usage({ inputTokens: 500_000, outputTokens: 500_000, cacheReadTokens: 10 }))
    t.addStt('deepgram', 'nova-3', 60)
    expect(t.total()).toBeCloseTo(1 + 0.6)
    expect(t.snapshot()).toMatchObject({ sttSeconds: 60, inputTokens: 500_000, outputTokens: 500_000, cacheReadTokens: 10, status: 'ok' })
  })

  it('warns at 80% of the cap and caps at 100%, notifying once each', () => {
    const { t, statuses } = setup(1)
    t.addLlm(tokens(500_000))
    expect(t.snapshot().status).toBe('ok')
    t.addLlm(tokens(300_000))
    t.addLlm(tokens(10_000))
    expect(t.snapshot().status).toBe('warn')
    t.addLlm(tokens(200_000))
    expect(t.isCapped()).toBe(true)
    t.addLlm(tokens(1))
    expect(statuses).toEqual(['warn', 'capped'])
  })

  it('re-evaluates when the cap changes, and 0 means no cap', () => {
    const { t, setCap } = setup(1)
    t.addLlm(tokens(1_500_000))
    expect(t.isCapped()).toBe(true)
    setCap(0)
    t.refresh()
    expect(t.snapshot().status).toBe('ok')
  })

  it('lists unpriced models and counts them as $0', () => {
    const { t } = setup(0)
    expect(t.addLlm(usage({ service: 'OpenRouter', model: 'some/paid' }))).toBe(0)
    expect(t.snapshot().unpriced).toEqual(['OpenRouter some/paid'])
  })

  it('throttles STT updates to about one per second', () => {
    const { t, updates, tick } = setup(0)
    t.addStt('deepgram', 'nova-3', 0.1)
    for (let i = 0; i < 9; i++) {
      tick(100)
      t.addStt('deepgram', 'nova-3', 0.1)
    }
    expect(updates).toHaveLength(1)
    tick(100)
    t.addStt('deepgram', 'nova-3', 0.1)
    expect(updates).toHaveLength(2)
  })

  it('starts from zero on reset', () => {
    const { t } = setup(1)
    t.addLlm(tokens(2_000_000))
    t.reset()
    expect(t.snapshot()).toMatchObject({ usd: 0, status: 'ok', unpriced: [] })
  })
})
