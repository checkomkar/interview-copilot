import { describe, expect, it, vi } from 'vitest'
import type { SessionStartResult, TranscriptUpdate } from '@shared/ipc'
import { averageScore, type PracticeItem, type PracticeState } from '@shared/practice'
import { EMPTY_PROFILE, type Profile } from '@shared/profile'
import { DEFAULT_SETTINGS } from '@shared/settings'
import { PracticeService, type PracticeHistory } from '../src/main/services/practice/PracticeService'
import {
  buildFeedbackMessages,
  buildPracticeQuestionsMessages,
  fallbackSummary,
  parseFeedback,
  parsePracticeQuestions
} from '../src/main/services/practice/practicePrompts'
import { LlmError, type LlmRequest } from '../src/main/services/llm/LlmProvider'
import { MockLlm } from './mockLlm'

const PROFILE: Profile = { ...EMPTY_PROFILE, name: 'Omkar', role: 'Backend Engineer', company: 'Acme', resumeText: 'Built a payments API in Go.' }

const QUESTIONS = JSON.stringify({
  questions: [
    { question: 'Tell me about the payments API you built.', type: 'behavioral' },
    { question: 'How would you make it idempotent?', type: 'technical' }
  ]
})
const feedback = (score: number) =>
  JSON.stringify({ score, strengths: ['Clear structure'], gaps: ['Add a measurable result'], improved_answer: '- **S**: …' })

describe('practice prompts', () => {
  it('asks for spoken, personalised questions as JSON', () => {
    const text = buildPracticeQuestionsMessages('behavioral', 5)[0].content as string
    expect(text).toContain('Write 5 interview questions for a behavioral round')
    expect(text).toContain('read aloud')
    expect(text).toContain('"questions"')
  })

  it('feedback prompt follows §6.4', () => {
    const text = buildFeedbackMessages('Q?', 'behavioral', 'my answer') [0].content as string
    expect(text).toContain('<answer>my answer</answer>')
    for (const k of ['"score"', '"strengths"', '"gaps"', '"improved_answer"']) expect(text).toContain(k)
  })

  it('parses questions defensively: fences, duplicates, unknown types, count', () => {
    const raw = '```json\n{"questions":[{"question":"Why  Acme?","type":"weird"},{"question":"why acme?"},{"question":"Design a URL shortener.","type":"system_design"},{"question":"Third?","type":"technical"}]}\n```'
    expect(parsePracticeQuestions(raw, 2)).toEqual([
      { question: 'Why Acme?', type: 'behavioral' },
      { question: 'Design a URL shortener.', type: 'system_design' }
    ])
    expect(parsePracticeQuestions('no json here', 5)).toBeNull()
    expect(parsePracticeQuestions('{"questions":[]}', 5)).toBeNull()
  })

  it('parses feedback, rounding and clamping the score', () => {
    expect(parseFeedback('Here you go: {"score":"7.6","strengths":[" a ",""],"gaps":[],"improved_answer":" x "}')).toEqual({
      score: 8,
      strengths: ['a'],
      gaps: [],
      improvedAnswer: 'x'
    })
    expect(parseFeedback('{"score":42}')).toBeNull()
    expect(parseFeedback('nonsense')).toBeNull()
  })

  it('averages reviewed answers and falls back to a plain summary', () => {
    const items: PracticeItem[] = [
      { question: 'a', type: 'behavioral', status: 'reviewed', answer: 'x', feedback: { score: 7, strengths: [], gaps: ['Be specific'], improvedAnswer: '' } },
      { question: 'b', type: 'behavioral', status: 'reviewed', answer: 'y', feedback: { score: 8, strengths: [], gaps: [], improvedAnswer: '' } },
      { question: 'c', type: 'behavioral', status: 'skipped', answer: '' }
    ]
    expect(averageScore(items)).toBe(7.5)
    expect(averageScore([])).toBeUndefined()
    expect(fallbackSummary(items, 7.5)).toContain('average 7.5/10 across 2 answers')
    expect(fallbackSummary(items, 7.5)).toContain('- Be specific')
  })
})

