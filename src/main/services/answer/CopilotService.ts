import { EventEmitter } from 'node:events'
import { servedBy } from '@shared/ipc'
import { shortcutText } from '@shared/keys'
import type {
  AnswerActionResult,
  AudioSource,
  AnswerDone,
  AnswerError,
  AnswerStyle,
  AnswerToken,
  LatencySample,
  QaSnapshot,
  QuestionDetected,
  QuestionType,
  ScreenshotPending,
  TranscriptUpdate
} from '@shared/ipc'
import type { AppMode, Settings } from '@shared/settings'
import { createLogger } from '../../logger'
import { guessType, looksIncomplete, wordCount, type Detection } from '../detect/QuestionDetector'
import { LlmError } from '../llm/LlmProvider'
import { SCREEN_QUESTION, type TranscriptLine } from '../llm/prompts'
import type { Screenshot } from '../screen/ScreenService'
import { WORK_SCREEN_QUESTION } from '../work/workPrompts'
import { PartialAnswerError, type AnswerService } from './AnswerService'

const log = createLogger('copilot')

const MAX_TRANSCRIPT_LINES = 300
const MAX_QAS = 100
/** Earlier Q&As sent with each answer so follow-ups ("what did you understand from this question?") have context. */
const EARLIER_QAS = 3
/** Interviewer utterances kept as "since the last answer" (FR-Q1). */
const MAX_PENDING = 4
/** FR-Q4: a short question this soon after the previous one is a follow-up. */
const FOLLOW_UP_MS = 10_000
const FOLLOW_UP_MAX_WORDS = 8
/**
 * Speech that starts this soon after a question ended is the same speaker carrying on (a pause
 * mid-sentence, even if speech-to-text punctuated the fragment as finished). After a real
 * question the candidate answers, so the interviewer's next words come much later.
 */
const RESUME_MS = 3000
/** Re-warm the prompt cache before its 5-minute TTL lapses during quiet stretches. */
const KEEP_WARM_CHECK_MS = 60_000
const KEEP_WARM_IDLE_MS = 270_000

/** A detection; Work Mode's also says which project a status question is about (FR-W9). */
export type CopilotDetection = Detection & { projectId?: string; taskId?: string; suggestedId?: string | null }

/** How a typed or voice question is handled in Work Mode (FR-W6): a status answer, the quick-pick, or a general answer. */
export interface DirectQuestion {
  type: QuestionType
  projectId?: string
  taskId?: string
  suggestedId?: string | null
}

export interface CopilotDeps {
  /** Interview: question detection (FR-Q2/Q3). Work: status-question detection (FR-W8). */
  detector: { detect: (utterances: string[], context: string[]) => Promise<CopilotDetection> }
  answers: Pick<AnswerService, 'generate' | 'prewarm'>
  getSettings: () => Settings
  /** Voice questions on: the user's mic speech is answered directly. */
  isVoiceAsk?: () => boolean
  /** Screen capture (FR-SC1). `manual`: the user pressed the hotkey (vs. "always include"). */
  captureScreen?: (opts: { manual: boolean }) => Promise<Screenshot>
  /** Default: interview. */
  getMode?: () => AppMode
  /** A project's name for display (Work Mode status answers), with the item's when there is one. */
  projectName?: (id: string, taskId?: string) => string | null
  /** Work Mode: what a typed or voice question is about (FR-W6). Default: a general work question. */
  resolveQuestion?: (text: string) => DirectQuestion
  /**
   * Work Mode: `text` names a different project or item than `prev` was about, so it starts a new
   * question instead of continuing or following up on `prev` (FR-W10).
   */
  differentTopic?: (prev: QaSnapshot, text: string) => boolean
  now?: () => number
}

/** Work Mode: a status update was asked for, but which project isn't certain — the user picks (FR-W6/W9). */
export interface StatusPickRequest {
  question: string
  suggestedId: string | null
}

