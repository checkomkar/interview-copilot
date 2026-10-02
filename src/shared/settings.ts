import { z } from 'zod'

/** Window bounds persisted for the overlay (FR-O1). */
const BoundsSchema = z.object({
  x: z.number().int(),
  y: z.number().int(),
  width: z.number().int().min(200),
  height: z.number().int().min(120)
})

const HotkeysSchema = z.object({
  startStop: z.string().default('CommandOrControl+Shift+Enter'),
  answerNow: z.string().default('CommandOrControl+Shift+Space'),
  screenshot: z.string().default('CommandOrControl+Shift+S'),
  regenerate: z.string().default('CommandOrControl+Shift+R'),
  shorter: z.string().default('CommandOrControl+Shift+D'),
  toggleOverlay: z.string().default('CommandOrControl+Shift+H'),
  prevAnswer: z.string().default('CommandOrControl+Shift+Left'),
  nextAnswer: z.string().default('CommandOrControl+Shift+Right'),
  toggleAutoAnswer: z.string().default('CommandOrControl+Shift+A'),
  toggleVoiceAsk: z.string().default('CommandOrControl+Shift+M'),
  focusAsk: z.string().default('CommandOrControl+Shift+K')
})

export const LLM_PROVIDERS = ['anthropic', 'openrouter', 'groq', 'gemini'] as const
export type LlmProviderId = (typeof LLM_PROVIDERS)[number]
/** Providers spoken to over the OpenAI-compatible chat completions API. */
export type CompatProviderId = Exclude<LlmProviderId, 'anthropic'>

/** A model field lists up to this many IDs (comma or newline separated), tried in order. */
export const MAX_MODEL_CHAIN = 12

/**
 * One-click OpenRouter model chains. `free` costs nothing but is capped at 20 requests/min and
 * 50/day without purchased credits; its upstreams share quota with every free user, so the chain
 * spreads across many different upstreams, ending with OpenRouter's own free router. Free
 * endpoints may log or train on prompts.
 */
export const OPENROUTER_PRESETS = {
  free: {
    label: 'Free (testing)',
    answerModel: [
      'google/gemma-4-31b-it:free',
      'nvidia/nemotron-3-super-120b-a12b:free',
      'qwen/qwen3.8-27b:free',
      'cohere/north-mini-code:free',
      'thinkingmachines/inkling:free',
      'poolside/laguna-s-2.1:free',
      'nvidia/nemotron-3-ultra-550b-a55b:free',
      'google/gemma-4-26b-a4b-it:free',
      'thinkingmachines/inkling-small:free',
      'inclusionai/ling-3.0-flash-sante:free',
      'poolside/laguna-xs-2.1:free',
      'openrouter/free'
    ].join(', '),
    fastModel: [
      'google/gemma-4-26b-a4b-it:free',
      'nvidia/nemotron-3.5-lightning:free',
      'thinkingmachines/inkling-small:free',
      'poolside/laguna-xs-2.1:free',
      'liquid/lfm-2.5-2.6b:free',
      'qwen/qwen3.8-27b:free',
      'cohere/north-mini-code:free',
      'inclusionai/ling-3.0-flash-sante:free',
      'nvidia/nemotron-3-super-120b-a12b:free',
      'openrouter/free'
    ].join(', ')
  },
  claude: { label: 'Claude', answerModel: 'anthropic/claude-sonnet-5.5', fastModel: 'anthropic/claude-haiku-4.5' }
} as const

/** Free-tier defaults; each model has its own daily quota, so a chain also outlasts one model's cap. */
const GROQ_DEFAULTS = {
  answerModel: 'openai/gpt-oss-120b, qwen/qwen3.8-27b, openai/gpt-oss-20b',
  fastModel: 'openai/gpt-oss-20b, qwen/qwen3.8-27b, openai/gpt-oss-120b'
}
const GEMINI_DEFAULTS = {
  answerModel: 'gemini-3.8-flash, gemini-3.7-flash, gemini-3.5-flash, gemini-3.1-flash-lite',
  fastModel: 'gemini-3.1-flash-lite, gemini-3.5-flash-lite, gemini-3.5-flash'
}

