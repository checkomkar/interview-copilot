import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { AnswerStyle } from '@shared/ipc'
import type { Profile } from '@shared/profile'
import { ITEM_KIND_LABELS, PROJECT_STATUS_LABELS, TASK_STATUS_LABELS, type Project, type ProjectUpdate, type Task } from '@shared/work'
import type { LlmImagePart, LlmMessage, LlmSystemBlock } from '../llm/LlmProvider'
import { clip, formatTranscript, type EarlierQa, type TranscriptLine } from '../llm/prompts'

/** Work Mode prompts (PRD §6.5–6.9). */

const DAY_MS = 86_400_000
/** Recent updates sent verbatim next to the project context (§6.5). */
export const RECENT_UPDATES = 5
/** Notes + finished items + older updates longer than this get a condensed summary (FR-W4, ~150 tokens). */
export const CONDENSE_OVER_CHARS = 600
/** Open items sent as exact lines with every status answer (FR-W4). */
export const MAX_OPEN_ITEMS = 40
/** An item's own updates sent when the question is about it (FR-W7a). */
const ITEM_TIMELINE = 8
/** Updates older than this are called out as stale (FR-W7a). */
const STALE_DAYS = 2
/** Raw context sent when there is no up-to-date summary. */
const RAW_CONTEXT_CHARS = 3000
const EARLIER_ANSWER_CHARS = 800
/** The other side of a work call, in prompts. */
const THEM = 'Them'

/** Asked when the screenshot hotkey is pressed in Work Mode with no question pending (FR-W11). */
export const WORK_SCREEN_QUESTION = "Explain / summarize what's shown on screen."

