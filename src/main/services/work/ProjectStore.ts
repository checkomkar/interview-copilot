import { EventEmitter } from 'node:events'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import {
  ProjectInputSchema,
  TaskInputSchema,
  type Project,
  type ProjectStatus,
  type ProjectUpdate,
  type ItemKind,
  type Proposal,
  type ProposalDecision,
  type ProposalState,
  type Task,
  type TaskStatus,
  type UpdateSource
} from '@shared/work'
import { openDb } from '../../db/db'
import { CONDENSE_OVER_CHARS, contextHash, projectBody } from './workPrompts'

/** Updates returned with each project (newest first); older ones stay in the database. */
const UPDATES_PER_PROJECT = 50

export interface ProjectStoreEvents {
  /** A project, its tasks or its updates changed (id), or one was deleted. */
  changed: [string]
  /** Proposals from Teams were added, accepted or skipped (FR-T4). */
  proposals: []
}

/** A proposal before it is stored. */
export type NewProposal = Omit<Proposal, 'id' | 'state' | 'createdAt'>

interface ProposalRow {
  id: string
  project_id: string
  state: string
  source: string
  data: string
  created_at: number
}

interface ProjectRow {
  id: string
  name: string
  aliases: string
  status: string
  owner: string
  stakeholders: string
  deadline: string
  notes: string
  created_at: number
  updated_at: number
  summary: string
  summary_of: string | null
}

interface TaskRow {
  id: string
  project_id: string
  kind: string
  title: string
  aliases: string
  status: string
  owner: string
  waiting_on: string
  environment: string
  due: string
  followed_up: string
  follow_up_note: string
  blockers: string
  ref: string
  note: string
  updated_at: number
}

interface UpdateRow {
  id: number
  project_id: string
  ts: number
  text: string
  source: string
  task_id: string | null
  author: string
}

/** Who said an update and which item it is about (FR-W3). */
export interface UpdateMeta {
  source?: UpdateSource
  sessionId?: string | null
  taskId?: string | null
  author?: string
}

/**
 * Work Mode's project context store (FR-W1..W3) in data.db: projects, their tasks and a log of
 * timestamped updates. Every change bumps the project's `updated_at`, which the status prompt
 * reports so stale context is called out (§6.5).
 */
export class ProjectStore extends EventEmitter {
  private readonly db: DatabaseSync
  private readonly now: () => number
  private seq = 0

  constructor(deps: { dir: string; now?: () => number }) {
    super()
    this.now = deps.now ?? Date.now
    mkdirSync(deps.dir, { recursive: true })
    this.db = openDb(join(deps.dir, 'data.db'))
  }

  override emit<E extends keyof ProjectStoreEvents>(event: E, ...args: ProjectStoreEvents[E]): boolean {
    return super.emit(event, ...args)
  }
  override on<E extends keyof ProjectStoreEvents>(event: E, listener: (...args: ProjectStoreEvents[E]) => void): this {
    return super.on(event, listener as (...a: unknown[]) => void)
  }

  /** Every project, most recently updated first, with its tasks and recent updates. */
  list(): Project[] {
    const rows = this.db.prepare('SELECT * FROM projects ORDER BY updated_at DESC').all() as unknown as ProjectRow[]
    return rows.map((r) => this.toProject(r))
  }

  get(id: string): Project | null {
    const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as unknown as ProjectRow | undefined
    return row ? this.toProject(row) : null
  }