/**
 * Reasoning effort. OpenRouter: unified `reasoning.effort`; Groq / Gemini: `reasoning_effort`.
 * `default` sends nothing and keeps the model's default.
 */
export const REASONING_EFFORTS = ['default', 'none', 'minimal', 'low', 'medium', 'high'] as const
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number]

const compatProvider = (defaults: { answerModel: string; fastModel: string }, reasoningEffort: ReasoningEffort) =>
  z
    .object({
      answerModel: z.string().min(1).default(defaults.answerModel),
      fastModel: z.string().min(1).default(defaults.fastModel),
      reasoningEffort: z.enum(REASONING_EFFORTS).default(reasoningEffort)
    })
    .prefault({})

// `prefault({})` parses the empty object so nested field defaults are applied.
export const SettingsSchema = z.object({
  stt: z
    .object({
      provider: z.enum(['deepgram']).default('deepgram'),
      model: z.string().min(1).default('nova-3'),
      language: z.string().min(1).default('en'),
      endpointingMs: z.number().int().min(10).max(5000).default(300),
      utteranceEndMs: z.number().int().min(1000).max(5000).default(1000)
    })
    .prefault({}),
  llm: z
    .object({
      // Groq: free tier with 1,000 requests/day per model and fast responses; free OpenRouter models are much slower.
      provider: z.enum(LLM_PROVIDERS).default('groq'),
      // Anthropic model IDs (kept at this level for settings saved before OpenRouter support).
      answerModel: z.string().min(1).default('claude-sonnet-5-5'),
      fastModel: z.string().min(1).default('claude-haiku-4-5-20251001'),
      /** Tried in order when the primary provider fails or runs out (only those with an API key). */
      fallbackProviders: z.array(z.enum(LLM_PROVIDERS)).max(LLM_PROVIDERS.length).default(['openrouter', 'gemini']),
      /** OpenRouter: effort applies to answers only (sending it to Haiku-class models would turn thinking on). */
      openrouter: compatProvider(OPENROUTER_PRESETS.free, 'low'),
      /** gpt-oss can't turn reasoning off; `low` keeps it short. */
      groq: compatProvider(GROQ_DEFAULTS, 'low'),
      /** Gemini 3 can't turn thinking off; `minimal` is the fastest setting. */
      gemini: compatProvider(GEMINI_DEFAULTS, 'minimal'),
      maxTokens: z.number().int().min(50).max(8000).default(600),
      maxTokensCoding: z.number().int().min(50).max(16000).default(1500)
    })
    .prefault({}),
  audio: z
    .object({
      micEnabled: z.boolean().default(false),
      micDeviceId: z.string().nullable().default(null)
    })
    .prefault({}),
  detection: z
    .object({
      autoAnswer: z.boolean().default(true),
      minWords: z.number().int().min(1).max(50).default(6),
      debounceMs: z.number().int().min(0).max(10000).default(2000),
      /** After a pause mid-sentence (no closing punctuation, or a hanging word), wait this long for the speaker to go on. 0 = off. */
      pauseGraceMs: z.number().int().min(0).max(5000).default(1500)
    })
    .prefault({}),
  screen: z
    .object({
      alwaysInclude: z.boolean().default(false),
      displayId: z.string().nullable().default(null),
      maxEdgePx: z.number().int().min(400).max(4000).default(1600)
    })
    .prefault({}),
  overlay: z
    .object({
      opacity: z.number().min(0.4).max(1).default(0.9),
      fontSize: z.number().int().min(12).max(22).default(15),
      theme: z.enum(['dark', 'light']).default('dark'),
      /** `single`: one Q&A at a time with prev/next. `list`: every Q&A of the session in one scroll. */
      view: z.enum(['single', 'list']).default('single'),
      bounds: BoundsSchema.nullable().default(null)
    })
    .prefault({}),
  cost: z.object({ sessionCapUsd: z.number().min(0).default(5) }).prefault({}),
  hotkeys: HotkeysSchema.prefault({}),
  preferredLanguage: z.string().min(1).default('TypeScript'),
  keepScreenshots: z.boolean().default(false)
})

