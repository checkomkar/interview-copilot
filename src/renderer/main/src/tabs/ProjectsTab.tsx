import { useEffect, useState, type ReactNode } from 'react'
import {
  ITEM_KINDS,
  ITEM_KIND_LABELS,
  PROJECT_STATUSES,
  PROJECT_STATUS_LABELS,
  TASK_STATUSES,
  TASK_STATUS_LABELS,
  type ItemKind,
  type Project,
  type ProjectInput,
  type Proposal,
  type ProjectStatus,
  type ProjectUpdate,
  type Task,
  type TaskStatus
} from '@shared/work'
import { useApp } from '../store'
import { keys } from '../../../shared/keys'
import { ImportUpdates } from './ImportUpdates'

const inputCls = 'w-full rounded-md border border-line bg-raised px-3 py-1.5 text-sm outline-none focus:border-accent'
const areaCls = `${inputCls} resize-y leading-relaxed`

const ITEM_TONE: Record<TaskStatus, string> = {
  todo: 'text-muted',
  in_progress: 'text-accent',
  waiting: 'text-warn',
  blocked: 'text-bad',
  done: 'text-ok'
}

const STATUS_TONE: Record<ProjectStatus, string> = {
  on_track: 'bg-ok/15 text-ok',
  at_risk: 'bg-warn/15 text-warn',
  blocked: 'bg-bad/15 text-bad',
  done: 'bg-raised text-muted'
}

interface Draft {
  name: string
  aliases: string
  status: ProjectStatus
  owner: string
  stakeholders: string
  deadline: string
  notes: string
}

const EMPTY_DRAFT: Draft = { name: '', aliases: '', status: 'on_track', owner: '', stakeholders: '', deadline: '', notes: '' }

function toDraft(p: Project): Draft {
  return { name: p.name, aliases: p.aliases.join(', '), status: p.status, owner: p.owner, stakeholders: p.stakeholders, deadline: p.deadline, notes: p.notes }
}

function toInput(d: Draft, id?: string): ProjectInput {
  return {
    ...(id ? { id } : {}),
    name: d.name,
    aliases: d.aliases
      .split(',')
      .map((a) => a.trim())
      .filter(Boolean),
    status: d.status,
    owner: d.owner,
    stakeholders: d.stakeholders,
    deadline: d.deadline,
    notes: d.notes
  }
}

function errorMessage(err: unknown): string {
  return (err instanceof Error ? err.message : String(err))
    .replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
    .replace(/^Invalid input: \w+: /, '')
}

