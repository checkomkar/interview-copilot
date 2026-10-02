import { z } from 'zod'
import { activeModels, type Settings } from '@shared/settings'
import {
  ITEM_KINDS,
  PROJECT_STATUS_LABELS,
  ProposalChangesSchema,
  TASK_STATUSES,
  type ImportResult,
  type ItemKind,
  type Project,
  type ProposalChanges,
  type SkippedMessage
} from '@shared/work'
import { createLogger } from '../../logger'
import type { LlmImagePart, LlmMessage, LlmProvider } from '../llm/LlmProvider'
import { extractJson } from '../practice/practicePrompts'
import type { NewProposal, ProjectStore } from './ProjectStore'
import { isoDate, itemLine } from './workPrompts'

const log = createLogger('teams-import')

/** Room for a day of messages' worth of proposals. */
const IMPORT_MAX_TOKENS = 4000
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/** One message to extract from (Teams sync passes these; pasted text is sent as it is). */
export interface ChatMessage {
  author: string
  ts: number
  text: string
  /** Where it was posted ("Mobile app dev" group chat), for the prompt. */
  chat?: string
}

export type ImportSource = { text: string } | { images: LlmImagePart[] } | { messages: ChatMessage[] }

/** "P1" for a project, "P1.3" for its third item: short ids the model can copy exactly. */
function refs(projects: Project[]): { project: Map<string, Project>; item: Map<string, { project: Project; taskId: string }> } {
  const project = new Map<string, Project>()
  const item = new Map<string, { project: Project; taskId: string }>()
  projects.forEach((p, i) => {
    project.set(`P${i + 1}`, p)
    p.tasks.forEach((t, j) => item.set(`P${i + 1}.${j + 1}`, { project: p, taskId: t.id }))
  })
  return { project, item }
}

