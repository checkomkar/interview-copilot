import { useEffect, useRef, useState, type ReactNode } from 'react'
import { LLM_PROVIDER_LABELS } from '@shared/settings'
import {
  ITEM_KINDS,
  ITEM_KIND_LABELS,
  TASK_STATUSES,
  TASK_STATUS_LABELS,
  type ItemKind,
  type Project,
  type Proposal,
  type ProposalChanges,
  type SkippedMessage,
  type Task,
  type TaskStatus
} from '@shared/work'
import { useApp } from '../store'
import { isMac, keys } from '../../../shared/keys'
import { TeamsSyncCard } from './TeamsSyncCard'

const inputCls = 'w-full rounded-md border border-line bg-raised px-3 py-1.5 text-sm outline-none focus:border-accent'
const small = 'w-full rounded-md border border-line bg-raised px-2 py-1 text-[13px] outline-none focus:border-accent'

const CHANGE_LABELS: Record<keyof ProposalChanges, string> = {
  status: 'Status',
  owner: 'Owner',
  waitingOn: 'Waiting on',
  environment: 'Environment',
  due: 'Due',
  followedUp: 'Last follow-up',
  followUpNote: 'Follow-up note',
  blockers: 'Blockers',
  ref: 'Reference'
}

function errorMessage(err: unknown): string {
  return (err instanceof Error ? err.message : String(err))
    .replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
    .replace(/^Invalid input: [\w.]+: /, '')
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(r.error ?? new Error('Could not read the image.'))
    r.readAsDataURL(file)
  })
}

const when = (ts: number) => new Date(ts).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })

