import type { AnswerUsage } from '@shared/ipc'
import { LLM_PROVIDER_LABELS, modelsFor, providerOrder, type LlmProviderId, type Settings } from '@shared/settings'
import { createLogger } from '../../logger'
import { cooldownMs, type Cooldowns } from './Cooldowns'
import { LlmError, type LlmProvider, type LlmRequest, type LlmResult, type LlmStreamHandlers } from './LlmProvider'

const log = createLogger('router')

export interface RouterDeps {
  getSettings: () => Settings
  hasKey: (id: LlmProviderId) => boolean
  cooldowns: Cooldowns
}

/**
 * Sends each request to the primary provider, failing over to the selected fallback providers
 * (those with an API key) when it is rate-limited, out of quota or rejecting the key. A provider
 * that is out for the whole account is skipped for a while. Reads settings per request, so
 * switching providers needs no restart.
 */
export class LlmRouter implements LlmProvider {
  constructor(
    private readonly providers: Record<LlmProviderId, LlmProvider>,
    private readonly deps: RouterDeps
  ) {}

  stream(req: LlmRequest, handlers: LlmStreamHandlers): Promise<LlmResult> {
    return this.run(req, (provider, r, onStreamed) =>
      provider.stream(r, {
        onText: (d) => {
          onStreamed()
          handlers.onText(d)
        }
      })
    )
  }

  complete(req: LlmRequest): Promise<LlmResult> {
    return this.run(req, (provider, r) => provider.complete(r))
  }

  /** Only the primary provider: warming a fallback's cache would be a guess. */
  prewarm(req: LlmRequest): Promise<AnswerUsage> {
    const id = this.deps.getSettings().llm.provider
    return this.providers[id].prewarm(req)
  }

  /** Providers to try now, in order: configured, keyed, not cooling down. */
  candidates(): { ready: LlmProviderId[]; keyed: LlmProviderId[] } {
    const keyed = providerOrder(this.deps.getSettings()).filter((id) => this.deps.hasKey(id))
    return { keyed, ready: keyed.filter((id) => !this.deps.cooldowns.active(providerKey(id))) }
  }

  private async run(req: LlmRequest, call: (p: LlmProvider, r: LlmRequest, onStreamed: () => void) => Promise<LlmResult>): Promise<LlmResult> {
    const settings = this.deps.getSettings()
    const { keyed, ready } = this.candidates()
    if (keyed.length === 0) {
      throw new LlmError('auth', `Add your ${LLM_PROVIDER_LABELS[settings.llm.provider]} API key in Settings.`)
    }
    // A request without a role carries a literal model ID, which only means something to the primary.
    const order = req.role ? ready : ready.filter((id) => id === settings.llm.provider)
    if (order.length === 0) {
      throw new LlmError('exhausted', 'Every answer provider is out of quota or failing right now — try again in a few minutes.')
    }

    let last: LlmError | null = null
    for (let i = 0; i < order.length; i++) {
      const id = order[i]
      const models = modelsFor(settings, id)
      const model = req.role === 'fast' ? models.fastModel : req.role === 'answer' ? models.answerModel : req.model
      let streamed = false
      try {
        const result = await call(this.providers[id], { ...req, model }, () => {
          streamed = true
        })
        result.usage.service = LLM_PROVIDER_LABELS[id]
        return result
      } catch (err) {
        const e = err instanceof LlmError ? err : new LlmError('other', String(err))
        if (e.kind === 'aborted' || streamed || !e.failover) throw e
        // Account-wide problems: stop sending this provider requests for a while.
        if (e.extra.scope === 'provider' || e.kind === 'exhausted' || e.kind === 'auth') {
          this.deps.cooldowns.mark(providerKey(id), cooldownMs(e.kind, e.extra.retryAfterMs, e.status))
        }
        const next = order[i + 1]
        log.warn(`${LLM_PROVIDER_LABELS[id]} failed (${e.message})${next ? `; switching to ${LLM_PROVIDER_LABELS[next]}` : ''}`)
        last = e
      }
    }
    throw last ?? new LlmError('other', 'No provider could answer.')
  }
}

export const providerKey = (id: LlmProviderId) => `provider:${id}`
