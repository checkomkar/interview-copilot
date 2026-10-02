import type { Project } from '@shared/work'
import { wordCount, type Detection } from '../detect/QuestionDetector'
import { confidentTarget, rankProjects } from './projectMatch'
import { parseStatusClassifier } from './workPrompts'

/** Cues that someone is asking for a status update (FR-W8). */
const STATUS_CUES = new RegExp(
  [
    String.raw`\bstatus\b`,
    String.raw`\bupdates? (?:on|for|about)\b`,
    String.raw`\bany (?:updates?|news|progress)\b`,
    String.raw`\bprogress (?:on|with)\b`,
    String.raw`\bwhere (?:are|is) (?:we|you|it|that|things)\b`,
    String.raw`\bhow(?:'s| is| are)\b.{0,60}\b(?:going|coming(?: along)?|looking|tracking|progressing|shaping up)\b`,
    String.raw`\bwhen (?:will|is|are|can|do|does|would)\b.{0,60}\b(?:done|ready|finished|complete|completed|ship|shipped|shipping|land|launch|launching|live|delivered|wrap(?:ped)? up)\b`,
    String.raw`\b(?:eta|timeline)\b`,
    String.raw`\bon track\b`,
    String.raw`\b(?:catch|bring|fill) (?:me|us) (?:up|in)\b`,
    String.raw`\bblock(?:ed|ers?)\b`,
    // Item questions (FR-W7a/b): approvals, follow-ups, who owns a bug.
    String.raw`\bpending\b`,
    String.raw`\bfollow(?:ed|ing)?[- ]?up\b`,
    String.raw`\bwho(?:'s| is| are| was)\b.{0,40}\b(?:working|handling|assigned|fixing|looking into|owning|on (?:it|that|this))\b`,
    String.raw`\bwhich\b.{0,40}\b(?:open|pending|blocked|working|assigned)\b`,
    String.raw`\b(?:open|outstanding) (?:bugs?|issues?|items?|approvals?|tickets?)\b`
  ].join('|'),
  'i'
)

/** A clear status cue (FR-W8): "what's the status of", "what's pending", "did we follow up"… */
export function hasStatusCue(text: string): boolean {
  return STATUS_CUES.test(text)
}

/** Words that make an utterance worth asking the classifier about even without a cue. */
const WEAK_CUES =
  /\?|\b(?:deadline|release|deliver\w*|milestone|next steps?|done yet|finish\w*|stuck|risk\w*|delay\w*|slip\w*|approv\w*|signed off|deploy\w*|resolved|fixed|assigned)\b/i

/** A question rather than a statement ("the TOM approvals came through" mentions an item but asks nothing). */
const QUESTION_START =
  /^(?:(?:so|and|okay|ok|also|um+|uh+|right|then|now|hey|quick one)[\s,.-]+)*(?:what|what's|whats|where|when|how|how's|did|do|does|have|has|had|are|is|was|were|any|who|who's|which|can|could|will|would|should)\b/i

/** The last sentence of `text` ends with "?" or starts like a question. */
export function looksLikeQuestion(text: string): boolean {
  const t = text.trim()
  if (/\?\s*$/.test(t)) return true
  const last = t.split(/(?<=[.!?])\s+/).at(-1) ?? t
  // Speech-to-text often keeps a name in front: "Omkar, did we follow up…".
  return QUESTION_START.test(last.replace(/^[A-Z][a-z]+,\s*/, ''))
}

export interface WorkDetection extends Detection {
  /** The project the question is about, when matched confidently. */
  projectId?: string
  /** The item it is about, when it names one (FR-W7a). */
  taskId?: string
  /** The best guess when not confident (shown first in the quick-pick). */
  suggestedId?: string | null
}

export interface WorkDetectorOptions {
  getProjects: () => Project[]
  /** Calls the fast model with the §6.6 prompt; resolves to its raw text. */
  classify: (utterance: string, context: string[], projects: Project[], signal: AbortSignal) => Promise<string>
  minWords: () => number
  timeoutMs?: number
}

/**
 * Work Mode's detector (FR-W8/W9): is the latest speech asking the user for a status update, and
 * on which project? Clear cues plus a confident project match skip the LLM; unclear ones with a
 * cue or a project mention ask the fast model (§6.6); everything else is ordinary call talk.
 */
export class WorkDetector {
  private readonly timeoutMs: number

  constructor(private readonly opts: WorkDetectorOptions) {
    this.timeoutMs = opts.timeoutMs ?? 1500
  }

  async detect(utterances: string[], context: string[]): Promise<WorkDetection> {
    const text = utterances.join(' ').trim()
    const projects = this.opts.getProjects()
    const not: WorkDetection = { isQuestion: false, type: 'status', question: text, via: 'heuristic' }
    // Nothing to report on without projects; the user is pointed to the Projects tab by the hotkey instead.
    if (!text || projects.length === 0) return not

    const cue = STATUS_CUES.test(text)
    const match = confidentTarget(text, projects)
    const mentioned = rankProjects(text, projects)[0]
    // A clear cue, a known project or item, and asked as a question: no classifier needed.
    if (cue && match && looksLikeQuestion(text)) return this.found(text, 'heuristic', match.project.id, undefined, match.task?.id)
    const worthAsking = cue || (mentioned !== undefined && mentioned.score >= 0.6) || WEAK_CUES.test(text)
    if (!worthAsking || wordCount(text) < Math.min(this.opts.minWords(), 4)) return not

    const controller = new AbortController()
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), this.timeoutMs)
    })
    try {
      const raw = await Promise.race([this.opts.classify(text, context.slice(-3), projects, controller.signal), timeout])
      if (raw === 'timeout') controller.abort()
      const c = raw === 'timeout' ? null : parseStatusClassifier(raw)
      if (!c) {
        // No verdict: only a clear cue that ends in a question counts.
        if (!(cue && /\?\s*$/.test(text))) return { ...not, via: raw === 'timeout' ? 'timeout' : 'fallback' }
        return this.found(text, raw === 'timeout' ? 'timeout' : 'fallback', match?.project.id, mentioned?.project.id, match?.task?.id)
      }
      if (!c.isStatus) return { ...not, via: 'classifier' }
      // What was said wins over the classifier's hint when both name something.
      const target = match ?? (c.hint ? confidentTarget(c.hint, projects) : null)
      const guess = c.hint ? rankProjects(c.hint, projects)[0]?.project.id : undefined
      return this.found(text, 'classifier', target?.project.id, guess ?? mentioned?.project.id, target?.task?.id)
    } catch {
      return { ...not, via: 'fallback' }
    } finally {
      clearTimeout(timer)
    }
  }

  private found(text: string, via: Detection['via'], projectId?: string, suggestedId?: string, taskId?: string): WorkDetection {
    return {
      isQuestion: true,
      type: 'status',
      question: text,
      via,
      ...(projectId ? { projectId, ...(taskId ? { taskId } : {}) } : { suggestedId: suggestedId ?? null })
    }
  }
}