function setup(opts: { profile?: Profile; live?: boolean; audioStart?: SessionStartResult } = {}) {
  const llm = new MockLlm()
  const replies: (string | LlmError)[] = []
  llm.completeText = (req: LlmRequest) => {
    const next = replies.shift()
    if (next instanceof LlmError) throw next
    if (next !== undefined) return next
    return (req.messages[0].content as string).includes('mock interview is over') ? '**Overall** — good.' : feedback(7)
  }
  const saved = new Map<number, PracticeItem>()
  const history: PracticeHistory & { opened: string[]; finished: [string, string, number | null][]; closed: number } = {
    opened: [],
    finished: [],
    closed: 0,
    openPractice: (label) => {
      history.opened.push(label)
      return 'p-1'
    },
    savePracticeItem: (_id, i, item) => void saved.set(i, item),
    finishPractice: (id, summary, avg) => void history.finished.push([id, summary, avg]),
    close: () => void history.closed++
  }
  let onStop: (() => void) | null = null
  const audio = {
    start: vi.fn((): SessionStartResult => opts.audioStart ?? { ok: true }),
    stop: vi.fn(async () => onStop?.())
  }
  const svc = new PracticeService({
    llm,
    getSettings: () => DEFAULT_SETTINGS,
    getProfile: () => opts.profile ?? PROFILE,
    history,
    audio,
    isLiveSessionActive: () => opts.live ?? false
  })
  const states: PracticeState[] = []
  svc.on('state', (s) => states.push(s))
  const say = (text: string, isFinal: boolean, id = 'mic-1') =>
    svc.onTranscript({ id, source: 'mic', text, isFinal, ts: 0 } satisfies TranscriptUpdate)
  return { svc, llm, replies, history, saved, audio, states, say, setOnStop: (fn: () => void) => (onStop = fn) }
}

