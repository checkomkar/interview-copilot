import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { QaSnapshot, QuestionDetected, ScreenshotPending, TranscriptUpdate } from '@shared/ipc'
import { EMPTY_PROFILE } from '@shared/profile'
import { DEFAULT_SETTINGS, mergeSettings, type Settings } from '@shared/settings'
import { AnswerService } from '../src/main/services/answer/AnswerService'
import { CopilotService } from '../src/main/services/answer/CopilotService'
import { QuestionDetector } from '../src/main/services/detect/QuestionDetector'
import { hasImage, type LlmRequest } from '../src/main/services/llm/LlmProvider'
import { SCREEN_QUESTION } from '../src/main/services/llm/prompts'
import type { Screenshot } from '../src/main/services/screen/ScreenService'
import { MockLlm } from './mockLlm'

vi.mock('electron', () => ({ desktopCapturer: {}, screen: {} }))

const flush = () => vi.advanceTimersByTimeAsync(2500)

let n = 0
const shot = (): Screenshot => ({ data: `IMG${++n}`, mediaType: 'image/jpeg', thumb: `data:thumb${n}`, width: 1600, height: 900, ts: 0 })

let seq = 0
const update = (text: string, isFinal: boolean): TranscriptUpdate => ({ id: `u${++seq}`, source: 'loopback', text, isFinal, ts: 0 })

function setup(opts: { settings?: Settings; capture?: () => Promise<Screenshot> } = {}) {
  const settings = opts.settings ?? DEFAULT_SETTINGS
  const llm = new MockLlm()
  const detector = new QuestionDetector({ classify: async () => '{"is_question": false, "type": "other"}', minWords: () => 6 })
  const answers = new AnswerService({ provider: llm, getSettings: () => settings, getProfile: () => EMPTY_PROFILE, sleep: async () => {} })
  const capture = vi.fn(opts.capture ?? (async () => shot()))
  const copilot = new CopilotService({ detector, answers, getSettings: () => settings, captureScreen: capture })
  const pending: ScreenshotPending[] = []
  const questions: QuestionDetected[] = []
  const settled: [QaSnapshot, { screenshots?: string[] }][] = []
  copilot.on('screenshot', (p) => pending.push(p))
  copilot.on('question', (q) => questions.push(q))
  copilot.on('settled', (qa, extra) => settled.push([qa, extra]))
  copilot.on('error', () => {})
  copilot.startSession()
  return { copilot, llm, capture, pending, questions, settled }
}

const answerRequests = (llm: MockLlm) => llm.requests.filter((r) => r.purpose === 'answer')
/** The base64 data of each image sent with a request, in order. */
const imagesOf = (r: LlmRequest) =>
  r.messages.flatMap((m) => (typeof m.content === 'string' ? [] : m.content.flatMap((p) => (p.type === 'image' ? [p.data] : []))))

