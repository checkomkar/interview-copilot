import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, SettingsSchema, mergeSettings } from '@shared/settings'

describe('settings schema', () => {
  it('produces PRD §8 defaults from an empty object', () => {
    expect(DEFAULT_SETTINGS.stt).toEqual({ provider: 'deepgram', model: 'nova-3', language: 'en', endpointingMs: 300, utteranceEndMs: 1000 })
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