export interface CopilotEvents {
  question: [QuestionDetected]
  token: [AnswerToken]
  done: [AnswerDone]
  error: [AnswerError]
  /** New session: renderers drop their Q&A history. */
  reset: []
  latency: [LatencySample]
  /** The screenshots waiting for the next answer changed. */
  screenshot: [ScreenshotPending]
  /** A Q&A finished (done, failed or interrupted), with the screenshots sent with it (base64 JPEGs). */
  settled: [QaSnapshot, { screenshots?: string[] }]
  pick: [StatusPickRequest]
}

interface PendingUtterance {
  text: string
  /** When the speaker started this utterance (first transcript update). */
  startedAt: number
  endedAt: number
}

/**
 * Turns interviewer utterances into answers: question detection, follow-up merging,
 * debounce/cancel (FR-Q1..Q6), and the answer-now / regenerate / shorter actions.
 */
export class CopilotService extends EventEmitter {
  private transcript: TranscriptLine[] = []
  private pending: PendingUtterance[] = []
  private livePartial = ''
  private qas: QaSnapshot[] = []
  private current: { qa: QaSnapshot; controller: AbortController } | null = null
  private scheduled: NodeJS.Timeout | null = null
  private lastGenAt = Number.NEGATIVE_INFINITY
  private lastQuestionAt = Number.NEGATIVE_INFINITY
  private lastLlmAt = 0
  private detecting = false
  private dirty = false
  private seq = 0
  private keepWarm: NodeJS.Timeout | null = null
  /** Voice questions not yet asked: the user's mic utterances of the current turn. */
  private voicePending: PendingUtterance[] = []
  /** Per lane: waiting to see whether a speaker who paused mid-sentence goes on. */
  private grace = new Map<AudioSource, NodeJS.Timeout>()
  /** The last question's text looked cut off, so speech that follows soon continues it. */
  private lastQuestionIncomplete = false
  /** When the speech of the last question ended. */
  private lastQuestionEndedAt = Number.NEGATIVE_INFINITY
  /** Per lane: when the utterance being spoken now started. */
  private speechStartedAt = new Map<AudioSource, number>()
  /** Screenshots waiting to be sent with the next answer, oldest first (FR-SC2). */
  private attached: Screenshot[] = []
  /** Screenshots each Q&A was asked with, so regenerating keeps them. */
  private shots = new Map<string, Screenshot[]>()
  private readonly now: () => number

  constructor(private readonly deps: CopilotDeps) {
    super()
    this.now = deps.now ?? Date.now
  }

  override emit<E extends keyof CopilotEvents>(event: E, ...args: CopilotEvents[E]): boolean {
    return super.emit(event, ...args)
  }
  override on<E extends keyof CopilotEvents>(event: E, listener: (...args: CopilotEvents[E]) => void): this {
    return super.on(event, listener as (...a: unknown[]) => void)
  }

  /** An answer is being generated. */
  isBusy(): boolean {
    return this.current !== null
  }

  list(): QaSnapshot[] {
    return this.qas.map((q) => ({ ...q }))
  }

  /**
   * `keepHistory`: the session was started implicitly (mic toggle) while the user may be reading
   * or waiting on an answer, so keep the Q&A list and any answer in flight.
   */
  startSession(opts: { keepHistory?: boolean } = {}): void {
    this.cancelScheduled()
    this.cancelGrace()
    this.transcript = []
    this.pending = []
    this.voicePending = []
    this.livePartial = ''
    if (!opts.keepHistory) {
      this.current?.controller.abort()
      this.current = null
      this.qas = []
      this.shots.clear()
      this.setAttached([])
      this.lastGenAt = Number.NEGATIVE_INFINITY
      this.lastQuestionAt = Number.NEGATIVE_INFINITY
      this.emit('reset')
    }
    void this.warm()
    if (this.keepWarm) clearInterval(this.keepWarm)
    this.keepWarm = setInterval(() => {
      if (this.now() - this.lastLlmAt >= KEEP_WARM_IDLE_MS) void this.warm()
    }, KEEP_WARM_CHECK_MS)
  }

  /** Idempotent. An answer already streaming is allowed to finish. */
  stopSession(): void {
    this.cancelScheduled()
    this.cancelGrace()
    if (this.keepWarm) clearInterval(this.keepWarm)
    this.keepWarm = null
    this.pending = []
    this.voicePending = []
    this.livePartial = ''
  }

