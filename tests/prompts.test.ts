import { describe, expect, it } from 'vitest'
import { EMPTY_PROFILE, type Profile } from '@shared/profile'
import { DEFAULT_SETTINGS, mergeSettings } from '@shared/settings'
import { modelOptions } from '../src/main/services/llm/AnthropicProvider'
import {
  answerMaxTokens,
  buildAnswerMessages,
  buildAnswerSystem,
  buildClassifierMessages,
  formatTranscript
} from '../src/main/services/llm/prompts'

const profile: Profile = {
  ...EMPTY_PROFILE,
  name: 'Omkar',
  role: 'Frontend Engineer',
  company: 'Acme',
  notes: 'Top project: payments dashboard',
  resumeText: 'RAW RESUME',
  resumeSummary: '- Led payments dashboard (React, -30% load time)',
  jdText: 'RAW JD',
  jdSummary: '- React, TypeScript'
}

describe('buildAnswerSystem', () => {
  it('is one cacheable block with the profile filled in', () => {
    const blocks = buildAnswerSystem(profile, DEFAULT_SETTINGS)
    expect(blocks).toHaveLength(1)
    expect(blocks[0].cache).toBe(true)
    const text = blocks[0].text
    expect(text).toContain('helping Omkar answer questions')
    expect(text).toContain('for a Frontend Engineer role at Acme')
    expect(text).toContain('<resume_summary>- Led payments dashboard')
    expect(text).toContain('<job_description_summary>- React, TypeScript')
    expect(text).toContain('<candidate_notes>Top project: payments dashboard')
    expect(text).toContain('clean code\n  in TypeScript')
    expect(text).not.toContain('RAW RESUME')
  })

  it('is byte-identical across calls so the prompt cache hits', () => {
    expect(buildAnswerSystem(profile, DEFAULT_SETTINGS)).toEqual(buildAnswerSystem(profile, DEFAULT_SETTINGS))
  })

  it('falls back to raw text without summaries and to neutral wording without a profile', () => {
    const raw = buildAnswerSystem({ ...profile, resumeSummary: '', jdSummary: '' }, DEFAULT_SETTINGS)[0].text
    expect(raw).toContain('<resume_summary>RAW RESUME')
    const empty = buildAnswerSystem(EMPTY_PROFILE, DEFAULT_SETTINGS)[0].text
    expect(empty).toContain('helping the candidate answer questions\nfor a role at the company.')
    expect(empty).toContain('<resume_summary>(not provided)')
  })
})

describe('buildAnswerMessages', () => {
  it('puts transcript, question and style in the user turn', () => {
    const [msg] = buildAnswerMessages({
      question: 'Tell me about a conflict',
      type: 'behavioral',
      style: 'auto',
      transcript: [
        { source: 'loopback', text: 'Hi there' },
        { source: 'mic', text: 'Hello' }
      ]
    })
    expect(msg.role).toBe('user')
    expect(msg.content).toContain('Interviewer: Hi there\nMe: Hello')
    expect(msg.content).toContain('<question type="behavioral">Tell me about a conflict</question>')
    expect(msg.content).toContain('STAR')
    expect(msg.content).not.toContain('much shorter')
  })

  it('adds the shorter instruction', () => {
    const [msg] = buildAnswerMessages({ question: 'q', type: 'technical', style: 'shorter', transcript: [] })
    expect(msg.content).toContain('much shorter')
  })
})

describe('formatTranscript', () => {
  it('keeps the most recent lines within the budget', () => {
    const lines = Array.from({ length: 50 }, (_, i) => ({ source: 'loopback' as const, text: `line ${i} ${'x'.repeat(80)}` }))
    const out = formatTranscript(lines, 500)
    expect(out.length).toBeLessThanOrEqual(500)
    expect(out).toContain('line 49')
    expect(out).not.toContain('line 0 ')
  })

  it('always keeps the last line even if it is long', () => {
    expect(formatTranscript([{ source: 'loopback', text: 'y'.repeat(1000) }], 100)).toHaveLength(1000 + 'Interviewer: '.length)
  })
})

describe('answerMaxTokens', () => {
  it('uses the coding budget for coding/system design and halves for shorter', () => {
    expect(answerMaxTokens('behavioral', 'auto', DEFAULT_SETTINGS)).toBe(600)
    expect(answerMaxTokens('coding', 'auto', DEFAULT_SETTINGS)).toBe(1500)
    expect(answerMaxTokens('system_design', 'auto', DEFAULT_SETTINGS)).toBe(1500)
    expect(answerMaxTokens('technical', 'shorter', DEFAULT_SETTINGS)).toBe(300)
    const s = mergeSettings(DEFAULT_SETTINGS, { llm: { maxTokens: 120 } })
    expect(answerMaxTokens('technical', 'shorter', s)).toBe(100)
  })
})

describe('buildClassifierMessages', () => {
  it('includes context and the latest utterance', () => {
    const [msg] = buildClassifierMessages('so how would you', ['a', 'b'])
    expect(msg.content).toContain('Recent context: "a" "b"')
    expect(msg.content).toContain('Latest utterance: "so how would you"')
  })
})

describe('modelOptions', () => {
  it('turns thinking off on Sonnet 5.5 with low effort and refusal fallback', () => {
    expect(modelOptions('claude-sonnet-5-5')).toEqual({
      thinking: { type: 'between_tools' },
      output_config: { effort: 'low' },
      fallbacks: 'default',
      betas: ['server-side-fallback-2026-07-01']
    })
  })

  it('sends nothing extra to Haiku 4.5 (no effort support)', () => {
    expect(modelOptions('claude-haiku-4-5-20251001')).toEqual({})
    expect(modelOptions('claude-haiku-4-5')).toEqual({})
  })

  it('uses low effort without a thinking override elsewhere', () => {
    expect(modelOptions('claude-opus-5-5')).toEqual({
      output_config: { effort: 'low' },
      fallbacks: 'default',
      betas: ['server-side-fallback-2026-07-01']
    })
    expect(modelOptions('claude-sonnet-4-6')).toEqual({ output_config: { effort: 'low' } })
  })
})
