import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AnswerDone, AnswerError, AudioSource, LatencySample, QuestionDetected, TranscriptUpdate } from '@shared/ipc'
import { EMPTY_PROFILE } from '@shared/profile'
import { DEFAULT_SETTINGS, mergeSettings, type Settings } from '@shared/settings'
import { AnswerService } from '../src/main/services/answer/AnswerService'
import { CopilotService } from '../src/main/services/answer/CopilotService'
import { QuestionDetector } from '../src/main/services/detect/QuestionDetector'
import { LlmError } from '../src/main/services/llm/LlmProvider'
import { SessionManager } from '../src/main/services/session/SessionManager'
import { BaseSttProvider } from '../src/main/services/stt/SttProvider'
import { MockLlm } from './mockLlm'

/** Long enough for the classifier timeout and the debounce window; the keep-warm interval rules out runAllTimers. */
const flush = () => vi.advanceTimersByTimeAsync(2500)

let seq = 0
function utterance(text: string, source: AudioSource = 'loopback'): TranscriptUpdate {
  return { id: `u${++seq}`, source, text, isFinal: true, ts: Date.now() }
}

function setup(opts: { settings?: Settings; classify?: () => Promise<string>; voiceAsk?: () => boolean } = {}) {
  let settings = opts.settings ?? DEFAULT_SETTINGS
  const llm = new MockLlm()
  const classify = vi.fn(opts.classify ?? (async () => '{"is_question": false, "type": "other", "clean_question": ""}'))
  const detector = new QuestionDetector({ classify, minWords: () => settings.detection.minWords })
  const answers = new AnswerService({ provider: llm, getSettings: () => settings, getProfile: () => EMPTY_PROFILE, sleep: async () => {} })
  const copilot = new CopilotService({ detector, answers, getSettings: () => settings, isVoiceAsk: opts.voiceAsk })
  const questions: QuestionDetected[] = []
  const tokens: string[] = []
  const done: AnswerDone[] = []
  const errors: AnswerError[] = []
  const latency: LatencySample[] = []
  copilot.on('question', (q) => questions.push(q))
  copilot.on('token', (t) => tokens.push(`${t.id}:${t.delta}`))
  copilot.on('done', (d) => done.push(d))
  copilot.on('error', (e) => errors.push(e))
  copilot.on('latency', (l) => latency.push(l))
  copilot.startSession()
  const setSettings = (patch: unknown) => {
    settings = mergeSettings(settings, patch)
  }
  return { copilot, llm, classify, questions, tokens, done, errors, latency, setSettings }
}