function ago(ts: number): string {
  const min = Math.round((Date.now() - ts) / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min} min ago`
  const h = Math.round(min / 60)
  if (h < 24) return `${h} h ago`
  const d = Math.round(h / 24)
  return d === 1 ? 'yesterday' : `${d} days ago`
}

const dateTime = (ts: number) => new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })

/** Work Mode's project context store (FR-W1..W4): what status answers are written from. */
export function ProjectsTab() {
  const mode = useApp((s) => s.settings?.mode)
  const [projects, setProjects] = useState<Project[] | null>(null)
  const [proposals, setProposals] = useState<Proposal[]>([])
  /** A project id, 'new' for an unsaved one, or 'import' for Teams updates (FR-T1..T4). */
  const [selected, setSelected] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ text: string; bad?: boolean } | null>(null)

  useEffect(() => {
    void window.api.work.list().then((list) => {
      setProjects(list)
      setSelected((s) => s ?? list[0]?.id ?? null)
    })
    void window.api.work.proposals().then(setProposals)
    const offs = [window.api.work.onChanged(setProjects), window.api.work.onProposals(setProposals)]
    return () => offs.forEach((off) => off())
  }, [])

  const project = projects?.find((p) => p.id === selected) ?? null

  return (
    <div className="flex h-full">
      <aside className="flex w-72 shrink-0 flex-col border-r border-line">
        <div className="flex items-center gap-2 border-b border-line px-4 py-3">
          <h1 className="flex-1 text-sm font-semibold">Projects</h1>
          <button
            onClick={() => {
              setNotice(null)
              setSelected('new')
            }}
            className="rounded-md bg-accent px-2.5 py-1 text-xs font-semibold text-bg hover:bg-accent/90"
          >
            New project
          </button>
        </div>
        <div className="border-b border-line p-2">
          <button
            onClick={() => {
              setNotice(null)
              setSelected('import')
            }}
            className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm ${selected === 'import' ? 'bg-raised' : 'hover:bg-raised/60'}`}
          >
            <span className="flex-1">Updates from Teams</span>
            {proposals.length > 0 && (
              <span className="rounded-full bg-accent px-1.5 font-mono text-[11px] font-semibold text-bg tabular-nums" title="Suggestions waiting for review">
                {proposals.length}
              </span>
            )}
          </button>
        </div>
        <ul className="min-h-0 flex-1 overflow-y-auto p-2">
          {projects === null ? (
            <li className="p-3 text-sm text-muted">Loading…</li>
          ) : projects.length === 0 ? (
            <li className="p-3 text-sm text-muted">No projects yet.</li>
          ) : (
            projects.map((p) => (
              <li key={p.id}>
                <button
                  onClick={() => {
                    setNotice(null)
                    setSelected(p.id)
                  }}
                  className={`flex w-full flex-col gap-0.5 rounded-md px-3 py-2 text-left ${selected === p.id ? 'bg-raised' : 'hover:bg-raised/60'}`}
                >
                  <span className="flex items-center gap-2 text-sm">
                    <span className="truncate">{p.name}</span>
                    <span className={`ml-auto shrink-0 rounded px-1.5 py-px text-[10px] font-medium tracking-wide uppercase ${STATUS_TONE[p.status]}`}>
                      {PROJECT_STATUS_LABELS[p.status]}
                    </span>
                  </span>
                  <span className="font-mono text-[11px] text-muted tabular-nums">
                    {p.deadline ? `due ${p.deadline} · ` : ''}updated {ago(p.updatedAt)}
                  </span>
                </button>
              </li>
            ))
          )}
        </ul>
        <p className="border-t border-line px-4 py-3 text-[11px] leading-relaxed text-muted">
          In a Work session, <span className="font-mono">{keys('Ctrl+Shift+Space')}</span> picks a project for a status update; questions like "where are we on
          X?" are spotted automatically.
        </p>
      </aside>

      <div className="min-w-0 flex-1 overflow-y-auto">
        {mode === 'interview' && (
          <div className="border-b border-warn/30 bg-warn/10 px-8 py-2 text-sm text-warn">
            You're in Interview Mode — projects are used in Work Mode (switch on the Session tab).
          </div>
        )}
        {notice && (
          <div className={`border-b px-8 py-2 text-sm ${notice.bad ? 'border-bad/30 bg-bad/10 text-bad' : 'border-ok/30 bg-ok/10 text-ok'}`}>{notice.text}</div>
        )}
        {selected === 'import' ? (
          <ImportUpdates projects={projects ?? []} proposals={proposals} />
        ) : selected === 'new' ? (
          <ProjectEditor
            key="new"
            project={null}
            onSaved={(p) => {
              setSelected(p.id)
              setNotice({ text: `Created ${p.name}. Add its work items and log updates below.` })
            }}
            onError={(text) => setNotice({ text, bad: true })}
            onDeleted={() => setSelected(projects?.[0]?.id ?? null)}
          />
        ) : project ? (
          <ProjectEditor
            key={project.id}
            project={project}
            onSaved={() => setNotice({ text: 'Saved.' })}
            onError={(text) => setNotice({ text, bad: true })}
            onDeleted={(list) => {
              setNotice(null)
              setSelected(list[0]?.id ?? null)
            }}
          />
        ) : (
          projects !== null && <EmptyState onNew={() => setSelected('new')} />
        )}
      </div>
    </div>
  )
}

function EmptyState({ onNew }: { onNew: () => void }) {
  return (
    <div className="mx-auto flex max-w-xl flex-col gap-4 px-8 py-16">
      <h2 className="text-xl font-semibold">Give Cue your projects</h2>
      <p className="text-sm leading-relaxed text-muted">
        In Work Mode, when someone on a call asks "what's the status of the migration?", Cue writes a ready-to-say update from what you store here plus
        what's been said in the call. Add each project you might be asked about, with the names people use for it, and log a quick update whenever
        something changes.
      </p>
      <div>
        <button onClick={onNew} className="rounded-lg bg-accent px-5 py-2 text-sm font-semibold text-bg">
          Add your first project
        </button>
      </div>
    </div>
  )
}