describe('screenshots', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    n = 0
  })
  afterEach(() => vi.useRealTimers())

  it('answers what is on screen right away when no question is underway', async () => {
    const { copilot, llm, capture, questions, settled } = setup()
    expect(await copilot.captureScreen()).toEqual({ ok: true })
    await flush()
    expect(capture).toHaveBeenCalledWith({ manual: true })
    expect(questions[0]).toMatchObject({ question: SCREEN_QUESTION, screenshots: ['data:thumb1'] })
    const sent = answerRequests(llm)[0]
    expect(imagesOf(sent)).toEqual(['IMG1'])
    expect(sent.role).toBe('vision')
    expect(copilot.list()[0].screenshots).toEqual(['data:thumb1'])
    expect(settled[0][1]).toEqual({ screenshots: ['IMG1'] })
    expect(copilot.pendingScreenshot()).toMatchObject({ thumbs: [] })
  })

  it('collects up to 3 screenshots of a long question and sends them together for one answer', async () => {
    const { copilot, llm, pending, questions } = setup()
    expect(await copilot.addScreenshot()).toEqual({ ok: true })
    expect(await copilot.addScreenshot()).toEqual({ ok: true })
    await flush()
    expect(answerRequests(llm)).toHaveLength(0)
    expect(pending.at(-1)).toMatchObject({ thumbs: ['data:thumb1', 'data:thumb2'] })
    // The answer hotkey adds the third part and answers with all of them.
    await copilot.captureScreen()
    await flush()
    expect(answerRequests(llm)).toHaveLength(1)
    expect(imagesOf(answerRequests(llm)[0])).toEqual(['IMG1', 'IMG2', 'IMG3'])
    expect(questions[0].screenshots).toEqual(['data:thumb1', 'data:thumb2', 'data:thumb3'])
    expect(pending.at(-1)).toMatchObject({ thumbs: [] })
  })

  it('refuses a screenshot over the limit, and answers with the ones it has without capturing again', async () => {
    const { copilot, llm, capture } = setup({ settings: mergeSettings(DEFAULT_SETTINGS, { screen: { maxScreenshots: 3 } }) })
    for (let i = 0; i < 3; i++) await copilot.addScreenshot()
    expect(await copilot.addScreenshot()).toEqual({ ok: false, error: expect.stringContaining('Up to 3 screenshots') })
    await copilot.captureScreen()
    await flush()
    expect(capture).toHaveBeenCalledTimes(3)
    expect(imagesOf(answerRequests(llm)[0])).toEqual(['IMG1', 'IMG2', 'IMG3'])
  })

  it('allows up to 5 screenshots by default and reports the limit', async () => {
    const { copilot } = setup()
    for (let i = 0; i < 5; i++) expect(await copilot.addScreenshot()).toEqual({ ok: true })
    expect(copilot.pendingScreenshot()).toMatchObject({ max: 5 })
    expect((await copilot.addScreenshot()).ok).toBe(false)
  })

  it('removes one waiting screenshot by position, and answers from the rest', async () => {
    const { copilot, llm } = setup()
    for (let i = 0; i < 3; i++) await copilot.addScreenshot()
    copilot.clearScreenshot(1)
    expect(copilot.pendingScreenshot()).toMatchObject({ thumbs: ['data:thumb1', 'data:thumb3'] })
    expect(copilot.answerScreenshots()).toEqual({ ok: true })
    await flush()
    expect(imagesOf(answerRequests(llm)[0])).toEqual(['IMG1', 'IMG3'])
    expect(copilot.answerScreenshots()).toEqual({ ok: false, error: 'Add a screenshot first.' })
  })

  it('waits for the question the interviewer is asking and sends it along', async () => {
    const { copilot, llm, pending, questions } = setup()
    copilot.onTranscript(update('Can you look at this problem and tell me', false))
    await copilot.captureScreen()
    expect(pending.at(-1)).toMatchObject({ thumbs: ['data:thumb1'] })
    expect(answerRequests(llm)).toHaveLength(0)
    copilot.onUtteranceEnd(update('Can you look at this problem and tell me how you would solve it?', true))
    await flush()
    expect(questions).toHaveLength(1)
    expect(questions[0].question).toContain('how you would solve it')
    expect(hasImage(answerRequests(llm)[0])).toBe(true)
    expect(pending.at(-1)).toMatchObject({ thumbs: [] })
  })

  it('sends a waiting screenshot with a typed question, and can be removed', async () => {
    const { copilot, llm } = setup()
    copilot.onTranscript(update('So here is the', false))
    await copilot.captureScreen()
    copilot.clearScreenshot()
    copilot.ask('What is the time complexity?')
    await flush()
    expect(hasImage(answerRequests(llm)[0])).toBe(false)
  })

  it('keeps the screenshots when an answer is regenerated', async () => {
    const { copilot, llm, capture } = setup()
    await copilot.addScreenshot()
    await copilot.captureScreen()
    await flush()
    copilot.regenerate()
    await flush()
    const reqs = answerRequests(llm)
    expect(reqs).toHaveLength(2)
    expect(imagesOf(reqs[1])).toEqual(['IMG1', 'IMG2'])
    expect(capture).toHaveBeenCalledTimes(2)
  })

  it('captures a fresh screenshot for every answer when "always include" is on', async () => {
    const { copilot, llm, capture } = setup({ settings: mergeSettings(DEFAULT_SETTINGS, { screen: { alwaysInclude: true } }) })
    copilot.ask('Explain this code')
    await flush()
    copilot.ask('And its complexity?')
    await flush()
    expect(capture.mock.calls).toEqual([[{ manual: false }], [{ manual: false }]])
    expect(answerRequests(llm).every(hasImage)).toBe(true)
  })

  it('answers without a screenshot when the automatic capture fails', async () => {
    const { copilot, llm } = setup({
      settings: mergeSettings(DEFAULT_SETTINGS, { screen: { alwaysInclude: true } }),
      capture: async () => {
        throw new Error('no display')
      }
    })
    copilot.ask('Explain this')
    await flush()
    expect(answerRequests(llm)).toHaveLength(1)
    expect(hasImage(answerRequests(llm)[0])).toBe(false)
  })

  it('reports a failed hotkey capture', async () => {
    const { copilot } = setup({
      capture: async () => {
        throw new Error('denied')
      }
    })
    expect(await copilot.captureScreen()).toEqual({ ok: false, error: 'Screenshot failed: denied' })
  })

  it('emits settled Q&As for history, including interrupted ones', async () => {
    const { copilot, llm, settled } = setup()
    llm.push({ tokens: ['a', 'b', 'c'], delayMs: 500 }, { tokens: ['done'] })
    copilot.ask('First question here?')
    await vi.advanceTimersByTimeAsync(100)
    copilot.ask('Second question here?')
    await flush()
    expect(settled.map(([q]) => [q.question, q.status])).toEqual([
      ['First question here?', 'error'],
      ['Second question here?', 'done']
    ])
  })
})

describe('follow-up context', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('sends the earlier Q&As (typed ones too) with the next question, but not the question itself on Retry', async () => {
    const { copilot, llm } = setup()
    llm.push({ tokens: ['Understanding: find the duplicate'] }, { tokens: ['detail'] }, { tokens: ['again'] })
    copilot.ask('Find the duplicate number in an array')
    await flush()
    copilot.ask('What did you understand from this question?')
    await flush()
    const second = answerRequests(llm)[1].messages[0].content as string
    expect(second).toContain('<question>Find the duplicate number in an array</question>')
    expect(second).toContain('Understanding: find the duplicate')
    copilot.regenerate()
    await flush()
    const retry = answerRequests(llm)[2].messages[0].content as string
    expect(retry.match(/<qa n=/g)).toHaveLength(1)
    expect(retry).not.toContain('<question>What did you understand')
  })
})

describe('fitWithin', () => {
  it('scales the long edge down to the cap and never up', async () => {
    const { fitWithin } = await import('../src/main/services/screen/ScreenService')
    expect(fitWithin(3840, 2160, 1600)).toEqual({ width: 1600, height: 900 })
    expect(fitWithin(1080, 1920, 1600)).toEqual({ width: 900, height: 1600 })
    expect(fitWithin(1280, 720, 1600)).toEqual({ width: 1280, height: 720 })
  })
})