  onTranscript(u: TranscriptUpdate): void {
    if (u.isFinal || !u.text.trim()) return
    if (!this.speechStartedAt.has(u.source)) this.speechStartedAt.set(u.source, this.now())
    // The speaker started again: their turn isn't over, the next utterance end decides.
    this.cancelGrace(u.source)
    if (u.source === 'loopback') this.livePartial = u.text
  }

  onUtteranceEnd(u: TranscriptUpdate): void {
    const endedAt = this.now()
    const startedAt = this.speechStartedAt.get(u.source) ?? endedAt
    this.speechStartedAt.delete(u.source)
    this.transcript.push({ source: u.source, text: u.text })
    if (this.transcript.length > MAX_TRANSCRIPT_LINES) this.transcript.splice(0, this.transcript.length - MAX_TRANSCRIPT_LINES)
    if (u.source === 'mic') {
      // FR-A3: the mic never triggers answers, except when the user turned voice questions on.
      if (!this.deps.isVoiceAsk?.()) return
      this.voicePending.push({ text: u.text, startedAt, endedAt })
      this.endOfUtterance('mic')
      return
    }
    this.livePartial = ''
    this.pending.push({ text: u.text, startedAt, endedAt })
    if (this.pending.length > MAX_PENDING) this.pending.splice(0, this.pending.length - MAX_PENDING)
    if (this.deps.getSettings().detection.autoAnswer) this.endOfUtterance('loopback')
  }

  /**
   * Speakers pause mid-sentence, and speech-to-text ends an utterance at each pause. If what was
   * said so far looks unfinished, wait a little for more before treating the turn as over;
   * speech resuming cancels the wait (see onTranscript) and the pieces are joined.
   */
  private endOfUtterance(source: AudioSource): void {
    this.cancelGrace(source)
    const buffer = source === 'mic' ? this.voicePending : this.pending
    const text = buffer.map((p) => p.text).join(' ')
    const graceMs = this.deps.getSettings().detection.pauseGraceMs
    if (graceMs > 0 && looksIncomplete(text)) {
      this.grace.set(
        source,
        setTimeout(() => this.endOfTurn(source), graceMs)
      )
      return
    }
    this.endOfTurn(source)
  }

  private endOfTurn(source: AudioSource): void {
    this.grace.delete(source)
    if (source === 'loopback') {
      void this.evaluate()
      return
    }
    const turn = this.voicePending
    this.voicePending = []
    const text = turn.map((p) => p.text).join(' ').trim()
    if (!text) return
    const d = this.direct(text)
    this.onQuestion(text, d.type, turn[turn.length - 1].endedAt, {
      voice: true,
      startedAt: turn[0].startedAt,
      projectId: d.projectId,
      taskId: d.taskId,
      suggestedId: d.suggestedId
    })
  }

  /** Speech that started at `startedAt` carries on the last question rather than asking a new one. */
  private continuesLastQuestion(startedAt: number): boolean {
    if (startedAt - this.lastQuestionEndedAt < RESUME_MS) return true
    return this.lastQuestionIncomplete && this.now() - this.lastQuestionAt < FOLLOW_UP_MS
  }

  private cancelGrace(source?: AudioSource): void {
    for (const [s, t] of this.grace) {
      if (source && s !== source) continue
      clearTimeout(t)
      this.grace.delete(s)
    }
  }

  /**
   * Force an answer to what the interviewer said last (U10). In Work Mode this opens the status
   * quick-pick instead (FR-W6), with what was said last as the question.
   */
  answerNow(): AnswerActionResult {
    const text = this.lastHeard()
    if (this.mode() === 'work') {
      this.emit('pick', { question: text, suggestedId: null })
      return { ok: true }
    }
    if (!text) return { ok: false, error: 'Nothing heard yet to answer.' }
    this.cancelGrace('loopback')
    this.pending = []
    const qa = this.newQa(text, guessType(text))
    this.lastQuestionAt = this.now()
    this.lastQuestionIncomplete = false
    this.lastQuestionEndedAt = Number.NEGATIVE_INFINITY
    this.schedule(qa, 'auto', this.now(), true)
    return { ok: true }
  }