describe('CopilotService', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('answers an interviewer question and reports latency', async () => {
    const { copilot, llm, questions, done, latency } = setup()
    llm.push({ tokens: ['**S**: ', 'migrated'] })
    copilot.onUtteranceEnd(utterance('Tell me about a time you led a migration.'))
    await flush()
    expect(questions).toHaveLength(1)
    expect(questions[0]).toMatchObject({ question: 'Tell me about a time you led a migration.', type: 'behavioral', style: 'auto' })
    expect(done).toHaveLength(1)
    expect(copilot.list()[0]).toMatchObject({ answer: '**S**: migrated', status: 'done' })
    expect(latency.map((l) => l.stage)).toEqual(['detect', 'firstToken'])
    // Transcript includes the question for context.
    expect(llm.requests[0].messages[0].content).toContain('Interviewer: Tell me about a time you led a migration.')
  })

  it('prewarms the prompt cache on session start', () => {
    const { llm } = setup()
    expect(llm.prewarms).toHaveLength(1)
  })

  it('ignores the mic lane and non-questions', async () => {
    const { copilot, questions, classify } = setup()
    copilot.onUtteranceEnd(utterance('What should I say here?', 'mic'))
    copilot.onUtteranceEnd(utterance('Okay, great.'))
    await flush()
    expect(questions).toHaveLength(0)
    expect(classify).not.toHaveBeenCalled()
  })

  it('uses the classifier for inconclusive speech and answers its clean question', async () => {
    const { copilot, questions } = setup({
      classify: async () => '{"is_question": true, "type": "technical", "clean_question": "Describe your Kubernetes experience."}'
    })
    copilot.onUtteranceEnd(utterance('I would love to hear about your experience with kubernetes in production'))
    await flush()
    expect(questions[0]).toMatchObject({ question: 'Describe your Kubernetes experience.', type: 'technical' })
  })

  it('carries earlier statements into the next question (FR-Q1)', async () => {
    const { copilot, questions } = setup()
    copilot.onUtteranceEnd(utterance('We run a large monolith written in Java at the moment'))
    await flush()
    expect(questions).toHaveLength(0)
    copilot.onUtteranceEnd(utterance('How would you break it up?'))
    await flush()
    expect(questions[0].question).toBe('We run a large monolith written in Java at the moment How would you break it up?')
  })

  it('merges a short follow-up into the previous question and regenerates it (FR-Q4)', async () => {
    const { copilot, llm, questions } = setup()
    llm.push({ tokens: ['first'] }, { tokens: ['merged'] })
    copilot.onUtteranceEnd(utterance('What is your favorite database?'))
    await flush()
    vi.advanceTimersByTime(3000)
    copilot.onUtteranceEnd(utterance('And why?'))
    await flush()
    expect(questions).toHaveLength(2)
    expect(questions[1].id).toBe(questions[0].id)
    expect(questions[1].question).toBe('What is your favorite database? And why?')
    expect(copilot.list()).toHaveLength(1)
    expect(copilot.list()[0].answer).toBe('merged')
  })

  it('treats a short question after 10 s as a new question', async () => {
    const { copilot, questions } = setup()
    copilot.onUtteranceEnd(utterance('What is your favorite database?'))
    await flush()
    vi.advanceTimersByTime(11_000)
    copilot.onUtteranceEnd(utterance('Why Postgres?'))
    await flush()
    expect(new Set(questions.map((q) => q.id)).size).toBe(2)
  })

  it('a new question cancels the answer in flight (FR-Q5)', async () => {
    const { copilot, llm, questions, done } = setup()
    llm.push({ tokens: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], delayMs: 500 }, { tokens: ['second'] })
    copilot.onUtteranceEnd(utterance('Walk me through your current architecture and the main services.'))
    await vi.advanceTimersByTimeAsync(3600)
    // Past the resume window: a separate question, not a continuation.
    copilot.onUtteranceEnd(utterance('Explain how you would add a caching layer to it in detail.'))
    await flush()
    expect(questions).toHaveLength(2)
    expect(new Set(questions.map((q) => q.id)).size).toBe(2)
    expect(done.map((d) => d.id)).toEqual([questions[1].id])
    const [first, second] = copilot.list()
    expect(first).toMatchObject({ status: 'error', error: 'Interrupted by the next question.', answer: 'abcdefg' })
    expect(second).toMatchObject({ answer: 'second', status: 'done' })
  })

  it('starts at most one generation per 2 s; a quick continuation waits, then regenerates (FR-Q5)', async () => {
    const { copilot, llm, questions } = setup()
    llm.push({ tokens: ['a', 'b', 'c', 'd'], delayMs: 500 }, { tokens: ['merged'] })
    copilot.onUtteranceEnd(utterance('Walk me through your current architecture and the main services.'))
    await vi.advanceTimersByTimeAsync(600)
    copilot.onUtteranceEnd(utterance('Explain how you would add a caching layer to it in detail.'))
    await vi.advanceTimersByTimeAsync(100)
    // Inside the 2 s window: queued while the first answer keeps streaming.
    expect(questions).toHaveLength(1)
    await flush()
    expect(questions).toHaveLength(2)
    expect(questions[1].id).toBe(questions[0].id)
    expect(questions[1].question).toBe(
      'Walk me through your current architecture and the main services. Explain how you would add a caching layer to it in detail.'
    )
    expect(copilot.list()).toEqual([expect.objectContaining({ answer: 'merged', status: 'done' })])
  })

  it('only answers on the hotkey when auto-answer is off (FR-Q6)', async () => {
    const { copilot, questions, setSettings } = setup()
    setSettings({ detection: { autoAnswer: false } })
    copilot.onUtteranceEnd(utterance('What is a closure?'))
    await flush()
    expect(questions).toHaveLength(0)
    expect(copilot.answerNow()).toEqual({ ok: true })
    await flush()
    expect(questions[0].question).toBe('What is a closure?')
  })

  it('answer-now uses the live partial when nothing is pending, and errors when nothing was heard', async () => {
    const { copilot, questions } = setup()
    expect(copilot.answerNow()).toEqual({ ok: false, error: expect.any(String) })
    copilot.onTranscript({ ...utterance('so how does garbage collection work'), isFinal: false })
    copilot.answerNow()
    await flush()
    expect(questions[0].question).toBe('so how does garbage collection work')
  })

  it('regenerate and shorter re-run the latest answer with the same id', async () => {
    const { copilot, llm, questions } = setup()
    expect(copilot.regenerate().ok).toBe(false)
    llm.push({ tokens: ['long'] }, { tokens: ['again'] }, { tokens: ['short'] })
    copilot.onUtteranceEnd(utterance('What is a closure?'))
    await flush()
    copilot.regenerate()
    await flush()
    copilot.shorter()
    await flush()
    expect(questions.map((q) => q.style)).toEqual(['auto', 'auto', 'shorter'])
    expect(new Set(questions.map((q) => q.id)).size).toBe(1)
    expect(llm.requests[2].maxTokens).toBe(300)
    expect(copilot.list()[0].answer).toBe('short')
  })

  it('keeps partial text and suggests retry when a stream breaks', async () => {
    const { copilot, llm, errors } = setup()
    llm.push({ tokens: ['partial'], error: new LlmError('network', 'dropped') })
    copilot.onUtteranceEnd(utterance('What is a closure?'))
    await flush()
    expect(errors[0]).toMatchObject({ partial: true, message: '⚠ incomplete — Ctrl+Shift+R to retry' })
    expect(copilot.list()[0]).toMatchObject({ answer: 'partial', status: 'error' })
  })

  it('reports errors without partial text as-is', async () => {
    const { copilot, llm, errors } = setup()
    llm.push(new LlmError('auth', 'Add your Anthropic API key in Settings.'))
    copilot.onUtteranceEnd(utterance('What is a closure?'))
    await flush()
    expect(errors[0]).toMatchObject({ partial: false, message: 'Add your Anthropic API key in Settings.' })
  })

  it('answers typed questions immediately, without detection or debounce', async () => {
    const { copilot, questions, classify } = setup()
    expect(copilot.ask('   ')).toEqual({ ok: false, error: expect.any(String) })
    copilot.onUtteranceEnd(utterance('What is a closure?'))
    await vi.advanceTimersByTimeAsync(10)
    expect(copilot.ask('  explain the event loop  ')).toEqual({ ok: true })
    await flush()
    expect(questions.map((q) => q.question)).toEqual(['What is a closure?', 'explain the event loop'])
    expect(classify).not.toHaveBeenCalled()
  })

  it('answers mic speech only while voice questions are on', async () => {
    let voice = false
    const { copilot, questions } = setup({ voiceAsk: () => voice })
    copilot.onUtteranceEnd(utterance('how do I reverse a linked list', 'mic'))
    await flush()
    expect(questions).toHaveLength(0)
    voice = true
    copilot.onUtteranceEnd(utterance('how do I reverse a linked list', 'mic'))
    await flush()
    expect(questions[0]).toMatchObject({ question: 'how do I reverse a linked list', type: 'coding' })
  })

  it('keeps history and the answer in flight when a session starts implicitly', async () => {
    const { copilot, llm, done } = setup()
    llm.push({ tokens: ['a', 'b'], delayMs: 200 })
    copilot.ask('What is a closure?')
    await vi.advanceTimersByTimeAsync(100)
    const resets = vi.fn()
    copilot.on('reset', resets)
    copilot.startSession({ keepHistory: true })
    await flush()
    expect(resets).not.toHaveBeenCalled()
    expect(done).toHaveLength(1)
    expect(copilot.list()[0]).toMatchObject({ answer: 'ab', status: 'done' })
  })

  describe('mid-sentence pauses', () => {
    it('joins an utterance cut off by a pause with the rest when the speaker goes on', async () => {
      const { copilot, questions } = setup()
      copilot.onUtteranceEnd(utterance("So you're asking me about how the virtual"))
      await vi.advanceTimersByTimeAsync(800)
      copilot.onTranscript({ ...utterance('DOM'), isFinal: false })
      await vi.advanceTimersByTimeAsync(800)
      expect(questions).toHaveLength(0)
      copilot.onUtteranceEnd(utterance('DOM works?'))
      await flush()
      expect(questions).toHaveLength(1)
      expect(questions[0].question).toBe("So you're asking me about how the virtual DOM works?")
    })

    it('answers a cut-off sentence after the grace period if nothing follows', async () => {
      const { copilot, questions } = setup()
      copilot.onUtteranceEnd(utterance('So tell me about your experience with'))
      await vi.advanceTimersByTimeAsync(1400)
      expect(questions).toHaveLength(0)
      await flush()
      expect(questions[0].question).toBe('So tell me about your experience with')
    })

    it('answers a finished question with no extra wait', async () => {
      const { copilot, questions } = setup()
      copilot.onUtteranceEnd(utterance('What is a closure?'))
      await vi.advanceTimersByTimeAsync(50)
      expect(questions).toHaveLength(1)
    })

    it('merges the rest of a sentence into the answer already started for its first part', async () => {
      const { copilot, questions } = setup()
      copilot.onUtteranceEnd(utterance('Can you tell me how the virtual'))
      await flush() // grace ran out: answered as-is
      expect(questions).toHaveLength(1)
      vi.advanceTimersByTime(2000)
      copilot.onUtteranceEnd(utterance('DOM works and why React uses it in production apps.'))
      await flush()
      expect(questions).toHaveLength(2)
      expect(questions[1].id).toBe(questions[0].id)
      expect(questions[1].question).toBe('Can you tell me how the virtual DOM works and why React uses it in production apps.')
      expect(copilot.list()).toHaveLength(1)
    })

    it('merges a short continuation that is not a question on its own ("virtual DOM works.")', async () => {
      const { copilot, questions, classify } = setup({
        classify: async () => '{"is_question": true, "type": "technical", "clean_question": "How does the virtual DOM work?"}'
      })
      copilot.onUtteranceEnd(utterance("So you're asking me about how the virtual"))
      await flush()
      expect(questions).toHaveLength(1)
      vi.advanceTimersByTime(1500)
      copilot.onUtteranceEnd(utterance('virtual DOM works.'))
      await flush()
      expect(copilot.list()).toHaveLength(1)
      expect(questions.at(-1)?.question).toBe('How does the virtual DOM work? virtual DOM works.')
      // The continuation skips detection: only the first part was classified.
      expect(classify).toHaveBeenCalledTimes(1)
    })

    it('merges speech that resumes right after a fragment speech-to-text punctuated as finished', async () => {
      const { copilot, questions } = setup()
      // Deepgram closed the utterance at the pause and added "?": answered immediately.
      copilot.onUtteranceEnd(utterance("So you're asking me about how the virtual?"))
      await vi.advanceTimersByTimeAsync(50)
      expect(questions).toHaveLength(1)
      // ~1 s later the interviewer carries on.
      await vi.advanceTimersByTimeAsync(1000)
      copilot.onTranscript({ ...utterance('DOM'), isFinal: false })
      await vi.advanceTimersByTimeAsync(700)
      copilot.onUtteranceEnd(utterance('DOM works.'))
      await flush()
      expect(copilot.list()).toHaveLength(1)
      expect(questions.at(-1)?.question).toBe("So you're asking me about how the virtual? DOM works.")
    })

    it('treats speech long after a question as new, even a short statement', async () => {
      const { copilot, questions } = setup()
      copilot.onUtteranceEnd(utterance('What is a closure?'))
      await flush()
      vi.advanceTimersByTime(20_000)
      copilot.onTranscript({ ...utterance('Great'), isFinal: false })
      copilot.onUtteranceEnd(utterance('Great, thanks.'))
      await flush()
      expect(questions).toHaveLength(1)
    })

    it('joins voice-question fragments, and keeps separate finished voice questions apart', async () => {
      const { copilot, questions } = setup({ voiceAsk: () => true })
      copilot.onUtteranceEnd(utterance('So you want me to give an example of', 'mic'))
      await vi.advanceTimersByTimeAsync(700)
      copilot.onTranscript({ ...utterance('use', 'mic'), isFinal: false })
      copilot.onUtteranceEnd(utterance('useState.', 'mic'))
      await vi.advanceTimersByTimeAsync(50)
      expect(questions.map((q) => q.question)).toEqual(['So you want me to give an example of useState.'])
      vi.advanceTimersByTime(3000)
      copilot.onUtteranceEnd(utterance('What is useEffect?', 'mic'))
      await vi.advanceTimersByTimeAsync(50)
      expect(new Set(questions.map((q) => q.id)).size).toBe(2)
    })

    it('can be turned off', async () => {
      const { copilot, questions, setSettings } = setup()
      setSettings({ detection: { pauseGraceMs: 0 } })
      copilot.onUtteranceEnd(utterance('So tell me about your experience with'))
      await vi.advanceTimersByTimeAsync(50)
      expect(questions).toHaveLength(1)
    })
  })

  it('clears history on a new session', async () => {
    const { copilot } = setup()
    copilot.onUtteranceEnd(utterance('What is a closure?'))
    await flush()
    const resets = vi.fn()
    copilot.on('reset', resets)
    copilot.startSession()
    expect(copilot.list()).toEqual([])
    expect(resets).toHaveBeenCalled()
  })
})

