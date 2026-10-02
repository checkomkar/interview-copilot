import type { AnswerUsage } from '@shared/ipc'
import { LlmError, type LlmProvider, type LlmRequest, type LlmResult, type LlmStreamHandlers } from '../src/main/services/llm/LlmProvider'

export type Script = { tokens: string[]; error?: LlmError; delayMs?: number } | LlmError

/** Scripted LLM provider: each stream() call consumes the next script entry. */
export class MockLlm implements LlmProvider {
  requests: LlmRequest[] = []
  prewarms: LlmRequest[] = []
  completions: LlmRequest[] = []
  completeText: string | ((req: LlmRequest) => string | Promise<string>) = 'summary'

  constructor(private readonly scripts: Script[] = []) {}

  push(...s: Script[]): void {
    this.scripts.push(...s)
  }

  async stream(req: LlmRequest, handlers: LlmStreamHandlers): Promise<LlmResult> {
    this.requests.push(req)
    const script = this.scripts.shift() ?? { tokens: ['ok'] }
    if (script instanceof LlmError) throw script
    let text = ''
    for (const t of script.tokens) {
      if (script.delayMs) await sleep(script.delayMs, req.signal)
      if (req.signal?.aborted) throw new LlmError('aborted', 'Canceled')
      text += t
      handlers.onText(t)
    }
    if (script.error) throw script.error
    return { text, usage: usage(req.model), truncated: false }
  }

  async complete(req: LlmRequest): Promise<LlmResult> {
    this.completions.push(req)
    const text = typeof this.completeText === 'function' ? await this.completeText(req) : this.completeText
    return { text, usage: usage(req.model), truncated: false }
  }

  async prewarm(req: LlmRequest): Promise<AnswerUsage> {
    this.prewarms.push(req)
    return usage(req.model)
  }
}

export function usage(model: string): AnswerUsage {
  return { model, inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(t)
      reject(new LlmError('aborted', 'Canceled'))
    })
  })
}
