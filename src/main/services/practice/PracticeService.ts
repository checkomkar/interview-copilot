import { EventEmitter } from 'node:events'
import { servedBy, type SessionStartResult, type TranscriptUpdate } from '@shared/ipc'
import {
  averageScore,
  IDLE_PRACTICE,
  PRACTICE_ROUND_LABELS,
  type PracticeItem,
  type PracticeResult,
  type PracticeStart,
  type PracticeState
} from '@shared/practice'
import type { Profile } from '@shared/profile'
import { activeModels, type Settings } from '@shared/settings'
import { createLogger } from '../../logger'
import type { LlmProvider, LlmRequest } from '../llm/LlmProvider'
import {
  buildFeedbackMessages,
  buildPracticeQuestionsMessages,
  buildPracticeSummaryMessages,
  buildPracticeSystem,
  fallbackSummary,
  parseFeedback,
  parsePracticeQuestions
} from './practicePrompts'

const log = createLogger('practice')

const FEEDBACK_MAX_TOKENS = 1200
const SUMMARY_MAX_TOKENS = 600

/** Where a practice run is saved (FR-P4). */
export interface PracticeHistory {
  /** Opens a history session for the run; returns its id. */
  openPractice(label: string): string
  savePracticeItem(sessionId: string, index: number, item: PracticeItem): void
  finishPractice(sessionId: string, summary: string, averageScore: number | null): void
  /** Ends the open history session (an empty one is dropped). */
  close(): void
}

/** Mic-only listening for spoken answers. */
export interface PracticeAudio {
  start(): SessionStartResult
  stop(): Promise<void>
}

export interface PracticeDeps {
  llm: LlmProvider
  getSettings: () => Settings
  getProfile: () => Profile
  history: PracticeHistory
  audio: PracticeAudio
  /** A live copilot session is running (practice needs the mic and STT to itself). */
  isLiveSessionActive: () => boolean
}

export interface PracticeEvents {
  state: [PracticeState]
}

/**
 * Practice Mode (FR-P1..P4): writes personalised questions, records each spoken (or typed)
 * answer, scores it with feedback, and ends with a summary saved to History.
 */
export class PracticeService extends EventEmitter {
  private state: PracticeState = IDLE_PRACTICE
  private abort: AbortController | null = null
  /** Finished utterances of the answer being recorded. */
  private heard: string[] = []
  private recording = false

  constructor(private readonly deps: PracticeDeps) {
    super()
  }

  override emit<E extends keyof PracticeEvents>(event: E, ...args: PracticeEvents[E]): boolean {
    return super.emit(event, ...args)
  }
  override on<E extends keyof PracticeEvents>(event: E, listener: (...args: PracticeEvents[E]) => void): this {
    return super.on(event, listener as (...a: unknown[]) => void)
  }

  getState(): PracticeState {
    return this.state
  }

  /** A run is in progress (questions being written, asked or summarised). */
  isRunning(): boolean {
    return this.state.status === 'generating' || this.state.status === 'running' || this.state.status === 'summarizing'
  }

  /** Writes the questions and starts at the first one. */
  async start(opts: PracticeStart): Promise<PracticeResult> {
    if (this.isRunning()) return { ok: false, error: 'A practice run is already going.' }
    if (this.deps.isLiveSessionActive()) return { ok: false, error: 'Stop the live session before practising.' }
    const profile = this.deps.getProfile()
    if (!profile.resumeText.trim() && !profile.jdText.trim()) {
      return { ok: false, error: 'Add your resume or a job description in the Profile tab first — questions are written from them.', navigate: 'profile' }
    }

    const sessionId = this.deps.history.openPractice(`Practice · ${PRACTICE_ROUND_LABELS[opts.round]}`)
    this.set({ ...IDLE_PRACTICE, status: 'generating', round: opts.round, sessionId })
    const abort = (this.abort = new AbortController())
    try {
      const res = await this.complete(buildPracticeQuestionsMessages(opts.round, opts.count), 200 + 120 * opts.count, abort.signal, 'fast')
      if (abort.signal.aborted) return { ok: false, error: 'Practice was stopped.' }
      const questions = parsePracticeQuestions(res.text, opts.count)
      if (!questions?.length) throw new Error('The model did not return any questions — try again.')
      log.info(`${questions.length} ${opts.round} questions written by ${servedBy(res.usage)}`)
      const items: PracticeItem[] = questions.map((q, i) => ({ ...q, status: i === 0 ? 'asking' : 'pending', answer: '' }))
      this.set({ ...this.state, status: 'running', items, current: 0 })
      return { ok: true }
    } catch (err) {
      if (abort.signal.aborted) return { ok: false, error: 'Practice was stopped.' }
      const error = `Could not write practice questions: ${message(err)}`
      log.warn(error)
      this.deps.history.close()
      this.set({ ...IDLE_PRACTICE, status: 'error', round: opts.round, error })
      return { ok: false, error }
    } finally {
      if (this.abort === abort) this.abort = null
    }
  }

