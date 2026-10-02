/**
 * Local fuzzy matching of spoken references to projects (FR-W5): "how's the migration going" →
 * the project named "Payments migration" or aliased "the migration". No LLM call, so only the
 * matched project's context is sent with a status answer.
 */

/** A work item, matched by its title, other names and reference ("BUG-142"). */
export interface MatchableItem {
  id: string
  title: string
  aliases?: string[]
  ref?: string
}

export interface MatchableProject {
  id: string
  name: string
  aliases: string[]
  tasks?: MatchableItem[]
}

export interface ProjectMatch<P extends MatchableProject = MatchableProject> {
  project: P
  /** 0..1: 1 = a name or alias said as-is. */
  score: number
}

/** At or above this a match is used without asking (FR-W9). */
export const CONFIDENT_SCORE = 0.75
/** The runner-up must trail by this much, or the user picks. */
const AMBIGUITY_MARGIN = 0.15

/** Words too generic to identify a project on their own. */
const GENERIC = new Set(
  (
    'the a an of and or for to in on at with our my your their this that project projects team work thing stuff ' +
    'initiative program effort task tasks app application service tool system new old v1 v2 ' +
    'item items approval approvals bug bugs issue issues fix fixes ticket tickets status update updates'
  ).split(' ')
)

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/['’]s\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function words(text: string): string[] {
  return normalize(text).split(' ').filter(Boolean)
}

/** Levenshtein distance, capped: anything above `max` returns max + 1. */
function distance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    let rowMin = i
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
      rowMin = Math.min(rowMin, cur[j])
    }
    if (rowMin > max) return max + 1
    prev = cur
  }
  return prev[b.length]
}

/**
 * How well one name word matches a heard word: 1 exact; 0.9 for the same stem ("migration" /
 * "migrating") or one transcription slip in a longer word ("prysm" / "prism"); else 0.
 */
function wordScore(target: string, heard: string): number {
  if (target === heard) return 1
  if (target.length < 4 || heard.length < 4) return 0
  const stem = Math.min(target.length, heard.length, 6)
  if (stem >= 5 && target.slice(0, stem) === heard.slice(0, stem)) return 0.9
  if (target.length >= 5 && distance(target, heard, 1) <= 1) return 0.9
  return 0
}

/** Score of one name or alias against the heard words. */
function phraseScore(phrase: string, heard: string[], heardText: string): number {
  const norm = normalize(phrase)
  if (!norm) return 0
  // Said as-is, as whole words.
  if (` ${heardText} `.includes(` ${norm} `)) return 1
  const key = norm.split(' ').filter((w) => !GENERIC.has(w))
  if (key.length === 0) return 0
  let total = 0
  for (const w of key) total += Math.max(0, ...heard.map((h) => wordScore(w, h)))
  // Partial phrases count for less: "the migration" for "Payments migration" is enough when no
  // other project shares the word (the runner-up check in confidentMatch catches that).
  const share = total / key.length
  if (share === 0) return 0
  return share === 1 ? 0.95 : 0.6 + 0.35 * share
}

/** The phrases an item is known by; a reference counts only for its distinctive part ("BUG-142" → "142"). */
function itemPhrases(item: MatchableItem): string[] {
  const out = [item.title, ...(item.aliases ?? [])]
  const ref = item.ref?.trim()
  // Links aren't said out loud; IDs are ("bug 142"). Numbers need 2+ digits to mean anything.
  if (ref && !/^https?:/i.test(ref) && /[a-z]{2,}|\d{2,}/i.test(ref)) out.push(ref)
  return out
}

/** A project, or one of its items, that speech refers to. */
export interface Target<P extends MatchableProject = MatchableProject> {
  project: P
  /** Set when the speech is about one item. */
  task?: NonNullable<P['tasks']>[number]
  score: number
}

/** Projects and items ranked by how well `text` refers to them (best first, zero scores dropped). */
export function rankTargets<P extends MatchableProject>(text: string, projects: P[]): Target<P>[] {
  const heard = words(text)
  const heardText = heard.join(' ')
  if (heard.length === 0) return []
  const out: Target<P>[] = []
  for (const project of projects) {
    const score = Math.max(0, ...[project.name, ...project.aliases].map((p) => phraseScore(p, heard, heardText)))
    if (score > 0) out.push({ project, score })
    for (const task of project.tasks ?? []) {
      const s = Math.max(0, ...itemPhrases(task).map((p) => phraseScore(p, heard, heardText)))
      if (s > 0) out.push({ project, task: task as Target<P>['task'], score: s })
    }
  }
  return out.sort((a, b) => b.score - a.score || (a.task ? 1 : 0) - (b.task ? 1 : 0))
}

/**
 * What `text` is about, if confident (FR-W5/W9): a project, or one of its items. Ambiguous
 * between projects → null (the user picks). Two of one project's items too close to call → that
 * project without an item. A project named alongside one of its items → the item.
 */
export function confidentTarget<P extends MatchableProject>(text: string, projects: P[]): Target<P> | null {
  const ranked = rankTargets(text, projects)
  const best = ranked[0]
  if (!best || best.score < CONFIDENT_SCORE) return null
  const rival = ranked.find((t) => t.project.id !== best.project.id)
  if (rival && best.score - rival.score < AMBIGUITY_MARGIN) return null
  const items = ranked.filter((t) => t.task && t.project.id === best.project.id && t.score >= CONFIDENT_SCORE)
  if (items.length === 0) return { project: best.project, score: best.score }
  if (items.length > 1 && items[0].score - items[1].score < AMBIGUITY_MARGIN) return { project: best.project, score: best.score }
  return items[0]
}

/** Projects ranked by how well `text` refers to them (best first, zero scores dropped). */
export function rankProjects<P extends MatchableProject>(text: string, projects: P[]): ProjectMatch<P>[] {
  // A project is referred to by its own names or by one of its items'.
  const best = new Map<string, ProjectMatch<P>>()
  for (const t of rankTargets(text, projects)) if (!best.has(t.project.id)) best.set(t.project.id, { project: t.project, score: t.score })
  return [...best.values()]
}

/** The project `text` refers to, if confident (FR-W5/W9); otherwise null and the user picks. */
export function confidentMatch<P extends MatchableProject>(text: string, projects: P[]): ProjectMatch<P> | null {
  const [best, second] = rankProjects(text, projects)
  if (!best || best.score < CONFIDENT_SCORE) return null
  if (second && best.score - second.score < AMBIGUITY_MARGIN) return null
  return best
}