function trackerList(projects: Project[], now: number): string {
  return projects
    .map((p, i) => {
      const head = `P${i + 1} ${p.name}${p.aliases.length ? ` (also called ${p.aliases.join(', ')})` : ''} — ${PROJECT_STATUS_LABELS[p.status]}`
      const items = p.tasks.map((t, j) => `  P${i + 1}.${j + 1} ${itemLine(t, now)}`)
      return [head, ...items].join('\n')
    })
    .join('\n')
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  return `${isoDate(ts)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** §6.10 — Teams messages → proposed tracker updates (answer models; vision models for screenshots). */
export function buildImportMessages(projects: Project[], source: ImportSource, now: number, owner: string): LlmMessage[] {
  const today = `${isoDate(now)} (${WEEKDAYS[new Date(now).getDay()]})`
  const kinds = ITEM_KINDS.join('|')
  const statuses = TASK_STATUSES.join('|')
  const instructions = `You turn Microsoft Teams messages from a software team into proposed updates to ${owner}'s project tracker. Today is ${today}.

Tracked projects and their items (use these ids):
${trackerList(projects, now) || '(none)'}

For each message — or run of messages from one person about one thing — that says something about a tracked project or item (progress, a status change, who is working on what, a new bug, a blocker, a follow-up, an approval, a date), return one proposal. Return ONLY JSON:
{"proposals": [{
  "project": "P1",
  "item": "P1.3" or null for the project as a whole,
  "new_item": null, or {"kind": "${kinds}", "title": "short title"} only when the message is clearly about something not listed (e.g. a newly reported bug),
  "changes": {only the fields the message changes: "status": "${statuses}", "owner", "waiting_on", "environment", "due": "YYYY-MM-DD", "followed_up": "YYYY-MM-DD", "follow_up_note", "blockers", "ref"},
  "update": "one line, third person, naming who said it: Ravi says the login crash fix is in code review",
  "author": "the sender's name as shown",
  "time": "YYYY-MM-DD HH:MM" or null,
  "quote": "the message, verbatim (shorten long ones with …)"
}],
 "skipped": [{"author": "...", "quote": "...", "reason": "small talk | not about a tracked project | unclear"}]}

Rules:
- Only what the messages say. Never invent owners, dates, statuses or bug numbers.
- "I'm picking up / looking into / assigned to me" → owner = that person, status in_progress.
- "fixed and merged", "deployed to prod", "approved", "signed off", "closed" → status done. A fix in review or on a branch is still in_progress.
- "waiting for / on / blocked by X" → status waiting (blocked if nothing can move), waiting_on or blockers = X.
- "followed up / pinged / chased X" → followed_up = the message's date, follow_up_note = who chased whom ("Priya pinged the MDM team").
- Resolve relative dates ("tomorrow", "Friday") from the message time, else from today.
- If it isn't clear which item a message is about, use the project with item null. If no tracked project fits, skip the message.
- Skip greetings, thanks, jokes, reactions and meeting logistics.`

  if ('images' in source) {
    const note = `${source.images.length === 1 ? 'The messages are in the attached screenshot of a Teams chat.' : `The messages are in the ${source.images.length} attached screenshots of one Teams chat, in order (they may overlap — don't repeat a message).`} Read the sender names and times as shown.`
    return [{ role: 'user', content: [...source.images, { type: 'text', text: `${instructions}\n\n${note}` }] }]
  }
  const body =
    'text' in source
      ? `<messages>\n${source.text}\n</messages>`
      : `<messages>\n${source.messages.map((m) => `[${formatTime(m.ts)}] ${m.author}${m.chat ? ` (in ${m.chat})` : ''}: ${m.text}`).join('\n')}\n</messages>`
  return [{ role: 'user', content: `${instructions}\n\n${body}` }]
}

const RawProposalSchema = z.object({
  project: z.string(),
  item: z.string().nullable().optional(),
  new_item: z.object({ kind: z.string(), title: z.string() }).nullable().optional(),
  changes: z.record(z.string(), z.unknown()).nullable().optional(),
  update: z.string().default(''),
  author: z.string().default(''),
  time: z.string().nullable().optional(),
  quote: z.string().default('')
})
const RawImportSchema = z.object({
  proposals: z.array(z.unknown()).default([]),
  skipped: z.array(z.object({ author: z.string().default(''), quote: z.string().default(''), reason: z.string().default('') })).default([])
})

/** The model writes snake_case; empty strings mean "not changed". Invalid fields are dropped, not fatal. */
function toChanges(raw: Record<string, unknown> | null | undefined): ProposalChanges {
  if (!raw) return {}
  const map: Record<string, keyof ProposalChanges> = {
    status: 'status',
    owner: 'owner',
    waiting_on: 'waitingOn',
    waitingOn: 'waitingOn',
    environment: 'environment',
    due: 'due',
    followed_up: 'followedUp',
    followedUp: 'followedUp',
    follow_up_note: 'followUpNote',
    followUpNote: 'followUpNote',
    blockers: 'blockers',
    ref: 'ref'
  }
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(raw)) {
    const key = map[k]
    if (!key || v === null || v === undefined || (typeof v === 'string' && !v.trim())) continue
    const one = ProposalChangesSchema.safeParse({ [key]: typeof v === 'string' ? v.trim() : v })
    if (one.success) Object.assign(out, one.data)
  }
  return out as ProposalChanges
}

function parseTime(raw: string | null | undefined): number | null {
  const m = raw ? /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{1,2}):(\d{2}))?/.exec(raw.trim()) : null
  if (!m) return null
  const ts = Date.parse(`${m[1]}T${m[2] ? m[2].padStart(2, '0') : '12'}:${m[3] ?? '00'}:00`)
  return Number.isNaN(ts) ? null : ts
}

/**
 * Parse the model's reply defensively: unknown project or item ids, bad kinds and invalid fields
 * are dropped rather than failing the whole import. Null when the reply isn't JSON at all.
 */
export function parseImport(raw: string, projects: Project[], source: NewProposal['source']): { proposals: NewProposal[]; skipped: SkippedMessage[] } | null {
  const json = extractJson(raw)
  if (json === null) return null
  const parsed = RawImportSchema.safeParse(json)
  if (!parsed.success) return null
  const ids = refs(projects)
  const proposals: NewProposal[] = []
  const skipped: SkippedMessage[] = [...parsed.data.skipped]
  for (const entry of parsed.data.proposals) {
    const r = RawProposalSchema.safeParse(entry)
    if (!r.success) continue
    const p = r.data
    const item = p.item ? ids.item.get(p.item.trim()) : undefined
    const project = item?.project ?? ids.project.get(p.project.trim())
    if (!project) {
      skipped.push({ author: p.author, quote: p.quote || p.update, reason: 'not about a tracked project' })
      continue
    }
    const kind: ItemKind = (ITEM_KINDS as readonly string[]).includes(p.new_item?.kind ?? '') ? (p.new_item!.kind as ItemKind) : 'task'
    const newItem = !item && p.new_item?.title.trim() ? { kind, title: p.new_item.title.trim().slice(0, 200) } : null
    const changes = toChanges(p.changes)
    // Drop "changes" to what the item already says (Owner: Ravi → Ravi).
    const task = item ? project.tasks.find((t) => t.id === item.taskId) : undefined
    if (task) for (const k of Object.keys(changes) as (keyof ProposalChanges)[]) if (String(task[k]).trim().toLowerCase() === String(changes[k]).trim().toLowerCase()) delete changes[k]
    const update = p.update.trim()
    if (!update && Object.keys(changes).length === 0 && !newItem) continue
    proposals.push({
      projectId: project.id,
      taskId: item?.taskId ?? null,
      newItem,
      changes,
      update: update.slice(0, 4000),
      author: p.author.trim().slice(0, 120),
      ts: parseTime(p.time),
      quote: p.quote.trim().slice(0, 2000),
      source
    })
  }
  return { proposals, skipped }
}

export interface TeamsImporterDeps {
  llm: Pick<LlmProvider, 'complete'>
  store: Pick<ProjectStore, 'list' | 'addProposals'>
  getSettings: () => Settings
  /** The user's name, for the prompt. */
  getOwner: () => string
  now?: () => number
}

/**
 * Turns Teams messages — pasted text, screenshots (FR-T1/T2) or synced messages (FR-T3) — into
 * proposals for the review queue (FR-T4). Nothing changes in the tracker until one is accepted.
 */
export class TeamsImporter {
  constructor(private readonly deps: TeamsImporterDeps) {}

  async run(source: ImportSource, origin: NewProposal['source'] = 'import', signal?: AbortSignal): Promise<ImportResult> {
    const projects = this.deps.store.list()
    if (projects.length === 0) return { ok: false, error: 'Add your projects in the Projects tab first — updates are matched to them.' }
    const now = (this.deps.now ?? Date.now)()
    const settings = this.deps.getSettings()
    const images = 'images' in source
    const models = activeModels(settings)
    let text: string
    try {
      const res = await this.deps.llm.complete({
        model: images ? models.visionModel : models.answerModel,
        role: images ? 'vision' : 'answer',
        purpose: 'import',
        system: [],
        messages: buildImportMessages(projects, source, now, this.deps.getOwner()),
        maxTokens: IMPORT_MAX_TOKENS,
        signal
      })
      text = res.text
    } catch (err) {
      log.warn('import request failed', err)
      return { ok: false, error: `Couldn't read the messages: ${err instanceof Error ? err.message : String(err)}` }
    }
    const parsed = parseImport(text, projects, origin)
    if (!parsed) {
      log.warn(`import reply was not JSON: ${text.slice(0, 200)}`)
      return { ok: false, error: "The model's reply couldn't be read — try again." }
    }
    const kept = this.deps.store.addProposals(parsed.proposals)
    log.info(`import: ${parsed.proposals.length} proposal(s), ${kept.length} new, ${parsed.skipped.length} skipped`)
    return { ok: true, proposals: kept, skipped: parsed.skipped }
  }
}

