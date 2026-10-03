import type { AnswerStyle, AnswerUsage, QuestionType } from '@shared/ipc'
import type { Profile } from '@shared/profile'
import { activeModels, type AppMode, type Settings } from '@shared/settings'
import type { Project } from '@shared/work'
import { createLogger } from '../../logger'
import { LlmError, type LlmImagePart, type LlmMessage, type LlmProvider, type LlmRequest, type LlmResult, type LlmSystemBlock } from '../llm/LlmProvider'
import { answerMaxTokens, buildAnswerMessages, buildAnswerSystem, type EarlierQa, type TranscriptLine } from '../llm/prompts'
import { rankProjects } from '../work/projectMatch'
import { buildStatusMessages, buildStatusSystem, buildWorkMessages, buildWorkSystem } from '../work/workPrompts'

const log = createLogger('answer')

export interface AnswerRequest {
  question: string
  type: QuestionType
  style: AnswerStyle
  transcript: TranscriptLine[]
  /** Earlier Q&As of the session (oldest first), so follow-ups have context. */
  earlier?: EarlierQa[]
  /** Screenshots sent with the question, in order; answered by the vision models. */
  images?: LlmImagePart[]
  /** Work Mode status update: the project it is about. */
  projectId?: string
  /** …and the item, when the question is about one (FR-W7a). */
  taskId?: string
  signal: AbortSignal
  onText: (delta: string) => void
}

export interface AnswerServiceDeps {
  provider: LlmProvider
  getSettings: () => Settings
  getProfile: () => Profile
  /** Over the session cost cap: answer with the fast models (FR-C4). */
  isCapped?: () => boolean
  /** Default: interview. */
  getMode?: () => AppMode
  /** Work Mode's project store (FR-W1). */
  projects?: { get: (id: string) => Project | null; list: () => Project[] }
  now?: () => number
  /** Injectable for tests. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
}

/** Thrown when a stream fails after some text was shown; the partial answer is kept. */
export class PartialAnswerError extends Error {
  constructor(readonly cause: LlmError) {
    super(cause.message)
    this.name = 'PartialAnswerError'
  }
}

const RETRY_DELAY_MS = 1000

/** Work questions get the context of the projects they mention, at most this many. */
const RELEVANT_PROJECTS = 2

/** Builds answer prompts and streams them (FR-G1..G7), with retry + fallback (PRD §9). */
export class AnswerService {
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>

  constructor(private readonly deps: AnswerServiceDeps) {
    this.sleep = deps.sleep ?? abortableSleep
  }

  async generate(req: AnswerRequest): Promise<LlmResult> {
    const settings = this.deps.getSettings()
    const { system, messages } = this.prompt(req, settings)
    const request: LlmRequest = {
      model: activeModels(settings).answerModel,
      role: 'answer',
      purpose: 'answer',
      system,
      messages,
      maxTokens: answerMaxTokens(req.type, req.style, settings, Boolean(req.images?.length), Boolean(req.earlier?.length), req.question),
      signal: req.signal
    }
    const { answerModel, fastModel, visionModel } = activeModels(settings)

    // 429/529 -> retry once after 1 s -> fall back to fastModel. (Model chains and provider failover
    // happen inside the provider; models already rate-limited are skipped without a request.)
    // Screenshots need models that accept images, so they retry on the vision chain only.
    const answer = { model: answerModel, role: 'answer' as const }
    const fast = { model: fastModel, role: 'fast' as const }
    const vision = { model: visionModel, role: 'vision' as const }
    const attempts = req.images?.length
      ? [vision, vision]
      : this.deps.isCapped?.()
        ? [fast, fast]
        : answerModel === fastModel
          ? [answer, answer]
          : [answer, answer, fast]
    let lastError: LlmError | null = null
    for (let i = 0; i < attempts.length; i++) {
      let streamed = false
      try {
        return await this.deps.provider.stream(
          { ...request, ...attempts[i] },
          {
            onText: (d) => {
              streamed = true
              req.onText(d)
            }
          }
        )
      } catch (err) {
        const e = err instanceof LlmError ? err : new LlmError('other', String(err))
        if (e.kind === 'aborted') throw e
        if (streamed) throw new PartialAnswerError(e)
        lastError = e
        if (!e.retryable || i === attempts.length - 1) break
        const retrying = attempts[i + 1] === attempts[i]
        log.warn(`${attempts[i].role} models failed (${e.message}); ${retrying ? 'retrying' : 'falling back to the fast models'}`)
        if (retrying) await this.sleep(RETRY_DELAY_MS, req.signal)
      }
    }
    throw lastError ?? new LlmError('other', 'Answer failed')
  }

  /**
   * Interview questions use §6.1; Work Mode status updates the project's §6.5 block, and other work
   * questions and screenshots the general work prompt with the projects they mention (FR-W5).
   */
  private prompt(req: AnswerRequest, settings: Settings): { system: LlmSystemBlock[]; messages: LlmMessage[] } {
    const profile = this.deps.getProfile()
    const store = this.deps.projects
    if (req.type !== 'status' && req.type !== 'work') {
      return {
        system: buildAnswerSystem(profile, settings),
        messages: buildAnswerMessages({ ...req, stepwise: settings.llm.codingAnswer === 'stepwise', diagrams: settings.llm.diagrams })
      }
    }
    const now = (this.deps.now ?? Date.now)()
    const project = req.projectId ? (store?.get(req.projectId) ?? null) : null
    if (req.type === 'status' && project && !req.images?.length) {
      return { system: buildStatusSystem(profile, project, now, req.taskId), messages: buildStatusMessages(req) }
    }
    const all = store?.list() ?? []
    const relevant = project
      ? [project]
      : rankProjects(req.question, all)
          .filter((m) => m.score >= 0.6)
          .slice(0, RELEVANT_PROJECTS)
          .map((m) => m.project)
    return { system: buildWorkSystem(profile, all, relevant, now), messages: buildWorkMessages(req) }
  }

  /** Warm the prompt cache for the answer model with the current profile (max_tokens 0). Interview Mode only: Work prompts depend on the project. */
  async prewarm(): Promise<AnswerUsage> {
    const settings = this.deps.getSettings()
    if ((this.deps.getMode?.() ?? 'interview') === 'work') throw new LlmError('other', 'nothing to pre-warm in Work Mode')
    return this.deps.provider.prewarm({
      ...this.baseRequest(settings),
      messages: [{ role: 'user', content: 'Ready.' }],
      maxTokens: 0
    })
  }

  private baseRequest(settings: Settings): Pick<LlmRequest, 'model' | 'role' | 'system' | 'purpose'> {
    return {
      model: activeModels(settings).answerModel,
      role: 'answer',
      purpose: 'answer',
      system: buildAnswerSystem(this.deps.getProfile(), settings)
    }
  }
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new LlmError('aborted', 'Canceled'))
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(t)
      reject(new LlmError('aborted', 'Canceled'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