  /** What the other side said last: speech not yet answered, else what's being said, else the last line heard. */
  lastHeard(): string {
    const last = [...this.transcript].reverse().find((l) => l.source === 'loopback')?.text ?? ''
    return this.pending.map((p) => p.text).join(' ').trim() || this.livePartial.trim() || last
  }

  /** A question the user typed or spoke to the assistant: answered as-is, no detection or debounce. */
  ask(text: string): AnswerActionResult {
    const question = text.trim()
    if (!question) return { ok: false, error: 'Type a question first.' }
    const d = this.direct(question)
    // A status question about an unclear project: ask which one rather than guess (FR-W9).
    if (d.type === 'status' && !d.projectId) {
      this.emit('pick', { question, suggestedId: d.suggestedId ?? null })
      return { ok: true }
    }
    const qa = this.newQa(question, d.type, d.projectId, d.taskId)
    this.lastQuestionAt = this.now()
    this.lastQuestionIncomplete = false
    this.lastQuestionEndedAt = Number.NEGATIVE_INFINITY
    this.schedule(qa, 'auto', this.now(), true)
    return { ok: true }
  }

  /** A spoken-ready status update on one project (FR-W6): picked in the overlay, or typed as "status <project>". */
  askStatus(projectId: string, question?: string, taskId?: string): AnswerActionResult {
    const name = this.deps.projectName?.(projectId, taskId)
    if (!name) return { ok: false, error: 'That project no longer exists.' }
    this.cancelGrace('loopback')
    this.pending = []
    const qa = this.newQa(question?.trim() || `What's the status of ${name}?`, 'status', projectId, taskId)
    this.lastQuestionAt = this.now()
    this.lastQuestionIncomplete = false
    this.lastQuestionEndedAt = Number.NEGATIVE_INFINITY
    this.schedule(qa, 'auto', this.now(), true)
    return { ok: true }
  }

  /**
   * Screenshot hotkey (FR-SC2): captures one more screenshot (unless the tray is full), then
   * while the interviewer is mid-question the screenshots wait for that answer; otherwise they
   * are answered right away ("Solve / answer what's shown on screen").
   */
  async captureScreen(): Promise<AnswerActionResult> {
    if (this.attached.length < this.maxShots()) {
      const added = await this.addScreenshot()
      if (!added.ok) return added
    }
    if (this.questionUnderway()) return { ok: true }
    return this.ask(this.screenQuestion())
  }

  /**
   * Add a screenshot to the next answer without answering yet, so a long question can be
   * captured in parts while scrolling (FR-SC6). Up to `screen.maxScreenshots`.
   */
  async addScreenshot(): Promise<AnswerActionResult> {
    if (!this.deps.captureScreen) return { ok: false, error: 'Screen capture is unavailable.' }
    const max = this.maxShots()
    if (this.attached.length >= max) {
      return { ok: false, error: `Up to ${max} screenshots per question (Settings → Screen) — remove one or answer first.` }
    }
    let shot: Screenshot
    try {
      shot = await this.deps.captureScreen({ manual: true })
    } catch (err) {
      log.warn('screenshot failed', err)
      return { ok: false, error: `Screenshot failed: ${err instanceof Error ? err.message : String(err)}` }
    }
    this.setAttached([...this.attached, shot].slice(-max))
    return { ok: true }
  }

  /** Answer from the waiting screenshots alone (the tray's Answer button). */
  answerScreenshots(): AnswerActionResult {
    if (this.attached.length === 0) return { ok: false, error: 'Add a screenshot first.' }
    return this.ask(this.screenQuestion())
  }

  /** Remove one waiting screenshot (the × on its thumbnail), or all of them. */
  clearScreenshot(index?: number): void {
    this.setAttached(index === undefined ? [] : this.attached.filter((_, i) => i !== index))
  }

  pendingScreenshot(): ScreenshotPending {
    return { thumbs: this.attached.map((s) => s.thumb), max: this.maxShots() }
  }

