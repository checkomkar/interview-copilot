import { describe, expect, it, vi } from 'vitest'
import { EMPTY_PROFILE } from '@shared/profile'
import { DEFAULT_SETTINGS, activeModels } from '@shared/settings'
import { AnswerService, PartialAnswerError } from '../src/main/services/answer/AnswerService'
import { LlmError } from '../src/main/services/llm/LlmProvider'
import { MockLlm } from './mockLlm'

function setup(llm: MockLlm) {
  const sleep = vi.fn(async () => {})
  const svc = new AnswerService({ provider: llm, getSettings: () => DEFAULT_SETTINGS, getProfile: () => EMPTY_PROFILE, sleep })
  const tokens: string[] = []
  const run = (signal = new AbortController().signal) =>
    svc.generate({ question: 'What is React?', type: 'technical', style: 'auto', transcript: [], signal, onText: (d) => tokens.push(d) })
  return { svc, sleep, tokens, run }
}

const { answerModel, fastModel } = activeModels(DEFAULT_SETTINGS)

describe('AnswerService', () => {
  it('streams tokens from the answer model with a cacheable system prompt', async () => {
    const llm = new MockLlm([{ tokens: ['Hello', ' world'] }])
    const { run, tokens } = setup(llm)
    const res = await run()
    expect(res.text).toBe('Hello world')
    expect(tokens).toEqual(['Hello', ' world'])
    expect(llm.requests[0]).toMatchObject({ model: answerModel, maxTokens: 600 })
    expect(llm.requests[0].system[0].cache).toBe(true)
  })

  it('retries once after 1 s on 429, then falls back to the fast model', async () => {
    const llm = new MockLlm([new LlmError('rate_limit', '429'), new LlmError('overloaded', '529'), { tokens: ['fallback'] }])
    const { run, sleep } = setup(llm)
    const res = await run()
    expect(res.text).toBe('fallback')
    expect(llm.requests.map((r) => r.model)).toEqual([answerModel, answerModel, fastModel])
    expect(sleep).toHaveBeenCalledTimes(1)
    expect(sleep).toHaveBeenCalledWith(1000, expect.any(AbortSignal))
  })

  it('does not retry non-retryable errors', async () => {
    const llm = new MockLlm([new LlmError('auth', 'bad key')])
    await expect(setup(llm).run()).rejects.toMatchObject({ kind: 'auth' })
    expect(llm.requests).toHaveLength(1)
  })

  it('keeps partial text when the stream fails mid-answer', async () => {
    const llm = new MockLlm([{ tokens: ['half'], error: new LlmError('network', 'dropped') }])
    const { run, tokens } = setup(llm)
    await expect(run()).rejects.toBeInstanceOf(PartialAnswerError)
    expect(tokens).toEqual(['half'])
    expect(llm.requests).toHaveLength(1)
  })

  it('prewarms with the same model and system prompt as real answers', async () => {
    const llm = new MockLlm([{ tokens: ['x'] }])
    const { svc, run } = setup(llm)
    await svc.prewarm()
    await run()
    expect(llm.prewarms[0]).toMatchObject({ model: answerModel, maxTokens: 0 })
    expect(llm.prewarms[0].system).toEqual(llm.requests[0].system)
  })
})