function ProjectEditor({
  project,
  onSaved,
  onError,
  onDeleted
}: {
  project: Project | null
  onSaved: (p: Project) => void
  onError: (message: string) => void
  onDeleted: (list: Project[]) => void
}) {
  const [draft, setDraft] = useState<Draft>(project ? toDraft(project) : EMPTY_DRAFT)
  const [busy, setBusy] = useState(false)
  const saved = project ? toDraft(project) : EMPTY_DRAFT
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved)
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }))

  // Another window or a logged update changed the project: keep the draft unless it was edited.
  useEffect(() => {
    if (project && !dirty) setDraft(toDraft(project))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.updatedAt])

  const save = async () => {
    setBusy(true)
    try {
      const p = await window.api.work.save(toInput(draft, project?.id))
      setDraft(toDraft(p))
      onSaved(p)
    } catch (err) {
      onError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    if (!project || !window.confirm(`Delete ${project.name} with its tasks and updates? This cannot be undone.`)) return
    onDeleted(await window.api.work.delete(project.id))
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 px-8 py-8">
      <Card title={project ? project.name : 'New project'}>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Name">
            <input className={inputCls} value={draft.name} onChange={(e) => set('name', e.target.value)} placeholder="Payments migration" autoFocus={!project} />
          </Field>
          <Field label="Also called (comma-separated)">
            <input className={inputCls} value={draft.aliases} onChange={(e) => set('aliases', e.target.value)} placeholder="PRISM, the migration" />
          </Field>
          <Field label="Status">
            <select className={inputCls} value={draft.status} onChange={(e) => set('status', e.target.value as ProjectStatus)}>
              {PROJECT_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {PROJECT_STATUS_LABELS[s]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Deadline">
            <input type="date" className={inputCls} value={draft.deadline} onChange={(e) => set('deadline', e.target.value)} />
          </Field>
          <Field label="Owner">
            <input className={inputCls} value={draft.owner} onChange={(e) => set('owner', e.target.value)} placeholder="Me" />
          </Field>
          <Field label="Stakeholders (who asks about it)">
            <input className={inputCls} value={draft.stakeholders} onChange={(e) => set('stakeholders', e.target.value)} placeholder="Priya (director), finance team" />
          </Field>
        </div>
        <Field label="Notes — goals, current state, risks, numbers worth quoting">
          <textarea className={areaCls} rows={6} value={draft.notes} onChange={(e) => set('notes', e.target.value)} />
        </Field>
        <div className="flex items-center gap-3">
          <button
            onClick={() => void save()}
            disabled={busy || !dirty || !draft.name.trim()}
            className="rounded-lg bg-accent px-5 py-2 text-sm font-semibold text-bg disabled:opacity-40"
          >
            {busy ? 'Saving…' : project ? 'Save changes' : 'Create project'}
          </button>
          {dirty && project && <span className="text-sm text-muted">Unsaved changes</span>}
          {project && (
            <button onClick={() => void remove()} className="ml-auto rounded-md px-3 py-1.5 text-sm text-muted hover:bg-bad/15 hover:text-bad">
              Delete project
            </button>
          )}
        </div>
      </Card>

      {project && (
        <>
          <ItemsCard project={project} onError={onError} />
          <UpdatesCard project={project} onError={onError} />
          <ContextCard project={project} />
        </>
      )}
    </div>
  )
}

/** FR-W3: the quick way to keep a project current. */
function UpdatesCard({ project, onError }: { project: Project; onError: (m: string) => void }) {
  const [text, setText] = useState('')
  const [taskId, setTaskId] = useState('')
  const [author, setAuthor] = useState('')
  const [busy, setBusy] = useState(false)
  const add = async () => {
    if (!text.trim() || busy) return
    setBusy(true)
    try {
      await window.api.work.addUpdate(project.id, text, { taskId: taskId || undefined, author: author.trim() || undefined })
      setText('')
    } catch (err) {
      onError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Card
      title="Log an update"
      description="What changed — progress, a decision, a new blocker, a date. Dated automatically; the latest five go with every status answer. Win+H dictates."
    >
      <textarea
        className={areaCls}
        rows={2}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void add()
        }}
        placeholder="e.g. Cut-over moved to Nov 12 — waiting on the bank's sandbox keys."
      />
      <div className="grid grid-cols-[repeat(2,minmax(0,1fr))] gap-3">
        <Field label="About">
          <select className={inputCls} value={taskId} onChange={(e) => setTaskId(e.target.value)}>
            <option value="">The whole project</option>
            {project.tasks.map((t) => (
              <option key={t.id} value={t.id}>
                {ITEM_KIND_LABELS[t.kind]}: {t.title}
              </option>
            ))}
          </select>
        </Field>
        <Field label="From (who said it — leave empty if it's you)">
          <input className={inputCls} value={author} onChange={(e) => setAuthor(e.target.value)} placeholder="Ravi" />
        </Field>
      </div>
      <div className="flex items-center gap-3">
        <button onClick={() => void add()} disabled={!text.trim() || busy} className="rounded-md border border-line px-3 py-1.5 text-sm hover:bg-raised disabled:opacity-40">
          Log update
        </button>
        <span className="text-[11px] text-muted">{keys('Ctrl+')}Enter · in a call, type "update {project.name}: …" in the overlay</span>
      </div>
      {project.updates.length > 0 && (
        <ol className="flex flex-col divide-y divide-line rounded-lg border border-line">
          {project.updates.map((u) => (
            <UpdateRow key={u.id} update={u} project={project} onError={onError} />
          ))}
        </ol>
      )}
    </Card>
  )
}

function UpdateRow({ update: u, project, onError, hideItem }: { update: ProjectUpdate; project: Project; onError: (m: string) => void; hideItem?: boolean }) {
  const item = !hideItem && u.taskId ? project.tasks.find((t) => t.id === u.taskId) : undefined
  return (
    <li className="group flex items-start gap-3 px-3 py-2 text-sm">
      <span className="w-36 shrink-0 font-mono text-[11px] text-muted tabular-nums">{dateTime(u.ts)}</span>
      <span className="min-w-0 flex-1 whitespace-pre-wrap">
        {(u.author || item) && (
          <span className="mr-1.5 text-xs text-muted">
            {[u.author, item && item.title].filter(Boolean).join(' · ')} —
          </span>
        )}
        {u.text}
      </span>
      {u.source !== 'typed' && <span className="shrink-0 rounded bg-me/15 px-1.5 text-[10px] text-me uppercase">{u.source}</span>}
      <button
        onClick={() => void window.api.work.deleteUpdate(u.id).catch((err) => onError(errorMessage(err)))}
        className="shrink-0 text-xs text-muted opacity-0 group-hover:opacity-100 hover:text-bad"
        aria-label="Delete update"
        title="Delete update"
      >
        ✕
      </button>
    </li>
  )
}

type ItemFilter = 'open' | 'all' | ItemKind

/** FR-W2: the things people ask about one by one — deployments, approvals, bugs, tasks. */
function ItemsCard({ project, onError }: { project: Project; onError: (m: string) => void }) {
  const [title, setTitle] = useState('')
  const [kind, setKind] = useState<ItemKind>('task')
  const [filter, setFilter] = useState<ItemFilter>('open')
  const [open, setOpen] = useState<string | null>(null)
  const add = async () => {
    if (!title.trim()) return
    try {
      const before = new Set(project.tasks.map((t) => t.id))
      const p = await window.api.work.saveTask({ projectId: project.id, kind, title, status: kind === 'approval' ? 'waiting' : 'todo' })
      setTitle('')
      setOpen(p.tasks.find((t) => !before.has(t.id))?.id ?? null)
    } catch (err) {
      onError(errorMessage(err))
    }
  }
  const shown = project.tasks.filter((t) => (filter === 'all' ? true : filter === 'open' ? t.status !== 'done' : t.kind === filter))
  const count = (f: ItemFilter) => project.tasks.filter((t) => (f === 'all' ? true : f === 'open' ? t.status !== 'done' : t.kind === f)).length
  return (
    <Card
      title="Work items"
      description="Deployments, approvals, bugs and tasks — each answered on its own when someone asks about it. Open items always go with status answers in full. Changes save when you leave a field."
    >
      <div className="flex flex-wrap gap-1">
        {(['open', 'all', ...ITEM_KINDS] as ItemFilter[]).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`rounded-full px-2.5 py-0.5 text-xs ${filter === f ? 'bg-raised text-fg' : 'text-muted hover:text-fg'}`}
          >
            {f === 'open' ? 'Open' : f === 'all' ? 'All' : `${ITEM_KIND_LABELS[f]}s`} <span className="font-mono tabular-nums opacity-70">{count(f)}</span>
          </button>
        ))}
      </div>
      {shown.length > 0 && (
        <ul className="flex flex-col divide-y divide-line rounded-lg border border-line">
          {shown.map((t) => (
            <ItemRow key={t.id} task={t} project={project} expanded={open === t.id} onToggle={() => setOpen(open === t.id ? null : t.id)} onError={onError} />
          ))}
        </ul>
      )}
      <div className="flex gap-2">
        <select className={`${inputCls.replace('w-full', 'w-36')} shrink-0`} value={kind} onChange={(e) => setKind(e.target.value as ItemKind)} aria-label="Kind">
          {ITEM_KINDS.map((k) => (
            <option key={k} value={k}>
              {ITEM_KIND_LABELS[k]}
            </option>
          ))}
        </select>
        <input
          className={inputCls}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void add()}
          placeholder={kind === 'bug' ? 'Login crash on Android 14, then Enter' : kind === 'approval' ? 'TOM approvals, then Enter' : kind === 'deployment' ? 'UAT deployment, then Enter' : 'New item title, then Enter'}
        />
        <button onClick={() => void add()} disabled={!title.trim()} className="shrink-0 rounded-md border border-line px-3 py-1.5 text-sm hover:bg-raised disabled:opacity-40">
          Add
        </button>
      </div>
    </Card>
  )
}

