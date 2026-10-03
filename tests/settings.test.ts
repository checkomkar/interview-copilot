import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, SettingsSchema, mergeSettings, upgradeSettings, sttModel, sttProviderOrder } from '@shared/settings'

describe('settings schema', () => {
  it('produces PRD §8 defaults from an empty object', () => {
    expect(DEFAULT_SETTINGS.stt).toEqual({ provider: 'deepgram', model: 'nova-3', assemblyaiModel: 'universal-streaming-english', language: 'en', endpointingMs: 300, utteranceEndMs: 1000, openrouterModel: 'openai/whisper-large-v3-turbo, openai/gpt-4o-mini-transcribe, openai/whisper-large-v3', groqModel: 'whisper-large-v3-turbo, whisper-large-v3', fallbackProviders: ['assemblyai', 'groq', 'openrouter'] })
  })

  it('orders STT providers: main first, then backups, without duplicates', () => {
    const s = mergeSettings(DEFAULT_SETTINGS, { stt: { provider: 'groq', fallbackProviders: ['deepgram', 'groq', 'openrouter'] } })
    expect(sttProviderOrder(s)).toEqual(['groq', 'deepgram', 'openrouter'])
    expect(sttModel(s)).toBe('whisper-large-v3-turbo, whisper-large-v3')
    expect(sttModel(s, 'deepgram')).toBe('nova-3')
    expect(DEFAULT_SETTINGS.llm.answerModel).toBe('claude-sonnet-5-5')
    expect(DEFAULT_SETTINGS.llm.fastModel).toBe('claude-haiku-4-5-20251001')
    expect(DEFAULT_SETTINGS.detection).toEqual({ autoAnswer: true, minWords: 6, debounceMs: 2000, pauseGraceMs: 1500 })
    expect(DEFAULT_SETTINGS.overlay.opacity).toBe(0.9)
    expect(DEFAULT_SETTINGS.cost.sessionCapUsd).toBe(5)
    expect(DEFAULT_SETTINGS.preferredLanguage).toBe('TypeScript')
    expect(DEFAULT_SETTINGS.keepScreenshots).toBe(false)
    expect(DEFAULT_SETTINGS.audio.micEnabled).toBe(false)
    expect(DEFAULT_SETTINGS.hotkeys.startStop).toBe('CommandOrControl+Shift+Enter')
  })

  it('fills missing nested fields', () => {
    const s = SettingsSchema.parse({ stt: { model: 'nova-2' } })
    expect(s.stt.model).toBe('nova-2')
    expect(s.stt.endpointingMs).toBe(300)
  })

  it('deep-merges a partial patch without touching siblings', () => {
    const s = mergeSettings(DEFAULT_SETTINGS, { overlay: { opacity: 0.5 } })
    expect(s.overlay.opacity).toBe(0.5)
    expect(s.overlay.fontSize).toBe(15)
    expect(s.stt).toEqual(DEFAULT_SETTINGS.stt)
  })

  it('accepts null to clear nullable fields', () => {
    const withBounds = mergeSettings(DEFAULT_SETTINGS, { overlay: { bounds: { x: 1, y: 2, width: 300, height: 200 } } })
    expect(withBounds.overlay.bounds).toEqual({ x: 1, y: 2, width: 300, height: 200 })
    expect(mergeSettings(withBounds, { overlay: { bounds: null } }).overlay.bounds).toBeNull()
  })

  it('rejects out-of-range values', () => {
    expect(() => mergeSettings(DEFAULT_SETTINGS, { overlay: { opacity: 0.1 } })).toThrow()
    expect(() => mergeSettings(DEFAULT_SETTINGS, { stt: { utteranceEndMs: 500 } })).toThrow()
    expect(() => mergeSettings(DEFAULT_SETTINGS, { llm: { answerModel: '' } })).toThrow()
  })

  it('strips unknown keys (e.g. a smuggled apiKey)', () => {
    const s = mergeSettings(DEFAULT_SETTINGS, { apiKey: 'secret', stt: { foo: 1 } }) as unknown as Record<string, unknown>
    expect(s.apiKey).toBeUndefined()
    expect((s.stt as Record<string, unknown>).foo).toBeUndefined()
  })
})

describe('coding answer settings', () => {
  it('defaults to step-by-step coding answers with room for all three versions', () => {
    expect(DEFAULT_SETTINGS.llm.codingAnswer).toBe('stepwise')
    expect(DEFAULT_SETTINGS.llm.maxTokensCoding).toBe(3000)
  })

  it('raises a saved coding budget still at the old 1500 default, and leaves custom budgets alone', () => {
    const old = mergeSettings(DEFAULT_SETTINGS, { llm: { maxTokensCoding: 1500 } })
    expect(upgradeSettings(old)?.llm.maxTokensCoding).toBe(3000)
    expect(upgradeSettings(mergeSettings(DEFAULT_SETTINGS, { llm: { maxTokensCoding: 2000 } }))).toBeNull()
  })
})

describe('hotkey upgrades', () => {
  it('moves the old add-screenshot hotkey (often owned by other apps) to Ctrl+Shift+Alt+S', () => {
    expect(DEFAULT_SETTINGS.hotkeys.addScreenshot).toBe('CommandOrControl+Shift+Alt+S')
    const old = mergeSettings(DEFAULT_SETTINGS, { hotkeys: { addScreenshot: 'CommandOrControl+Alt+S' } })
    expect(upgradeSettings(old)?.hotkeys.addScreenshot).toBe('CommandOrControl+Shift+Alt+S')
    expect(upgradeSettings(mergeSettings(DEFAULT_SETTINGS, { hotkeys: { addScreenshot: 'F9' } }))).toBeNull()
  })

  it('defaults to 5 screenshots per question, capped at 10', () => {
    expect(DEFAULT_SETTINGS.screen.maxScreenshots).toBe(5)
    expect(() => mergeSettings(DEFAULT_SETTINGS, { screen: { maxScreenshots: 11 } })).toThrow()
  })
})