  private maxShots(): number {
    return this.deps.getSettings().screen.maxScreenshots
  }

  /** The interviewer is speaking, or what they said is about to be answered. */
  private questionUnderway(): boolean {
    return (
      this.livePartial.trim().length > 0 ||
      this.speechStartedAt.has('loopback') ||
      this.grace.has('loopback') ||
      this.detecting ||
      this.scheduled !== null
    )
  }

  private setAttached(shots: Screenshot[]): void {
    if (shots.length === 0 && this.attached.length === 0) return
    this.attached = shots
    this.emit('screenshot', this.pendingScreenshot())
  }

  regenerate(): AnswerActionResult {
    return this.rerun('auto')
  }

  shorter(): AnswerActionResult {
    return this.rerun('shorter')
  }

  private rerun(style: AnswerStyle): AnswerActionResult {
    const qa = this.qas.at(-1)
    if (!qa) return { ok: false, error: 'No answer to redo yet.' }
    this.schedule(qa, style, this.now(), true)
    return { ok: true }
  }

  /** Run detection on pending speech; re-runs if more speech arrives meanwhile. */
  private async evaluate(): Promise<void> {
    if (this.detecting) {
      this.dirty = true
      return
    }
    this.detecting = true
    try {
      do {
        this.dirty = false
        if (!this.deps.getSettings().detection.autoAnswer || this.pending.length === 0) return
        const batch = this.pending.slice()
        const endedAt = batch[batch.length - 1].endedAt
        const raw = batch.map((p) => p.text).join(' ')
        // The rest of a question cut off by a pause ("…how the virtual" + "DOM works.") isn't a
        // question by itself; it continues the last one, so skip detection.
        const prev = this.qas.at(-1)
        if (prev && this.continuesLastQuestion(batch[0].startedAt) && !this.deps.differentTopic?.(prev, raw)) {
          this.pending = []
          this.onQuestion(raw, prev.type, endedAt, { raw, startedAt: batch[0].startedAt, projectId: prev.projectId, taskId: prev.taskId })
          continue
        }
        const context = this.transcript
          .slice(0, -batch.length)
          .slice(-3)
          .map((l) => l.text)
        const d = await this.deps.detector.detect(
          batch.map((p) => p.text),
          context
        )
        this.emitLatency('detect', this.now() - endedAt)
        // Newer speech arrived, or a hotkey already consumed this text: decide again.
        if (this.dirty || !batch.every((p) => this.pending.includes(p))) continue
        log.debug(`detect via ${d.via}: question=${d.isQuestion} type=${d.type}`)
        if (!d.isQuestion) return
        this.pending = []
        // Judge "unfinished" on what was said, not on the classifier's cleaned-up rewrite.
        this.onQuestion(d.question, d.type, endedAt, {
          raw,
          startedAt: batch[0].startedAt,
          projectId: d.projectId,
          taskId: d.taskId,
          suggestedId: d.suggestedId
        })
      } while (this.dirty)
    } catch (err) {
      log.warn('question detection failed', err)
    } finally {
      this.detecting = false
    }
  }

  /**
   * Start an answer, or fold the text into the previous question and regenerate it when it
   * continues that one: the previous question was cut off mid-sentence (the rest arrived after
   * the pause), or (interviewer only, FR-Q4) it's a short follow-up like "And why?".
   * Voice questions skip the short-follow-up rule: two quick short questions are separate asks.
   */
  private onQuestion(
    question: string,
    type: QuestionType,
    endedAt: number,
    opts: { raw?: string; voice?: boolean; startedAt?: number; projectId?: string; taskId?: string; suggestedId?: string | null } = {}
  ): void {
    const now = this.now()
    // About another project or item (Work Mode): a new question, however soon it follows (FR-W10).
    const prev = this.qas.at(-1) && !this.deps.differentTopic?.(this.qas.at(-1)!, opts.raw ?? question) ? this.qas.at(-1) : undefined
    const recent = prev !== undefined && now - this.lastQuestionAt < FOLLOW_UP_MS
    const continues = prev !== undefined && this.continuesLastQuestion(opts.startedAt ?? endedAt)
    const followUp = recent && !opts.voice && wordCount(question) < FOLLOW_UP_MAX_WORDS
    this.lastQuestionAt = now
    this.lastQuestionEndedAt = endedAt
    this.lastQuestionIncomplete = looksIncomplete(opts.raw ?? question)
    if (prev && (continues || followUp)) {
      prev.question = `${prev.question} ${question}`
      this.schedule(prev, prev.style, endedAt, opts.voice)
      return
    }
    // A status question about an unknown project: ask which one rather than guess (FR-W9).
    if (type === 'status' && !opts.projectId) {
      this.emit('pick', { question, suggestedId: opts.suggestedId ?? null })
      return
    }
    this.schedule(this.newQa(question, type, opts.projectId, opts.taskId), 'auto', endedAt, opts.voice)
  }