const TEXT_FIELDS = ['title', 'owner', 'waitingOn', 'environment', 'due', 'followedUp', 'followUpNote', 'blockers', 'ref', 'note'] as const

function ItemRow({
  task,
  project,
  expanded,
  onToggle,
  onError
}: {
  task: Task
  project: Project
  expanded: boolean
  onToggle: () => void
  onError: (m: string) => void
}) {
  const [draft, setDraft] = useState({ ...task, aliasText: task.aliases.join(', ') })
  const [update, setUpdate] = useState('')
  const [from, setFrom] = useState('')
  useEffect(() => setDraft({ ...task, aliasText: task.aliases.join(', ') }), [task])
  const commit = async (next: typeof draft) => {
    setDraft(next)
    const aliases = next.aliasText
      .split(',')
      .map((a) => a.trim())
      .filter(Boolean)
    const changed =
      TEXT_FIELDS.some((k) => next[k] !== task[k]) || next.kind !== task.kind || next.status !== task.status || aliases.join('|') !== task.aliases.join('|')
    if (!changed || !next.title.trim()) return
    const { aliasText: _, updatedAt: __, ...fields } = next
    try {
      await window.api.work.saveTask({ ...fields, aliases })
    } catch (err) {
      setDraft({ ...task, aliasText: task.aliases.join(', ') })
      onError(errorMessage(err))
    }
  }
  const logUpdate = async () => {
    if (!update.trim()) return
    try {
      await window.api.work.addUpdate(project.id, update, { taskId: task.id, author: from.trim() || undefined })
      setUpdate('')
    } catch (err) {
      onError(errorMessage(err))
    }
  }
  const small = 'w-full rounded-md border border-line bg-raised px-2 py-1 text-[13px] outline-none focus:border-accent'
  const text = (key: (typeof TEXT_FIELDS)[number], placeholder: string, type = 'text') => (
    <input
      type={type}
      className={small}
      value={draft[key]}
      onChange={(e) => (type === 'date' ? void commit({ ...draft, [key]: e.target.value }) : setDraft({ ...draft, [key]: e.target.value }))}
      onBlur={() => type !== 'date' && void commit(draft)}
      placeholder={placeholder}
    />
  )
  const updates = project.updates.filter((u) => u.taskId === task.id)
  const summary = [task.owner, task.waitingOn && `waiting on ${task.waitingOn}`, task.environment, task.ref].filter(Boolean).join(' · ')
  return (
    <li className="flex flex-col">
      <div className="flex items-center gap-2 px-3 py-2">
        <button onClick={onToggle} className="flex min-w-0 flex-1 items-start gap-2 text-left" aria-expanded={expanded}>
          <span className="pt-0.5 text-[10px] text-muted">{expanded ? '▾' : '▸'}</span>
          <span className="w-20 shrink-0 pt-0.5 text-[10px] font-medium tracking-wide text-muted uppercase">{ITEM_KIND_LABELS[task.kind]}</span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-sm">{task.title}</span>
            {summary && <span className="truncate text-xs text-muted">{summary}</span>}
          </span>
        </button>
        <select
          className={`w-32 shrink-0 rounded-md border border-line bg-raised px-2 py-1 text-[12px] outline-none ${ITEM_TONE[draft.status]}`}
          value={draft.status}
          onChange={(e) => void commit({ ...draft, status: e.target.value as TaskStatus })}
          aria-label={`Status of ${task.title}`}
        >
          {TASK_STATUSES.map((st) => (
            <option key={st} value={st}>
              {TASK_STATUS_LABELS[st]}
            </option>
          ))}
        </select>
      </div>
      {expanded && (
        <div className="flex flex-col gap-2 border-t border-line bg-bg/40 px-3 py-3">
          <div className="grid grid-cols-[repeat(3,minmax(0,1fr))] gap-2">
            <SmallField label="Title">{text('title', 'Title')}</SmallField>
            <SmallField label="Also called">
              <input
                className={small}
                value={draft.aliasText}
                onChange={(e) => setDraft({ ...draft, aliasText: e.target.value })}
                onBlur={() => void commit(draft)}
                placeholder="UAT deploy, the MDM thing"
              />
            </SmallField>
            <SmallField label="Kind">
              <select className={small} value={draft.kind} onChange={(e) => void commit({ ...draft, kind: e.target.value as ItemKind })}>
                {ITEM_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {ITEM_KIND_LABELS[k]}
                  </option>
                ))}
              </select>
            </SmallField>
            <SmallField label={task.kind === 'bug' ? 'Developer on it' : 'Owner'}>{text('owner', 'Ravi')}</SmallField>
            <SmallField label="Waiting on">{text('waitingOn', 'MDM team')}</SmallField>
            <SmallField label="Environment">{text('environment', 'UAT')}</SmallField>
            <SmallField label="Due">{text('due', '', 'date')}</SmallField>
            <SmallField label="Last follow-up">{text('followedUp', '', 'date')}</SmallField>
            <SmallField label="Follow-up note">{text('followUpNote', 'Priya emailed MDM')}</SmallField>
            <SmallField label={task.kind === 'bug' ? 'Bug ID / link' : 'Reference'}>{text('ref', 'BUG-142')}</SmallField>
            <div className="col-span-2">
              <SmallField label="Blockers">{text('blockers', 'Waiting on sign-off from security')}</SmallField>
            </div>
          </div>
          <SmallField label="Note">{text('note', 'Latest state in a line')}</SmallField>
          <div className="flex gap-2">
            <input
              className={small}
              value={update}
              onChange={(e) => setUpdate(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void logUpdate()}
              placeholder={`Log an update on ${task.title}, then Enter`}
            />
            <input className={`${small.replace('w-full', 'w-28')} shrink-0`} value={from} onChange={(e) => setFrom(e.target.value)} placeholder="From (optional)" />
          </div>
          {updates.length > 0 && (
            <ol className="flex flex-col divide-y divide-line rounded-lg border border-line">
              {updates.map((u) => (
                <UpdateRow key={u.id} update={u} project={project} onError={onError} hideItem />
              ))}
            </ol>
          )}
          <div className="flex">
            <button
              onClick={() =>
                window.confirm(`Delete ${task.title}? Its updates stay on the project.`) &&
                void window.api.work.deleteTask(task.id).catch((err) => onError(errorMessage(err)))
              }
              className="ml-auto rounded-md px-2 py-1 text-xs text-muted hover:bg-bad/15 hover:text-bad"
            >
              Delete item
            </button>
          </div>
        </div>
      )}
    </li>
  )
}

function SmallField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] text-muted">{label}</span>
      {children}
    </label>
  )
}

/** FR-W4: what a status answer is written from. */
function ContextCard({ project }: { project: Project }) {
  const state =
    project.context === 'short'
      ? 'Notes, finished items and updates are short, so they are sent as they are. Open items always go in full.'
      : project.context === 'condensed'
        ? 'Notes, finished items and older updates are condensed to about 150 tokens (below) so several projects fit in context. Open items and the latest five updates are always sent in full.'
        : 'Being condensed by the fast model; until then status answers use the full text. (Needs an API key.)'
  return (
    <Card title="What status answers use" description={state}>
      {project.context === 'condensed' && <pre className="rounded-lg bg-raised px-3 py-2 font-sans text-[12px] leading-relaxed whitespace-pre-wrap">{project.summary}</pre>}
    </Card>
  )
}

function Card({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-line bg-panel p-5">
      <h2 className="text-sm font-semibold">{title}</h2>
      {description && <p className="mt-1 text-xs text-muted">{description}</p>}
      <div className="mt-4 flex flex-col gap-3">{children}</div>
    </section>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs text-muted">{label}</span>
      {children}
    </label>
  )
}
