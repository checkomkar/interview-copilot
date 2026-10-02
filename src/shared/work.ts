import { z } from 'zod'

/** Work Mode project context store (PRD §3.10, FR-W1..W5). */

export const PROJECT_STATUSES = ['on_track', 'at_risk', 'blocked', 'done'] as const
export type ProjectStatus = (typeof PROJECT_STATUSES)[number]
export const PROJECT_STATUS_LABELS: Record<ProjectStatus, string> = {
  on_track: 'On track',
  at_risk: 'At risk',
  blocked: 'Blocked',
  done: 'Done'
}

/** What a work item is (FR-W2): people ask about each one separately. */
export const ITEM_KINDS = ['task', 'approval', 'bug', 'deployment'] as const
export type ItemKind = (typeof ITEM_KINDS)[number]
export const ITEM_KIND_LABELS: Record<ItemKind, string> = {
  task: 'Task',
  approval: 'Approval',
  bug: 'Bug',
  deployment: 'Deployment'
}

/** `waiting`: on another team or person (an approval, the MDM team). */
export const TASK_STATUSES = ['todo', 'in_progress', 'waiting', 'blocked', 'done'] as const
export type TaskStatus = (typeof TASK_STATUSES)[number]
export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  todo: 'To do',
  in_progress: 'In progress',
  waiting: 'Waiting',
  blocked: 'Blocked',
  done: 'Done'
}

/**
 * `typed`: logged by the user (Projects tab or the overlay). `recap`: added by an end-of-call recap.
 * `import`: accepted from pasted or screenshotted Teams messages. `teams`: accepted from Teams sync.
 */
export const UPDATE_SOURCES = ['typed', 'recap', 'import', 'teams'] as const
export type UpdateSource = (typeof UPDATE_SOURCES)[number]