/** FR-T1/T2/T4: paste Teams messages or screenshots, then review what Cue proposes to change. */
export function ImportUpdates({ projects, proposals }: { projects: Project[]; proposals: Proposal[] }) {
  const settings = useApp((s) => s.settings)
  const [text, setText] = useState('')
  const [images, setImages] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ found: number; skipped: SkippedMessage[] } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showSkipped, setShowSkipped] = useState(false)
  const file = useRef<HTMLInputElement>(null)

  const addFiles = async (files: Iterable<File>) => {
    const list = [...files].filter((f) => f.type.startsWith('image/'))
    if (!list.length) return
    const urls = await Promise.all(list.map(readAsDataUrl))
    setImages((cur) => [...cur, ...urls].slice(0, 8))
  }

  const run = async () => {
    if (busy || (!text.trim() && images.length === 0)) return
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const res = await window.api.work.importUpdates(images.length ? { images } : { text })
      if (!res.ok) setError(res.error)
      else {
        setResult({ found: res.proposals.length, skipped: res.skipped })
        setText('')
        setImages([])
      }
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const acceptAll = async () => {
    for (const p of proposals) {
      try {
        await window.api.work.decide({ id: p.id, action: 'accept' })
      } catch (err) {
        setError(errorMessage(err))
        return
      }
    }
  }

  const provider = settings ? LLM_PROVIDER_LABELS[settings.llm.provider] : 'your answer provider'
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 px-8 py-8">
      <TeamsSyncCard />
      <section className="rounded-xl border border-line bg-panel p-5">
        <h2 className="text-sm font-semibold">Paste or screenshot Teams messages</h2>
        <p className="mt-1 text-xs leading-relaxed text-muted">
          {keys(
            `Copy messages from a Teams group or private chat (select them, Ctrl+C) and paste them here — or paste screenshots of the chat (${isMac ? '⌃⌘⇧4' : 'Win+Shift+S'}, then Ctrl+V here), several if you scrolled. Cue suggests what changed on your projects and items; nothing changes until you accept it.`
          )}
        </p>
        <div className="mt-4 flex flex-col gap-3">
          <textarea
            className={`${inputCls} resize-y font-mono text-[12px] leading-relaxed`}
            rows={8}
            value={text}
            disabled={images.length > 0}
            onChange={(e) => setText(e.target.value)}
            onPaste={(e) => {
              const files = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'))
              if (files.length) {
                e.preventDefault()
                void addFiles(files)
              }
            }}
            onDrop={(e) => {
              if (e.dataTransfer.files.length) {
                e.preventDefault()
                void addFiles(e.dataTransfer.files)
              }
            }}
            placeholder={images.length ? 'Screenshots attached — remove them to paste text instead.' : 'Ravi Kumar  10:42 AM\nPicked up the Android 14 login crash, fix should be in review by EOD\n…'}
            aria-label="Teams messages"
          />
          {images.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              {images.map((src, i) => (
                <div key={i} className="relative">
                  <img src={src} alt={`Chat screenshot ${i + 1}`} className="h-20 rounded border border-line object-cover" />
                  <button
                    onClick={() => setImages(images.filter((_, j) => j !== i))}
                    className="absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full bg-black/70 text-[10px] text-white hover:bg-bad"
                    aria-label={`Remove screenshot ${i + 1}`}
                  >
                    ✕
                  </button>
                </div>
              ))}
              <span className="text-xs text-muted">{images.length} of 8 · read in order</span>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <button
              onClick={() => void run()}
              disabled={busy || (!text.trim() && images.length === 0)}
              className="rounded-lg bg-accent px-5 py-2 text-sm font-semibold text-bg disabled:opacity-40"
            >
              {busy ? 'Reading messages…' : 'Find updates'}
            </button>
            <button onClick={() => file.current?.click()} className="rounded-md border border-line px-3 py-1.5 text-sm text-muted hover:text-fg">
              Add screenshot files…
            </button>
            <input
              ref={file}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              multiple
              hidden
              onChange={(e) => {
                if (e.target.files) void addFiles(e.target.files)
                e.target.value = ''
              }}
            />
          </div>
          <p className="text-[11px] leading-relaxed text-muted">
            Messages are sent to {provider} to read them. Free tiers may log or train on what they're sent — use a paid provider for company chats, and
            check what your company allows.
          </p>
          {error && <p className="text-sm text-bad">{error}</p>}
          {result && (
            <p className="text-sm text-ok">
              {result.found === 0 ? 'No new updates found.' : `Found ${result.found} update${result.found === 1 ? '' : 's'} to review below.`}
              {result.skipped.length > 0 && (
                <button onClick={() => setShowSkipped(!showSkipped)} className="ml-2 text-xs text-muted underline">
                  {result.skipped.length} message{result.skipped.length === 1 ? '' : 's'} skipped
                </button>
              )}
            </p>
          )}
          {result && showSkipped && (
            <ul className="flex flex-col gap-1 rounded-lg border border-line px-3 py-2 text-xs text-muted">
              {result.skipped.map((m, i) => (
                <li key={i}>
                  <span className="text-fg">{m.author || 'Someone'}</span>: “{m.quote}” — {m.reason}
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <h2 className="text-sm font-semibold">To review</h2>
          <span className="font-mono text-xs text-muted tabular-nums">{proposals.length}</span>
          {proposals.length > 1 && (
            <button onClick={() => void acceptAll()} className="ml-auto rounded-md border border-line px-3 py-1 text-xs hover:bg-raised">
              Accept all
            </button>
          )}
        </div>
        {proposals.length === 0 ? (
          <p className="text-sm text-muted">Nothing waiting. Suggestions from imported or synced Teams messages appear here.</p>
        ) : (
          proposals.map((p) => <ProposalCard key={p.id} proposal={p} projects={projects} onError={setError} />)
        )}
      </section>
    </div>
  )
}

function ProposalCard({ proposal: p, projects, onError }: { proposal: Proposal; projects: Project[]; onError: (m: string) => void }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(p)
  useEffect(() => setDraft(p), [p])
  const project = projects.find((x) => x.id === draft.projectId)
  const task = project?.tasks.find((t) => t.id === draft.taskId)

  const decide = async (action: 'accept' | 'skip') => {
    try {
      await window.api.work.decide({
        id: p.id,
        action,
        ...(action === 'accept' && editing
          ? { edits: { projectId: draft.projectId, taskId: draft.taskId, newItem: draft.newItem, changes: draft.changes, update: draft.update } }
          : {})
      })
    } catch (err) {
      onError(errorMessage(err))
    }
  }

  const target = task
    ? `${ITEM_KIND_LABELS[task.kind]} · ${task.title}`
    : draft.newItem
      ? `New ${ITEM_KIND_LABELS[draft.newItem.kind].toLowerCase()}: ${draft.newItem.title}`
      : 'The whole project'
  // Already true of the item (accepted from another message meanwhile): not worth showing.
  const changed = (Object.keys(p.changes) as (keyof ProposalChanges)[]).filter((k) => !task || String(task[k]) !== String(p.changes[k]))
  const setChange = <K extends keyof ProposalChanges>(key: K, value: ProposalChanges[K] | undefined) => {
    const changes = { ...draft.changes }
    if (value === undefined || value === '') delete changes[key]
    else changes[key] = value
    setDraft({ ...draft, changes })
  }

  return (
    <article className="rounded-xl border border-line bg-panel p-4">
      <header className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
        <span className="font-semibold">{project?.name ?? 'Unknown project'}</span>
        <span className="text-muted">›</span>
        <span className={draft.newItem && !task ? 'text-accent' : ''}>{target}</span>
        <span className="ml-auto text-xs text-muted">
          {p.author || 'Someone'}
          {p.ts ? ` · ${when(p.ts)}` : ''}
          {p.source === 'teams' ? ' · Teams sync' : ''}
        </span>
      </header>
      {p.quote && <blockquote className="mt-2 border-l-2 border-line pl-3 text-[13px] text-muted italic">{p.quote}</blockquote>}

      {editing ? (
        <div className="mt-3 flex flex-col gap-2">
          <div className="grid grid-cols-[repeat(2,minmax(0,1fr))] gap-2">
            <Labeled label="Project">
              <select className={small} value={draft.projectId} onChange={(e) => setDraft({ ...draft, projectId: e.target.value, taskId: null })}>
                {projects.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
              </select>
            </Labeled>
            <Labeled label="About">
              <select
                className={small}
                value={draft.taskId ?? (draft.newItem ? '__new' : '')}
                onChange={(e) => {
                  const v = e.target.value
                  if (v === '__new') setDraft({ ...draft, taskId: null, newItem: draft.newItem ?? p.newItem ?? { kind: 'task', title: '' } })
                  else setDraft({ ...draft, taskId: v || null, newItem: null })
                }}
              >
                <option value="">The whole project</option>
                <option value="__new">A new item…</option>
                {project?.tasks.map((t) => (
                  <option key={t.id} value={t.id}>
                    {ITEM_KIND_LABELS[t.kind]}: {t.title}
                  </option>
                ))}
              </select>
            </Labeled>
            {draft.newItem && !draft.taskId && (
              <>
                <Labeled label="New item kind">
                  <select className={small} value={draft.newItem.kind} onChange={(e) => setDraft({ ...draft, newItem: { ...draft.newItem!, kind: e.target.value as ItemKind } })}>
                    {ITEM_KINDS.map((k) => (
                      <option key={k} value={k}>
                        {ITEM_KIND_LABELS[k]}
                      </option>
                    ))}
                  </select>
                </Labeled>
                <Labeled label="New item title">
                  <input className={small} value={draft.newItem.title} onChange={(e) => setDraft({ ...draft, newItem: { ...draft.newItem!, title: e.target.value } })} />
                </Labeled>
              </>
            )}
            <Labeled label="Status">
              <select className={small} value={draft.changes.status ?? ''} onChange={(e) => setChange('status', (e.target.value || undefined) as TaskStatus | undefined)}>
                <option value="">Unchanged</option>
                {TASK_STATUSES.map((st) => (
                  <option key={st} value={st}>
                    {TASK_STATUS_LABELS[st]}
                  </option>
                ))}
              </select>
            </Labeled>
            <Labeled label="Owner">
              <input className={small} value={draft.changes.owner ?? ''} onChange={(e) => setChange('owner', e.target.value)} placeholder="Unchanged" />
            </Labeled>
            <Labeled label="Waiting on">
              <input className={small} value={draft.changes.waitingOn ?? ''} onChange={(e) => setChange('waitingOn', e.target.value)} placeholder="Unchanged" />
            </Labeled>
            <Labeled label="Blockers">
              <input className={small} value={draft.changes.blockers ?? ''} onChange={(e) => setChange('blockers', e.target.value)} placeholder="Unchanged" />
            </Labeled>
          </div>
          <Labeled label="Update to log">
            <textarea className={`${small} resize-y`} rows={2} value={draft.update} onChange={(e) => setDraft({ ...draft, update: e.target.value })} />
          </Labeled>
        </div>
      ) : (
        <div className="mt-3 flex flex-col gap-2">
          {changed.length > 0 && (
            <ul className="flex flex-wrap gap-1.5">
              {changed.map((k) => (
                <li key={k} className="rounded-md bg-raised px-2 py-0.5 text-xs">
                  <span className="text-muted">{CHANGE_LABELS[k]}:</span> {changeText(k, task)} → <span className="text-fg">{display(k, p.changes[k])}</span>
                </li>
              ))}
            </ul>
          )}
          {p.update && <p className="text-sm">{p.update}</p>}
        </div>
      )}

      <footer className="mt-3 flex items-center gap-2">
        <button onClick={() => void decide('accept')} className="rounded-md bg-accent px-3 py-1 text-xs font-semibold text-bg">
          {editing ? 'Save and accept' : draft.newItem && !task ? 'Create item and accept' : 'Accept'}
        </button>
        <button onClick={() => setEditing(!editing)} className="rounded-md border border-line px-3 py-1 text-xs hover:bg-raised">
          {editing ? 'Cancel edit' : 'Edit'}
        </button>
        <button onClick={() => void decide('skip')} className="ml-auto rounded-md px-3 py-1 text-xs text-muted hover:bg-raised hover:text-fg">
          Skip
        </button>
      </footer>
    </article>
  )
}

/** The item's current value of a field, for "old → new". */
function changeText(key: keyof ProposalChanges, task: Task | undefined): string {
  const v = task ? task[key] : ''
  return v ? display(key, v) : '—'
}

function display(key: keyof ProposalChanges, v: unknown): string {
  return key === 'status' ? TASK_STATUS_LABELS[v as TaskStatus] : String(v)
}

function Labeled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] text-muted">{label}</span>
      {children}
    </label>
  )
}
