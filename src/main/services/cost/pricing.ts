import { readFileSync } from 'node:fs'
import { z } from 'zod'
import type { AnswerUsage } from '@shared/ipc'
import { LLM_PROVIDER_LABELS, LLM_PROVIDERS, type LlmProviderId } from '@shared/settings'

/** USD per 1M tokens. */
const TokenPriceSchema = z.object({
  input: z.number().min(0),
  output: z.number().min(0),
  cacheRead: z.number().min(0).optional(),
  cacheWrite: z.number().min(0).optional()
})
export type TokenPrice = z.infer<typeof TokenPriceSchema>

const SttPriceSchema = z.object({ perMinute: z.number().min(0) })

/** Entries whose key starts with `_` are notes / parked prices and ignored. */
const table = <T extends z.ZodType>(entry: T) =>
  z.record(z.string(), z.unknown()).transform((obj, ctx) => {
    const out: Record<string, z.infer<T>> = {}
    for (const [k, v] of Object.entries(obj)) {
      if (k.startsWith('_')) continue
      const parsed = entry.safeParse(v)
      if (!parsed.success) {
        ctx.addIssue({ code: 'custom', message: `invalid price for "${k}"` })
        return z.NEVER
      }
      out[k] = parsed.data
    }
    return out
  })

export const PricingSchema = z.object({
  stt: z.record(z.string(), table(SttPriceSchema)).default({}),
  llm: z.record(z.string(), table(TokenPriceSchema)).default({})
})
export type Pricing = z.infer<typeof PricingSchema>

export const EMPTY_PRICING: Pricing = { stt: {}, llm: {} }

/** Read and validate a pricing file. Throws with a readable message. */
export function readPricing(path: string): Pricing {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown
  const parsed = PricingSchema.safeParse(raw)
  if (!parsed.success) throw new Error(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '))
  return parsed.data
}

/** Exact key first, then the most specific `*` pattern (most literal characters). */
export function lookup<T>(entries: Record<string, T> | undefined, id: string): T | undefined {
  if (!entries) return undefined
  if (id in entries) return entries[id]
  let best: { price: T; score: number } | undefined
  for (const [pattern, price] of Object.entries(entries)) {
    if (!pattern.includes('*')) continue
    const re = new RegExp(`^${pattern.split('*').map(escapeRegExp).join('.*')}$`)
    const score = pattern.replace(/\*/g, '').length
    if (re.test(id) && (!best || score > best.score)) best = { price, score }
  }
  return best?.price
}

const providerByLabel = new Map<string, LlmProviderId>(LLM_PROVIDERS.map((id) => [LLM_PROVIDER_LABELS[id], id]))

/**
 * Cost of one request in USD; null when the model has no price. The API's own figure
 * (OpenRouter) wins over the table.
 */
export function priceLlm(pricing: Pricing, usage: AnswerUsage): number | null {
  if (typeof usage.costUsd === 'number') return usage.costUsd
  const provider = usage.service ? providerByLabel.get(usage.service) : undefined
  if (!provider) return null
  const model = usage.model.replace(/^models\//, '')
  const p = lookup(pricing.llm[provider], model)
  if (!p) return null
  return (
    (usage.inputTokens * p.input +
      usage.outputTokens * p.output +
      usage.cacheReadTokens * (p.cacheRead ?? p.input) +
      usage.cacheWriteTokens * (p.cacheWrite ?? p.input)) /
    1_000_000
  )
}

/** Cost of streaming `seconds` of audio; null when the model has no price. */
export function priceStt(pricing: Pricing, provider: string, model: string, seconds: number): number | null {
  const p = lookup(pricing.stt[provider], model)
  return p ? (seconds / 60) * p.perMinute : null
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