export type Settings = z.infer<typeof SettingsSchema>
export type HotkeyAction = keyof Settings['hotkeys']

export const DEFAULT_SETTINGS: Settings = SettingsSchema.parse({})

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object | null
    ? T[K] extends unknown[] | null
      ? T[K]
      : DeepPartial<T[K]>
    : T[K]
}

export const API_KEY_PROVIDERS = ['deepgram', 'anthropic', 'openrouter', 'groq', 'gemini'] as const
export type ApiKeyProvider = (typeof API_KEY_PROVIDERS)[number]

/** What renderers see about API keys: presence only, never the value. */
export type ApiKeyStatus = Record<ApiKeyProvider, boolean>

/** OpenRouter free presets from earlier versions; saved settings still holding one are upgraded. */
const LEGACY_FREE_PRESETS = [
  { answerModel: 'google/gemma-4-31b-it:free', fastModel: 'google/gemma-4-26b-a4b-it:free' },
  {
    answerModel: 'google/gemma-4-31b-it:free, nvidia/nemotron-3-super-120b-a12b:free, openrouter/free',
    fastModel: 'google/gemma-4-26b-a4b-it:free, nvidia/nemotron-3.5-lightning:free, openrouter/free'
  }
]

/** Returns upgraded settings, or null when nothing needed changing. */
export function upgradeSettings(settings: Settings): Settings | null {
  const or = settings.llm.openrouter
  if (!LEGACY_FREE_PRESETS.some((p) => p.answerModel === or.answerModel && p.fastModel === or.fastModel)) return null
  const { answerModel, fastModel } = OPENROUTER_PRESETS.free
  return { ...settings, llm: { ...settings.llm, openrouter: { ...or, answerModel, fastModel } } }
}

export type ModelRole = 'answer' | 'fast'

/** Answer/fast model chains configured for one provider. */
export function modelsFor(settings: Settings, provider: LlmProviderId): { answerModel: string; fastModel: string } {
  const { answerModel, fastModel } = provider === 'anthropic' ? settings.llm : settings.llm[provider]
  return { answerModel, fastModel }
}

/** Answer/fast model chains for the primary LLM provider. */
export function activeModels(settings: Settings): { answerModel: string; fastModel: string } {
  return modelsFor(settings, settings.llm.provider)
}

/** Primary provider, then the selected fallbacks, without duplicates. */
export function providerOrder(settings: Settings): LlmProviderId[] {
  return [...new Set([settings.llm.provider, ...settings.llm.fallbackProviders])]
}

/** Split a model field into its IDs ("a, b" or one per line), capped at MAX_MODEL_CHAIN. */
export function splitModels(field: string): string[] {
  return field
    .split(/[,\n]/)
    .map((m) => m.trim())
    .filter(Boolean)
    .slice(0, MAX_MODEL_CHAIN)
}

export const LLM_PROVIDER_LABELS: Record<LlmProviderId, string> = {
  anthropic: 'Anthropic',
  openrouter: 'OpenRouter',
  groq: 'Groq',
  gemini: 'Google Gemini'
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Deep-merge a partial patch into settings, then re-validate. Throws on invalid values. */
export function mergeSettings(base: Settings, patch: unknown): Settings {
  const merge = (a: unknown, b: unknown): unknown => {
    if (!isPlainObject(a) || !isPlainObject(b)) return b === undefined ? a : b
    const out: Record<string, unknown> = { ...a }
    for (const [k, v] of Object.entries(b)) out[k] = merge(a[k], v)
    return out
  }
  return SettingsSchema.parse(merge(base, patch))
}