  /** Start recording the spoken answer to the current question. */
  record(): PracticeResult {
    const item = this.currentItem()
    if (!item || (item.status !== 'asking' && item.status !== 'error')) return { ok: false, error: 'Nothing to answer right now.' }
    if (!this.recording) {
      const started = this.deps.audio.start()
      if (!started.ok) return { ok: false, error: started.error, navigate: started.navigate === 'settings' ? 'settings' : undefined }
      this.recording = true
    }
    this.heard = []
    this.patchItem({ status: 'recording', answer: '', error: undefined, feedback: undefined })
    this.set({ ...this.state, live: '', error: undefined })
    return { ok: true }
  }

  /** Mic transcripts while recording (wired to the practice audio session). */
  onTranscript(u: TranscriptUpdate): void {
    if (!this.recording || u.source !== 'mic' || this.currentItem()?.status !== 'recording') return
    if (u.isFinal) {
      this.heard.push(u.text.trim())
      this.patchItem({ answer: this.heard.join(' ') })
      this.set({ ...this.state, live: '' })
    } else {
      this.set({ ...this.state, live: u.text })
    }
  }

  /** The mic or speech service failed mid-answer: keep what was heard and let the user retry or type. */
  onAudioFailed(error: string): void {
    if (!this.recording) return
    this.recording = false
    if (this.currentItem()?.status === 'recording') this.patchItem({ status: 'asking' })
    this.set({ ...this.state, live: '', error })
  }

  /** Stop recording and get feedback on what was heard. */
  async finishAnswer(): Promise<PracticeResult> {
    if (this.currentItem()?.status !== 'recording') return { ok: false, error: 'Not recording.' }
    await this.stopRecording()
    const answer = this.heard.join(' ').trim()
    if (!answer) {
      this.patchItem({ status: 'asking', answer: '' })
      return { ok: false, error: "Didn't catch anything — check the microphone, then try again or type your answer." }
    }
    return this.review(answer)
  }

  /** A typed answer, replacing anything recorded. */
  async submit(text: string): Promise<PracticeResult> {
    const item = this.currentItem()
    if (!item || !['asking', 'recording', 'error'].includes(item.status)) return { ok: false, error: 'Nothing to answer right now.' }
    await this.stopRecording()
    return this.review(text.trim())
  }

  /** Feedback failed: ask again for the same answer. */
  async retryFeedback(): Promise<PracticeResult> {
    const item = this.currentItem()
    if (item?.status !== 'error' || !item.answer.trim()) return { ok: false, error: 'Nothing to retry.' }
    return this.review(item.answer)
  }

  /** Answer the current question again (after seeing feedback). */
  redo(): PracticeResult {
    const item = this.currentItem()
    if (!item || item.status === 'reviewing' || item.status === 'recording') return { ok: false, error: 'Nothing to redo.' }
    this.patchItem({ status: 'asking', answer: '', feedback: undefined, error: undefined, servedBy: undefined })
    return { ok: true }
  }

  async skip(): Promise<PracticeResult> {
    const item = this.currentItem()
    if (!item || item.status === 'reviewing') return { ok: false, error: 'Nothing to skip.' }
    await this.stopRecording()
    this.patchItem({ status: 'skipped' })
    this.save(this.state.current)
    return this.next()
  }

  /** Move to the next question, or finish after the last one. */
  async next(): Promise<PracticeResult> {
    const item = this.currentItem()
    if (!item || !['reviewed', 'skipped', 'error'].includes(item.status)) return { ok: false, error: 'Answer or skip this question first.' }
    const nextIndex = this.state.current + 1
    if (nextIndex >= this.state.items.length) return this.finish()
    const items = this.state.items.map((it, i) => (i === nextIndex ? { ...it, status: 'asking' as const } : it))
    this.set({ ...this.state, items, current: nextIndex, live: '' })
    return { ok: true }
  }