describe('PracticeService', () => {
  it('runs a full practice: questions, a spoken answer, a typed answer, summary saved to History', async () => {
    const t = setup()
    t.replies.push(QUESTIONS)
    expect(await t.svc.start({ round: 'mixed', count: 5 })).toEqual({ ok: true })
    expect(t.history.opened).toEqual(['Practice · Mixed'])
    let s = t.svc.getState()
    expect(s).toMatchObject({ status: 'running', current: 0, sessionId: 'p-1' })
    expect(s.items.map((i) => i.status)).toEqual(['asking', 'pending'])
    // Questions come from the fast model, with the profile in a cacheable system block.
    expect(t.llm.completions[0]).toMatchObject({ role: 'fast', purpose: 'practice' })
    expect(t.llm.completions[0].system[0]).toMatchObject({ cache: true })
    expect(t.llm.completions[0].system[0].text).toContain('Built a payments API in Go.')

    // Spoken answer: live partials, finished utterances join up, and stopping flushes the last one.
    expect(t.svc.record()).toEqual({ ok: true })
    expect(t.audio.start).toHaveBeenCalledTimes(1)
    t.say('I built the', false)
    expect(t.svc.getState().live).toBe('I built the')
    t.say('I built the payments API.', true)
    t.say('It handled', false, 'mic-2')
    t.setOnStop(() => t.say('It handled 2k requests a second.', true, 'mic-2'))
    t.replies.push(feedback(6))
    expect(await t.svc.finishAnswer()).toEqual({ ok: true })
    s = t.svc.getState()
    expect(s.items[0]).toMatchObject({ status: 'reviewed', answer: 'I built the payments API. It handled 2k requests a second.', servedBy: expect.any(String) })
    expect(s.items[0].feedback).toEqual({ score: 6, strengths: ['Clear structure'], gaps: ['Add a measurable result'], improvedAnswer: '- **S**: …' })
    expect(t.llm.completions[1]).toMatchObject({ role: 'answer', purpose: 'practice' })
    expect(t.saved.get(0)?.status).toBe('reviewed')

    // Mic transcripts after recording stopped are ignored.
    t.say('stray words', true, 'mic-3')
    expect(t.svc.getState().items[0].answer).not.toContain('stray')

    expect(await t.svc.next()).toEqual({ ok: true })
    expect(t.svc.getState()).toMatchObject({ current: 1 })
    expect(t.svc.getState().items[1].status).toBe('asking')

    t.replies.push(feedback(9))
    expect(await t.svc.submit('Use an idempotency key stored with the result.')).toEqual({ ok: true })
    expect(t.svc.getState().items[1]).toMatchObject({ status: 'reviewed', answer: 'Use an idempotency key stored with the result.' })

    // After the last question, next() writes the summary and saves it.
    expect(await t.svc.next()).toEqual({ ok: true })
    s = t.svc.getState()
    expect(s).toMatchObject({ status: 'done', summary: '**Overall** — good.', averageScore: 7.5 })
    expect(t.history.finished).toEqual([['p-1', '**Overall** — good.', 7.5]])
    expect(t.history.closed).toBe(1)
    expect(t.states.some((x) => x.status === 'summarizing')).toBe(true)

    t.svc.reset()
    expect(t.svc.getState().status).toBe('idle')
  })

  it('needs a resume or JD, no live session, and reports failed question generation', async () => {
    expect(await setup({ profile: EMPTY_PROFILE }).svc.start({ round: 'behavioral', count: 5 })).toMatchObject({ ok: false, navigate: 'profile' })
    expect(await setup({ live: true }).svc.start({ round: 'behavioral', count: 5 })).toMatchObject({ ok: false, error: expect.stringContaining('live session') })

    const t = setup()
    t.replies.push('Sorry, I cannot help with that.')
    const res = await t.svc.start({ round: 'behavioral', count: 5 })
    expect(res).toMatchObject({ ok: false, error: expect.stringContaining('did not return any questions') })
    expect(t.svc.getState().status).toBe('error')
    // The empty history session is closed (and dropped).
    expect(t.history.closed).toBe(1)
  })

  it('nothing heard: back to asking with a hint; recording needs an STT key', async () => {
    const t = setup()
    t.replies.push(QUESTIONS)
    await t.svc.start({ round: 'mixed', count: 5 })
    t.svc.record()
    expect(await t.svc.finishAnswer()).toMatchObject({ ok: false, error: expect.stringContaining("Didn't catch anything") })
    expect(t.svc.getState().items[0].status).toBe('asking')

    const noKey = setup({ audioStart: { ok: false, error: 'Add your Deepgram API key in Settings to start a session.', navigate: 'settings' } })
    noKey.replies.push(QUESTIONS)
    await noKey.svc.start({ round: 'mixed', count: 5 })
    expect(noKey.svc.record()).toMatchObject({ ok: false, navigate: 'settings' })
    expect(noKey.svc.getState().items[0].status).toBe('asking')
  })

  it('a mic failure mid-answer keeps the run going', async () => {
    const t = setup()
    t.replies.push(QUESTIONS)
    await t.svc.start({ round: 'mixed', count: 5 })
    t.svc.record()
    t.svc.onAudioFailed('Microphone capture failed: device lost')
    expect(t.svc.getState()).toMatchObject({ status: 'running', error: 'Microphone capture failed: device lost' })
    expect(t.svc.getState().items[0].status).toBe('asking')
    // Recording again clears the error.
    t.svc.record()
    expect(t.svc.getState().error).toBeUndefined()
  })

  it('failed feedback can be retried; skip and redo work', async () => {
    const t = setup()
    t.replies.push(QUESTIONS, new LlmError('rate_limit', 'Groq: rate limited'))
    await t.svc.start({ round: 'mixed', count: 5 })
    expect(await t.svc.submit('My answer')).toMatchObject({ ok: false, error: expect.stringContaining('rate limited') })
    expect(t.svc.getState().items[0]).toMatchObject({ status: 'error', answer: 'My answer' })
    t.replies.push('not json at all')
    expect(await t.svc.retryFeedback()).toMatchObject({ ok: false, error: expect.stringContaining('unexpected format') })
    expect(await t.svc.retryFeedback()).toEqual({ ok: true })
    expect(t.svc.getState().items[0].status).toBe('reviewed')

    expect(t.svc.redo()).toEqual({ ok: true })
    expect(t.svc.getState().items[0]).toMatchObject({ status: 'asking', answer: '' })
    expect(t.svc.getState().items[0].feedback).toBeUndefined()

    expect(await t.svc.skip()).toEqual({ ok: true })
    expect(t.saved.get(0)?.status).toBe('skipped')
    expect(t.svc.getState().current).toBe(1)
  })

  it('ending early summarises what was answered and drops unreached questions; ending with nothing answered saves nothing', async () => {
    const t = setup()
    t.replies.push(QUESTIONS)
    await t.svc.start({ round: 'mixed', count: 5 })
    await t.svc.submit('An answer')
    await t.svc.finish()
    const s = t.svc.getState()
    expect(s.status).toBe('done')
    expect(s.items).toHaveLength(1)
    expect(t.history.finished[0][2]).toBe(7)

    const empty = setup()
    empty.replies.push(QUESTIONS)
    await empty.svc.start({ round: 'mixed', count: 5 })
    await empty.svc.finish()
    expect(empty.svc.getState().status).toBe('idle')
    expect(empty.history.finished).toEqual([])
    expect(empty.history.closed).toBe(1)
  })

  it('falls back to a plain summary when the summary request fails', async () => {
    const t = setup()
    t.replies.push(QUESTIONS, feedback(5), new LlmError('network', 'offline'))
    await t.svc.start({ round: 'mixed', count: 5 })
    await t.svc.submit('An answer')
    await t.svc.finish()
    expect(t.svc.getState().summary).toContain('average 5/10')
  })
})
