/**
 * Remembers models and providers that recently failed (rate limits, daily caps, bad keys) so the
 * next requests skip them instead of spending scarce free-tier requests on known failures.
 * In memory only: a restart clears it.
 */
export class Cooldowns {
  private readonly until = new Map<string, number>()

  constructor(private readonly now: () => number = Date.now) {}

  mark(key: string, ms: number): void {
    if (ms <= 0) return
    this.until.set(key, Math.max(this.until.get(key) ?? 0, this.now() + ms))
  }

  active(key: string): boolean {
    const until = this.until.get(key)
    if (until === undefined) return false
    if (until > this.now()) return true
    this.until.delete(key)
    return false
  }

  /** e.g. after an API key changes. */
  clear(prefix = ''): void {
    for (const key of [...this.until.keys()]) if (key.startsWith(prefix)) this.until.delete(key)
  }
}

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE

/** How long to skip a model/provider after an error of this kind, unless the API said (Retry-After). */
export function cooldownMs(kind: string, retryAfterMs?: number, status?: number): number {
  if (retryAfterMs !== undefined) return Math.min(retryAfterMs, 24 * HOUR)
  switch (kind) {
    case 'rate_limit':
      return MINUTE
    case 'overloaded':
      return 30 * SECOND
    case 'network':
      return 15 * SECOND
    case 'exhausted':
      return HOUR
    case 'auth':
      return 10 * MINUTE
    default:
      // Model not found / blocked by data policy: unlikely to change soon.
      return status === 404 ? 10 * MINUTE : 0
  }
}

/** Parse a Retry-After header (seconds or HTTP date) into ms. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * SECOND
  const date = Date.parse(value)
  return Number.isNaN(date) ? undefined : Math.max(0, date - now)
}