  /** End early (or after the last question): summarise what was answered and save it. */
  async finish(): Promise<PracticeResult> {
    if (this.state.status === 'generating') {
      this.abort?.abort()
      this.deps.history.close()
      this.set(IDLE_PRACTICE)
      return { ok: true }
    }
    if (this.state.status !== 'running') return { ok: false, error: 'No practice run to finish.' }
    this.abort?.abort()
    await this.stopRecording()
    // Questions never reached are dropped from the record; an unanswered current one counts as skipped.
    const items = this.state.items
      .map((it): PracticeItem => (['asking', 'recording', 'reviewing'].includes(it.status) ? { ...it, status: 'skipped' } : it))
      .filter((it) => it.status !== 'pending')
    const avg = averageScore(items)
    const sessionId = this.state.sessionId
    if (!items.some((i) => i.feedback)) {
      // Nothing answered: no summary worth saving.
      this.deps.history.close()
      this.set(IDLE_PRACTICE)
      return { ok: true }
    }
    this.set({ ...this.state, status: 'summarizing', items, averageScore: avg, live: '' })
    items.forEach((_, i) => this.save(i))
    let summary: string
    try {
      const res = await this.complete(buildPracticeSummaryMessages(this.state.round, items), SUMMARY_MAX_TOKENS, undefined, 'answer')
      summary = res.text.trim() || fallbackSummary(items, avg)
    } catch (err) {
      log.warn(`summary failed: ${message(err)}`)
      summary = fallbackSummary(items, avg)
    }
    if (sessionId) this.deps.history.finishPractice(sessionId, summary, avg ?? null)
    this.deps.history.close()
    this.set({ ...this.state, status: 'done', summary })
    return { ok: true }
  }

  /** Back to the start screen after a finished or failed run. */
  reset(): void {
    if (this.isRunning()) return
    this.set(IDLE_PRACTICE)
  }

  /** App quitting or data wiped: stop without saving more. */
  async dispose(): Promise<void> {
    this.abort?.abort()
    await this.stopRecording()
  }

  private async review(answer: string): Promise<PracticeResult> {
    const index = this.state.current
    const item = this.state.items[index]
    this.patchItem({ status: 'reviewing', answer, error: undefined })
    this.set({ ...this.state, live: '' })
    const abort = (this.abort = new AbortController())
    try {
      const res = await this.complete(buildFeedbackMessages(item.question, item.type, answer), FEEDBACK_MAX_TOKENS, abort.signal, 'answer')
      if (abort.signal.aborted || this.state.current !== index) return { ok: false, error: 'Stopped.' }
      const feedback = parseFeedback(res.text)
      if (!feedback) throw new Error('the feedback came back in an unexpected format')
      this.patchItem({ status: 'reviewed', feedback, servedBy: servedBy(res.usage) })
      this.save(index)
      return { ok: true }
    } catch (err) {
      if (abort.signal.aborted) return { ok: false, error: 'Stopped.' }
      const error = `Feedback failed: ${message(err)}`
      log.warn(error)
      this.patchItem({ status: 'error', error })
      return { ok: false, error }
    } finally {
      if (this.abort === abort) this.abort = null
    }
  }

  private complete(messages: LlmRequest['messages'], maxTokens: number, signal: AbortSignal | undefined, role: 'answer' | 'fast') {
    const models = activeModels(this.deps.getSettings())
    return this.deps.llm.complete({
      model: role === 'fast' ? models.fastModel : models.answerModel,
      role,
      purpose: 'practice',
      system: buildPracticeSystem(this.deps.getProfile()),
      messages,
      maxTokens,
      signal
    })
  }

  private async stopRecording(): Promise<void> {
    if (!this.recording) return
    // Stopping flushes the last utterance through onTranscript, which still accepts it until this resolves.
    await this.deps.audio.stop()
    this.recording = false
  }

  private save(index: number): void {
    const id = this.state.sessionId
    const item = this.state.items[index]
    if (id && item) this.deps.history.savePracticeItem(id, index, item)
  }

  private currentItem(): PracticeItem | undefined {
    return this.state.status === 'running' ? this.state.items[this.state.current] : undefined
  }

  private patchItem(patch: Partial<PracticeItem>): void {
    const items = this.state.items.map((it, i) => (i === this.state.current ? { ...it, ...patch } : it))
    this.set({ ...this.state, items })
  }

  private set(next: PracticeState): void {
    this.state = next
    this.emit('state', next)
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
