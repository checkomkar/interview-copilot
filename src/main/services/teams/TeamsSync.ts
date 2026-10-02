import { EventEmitter } from 'node:events'
import type { Settings } from '@shared/settings'
import type { TeamsSource, TeamsStatus } from '@shared/work'
import { createLogger } from '../../logger'
import type { ProjectStore } from '../work/ProjectStore'
import type { ChatMessage, TeamsImporter } from '../work/teamsImport'
import { TeamsError, type DeviceCode, type TeamsGraph } from './TeamsGraph'

const log = createLogger('teams')

/** The first sync of a newly followed chat reads this far back. */
const FIRST_SYNC_MS = 24 * 60 * 60 * 1000
/** Messages per extraction request. */
const BATCH = 120

export interface TeamsSyncDeps {
  graph: Pick<TeamsGraph, 'startSignIn' | 'finishSignIn' | 'me' | 'listSources' | 'messagesSince' | 'isSignedIn' | 'signOut'>
  importer: Pick<TeamsImporter, 'run'>
  store: Pick<ProjectStore, 'getCursor' | 'setCursor'>
  getSettings: () => Settings
  now?: () => number
}

export interface TeamsSyncEvents {
  status: [TeamsStatus]
}

/**
 * Teams sync (FR-T3): signs in with a work or school account, polls the followed chats and
 * channels every few minutes for messages newer than the last one read, and sends them through
 * the same extraction as a paste, so they land in the review queue (FR-T4).
 */
export class TeamsSync extends EventEmitter {
  private state: TeamsStatus
  private timer: NodeJS.Timeout | null = null
  private signInAbort: AbortController | null = null
  private running: Promise<void> | null = null
  private readonly now: () => number

  constructor(private readonly deps: TeamsSyncDeps) {
    super()
    this.now = deps.now ?? Date.now
    this.state = { configured: false, account: null, signIn: null, syncing: false, lastSync: null, lastFound: 0, error: null }
    this.state.configured = this.configured()
  }

  override emit<E extends keyof TeamsSyncEvents>(event: E, ...args: TeamsSyncEvents[E]): boolean {
    return super.emit(event, ...args)
  }
  override on<E extends keyof TeamsSyncEvents>(event: E, listener: (...args: TeamsSyncEvents[E]) => void): this {
    return super.on(event, listener as (...a: unknown[]) => void)
  }

  status(): TeamsStatus {
    return { ...this.state, configured: this.configured() }
  }

  /** At app start: pick up an existing sign-in and start polling. */
  async start(): Promise<void> {
    if (!this.configured() || !this.deps.graph.isSignedIn()) return this.schedule()
    try {
      this.set({ account: await this.account(), error: null })
    } catch (err) {
      this.fail(err)
    }
    this.schedule()
  }

  /** Begin device-code sign-in; resolves with the code to show. Sign-in completes in the background. */
  async signIn(): Promise<{ userCode: string; verificationUri: string }> {
    this.cancelSignIn()
    const code: DeviceCode = await this.deps.graph.startSignIn()
    this.set({ signIn: { userCode: code.userCode, verificationUri: code.verificationUri, expiresAt: code.expiresAt }, error: null })
    const abort = new AbortController()
    this.signInAbort = abort
    void this.deps.graph
      .finishSignIn(code, abort.signal)
      .then(async () => {
        this.set({ signIn: null, account: await this.account(), error: null })
        log.info('signed in to Teams')
        this.schedule()
        await this.syncNow()
      })
      .catch((err) => {
        if (abort.signal.aborted) return
        this.set({ signIn: null })
        this.fail(err)
      })
      .finally(() => {
        if (this.signInAbort === abort) this.signInAbort = null
      })
    return { userCode: code.userCode, verificationUri: code.verificationUri }
  }

  cancelSignIn(): void {
    this.signInAbort?.abort()
    this.signInAbort = null
    if (this.state.signIn) this.set({ signIn: null })
  }

  signOut(): void {
    this.cancelSignIn()
    this.deps.graph.signOut()
    this.set({ account: null, error: null, lastSync: null, lastFound: 0 })
    this.schedule()
  }

  /** Chats and channels to choose from. */
  async listSources(): Promise<TeamsSource[]> {
    try {
      return await this.deps.graph.listSources()
    } catch (err) {
      this.fail(err)
      throw err
    }
  }

  /** Read new messages from every followed source now; one sync at a time. */
  syncNow(): Promise<void> {
    this.running ??= this.sync().finally(() => {
      this.running = null
    })
    return this.running
  }

  /** Settings changed: re-plan polling. */
  refresh(): void {
    this.set({ configured: this.configured() })
    this.schedule()
  }

  dispose(): void {
    this.cancelSignIn()
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private async sync(): Promise<void> {
    const sources = this.deps.getSettings().work.teams.sources
    if (!this.deps.graph.isSignedIn() || sources.length === 0) return
    this.set({ syncing: true })
    try {
      const now = this.now()
      const read: { source: TeamsSource; messages: ChatMessage[] }[] = []
      for (const source of sources) {
        const since = this.deps.store.getCursor(cursorId(source)) ?? now - FIRST_SYNC_MS
        read.push({ source, messages: await this.deps.graph.messagesSince(source, since) })
      }
      const all = read.flatMap((r) => r.messages).sort((a, b) => a.ts - b.ts)
      let found = 0
      for (let i = 0; i < all.length; i += BATCH) {
        const res = await this.deps.importer.run({ messages: all.slice(i, i + BATCH) }, 'teams')
        // Not marked as read, so the next sync tries these messages again.
        if (!res.ok) throw new TeamsError(res.error, 'other')
        found += res.proposals.length
      }
      for (const r of read) if (r.messages.length) this.deps.store.setCursor(cursorId(r.source), Math.max(...r.messages.map((m) => m.ts)))
      log.info(`Teams sync: ${all.length} new message(s), ${found} suggestion(s)`)
      this.set({ lastSync: now, lastFound: found, error: null })
    } catch (err) {
      this.fail(err)
    } finally {
      this.set({ syncing: false })
    }
  }

  private schedule(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    const t = this.deps.getSettings().work.teams
    if (!t.enabled || !this.configured() || !this.deps.graph.isSignedIn() || t.sources.length === 0) return
    this.timer = setInterval(() => void this.syncNow(), t.pollMinutes * 60_000)
  }

  private async account(): Promise<string> {
    const me = await this.deps.graph.me()
    return [me.displayName, me.userPrincipalName].filter(Boolean).join(' · ') || 'Signed in'
  }

  private configured(): boolean {
    return Boolean(this.deps.getSettings().work.teams.clientId.trim())
  }

  private fail(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err)
    log.warn(`Teams: ${message}`)
    if (err instanceof TeamsError && err.kind === 'auth' && !this.deps.graph.isSignedIn()) this.set({ account: null })
    this.set({ error: message })
  }

  private set(patch: Partial<TeamsStatus>): void {
    this.state = { ...this.state, ...patch }
    this.emit('status', this.status())
  }
}

/** Channel ids repeat across teams; chat ids don't. */
function cursorId(s: TeamsSource): string {
  return s.kind === 'channel' ? `channel:${s.teamId}:${s.id}` : `chat:${s.id}`
}
