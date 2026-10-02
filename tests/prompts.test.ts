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
    expect(text).toContain('first explain the problem in my own words, then three')
    expect(text).toContain('Code in TypeScript')
    expect(text).not.toContain('RAW RESUME')
    const direct = buildAnswerSystem(profile, mergeSettings(DEFAULT_SETTINGS, { llm: { codingAnswer: 'direct' } }))[0].text
    expect(direct).toContain('clean code\n  in TypeScript')
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
    expect(answerMaxTokens('coding', 'auto', DEFAULT_SETTINGS)).toBe(3000)
    expect(answerMaxTokens('system_design', 'auto', DEFAULT_SETTINGS)).toBe(3000)
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

describe('step-by-step coding answers', () => {
  const msg = (opts: Partial<Parameters<typeof buildAnswerMessages>[0]> = {}) =>
    buildAnswerMessages({ question: 'Reverse a linked list', type: 'coding', style: 'auto', transcript: [], ...opts })[0].content as string

  it('explains the problem, then pseudocode, brute force with its complexity, then the optimal solution', () => {
    const text = msg()
    const order = ['### 1. Understanding the problem', '### 2. Pseudocode', '### 3. Brute force', '### 4. Optimal'].map((h) => text.indexOf(h))
    expect(order.every((i) => i > 0)).toBe(true)
    expect(order).toEqual([...order].sort((a, b) => a - b))
    expect(text).toContain('why its complexity is poor')
    expect(text).not.toContain('Approach in 2–3 bullets')
  })

  it('gives only the optimal solution for Shorter', () => {
    const text = msg({ style: 'shorter' })
    expect(text).toContain('Give only the optimal solution')
    expect(text).not.toContain('### 2. Pseudocode')
    expect(text).not.toContain('at most 3 bullets')
  })

  it('keeps the single approach + code style when turned off, and leaves other types alone', () => {
    expect(msg({ stepwise: false })).toContain('Approach in 2–3 bullets')
    expect(msg({ type: 'technical' })).not.toContain('Pseudocode')
  })

  it('applies to coding problems shown in screenshots', () => {
    const image = { type: 'image' as const, mediaType: 'image/jpeg' as const, data: 'QUJD' }
    const [m] = buildAnswerMessages({ question: 'Solve', type: 'technical', style: 'auto', transcript: [], images: [image] })
    const text = (m.content as { type: string; text?: string }[]).find((p) => p.type === 'text')!.text!
    expect(text).toContain('If it shows a coding problem, answer it like this:')
    expect(text).toContain('### 1. Understanding the problem')
  })
})

describe('follow-up context', () => {
  const earlier = [{ question: "Solve / answer what's shown on screen.", answer: '### 1. Understanding the problem\nFind the duplicate in nums.' }]

  it('sends earlier Q&As before the transcript and asks for a detailed, specific follow-up answer', () => {
    const text = buildAnswerMessages({ question: 'What did you understand from this question?', type: 'technical', style: 'auto', transcript: [], earlier })[0]
      .content as string
    expect(text.indexOf('<earlier_qa>')).toBeLessThan(text.indexOf('<transcript>'))
    expect(text).toContain(`<question>Solve / answer what's shown on screen.</question>`)
    expect(text).toContain('Find the duplicate in nums.')
    expect(text).toContain('ignore the style above and the ~120-word limit, and answer in detail (150–300 words) about that specific problem')
  })

  it('clips long earlier answers and leaves the block out when there are none', () => {
    const long = [{ question: 'q', answer: 'x'.repeat(5000) }]
    const text = buildAnswerMessages({ question: 'Why?', type: 'other', style: 'auto', transcript: [], earlier: long })[0].content as string
    expect(text).toContain(`${'x'.repeat(1500)}…`)
    expect(text).not.toContain('x'.repeat(1501))
    const none = buildAnswerMessages({ question: 'Why?', type: 'other', style: 'auto', transcript: [] })[0].content as string
    expect(none).not.toContain('earlier_qa')
    expect(none).not.toContain('follows up')
  })

  it('tells the model to answer follow-ups in detail, and gives them the long budget', () => {
    expect(buildAnswerSystem(profile, DEFAULT_SETTINGS)[0].text).toContain('Never answer a follow-up generically')
    expect(answerMaxTokens('technical', 'auto', DEFAULT_SETTINGS, false, true)).toBe(DEFAULT_SETTINGS.llm.maxTokensCoding)
  })
})