/** `YYYY-MM-DD`, or empty for none. */
const DateSchema = z.union([z.literal(''), z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a YYYY-MM-DD date')]).default('')
const Text = (max: number) => z.string().trim().max(max).default('')

export const ProjectInputSchema = z.object({
  /** Absent for a new project. */
  id: z.string().min(1).max(100).optional(),
  name: z.string().trim().min(1, 'Give the project a name.').max(120),
  /** Other names people use for it ("PRISM", "the benchmarking tool"). */
  aliases: z.array(z.string().trim().min(1).max(80)).max(10).default([]),
  status: z.enum(PROJECT_STATUSES).default('on_track'),
  owner: Text(120),
  stakeholders: Text(300),
  deadline: DateSchema,
  notes: Text(20_000)
})
export type ProjectInput = z.input<typeof ProjectInputSchema>

export const TaskInputSchema = z.object({
  id: z.string().min(1).max(100).optional(),
  projectId: z.string().min(1).max(100),
  kind: z.enum(ITEM_KINDS).default('task'),
  title: z.string().trim().min(1, 'Give the item a title.').max(200),
  /** Other names people use ("UAT deploy", "the login crash"). */
  aliases: z.array(z.string().trim().min(1).max(80)).max(10).default([]),
  status: z.enum(TASK_STATUSES).default('todo'),
  /** Who's on it (the developer for a bug). */
  owner: Text(120),
  /** A team or person it's waiting on ("MDM team"). */
  waitingOn: Text(200),
  /** "UAT", "Prod". */
  environment: Text(60),
  due: DateSchema,
  /** Last time someone chased it, and a note on who chased whom. */
  followedUp: DateSchema,
  followUpNote: Text(500),
  blockers: Text(1000),
  /** Bug ID or link ("BUG-142"). */
  ref: Text(300),
  /** Last-updated note. */
  note: Text(2000)
})
export type TaskInput = z.input<typeof TaskInputSchema>

export const UpdateAddSchema = z.object({
  projectId: z.string().min(1).max(100),
  /** The item it is about, if any. */
  taskId: z.string().min(1).max(100).optional(),
  text: z.string().trim().min(1, 'Write the update first.').max(4000),
  /** Who said it, when it isn't the user ("Ravi"). */
  author: z.string().trim().max(120).optional()
})

export const WorkIdSchema = z.object({ id: z.string().min(1).max(100) })
export const UpdateIdSchema = z.object({ id: z.number().int().positive() })

/** The overlay's pick: a status update on this project, for the question heard (if any). */
export const WorkStatusSchema = z.object({
  projectId: z.string().min(1).max(100),
  taskId: z.string().min(1).max(100).optional(),
  question: z.string().max(2000).optional()
})

/** A work item (FR-W2). Called a task in code and storage. */
export interface Task {
  id: string
  projectId: string
  kind: ItemKind
  title: string
  aliases: string[]
  status: TaskStatus
  owner: string
  waitingOn: string
  environment: string
  due: string
  followedUp: string
  followUpNote: string
  blockers: string
  ref: string
  note: string
  updatedAt: number
}

export interface ProjectUpdate {
  id: number
  projectId: string
  ts: number
  text: string
  source: UpdateSource
  /** The item it is about; null for the project as a whole. */
  taskId: string | null
  /** Who said it ("Ravi"); empty when the user logged it themselves. */
  author: string
}

export interface Project {
  id: string
  name: string
  aliases: string[]
  status: ProjectStatus
  owner: string
  stakeholders: string
  deadline: string
  notes: string
  createdAt: number
  /** Last change to the project, its tasks or its updates. */
  updatedAt: number
  /** fastModel condensed context (FR-W4); empty until made, or when the raw context is already short. */
  summary: string
  /** Hash of the raw context the summary was made from; a mismatch means it is out of date. */
  summaryOf: string | null
  /** What status answers get (FR-W4): the full text (`short`), the condensed summary, or the full text until it is condensed (`pending`). */
  context: 'short' | 'condensed' | 'pending'
  tasks: Task[]
  /** Newest first (the most recent ones). */
  updates: ProjectUpdate[]
}

/** One choice in the overlay's status quick-pick (FR-W6, FR-W9). */
export interface WorkPickProject {
  id: string
  name: string
  status: ProjectStatus
}

/** Shown in the overlay when a status update was asked for but the project isn't certain. */
export interface WorkPick {
  /** What was heard, if the pick follows a detected question. */
  question: string
  projects: WorkPickProject[]
  /** Best guess, listed first and preselected. */
  suggestedId: string | null
  ts: number
}

export type WorkResult = { ok: true } | { ok: false; error: string }

/** Item fields a Teams message can change (FR-T1). */
export const ProposalChangesSchema = z
  .object({
    status: z.enum(TASK_STATUSES),
    owner: z.string().trim().max(120),
    waitingOn: z.string().trim().max(200),
    environment: z.string().trim().max(60),
    due: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    followedUp: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    followUpNote: z.string().trim().max(500),
    blockers: z.string().trim().max(1000),
    ref: z.string().trim().max(300)
  })
  .partial()
export type ProposalChanges = z.infer<typeof ProposalChangesSchema>

export type ProposalState = 'pending' | 'accepted' | 'skipped'

/**
 * A change Cue proposes from a Teams message (FR-T1..T4); nothing is applied until the user
 * accepts it. Either an existing item (`taskId`), a new one (`newItem`), or the project as a whole.
 */
export interface Proposal {
  id: string
  projectId: string
  taskId: string | null
  newItem: { kind: ItemKind; title: string } | null
  changes: ProposalChanges
  /** One line logged as the update ("Fix for the login crash is in review"). */
  update: string
  /** Who said it, as shown in Teams. */
  author: string
  /** When the message was sent, if known. */
  ts: number | null
  /** The message itself, for checking. */
  quote: string
  source: 'import' | 'teams'
  state: ProposalState
  createdAt: number
}

/** A message the import found nothing tracked in. */
export interface SkippedMessage {
  author: string
  quote: string
  reason: string
}

export type ImportResult =
  | { ok: true; proposals: Proposal[]; skipped: SkippedMessage[] }
  | { ok: false; error: string }

/** Pasted chat text, or screenshots of it (data URLs from the clipboard or files). */
export const ImportSchema = z.union([
  z.object({ text: z.string().trim().min(1, 'Paste some messages first.').max(60_000, 'That is too much at once — paste up to about a day of messages.') }),
  z.object({
    images: z
      .array(z.string().regex(/^data:image\/(?:png|jpeg|webp);base64,/, 'Only PNG, JPEG or WebP screenshots.').max(15_000_000))
      .min(1)
      .max(8, 'Up to 8 screenshots at once.')
  })
])
export type ImportInput = z.infer<typeof ImportSchema>

/** Accept (optionally with edits) or skip a proposal. */
export const ProposalDecisionSchema = z.object({
  id: z.string().min(1).max(100),
  action: z.enum(['accept', 'skip']),
  edits: z
    .object({
      update: z.string().trim().max(4000).optional(),
      changes: ProposalChangesSchema.optional(),
      projectId: z.string().min(1).max(100).optional(),
      taskId: z.string().min(1).max(100).nullable().optional(),
      newItem: z.object({ kind: z.enum(ITEM_KINDS), title: z.string().trim().min(1).max(200) }).nullable().optional()
    })
    .optional()
})
export type ProposalDecision = z.infer<typeof ProposalDecisionSchema>

/** A Teams chat or channel that can be followed (FR-T3). */
export interface TeamsSource {
  kind: 'chat' | 'channel'
  id: string
  teamId: string | null
  name: string
}

/** Teams sync state for the UI (FR-T3). */
export interface TeamsStatus {
  /** An app (client) ID is set. */
  configured: boolean
  /** Signed-in account ("Omkar Kamale · omkar@contoso.com"), or null. */
  account: string | null
  /** Waiting for the user to enter the code at the sign-in page. */
  signIn: { userCode: string; verificationUri: string; expiresAt: number } | null
  syncing: boolean
  lastSync: number | null
  /** Proposals the last sync added. */
  lastFound: number
  error: string | null
}