  /** FR-Q5: at most one generation per debounce window; the latest request wins. */
  private schedule(qa: QaSnapshot, style: AnswerStyle, triggeredAt: number, immediate = false): void {
    this.cancelScheduled()
    const wait = immediate ? 0 : Math.max(0, this.lastGenAt + this.deps.getSettings().detection.debounceMs - this.now())
    if (wait === 0) {
      void this.run(qa, style, triggeredAt)
      return
    }
    this.scheduled = setTimeout(() => {
      this.scheduled = null
      void this.run(qa, style, triggeredAt)
    }, wait)
  }

  private async run(qa: QaSnapshot, style: AnswerStyle, triggeredAt: number): Promise<void> {
    // A new generation cancels the one in flight (FR-Q5).
    const prev = this.current
    if (prev) {
      prev.controller.abort()
      // Re-running the same Q&A resets it via the 'question' event; a different one is left as interrupted.
      if (prev.qa !== qa) {
        const message = 'Interrupted by the next question.'
        Object.assign(prev.qa, { status: 'error', error: message })
        this.emit('error', { id: prev.qa.id, message, partial: prev.qa.answer.length > 0 })
        this.settle(prev.qa)
      }
    }
    const controller = new AbortController()
    this.current = { qa, controller }
    this.lastGenAt = this.now()

    // The Q&A's own screenshots (regenerate), else the ones waiting, else a fresh one if "always include" is on.
    let shots = this.shots.get(qa.id) ?? []
    if (shots.length === 0 && this.attached.length > 0) {
      shots = this.attached
      this.setAttached([])
    }
    if (shots.length === 0 && this.deps.captureScreen && this.deps.getSettings().screen.alwaysInclude) {
      try {
        shots = [await this.deps.captureScreen({ manual: false })]
      } catch (err) {
        log.warn('automatic screenshot failed; answering without it', err)
      }
      if (controller.signal.aborted) return
    }
    if (shots.length) this.shots.set(qa.id, shots)
    const thumbs = shots.length ? shots.map((s) => s.thumb) : undefined

    Object.assign(qa, { answer: '', status: 'thinking', style, error: undefined, truncated: undefined, servedBy: undefined, screenshots: thumbs })
    if (!this.qas.includes(qa)) {
      this.qas.push(qa)
      if (this.qas.length > MAX_QAS) this.shots.delete(this.qas.shift()!.id)
    }
    this.emit('question', {
      id: qa.id,
      question: qa.question,
      type: qa.type,
      style,
      ts: this.now(),
      ...(thumbs ? { screenshots: thumbs } : {}),
      ...(qa.project ? { project: qa.project } : {})
    })

    let first = true
    try {
      const result = await this.deps.answers.generate({
        question: qa.question,
        type: qa.type,
        style,
        ...(qa.projectId ? { projectId: qa.projectId } : {}),
        ...(qa.taskId ? { taskId: qa.taskId } : {}),
        transcript: this.transcript.slice(),
        earlier: this.earlierThan(qa),
        ...(shots.length ? { images: shots.map((s) => ({ type: 'image' as const, mediaType: s.mediaType, data: s.data })) } : {}),
        signal: controller.signal,
        onText: (delta) => {
          if (controller.signal.aborted) return
          if (first) {
            first = false
            qa.status = 'streaming'
            this.emitLatency('firstToken', this.now() - triggeredAt)
          }
          qa.answer += delta
          this.emit('token', { id: qa.id, delta })
        }
      })
      if (controller.signal.aborted) return
      this.lastLlmAt = this.now()
      qa.status = 'done'
      qa.truncated = result.truncated
      qa.servedBy = servedBy(result.usage)
      this.emit('done', { id: qa.id, usage: result.usage, truncated: result.truncated })
      this.settle(qa)
      log.info(
        `answer ${qa.id} ${qa.type}/${style}: ${result.usage.service ? `[${result.usage.service}] ` : ''}${result.usage.model}${result.usage.provider ? ` via ${result.usage.provider}` : ''} in=${result.usage.inputTokens} cached=${result.usage.cacheReadTokens} out=${result.usage.outputTokens}`
      )
    } catch (err) {
      if (controller.signal.aborted || (err instanceof LlmError && err.kind === 'aborted')) return
      const partial = err instanceof PartialAnswerError
      const retry = shortcutText(this.deps.getSettings().hotkeys.regenerate.replace(/CommandOrControl|CmdOrCtrl/g, 'Ctrl'), process.platform)
      const message = partial ? `⚠ incomplete — ${retry} to retry` : err instanceof Error ? err.message : String(err)
      log.warn(`answer ${qa.id} failed: ${err instanceof Error ? err.message : String(err)}`)
      qa.status = 'error'
      qa.error = message
      this.emit('error', { id: qa.id, message, partial })
      this.settle(qa)
    } finally {
      if (this.current?.controller === controller) this.current = null
    }
  }