export function isoDate(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** "3 days ago", "today", "in 12 days" relative to `now`, for dates the model must reason about. */
export function relativeDays(date: string | number, now: number): string {
  const ts = typeof date === 'number' ? date : Date.parse(`${date}T12:00:00`)
  if (Number.isNaN(ts)) return ''
  const days = Math.round((startOfDay(ts) - startOfDay(now)) / DAY_MS)
  if (days === 0) return 'today'
  if (days === 1) return 'tomorrow'
  if (days === -1) return 'yesterday'
  return days > 0 ? `in ${days} days` : `${-days} days ago`
}

function startOfDay(ts: number): number {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** Status, owner, deadline and freshness: always sent as-is (short, and must be exact). */
export function projectHeader(p: Project, now: number): string {
  const facts = [
    `Status: ${PROJECT_STATUS_LABELS[p.status]}`,
    p.owner && `Owner: ${p.owner}`,
    p.deadline && `Deadline: ${p.deadline} (${relativeDays(p.deadline, now)})`,
    p.stakeholders && `Stakeholders: ${p.stakeholders}`
  ].filter(Boolean)
  return [
    `Project: ${p.name}${p.aliases.length ? ` (also called ${p.aliases.join(', ')})` : ''}`,
    facts.join(' · '),
    `Last updated: ${isoDate(p.updatedAt)} (${relativeDays(p.updatedAt, now)})`
  ].join('\n')
}

/**
 * What gets condensed (FR-W4): notes, finished items and the updates older than the recent ones.
 * Open items are never condensed — they are sent line by line (openItems).
 */
export function projectBody(p: Project): string {
  const parts: string[] = []
  if (p.notes.trim()) parts.push(`Notes:\n${p.notes.trim()}`)
  const done = p.tasks.filter((t) => t.status === 'done')
  if (done.length) parts.push(`Finished items:\n${done.map((t) => `- ${itemLine(t)}`).join('\n')}`)
  const older = p.updates.slice(RECENT_UPDATES)
  if (older.length) parts.push(`Earlier updates:\n${older.map((u) => updateLine(u, p)).join('\n')}`)
  return parts.join('\n\n')
}

/** One item as an exact line: kind and status, title, ref, then the facts that are set. */
export function itemLine(t: Task, now?: number): string {
  const facts = [
    t.owner && `owner ${t.owner}`,
    t.waitingOn && `waiting on ${t.waitingOn}`,
    t.environment && `env ${t.environment}`,
    t.due && `due ${t.due}${now !== undefined ? ` (${relativeDays(t.due, now)})` : ''}`,
    t.followedUp && `last follow-up ${t.followedUp}${now !== undefined ? ` (${relativeDays(t.followedUp, now)})` : ''}${t.followUpNote ? `: ${t.followUpNote}` : ''}`,
    !t.followedUp && t.followUpNote && `follow-up: ${t.followUpNote}`,
    t.blockers && `blocker: ${t.blockers}`,
    t.note && `note: ${t.note}`,
    now !== undefined && `updated ${isoDate(t.updatedAt)} (${relativeDays(t.updatedAt, now)})`
  ].filter(Boolean)
  const names = t.aliases.length ? ` (also called ${t.aliases.join(', ')})` : ''
  return `[${ITEM_KIND_LABELS[t.kind]} · ${TASK_STATUS_LABELS[t.status]}] ${t.title}${t.ref ? ` [${t.ref}]` : ''}${names}${facts.length ? ` — ${facts.join('; ')}` : ''}`
}

/**
 * Open items, most relevant first: the one asked about, then blocked and waiting ones, then the
 * most recently changed. At most MAX_OPEN_ITEMS.
 */
export function openItems(p: Project, focusId?: string): Task[] {
  const rank = (t: Task) => (t.id === focusId ? 0 : t.status === 'blocked' ? 1 : t.status === 'waiting' ? 2 : 3)
  return p.tasks
    .filter((t) => t.status !== 'done' || t.id === focusId)
    .sort((a, b) => rank(a) - rank(b) || b.updatedAt - a.updatedAt)
    .slice(0, MAX_OPEN_ITEMS)
}

function updateLine(u: ProjectUpdate, p: Project): string {
  const item = u.taskId ? p.tasks.find((t) => t.id === u.taskId)?.title : undefined
  const meta = [u.author, item && `on ${item}`].filter(Boolean).join(', ')
  return `- ${isoDate(u.ts)}${meta ? ` (${meta})` : ''}: ${u.text.replace(/\s+/g, ' ').trim()}`
}

export function recentUpdates(p: Project): string {
  return p.updates.slice(0, RECENT_UPDATES).map((u) => updateLine(u, p)).join('\n')
}

/** The asked-about item's own updates, newest first, with how old the latest one is (FR-W7a). */
export function itemTimeline(p: Project, taskId: string, now: number): string {
  const updates = p.updates.filter((u) => u.taskId === taskId).slice(0, ITEM_TIMELINE)
  if (updates.length === 0) return '(no updates logged on this item)'
  const days = Math.round((now - updates[0].ts) / DAY_MS)
  const age = days > STALE_DAYS ? `\n(The latest update is ${days} days old — say so.)` : ''
  return `${updates.map((u) => updateLine(u, p)).join('\n')}${age}`
}

export function contextHash(text: string): string {
  return createHash('sha256').update(text.trim()).digest('hex').slice(0, 16)
}

/** The body needs condensing and its summary is missing or out of date. */
export function needsCondensing(p: Project): boolean {
  const body = projectBody(p)
  return body.length > CONDENSE_OVER_CHARS && p.summaryOf !== contextHash(body)
}

/**
 * Header, the background (condensed when it's long and the summary is up to date, else raw and
 * clipped), then every open item as an exact line (FR-W4).
 */
export function projectContext(p: Project, now: number, focusId?: string): string {
  const body = projectBody(p)
  const fresh = p.summary.trim() && p.summaryOf === contextHash(body)
  const text = body.length <= CONDENSE_OVER_CHARS ? body : fresh ? p.summary.trim() : clip(body, RAW_CONTEXT_CHARS)
  const open = openItems(p, focusId)
  const more = p.tasks.filter((t) => t.status !== 'done').length - open.filter((t) => t.status !== 'done').length
  const items = open.length
    ? `Open items:\n${open.map((t) => `- ${itemLine(t, now)}`).join('\n')}${more > 0 ? `\n(${more} more open items not listed)` : ''}`
    : ''
  return [projectHeader(p, now), text, items].filter(Boolean).join('\n\n')
}

function who(profile: Profile): string {
  return profile.name.trim() || 'the user'
}

/**
 * §6.5 — cacheable per-project block; the call transcript goes in the user turn. `taskId`: the
 * question is about one item, whose own updates are added (FR-W7a).
 */
export function buildStatusSystem(profile: Profile, project: Project, now: number, taskId?: string): LlmSystemBlock[] {
  const item = taskId ? project.tasks.find((t) => t.id === taskId) : undefined
  const name = who(profile)
  const audience = project.stakeholders.trim() || 'colleagues'
  const text = `You help ${name}${profile.role.trim() ? ` (${profile.role.trim()})` : ''} give a live, spoken status update on "${project.name}"
during a work call with ${audience}. This will be read aloud or
paraphrased immediately, not displayed as notes. Today is ${isoDate(now)}.

Rules:
- 3-5 natural spoken sentences, in first person as ${name}. No bullets,
  no headers, no jargon.
- Lead with current state, then recent progress, then any blocker,
  then next step — but phrase it as something a person would actually
  say out loud, not a status-report template.
- Use only the facts in the project context below plus the live call
  transcript. Never invent progress, dates, or numbers.
- If stored context is stale (older than the "last updated" note
  implies it should be), say so briefly rather than presenting it as
  current.
- Say the stored status as it is ("${PROJECT_STATUS_LABELS[project.status].toLowerCase()}", "blocked",
  "waiting on …"); never soften it.
- If the question is about one item (a deployment, an approval, a bug,
  a follow-up), answer about that item first and mostly: its state, who
  owns it, who it's waiting on, and the last follow-up and who did it —
  1-3 sentences. If its latest update is more than ${STALE_DAYS} days old, say
  how old ("last update from Ravi, 3 days ago").
- If the question asks for a list (open bugs, pending approvals, who is
  on what), go through every matching open item, one short spoken
  clause each: what it is, who owns it, where it stands.
- Updates name who said them (in brackets). Refer to everyone other
  than ${name} by name, in the third person ("Priya emailed the MDM
  team") — never "you".
- An item question gets 1-3 sentences; don't add a whole-project
  update unless asked.

<project_context>
${projectContext(project, now, taskId)}
</project_context>
<recent_updates>
${recentUpdates(project) || '(none logged)'}
</recent_updates>${
    item
      ? `
<asked_about_item>
${itemLine(item, now)}
Its updates:
${itemTimeline(project, item.id, now)}
</asked_about_item>`
      : ''
  }`
  return [{ text, cache: true }]
}

export function buildStatusMessages(opts: { question: string; transcript: TranscriptLine[]; style: AnswerStyle }): LlmMessage[] {
  const transcript = formatTranscript(opts.transcript, undefined, THEM)
  const shorter = opts.style === 'shorter' ? '\nGive a shorter version: two sentences at most.' : ''
  return [
    {
      role: 'user',
      content: `<call_transcript_recent>
${transcript || '(no transcript yet)'}
</call_transcript_recent>

They asked: "${opts.question}"
Give the spoken status update now.${shorter}`
    }
  ]
}

/** Work Mode's answer prompt for anything other than a status update: typed/voice questions and screenshots (§6.7). */
export function buildWorkSystem(profile: Profile, projects: Project[], relevant: Project[], now: number): LlmSystemBlock[] {
  const name = who(profile)
  const index = projects.map((p) => `- ${p.name}: ${PROJECT_STATUS_LABELS[p.status]}${p.deadline ? `, deadline ${p.deadline}` : ''}`).join('\n')
  const contexts = relevant.map((p) => `<project_context name="${p.name}">\n${projectContext(p, now)}\n</project_context>`).join('\n')
  const text = `You help ${name}${profile.role.trim() ? ` (${profile.role.trim()})` : ''} during live work calls. Answers are read at a glance while talking. Today is ${isoDate(now)}.

Rules:
- Lead with the answer. No preamble. 2-4 short sentences or 3-5 short bullets, bold key terms, max ~100 words.
- Use the project context below and the call transcript. Never invent progress, dates, numbers, or names; say what is unknown.
- If a screenshot is attached, ${name} is presenting it live: explain or summarize it concisely enough to glance at while talking, not read verbatim — 3-6 short bullets: what this shows, the key number/point to call out, and anything that invites a follow-up question worth being ready for. For a chart or table, state the headline takeaway first. Use project context only if the screenshot clearly matches a known project; otherwise work from the screenshot alone.
- Format as Markdown.

<projects>
${index || '(no projects saved)'}
</projects>
${contexts}`.trimEnd()
  return [{ text, cache: true }]
}

export function buildWorkMessages(opts: {
  question: string
  transcript: TranscriptLine[]
  style: AnswerStyle
  images?: LlmImagePart[]
  earlier?: EarlierQa[]
}): LlmMessage[] {
  const images = opts.images ?? []
  const transcript = formatTranscript(opts.transcript, undefined, THEM)
  const earlier = opts.earlier ?? []
  const earlierBlock = earlier.length
    ? `<earlier_qa>\n${earlier.map((q) => `<question>${q.question}</question>\n<answer>${clip(q.answer, EARLIER_ANSWER_CHARS)}</answer>`).join('\n')}\n</earlier_qa>\n\n`
    : ''
  const screen = images.length === 1 ? '\nA screenshot of my screen is attached.' : images.length > 1 ? `\n${images.length} screenshots of my screen are attached, in order (parts of the same screen; they may overlap).` : ''
  const shorter = opts.style === 'shorter' ? '\nGive a much shorter version: at most 2 sentences or 3 bullets.' : ''
  const text = `${earlierBlock}<call_transcript_recent>
${transcript || '(no transcript yet)'}
</call_transcript_recent>

<question>${opts.question}</question>${screen}${shorter}`
  if (!images.length) return [{ role: 'user', content: text }]
  return [{ role: 'user', content: [...images, { type: 'text', text }] }]
}

/** §6.6 — status question classifier (fastModel). */
export function buildStatusClassifierMessages(
  utterance: string,
  context: string[],
  projects: (Pick<Project, 'name' | 'aliases'> & { tasks?: Pick<Task, 'title' | 'status'>[] })[]
): LlmMessage[] {
  const known = projects
    .map((p) => {
      const name = p.aliases.length ? `${p.name} (${p.aliases.join(', ')})` : p.name
      const items = (p.tasks ?? []).filter((t) => t.status !== 'done').slice(0, 15).map((t) => t.title)
      return items.length ? `${name} — items: ${items.join(', ')}` : name
    })
    .join('; ')
  return [
    {
      role: 'user',
      content: `Decide if the latest utterance is asking the user for a status/update
on a project, or on one of its items (a deployment, an approval, a bug,
a follow-up, who is working on what) — not a general question. Return ONLY JSON:
{"is_status_question": boolean,
 "project_hint": "best-guess project name/alias or null"}

Known projects: ${known || '(none)'}
Recent context: ${context.length ? context.map((c) => `"${c}"`).join(' ') : '(none)'}
Latest utterance: "${utterance}"`
    }
  ]
}

const StatusClassifierSchema = z.object({
  is_status_question: z.boolean(),
  project_hint: z.string().nullable().optional()
})

/** Strip fences, parse, validate. Null on anything unexpected. */
export function parseStatusClassifier(raw: string): { isStatus: boolean; hint: string | null } | null {
  let text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  text = text.slice(start, end + 1)
  try {
    const parsed = StatusClassifierSchema.safeParse(JSON.parse(text))
    if (!parsed.success) return null
    const hint = parsed.data.project_hint?.trim()
    return { isStatus: parsed.data.is_status_question, hint: hint && hint.toLowerCase() !== 'null' ? hint : null }
  } catch {
    return null
  }
}

/** §6.9 — condense a project's notes, tasks and older updates to ~150 tokens (FR-W4). */
export function buildCondenseMessages(p: Project): LlmMessage[] {
  return [
    {
      role: 'user',
      content: `Condense this project context to at most 150 tokens for a status-update assistant: current state, latest progress, open blockers, next step, and any dates. Facts only — keep names, numbers and dates exactly; drop anything superseded by a later update. Terse bullets. Return just the summary.

<project name="${p.name}">
${projectBody(p)}
</project>`
    }
  ]
}
