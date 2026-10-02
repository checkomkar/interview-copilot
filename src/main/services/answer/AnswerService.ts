import type { AnswerStyle, AnswerUsage, QuestionType } from '@shared/ipc'
import type { Profile } from '@shared/profile'
import { activeModels, type Settings } from '@shared/settings'
import { createLogger } from '../../logger'
import { LlmError, type LlmProvider, type LlmRequest, type LlmResult } from '../llm/LlmProvider'
import { answerMaxTokens, buildAnswerMessages, buildAnswerSystem, type TranscriptLine } from '../llm/prompts'

const log = createLogger('answer')

export interface AnswerRequest {
  question: string
  type: QuestionType
  style: AnswerStyle
  transcript: TranscriptLine[]
  signal: AbortSignal
  onText: (delta: string) => void
}

export interface AnswerServiceDeps {
  provider: LlmProvider
  getSettings: () => Settings
  getProfile: () => Profile
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

/** Builds answer prompts and streams them (FR-G1..G7), with retry + fallback (PRD §9). */
export class AnswerService {
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>

  constructor(private readonly deps: AnswerServiceDeps) {
    this.sleep = deps.sleep ?? abortableSleep
  }

  async generate(req: AnswerRequest): Promise<LlmResult> {
    const settings = this.deps.getSettings()
    const base = this.baseRequest(settings)
    const request: LlmRequest = {
      ...base,
      messages: buildAnswerMessages(req),
      maxTokens: answerMaxTokens(req.type, req.style, settings),
      signal: req.signal
    }
    const { answerModel, fastModel } = activeModels(settings)

    // 429/529 -> retry once after 1 s -> fall back to fastModel. (Model chains and provider failover
    // happen inside the provider; models already rate-limited are skipped without a request.)
    const answer = { model: answerModel, role: 'answer' as const }
    const fast = { model: fastModel, role: 'fast' as const }
    const attempts = answerModel === fastModel ? [answer, answer] : [answer, answer, fast]
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

  /** Warm the prompt cache for the answer model with the current profile (max_tokens 0). */
  async prewarm(): Promise<AnswerUsage> {
    const settings = this.deps.getSettings()
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