  /** Create (no id) or update a project's own fields. */
  save(input: unknown): Project {
    const p = ProjectInputSchema.parse(input)
    const now = this.now()
    const aliases = JSON.stringify([...new Set(p.aliases.filter((a) => a.toLowerCase() !== p.name.toLowerCase()))])
    if (p.id && this.exists(p.id)) {
      this.db
        .prepare(
          `UPDATE projects SET name = ?, aliases = ?, status = ?, owner = ?, stakeholders = ?, deadline = ?, notes = ?, updated_at = ? WHERE id = ?`
        )
        .run(p.name, aliases, p.status, p.owner, p.stakeholders, p.deadline, p.notes, now, p.id)
      return this.changed(p.id)
    }
    const id = `prj-${now}-${++this.seq}`
    this.db
      .prepare(
        `INSERT INTO projects (id, name, aliases, status, owner, stakeholders, deadline, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, p.name, aliases, p.status, p.owner, p.stakeholders, p.deadline, p.notes, now, now)
    return this.changed(id)
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM projects WHERE id = ?').run(id)
    this.emit('changed', id)
  }

  /** Create (no id) or update a work item; returns its project. */
  saveTask(input: unknown): Project {
    return this.saveTaskWithId(input).project
  }

  /** Like saveTask, also returning the item's id (a new item's id is made here). */
  saveTaskWithId(input: unknown): { project: Project; taskId: string } {
    const t = TaskInputSchema.parse(input)
    if (!this.exists(t.projectId)) throw new Error('That project no longer exists.')
    const now = this.now()
    const aliases = JSON.stringify([...new Set(t.aliases.filter((a) => a.toLowerCase() !== t.title.toLowerCase()))])
    const fields = [t.kind, t.title, aliases, t.status, t.owner, t.waitingOn, t.environment, t.due, t.followedUp, t.followUpNote, t.blockers, t.ref, t.note]
    const existing = t.id ? (this.db.prepare('SELECT project_id FROM tasks WHERE id = ?').get(t.id) as { project_id: string } | undefined) : undefined
    let id = t.id
    if (id && existing) {
      this.db
        .prepare(
          `UPDATE tasks SET kind = ?, title = ?, aliases = ?, status = ?, owner = ?, waiting_on = ?, environment = ?, due = ?,
             followed_up = ?, follow_up_note = ?, blockers = ?, ref = ?, note = ?, updated_at = ? WHERE id = ?`
        )
        .run(...fields, now, id)
    } else {
      id = `tsk-${now}-${++this.seq}`
      const { n } = this.db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS n FROM tasks WHERE project_id = ?').get(t.projectId) as { n: number }
      this.db
        .prepare(
          `INSERT INTO tasks (kind, title, aliases, status, owner, waiting_on, environment, due, followed_up, follow_up_note, blockers, ref, note,
             id, project_id, position, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(...fields, id, t.projectId, n, now)
    }
    return { project: this.touch(t.projectId), taskId: id }
  }

  getTask(id: string): Task | null {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as unknown as TaskRow | undefined
    return row ? toTask(row) : null
  }

  deleteTask(id: string): Project | null {
    const row = this.db.prepare('SELECT project_id FROM tasks WHERE id = ?').get(id) as { project_id: string } | undefined
    if (!row) return null
    this.db.prepare('DELETE FROM tasks WHERE id = ?').run(id)
    return this.touch(row.project_id)
  }

  /**
   * Log a timestamped update (FR-W3); the main way the store stays current. It can be about one
   * item (which then counts as changed) and say who it came from. `ts`: when it was said (an
   * imported message's time), else now.
   */
  addUpdate(projectId: string, text: string, meta: UpdateMeta = {}, ts?: number): Project {
    const body = text.trim()
    if (!body) throw new Error('Write the update first.')
    if (!this.exists(projectId)) throw new Error('That project no longer exists.')
    const taskId = meta.taskId ?? null
    if (taskId) {
      const row = this.db.prepare('SELECT project_id FROM tasks WHERE id = ?').get(taskId) as { project_id: string } | undefined
      if (row?.project_id !== projectId) throw new Error('That item is not part of this project.')
      this.db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(this.now(), taskId)
    }
    this.db
      .prepare('INSERT INTO project_updates (project_id, ts, text, source, session_id, task_id, author) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(projectId, ts ?? this.now(), body, meta.source ?? 'typed', meta.sessionId ?? null, taskId, meta.author?.trim() ?? '')
    return this.touch(projectId)
  }

  deleteUpdate(id: number): Project | null {
    const row = this.db.prepare('SELECT project_id FROM project_updates WHERE id = ?').get(id) as { project_id: string } | undefined
    if (!row) return null
    this.db.prepare('DELETE FROM project_updates WHERE id = ?').run(id)
    return this.touch(row.project_id)
  }

  /** Store a condensed summary made from the context with hash `of` (FR-W4). Doesn't count as a change. */
  setSummary(id: string, summary: string, of: string | null): void {
    this.db.prepare('UPDATE projects SET summary = ?, summary_of = ? WHERE id = ?').run(summary, of, id)
    this.emit('changed', id)
  }

  // --- proposals from Teams (FR-T1..T4) ---

  /**
   * Store new proposals for review. Ones already proposed (same author and message, pending or
   * accepted) are dropped, so pasting the same chat twice doesn't double them. Returns those kept.
   */
  addProposals(list: NewProposal[]): Proposal[] {
    const seen = new Set(
      (this.db.prepare(`SELECT data FROM work_proposals WHERE state != 'skipped'`).all() as { data: string }[]).map((r) => {
        const d = JSON.parse(r.data) as Proposal
        return proposalKey(d)
      })
    )
    const kept: Proposal[] = []
    const now = this.now()
    for (const p of list) {
      const key = proposalKey(p)
      if (seen.has(key) || !this.exists(p.projectId)) continue
      seen.add(key)
      const proposal: Proposal = { ...p, id: `prp-${now}-${++this.seq}`, state: 'pending', createdAt: now }
      this.db
        .prepare('INSERT INTO work_proposals (id, project_id, state, source, data, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(proposal.id, proposal.projectId, proposal.state, proposal.source, JSON.stringify(proposal), now)
      kept.push(proposal)
    }
    if (kept.length) this.emit('proposals')
    return kept
  }

  /** Proposals waiting for review, oldest message first. */
  proposals(state: ProposalState = 'pending'): Proposal[] {
    const rows = this.db.prepare('SELECT * FROM work_proposals WHERE state = ? ORDER BY created_at, id').all(state) as unknown as ProposalRow[]
    return rows.map(toProposal).sort((a, b) => (a.ts ?? a.createdAt) - (b.ts ?? b.createdAt))
  }

  getProposal(id: string): Proposal | null {
    const row = this.db.prepare('SELECT * FROM work_proposals WHERE id = ?').get(id) as unknown as ProposalRow | undefined
    return row ? toProposal(row) : null
  }

  /**
   * Accept (applying it, with the user's edits) or skip a proposal (FR-T4). Accepting sets the
   * item's changed fields — creating the item first when it is new — and logs the update on it
   * with its author, source and message time.
   */
  decideProposal(decision: ProposalDecision): Proposal {
    const p = this.getProposal(decision.id)
    if (!p) throw new Error('That suggestion no longer exists.')
    if (p.state !== 'pending') throw new Error('That suggestion was already handled.')
    if (decision.action === 'skip') return this.setProposalState(p, 'skipped')
    const e = decision.edits ?? {}
    const next: Proposal = {
      ...p,
      projectId: e.projectId ?? p.projectId,
      taskId: e.taskId !== undefined ? e.taskId : p.taskId,
      newItem: e.newItem !== undefined ? e.newItem : p.newItem,
      changes: e.changes ?? p.changes,
      update: e.update ?? p.update
    }
    if (!this.exists(next.projectId)) throw new Error('That project no longer exists.')
    let taskId = next.taskId
    if (taskId) {
      const task = this.getTask(taskId)
      if (!task || task.projectId !== next.projectId) throw new Error('That item no longer exists — pick another or create it.')
      if (Object.keys(next.changes).length) this.saveTask({ ...taskInput(task), ...next.changes })
    } else if (next.newItem) {
      // Already created (the same bug reported in two chats, or accepted twice): update that one instead.
      const existing = this.findItem(next.projectId, next.newItem.title, next.changes.ref)
      if (existing) {
        taskId = existing.id
        if (Object.keys(next.changes).length) this.saveTask({ ...taskInput(existing), ...next.changes })
      } else {
        taskId = this.saveTaskWithId({ projectId: next.projectId, kind: next.newItem.kind, title: next.newItem.title, ...next.changes }).taskId
      }
    }
    if (next.update.trim()) this.addUpdate(next.projectId, next.update, { taskId, author: next.author, source: next.source }, next.ts ?? undefined)
    return this.setProposalState({ ...next, taskId, newItem: taskId && next.newItem ? null : next.newItem }, 'accepted')
  }

  /** An item of the project with this reference ("BUG-171") or this title, ignoring case. */
  private findItem(projectId: string, title: string, ref?: string): Task | null {
    const tasks = this.get(projectId)?.tasks ?? []
    const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()
    return (ref ? tasks.find((t) => t.ref && same(t.ref, ref)) : undefined) ?? tasks.find((t) => same(t.title, title)) ?? null
  }

  private setProposalState(p: Proposal, state: ProposalState): Proposal {
    const next = { ...p, state }
    this.db.prepare('UPDATE work_proposals SET state = ?, project_id = ?, data = ? WHERE id = ?').run(state, next.projectId, JSON.stringify(next), p.id)
    this.emit('proposals')
    return next
  }

  /** How far a followed Teams chat or channel has been read (FR-T3); null before the first sync. */
  getCursor(sourceId: string): number | null {
    const row = this.db.prepare('SELECT last_ts FROM teams_cursors WHERE source_id = ?').get(sourceId) as { last_ts: number } | undefined
    return row?.last_ts ?? null
  }

  setCursor(sourceId: string, ts: number): void {
    this.db.prepare('INSERT INTO teams_cursors (source_id, last_ts) VALUES (?, ?) ON CONFLICT(source_id) DO UPDATE SET last_ts = excluded.last_ts').run(sourceId, ts)
  }

  /** Deletes every project, task and update. */
  deleteAll(): void {
    this.db.exec('DELETE FROM projects')
    this.emit('changed', '')
  }

  dispose(): void {
    this.db.close()
  }

  private exists(id: string): boolean {
    return this.db.prepare('SELECT 1 FROM projects WHERE id = ?').get(id) !== undefined
  }

  private touch(id: string): Project {
    this.db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(this.now(), id)
    return this.changed(id)
  }

  private changed(id: string): Project {
    this.emit('changed', id)
    const p = this.get(id)
    if (!p) throw new Error('Project not found.')
    return p
  }

  private toProject(r: ProjectRow): Project {
    const tasks = (this.db.prepare('SELECT * FROM tasks WHERE project_id = ? ORDER BY position, updated_at').all(r.id) as unknown as TaskRow[]).map(toTask)
    const updates = (
      this.db.prepare('SELECT * FROM project_updates WHERE project_id = ? ORDER BY ts DESC, id DESC LIMIT ?').all(r.id, UPDATES_PER_PROJECT) as unknown as UpdateRow[]
    ).map(
      (u): ProjectUpdate => ({
        id: u.id,
        projectId: u.project_id,
        ts: u.ts,
        text: u.text,
        source: u.source as UpdateSource,
        taskId: u.task_id,
        author: u.author ?? ''
      })
    )
    const project: Project = {
      id: r.id,
      name: r.name,
      aliases: parseAliases(r.aliases),
      status: r.status as ProjectStatus,
      owner: r.owner,
      stakeholders: r.stakeholders,
      deadline: r.deadline,
      notes: r.notes,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      summary: r.summary,
      summaryOf: r.summary_of,
      context: 'short',
      tasks,
      updates
    }
    const body = projectBody(project)
    if (body.length > CONDENSE_OVER_CHARS) project.context = r.summary && r.summary_of === contextHash(body) ? 'condensed' : 'pending'
    return project
  }
}

/** Same author and same message: the same proposal. */
/** Same author and same message (ignoring case, spacing and punctuation): the same proposal. */
function proposalKey(p: Pick<Proposal, 'author' | 'quote' | 'update'>): string {
  const norm = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
  return `${norm(p.author)}|${norm(p.quote || p.update)}`
}

function toProposal(r: ProposalRow): Proposal {
  return { ...(JSON.parse(r.data) as Proposal), id: r.id, projectId: r.project_id, state: r.state as ProposalState }
}

/** An item's editable fields, for saving it back with some changed. */
function taskInput(t: Task) {
  return {
    id: t.id,
    projectId: t.projectId,
    kind: t.kind,
    title: t.title,
    aliases: t.aliases,
    status: t.status,
    owner: t.owner,
    waitingOn: t.waitingOn,
    environment: t.environment,
    due: t.due,
    followedUp: t.followedUp,
    followUpNote: t.followUpNote,
    blockers: t.blockers,
    ref: t.ref,
    note: t.note
  }
}

function toTask(t: TaskRow): Task {
  return {
    id: t.id,
    projectId: t.project_id,
    kind: (t.kind ?? 'task') as ItemKind,
    title: t.title,
    aliases: parseAliases(t.aliases ?? '[]'),
    status: t.status as TaskStatus,
    owner: t.owner ?? '',
    waitingOn: t.waiting_on ?? '',
    environment: t.environment ?? '',
    due: t.due,
    followedUp: t.followed_up ?? '',
    followUpNote: t.follow_up_note ?? '',
    blockers: t.blockers,
    ref: t.ref ?? '',
    note: t.note,
    updatedAt: t.updated_at
  }
}

function parseAliases(json: string): string[] {
  try {
    const v = JSON.parse(json) as unknown
    return Array.isArray(v) ? v.filter((a): a is string => typeof a === 'string') : []
  } catch {
    return []
  }
}
