import { createLogger } from '../../logger'
import type { LlmMessage } from '../llm/LlmProvider'
import type { ProjectStore } from './ProjectStore'
import { buildCondenseMessages, contextHash, needsCondensing, projectBody } from './workPrompts'

const log = createLogger('work')

/** Wait for edits to settle before condensing (typing a few updates in a row is one request). */
const DEBOUNCE_MS = 3000

export interface ProjectCondenserDeps {
  store: Pick<ProjectStore, 'get' | 'setSummary'>
  /** Calls the fast model; resolves to its text. */
  complete: (messages: LlmMessage[]) => Promise<string>
  delayMs?: number
}

/**
 * Keeps each project's context short (FR-W4): once notes, tasks and older updates pass ~150
 * tokens, the fast model condenses them in the background. Answers never wait for it — until the
 * summary catches up they use the raw text.
 */
export class ProjectCondenser {
  private timers = new Map<string, NodeJS.Timeout>()
  private running = new Set<string>()

  constructor(private readonly deps: ProjectCondenserDeps) {}

  schedule(id: string): void {
    if (!id) return
    clearTimeout(this.timers.get(id))
    this.timers.set(
      id,
      setTimeout(() => {
        this.timers.delete(id)
        void this.run(id)
      }, this.deps.delayMs ?? DEBOUNCE_MS)
    )
  }

  /** Condense now if needed; resolves when done (or skipped). */
  async run(id: string): Promise<void> {
    const project = this.deps.store.get(id)
    if (!project || !needsCondensing(project) || this.running.has(id)) return
    this.running.add(id)
    const hash = contextHash(projectBody(project))
    try {
      const summary = (await this.deps.complete(buildCondenseMessages(project))).trim()
      // Edited meanwhile: the next scheduled run condenses the newer text.
      const now = this.deps.store.get(id)
      if (summary && now && contextHash(projectBody(now)) === hash) this.deps.store.setSummary(id, summary, hash)
    } catch (err) {
      log.warn(`could not condense "${project.name}"; answers use the full notes`, err)
    } finally {
      this.running.delete(id)
    }
  }

  dispose(): void {
    for (const t of this.timers.values()) clearTimeout(t)
    this.timers.clear()
  }
}