  private async warm(): Promise<void> {
    this.lastLlmAt = this.now()
    try {
      const usage = await this.deps.answers.prewarm()
      log.debug(`prompt cache warmed: write=${usage.cacheWriteTokens} read=${usage.cacheReadTokens}`)
    } catch (err) {
      log.debug(`prompt cache warm skipped: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** The answered Q&As before `qa` (oldest first), for follow-up context. Typed questions aren't in the transcript. */
  private earlierThan(qa: QaSnapshot): { question: string; answer: string }[] {
    const i = this.qas.indexOf(qa)
    return (i === -1 ? this.qas : this.qas.slice(0, i))
      .filter((q) => q.answer.trim())
      .slice(-EARLIER_QAS)
      .map((q) => ({ question: q.question, answer: q.answer }))
  }

  private settle(qa: QaSnapshot): void {
    const shots = this.shots.get(qa.id)
    this.emit('settled', { ...qa }, shots ? { screenshots: shots.map((s) => s.data) } : {})
  }

  private newQa(question: string, type: QuestionType, projectId?: string, taskId?: string): QaSnapshot {
    const project = projectId ? (this.deps.projectName?.(projectId, taskId) ?? undefined) : undefined
    return {
      id: `qa-${this.now()}-${++this.seq}`,
      question,
      type,
      style: 'auto',
      answer: '',
      status: 'thinking',
      ...(projectId ? { projectId, project, ...(taskId ? { taskId } : {}) } : {})
    }
  }

  private mode(): AppMode {
    return this.deps.getMode?.() ?? 'interview'
  }

  /**
   * Typed and voice questions: Work Mode checks them for a status question about a known project or
   * item (FR-W6), else answers them from project context; Interview Mode guesses the interview type.
   */
  private direct(text: string): DirectQuestion {
    if (this.mode() !== 'work') return { type: guessType(text) }
    return this.deps.resolveQuestion?.(text) ?? { type: 'work' }
  }

  private screenQuestion(): string {
    return this.mode() === 'work' ? WORK_SCREEN_QUESTION : SCREEN_QUESTION
  }

  private cancelScheduled(): void {
    if (this.scheduled) clearTimeout(this.scheduled)
    this.scheduled = null
  }

  private emitLatency(stage: 'detect' | 'firstToken', ms: number): void {
    this.emit('latency', { stage, source: 'loopback', ms: Math.max(0, Math.round(ms)), ts: this.now() })
  }
}

