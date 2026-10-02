import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QuestionDetector, guessType, heuristic, looksIncomplete, parseClassifierOutput } from '../src/main/services/detect/QuestionDetector'

describe('heuristic', () => {
  it.each([
    'What is your experience with React?',
    'So tell me about yourself',
    'Okay, walk me through your last project',
    'Can you explain how a hash map works',
    'I want to hear how would you scale this service',
    'Design a URL shortener',
    'And why?'
  ])('flags a question: %s', (text) => {
    expect(heuristic(text, 6)).toBe('question')
  })

  it.each(['Okay.', 'Great, thanks.', 'Mm-hm', 'How are you doing today?', 'Can you hear me?'])('ignores %s', (text) => {
    expect(heuristic(text, 6)).toBe('not')
  })

  it('is inconclusive for longer statements without cues', () => {
    expect(heuristic('I would like to understand your experience with distributed caching', 6)).toBe('inconclusive')
  })
})

describe('looksIncomplete', () => {
  it.each([
    'So you want me to give an example of your',
    "So you're asking me about how the virtual",
    'use context and use',
    'Tell me about the.',
    'And what about'
  ])('cut off: %s', (text) => expect(looksIncomplete(text)).toBe(true))

  it.each(['virtual DOM works.', 'What is useState?', 'Tell me about yourself.', 'Okay, great!', 'Why?', 'He said "really?"'])(
    'finished: %s',
    (text) => expect(looksIncomplete(text)).toBe(false)
  )
})

describe('guessType', () => {
  it.each([
    ['Tell me about a time you disagreed with your manager', 'behavioral'],
    ['Write a function to reverse a linked list', 'coding'],
    ['How would you design a chat system for millions of users', 'system_design'],
    ['What is the difference between TCP and UDP', 'technical'],
    ['What would you do if a release broke production', 'situational']
  ])('%s -> %s', (text, type) => {
    expect(guessType(text)).toBe(type)
  })
})

describe('parseClassifierOutput', () => {
  it('parses plain JSON', () => {
    expect(parseClassifierOutput('{"is_question": true, "type": "coding", "clean_question": "Reverse a list"}')).toEqual({
      isQuestion: true,
      type: 'coding',
      cleanQuestion: 'Reverse a list'
    })
  })

  it('strips code fences and surrounding prose', () => {
    const raw = 'Here you go:\n```json\n{"is_question": false, "type": "smalltalk", "clean_question": ""}\n```'
    expect(parseClassifierOutput(raw)).toEqual({ isQuestion: false, type: 'smalltalk', cleanQuestion: '' })
  })

  it('maps unknown types to other', () => {
    expect(parseClassifierOutput('{"is_question": true, "type": "trivia", "clean_question": "x"}')?.type).toBe('other')
  })

  it.each(['', 'not json', '{"is_question": "yes"}', '{broken'])('returns null for %j', (raw) => {
    expect(parseClassifierOutput(raw)).toBeNull()
  })
})

describe('QuestionDetector', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const make = (classify: (u: string, c: string[], s: AbortSignal) => Promise<string>) =>
    new QuestionDetector({ classify, minWords: () => 6 })

  it('answers heuristic hits without calling the classifier', async () => {
    const classify = vi.fn()
    const d = await make(classify).detect(['We have a big monolith.', 'How would you split it?'], [])
    expect(d).toMatchObject({ isQuestion: true, via: 'heuristic', question: 'We have a big monolith. How would you split it?' })
    expect(classify).not.toHaveBeenCalled()
  })

  it('skips the classifier for short non-questions', async () => {
    const classify = vi.fn()
    const d = await make(classify).detect(['Okay, sounds good.'], [])
    expect(d.isQuestion).toBe(false)
    expect(classify).not.toHaveBeenCalled()
  })

  it('uses the classifier for inconclusive text and its clean question', async () => {
    const classify = vi.fn(async () => '{"is_question": true, "type": "technical", "clean_question": "Explain Kubernetes pods."}')
    const d = await make(classify).detect(['I would like to understand your experience with kubernetes pods'], ['earlier'])
    expect(classify).toHaveBeenCalledWith('I would like to understand your experience with kubernetes pods', ['earlier'], expect.any(AbortSignal))
    expect(d).toEqual({ isQuestion: true, type: 'technical', question: 'Explain Kubernetes pods.', via: 'classifier' })
  })

  it('does not answer classifier smalltalk', async () => {
    const d = await make(async () => '{"is_question": true, "type": "smalltalk", "clean_question": "Nice weather?"}').detect(
      ['I hope the weather has been nice where you are this week'],
      []
    )
    expect(d.isQuestion).toBe(false)
  })

  it('on classifier timeout treats 8+ words as a question and aborts the call', async () => {
    let signal: AbortSignal | undefined
    const classify = (_u: string, _c: string[], s: AbortSignal) => {
      signal = s
      return new Promise<string>(() => {})
    }
    const p = make(classify).detect(['I would like to understand your experience with kubernetes pods'], [])
    await vi.advanceTimersByTimeAsync(1500)
    expect(await p).toMatchObject({ isQuestion: true, via: 'timeout' })
    expect(signal?.aborted).toBe(true)
  })

  it('on timeout keeps 6-7 word statements as non-questions', async () => {
    const p = make(() => new Promise<string>(() => {})).detect(['Our team mostly ships backend services'], [])
    await vi.advanceTimersByTimeAsync(1500)
    expect((await p).isQuestion).toBe(false)
  })

  it('falls back to the word rule when the classifier fails or returns junk', async () => {
    const text = ['I would like to understand your experience with kubernetes pods']
    expect(await make(async () => 'nope').detect(text, [])).toMatchObject({ isQuestion: true, via: 'fallback' })
    expect(await make(async () => Promise.reject(new Error('down'))).detect(text, [])).toMatchObject({ isQuestion: true, via: 'fallback' })
  })
})
