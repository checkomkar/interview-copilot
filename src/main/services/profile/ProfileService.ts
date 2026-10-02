import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { EMPTY_PROFILE, ProfileInputSchema, ProfileSchema, type Profile, type ProfileSaveResult } from '@shared/profile'
import { activeModels, type Settings } from '@shared/settings'
import { createLogger } from '../../logger'
import type { LlmProvider } from '../llm/LlmProvider'
import { buildJdSummaryMessages, buildResumeSummaryMessages } from '../llm/prompts'

const log = createLogger('profile')

export interface ProfileServiceDeps {
  /** Directory for profile.json; null keeps the profile in memory only (tests). */
  dir: string | null
  provider: LlmProvider
  getSettings: () => Settings
}

export const hashText = (text: string): string => createHash('sha256').update(text.trim()).digest('hex').slice(0, 16)

/**
 * The single candidate profile (resume, JD, notes) plus fastModel summaries (PRD §3.7, §6.3).
 * Stored as profile.json until the SQLite `profiles` table lands in Phase 3.
 */
export class ProfileService extends EventEmitter {
  private profile: Profile
  private readonly path: string | null

  constructor(private readonly deps: ProfileServiceDeps) {
    super()
    this.path = deps.dir ? join(deps.dir, 'profile.json') : null
    this.profile = this.load()
  }

  get(): Profile {
    return this.profile
  }

  /** Validate and store the edited fields, then (re)summarize the resume/JD if their text changed. */
  async save(input: unknown): Promise<ProfileSaveResult> {
    const fields = ProfileInputSchema.parse(input)
    let next: Profile = { ...this.profile, ...fields, updatedAt: Date.now() }

    const errors: string[] = []
    const summarize = async (kind: 'resume' | 'jd') => {
      const text = kind === 'resume' ? next.resumeText : next.jdText
      const of = kind === 'resume' ? next.resumeSummaryOf : next.jdSummaryOf
      const summaryKey = kind === 'resume' ? 'resumeSummary' : 'jdSummary'
      const ofKey = kind === 'resume' ? 'resumeSummaryOf' : 'jdSummaryOf'
      if (!text.trim()) {
        next = { ...next, [summaryKey]: '', [ofKey]: null }
        return
      }
      const hash = hashText(text)
      if (of === hash && next[summaryKey]) return
      try {
        const summary = await this.summarize(kind, text)
        next = { ...next, [summaryKey]: summary, [ofKey]: hash }
      } catch (err) {
        // Keep going without a summary; prompts fall back to the raw text.
        next = { ...next, [summaryKey]: '', [ofKey]: null }
        errors.push(`${kind === 'resume' ? 'Resume' : 'Job description'} summary failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    await Promise.all([summarize('resume'), summarize('jd')])

    this.profile = ProfileSchema.parse(next)
    this.persist()
    this.emit('changed', this.profile)
    if (errors.length) log.warn(errors.join('; '))
    return errors.length ? { profile: this.profile, summaryError: errors.join(' ') } : { profile: this.profile }
  }

  private async summarize(kind: 'resume' | 'jd', text: string): Promise<string> {
    const started = Date.now()
    const result = await this.deps.provider.complete({
      model: activeModels(this.deps.getSettings()).fastModel,
      role: 'fast',
      purpose: 'summary',
      system: [],
      messages: kind === 'resume' ? buildResumeSummaryMessages(text) : buildJdSummaryMessages(text),
      maxTokens: kind === 'resume' ? 700 : 400
    })
    log.info(`${kind} summarized in ${Date.now() - started} ms (${result.usage.outputTokens} tokens)`)
    return result.text.trim()
  }

  private load(): Profile {
    if (!this.path || !existsSync(this.path)) return EMPTY_PROFILE
    try {
      const parsed = ProfileSchema.safeParse(JSON.parse(readFileSync(this.path, 'utf8')))
      if (parsed.success) return parsed.data
      log.warn('profile.json invalid, starting empty', parsed.error.issues)
    } catch (err) {
      log.error('could not read profile.json', err)
    }
    return EMPTY_PROFILE
  }

  private persist(): void {
    if (!this.path) return
    const tmp = `${this.path}.tmp`
    writeFileSync(tmp, JSON.stringify(this.profile, null, 2), 'utf8')
    renameSync(tmp, this.path)
  }
}