/** Scripted STT provider so the whole chain runs without network. */
class MockStt extends BaseSttProvider {
  start() {
    this.emit('state', 'open')
  }
  sendAudio() {}
  async stop() {}
}

describe('session -> copilot integration', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('turns scripted STT events into a streamed answer', async () => {
    const { copilot, llm, questions, tokens, done } = setup()
    llm.push({ tokens: ['Use ', 'a hash map.'] })
    const stts = new Map<AudioSource, MockStt>()
    const session = new SessionManager({
      getSettings: () => DEFAULT_SETTINGS,
      getSttApiKey: () => 'key',
      createStt: (source) => {
        const s = new MockStt()
        stts.set(source, s)
        return s
      },
      startCapture: () => {},
      stopCapture: () => {},
      setMic: () => {}
    })
    session.on('transcript', (u) => copilot.onTranscript(u))
    session.on('utteranceEnd', (u) => copilot.onUtteranceEnd(u))
    session.start()

    const stt = stts.get('loopback')!
    stt.emit('partial', { text: 'how would you', speechFinal: false, start: 0, end: 1 })
    stt.emit('final', { text: 'How would you find duplicates in an array?', speechFinal: true, start: 0, end: 2 })
    stt.emit('utteranceEnd')
    await flush()

    expect(questions[0]).toMatchObject({ question: 'How would you find duplicates in an array?', type: 'coding' })
    expect(tokens).toEqual([`${questions[0].id}:Use `, `${questions[0].id}:a hash map.`])
    expect(done).toHaveLength(1)
    // Coding questions get the larger token budget.
    expect(llm.requests[0].maxTokens).toBe(1500)
    await session.stop()
  })
})
