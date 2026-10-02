import { useEffect, useState } from 'react'
import type { HistoryPracticeItem, HistoryQa, HistorySession, HistorySessionSummary } from '@shared/history'
import { Markdown } from '../../../shared/Markdown'

const TYPE_LABEL: Record<string, string> = {
  behavioral: 'Behavioral',
  technical: 'Technical',
  coding: 'Coding',
  system_design: 'System design',
  situational: 'Situational',
  smalltalk: 'Small talk',
  other: 'Question',
  status: 'Status',
  work: 'Work'
}

type Filter = 'all' | HistorySessionSummary['kind']
const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'work', label: 'Work' },
  { id: 'copilot', label: 'Interview' },
  { id: 'practice', label: 'Practice' }
]

const dateTime = (ts: number) => new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
const time = (ts: number) => new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })

function duration(ms: number): string {
  const min = Math.round(ms / 60_000)
  return min < 1 ? '< 1 min' : min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`
}

function errorMessage(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

/** Past sessions: transcript + Q&As, Markdown export, delete (U9, FR-D5 for history). */
export function HistoryTab() {
  const [sessions, setSessions] = useState<HistorySessionSummary[] | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [detail, setDetail] = useState<HistorySession | null>(null)
  const [notice, setNotice] = useState<{ text: string; bad?: boolean } | null>(null)
  const [filter, setFilter] = useState<Filter>('all')
  const shown = sessions?.filter((s) => filter === 'all' || s.kind === filter) ?? null

  const refresh = async () => {
    try {
      setSessions(await window.api.history.list())
    } catch (err) {
      setNotice({ text: errorMessage(err), bad: true })
    }
  }
  useEffect(() => {
    void refresh()
  }, [])

  useEffect(() => {
    setDetail(null)
    if (!selected) return
    let live = true
    void window.api.history.get(selected).then((s) => live && setDetail(s))
    return () => {
      live = false
    }
  }, [selected])

  const remove = async (id: string) => {
    if (!window.confirm('Delete this session? This cannot be undone.')) return
    setSessions(await window.api.history.delete(id))
    if (selected === id) setSelected(null)
  }

  const removeAll = async () => {
    const next = await window.api.history.deleteAll()
    setSessions(next)
    if (!next.some((s) => s.id === selected)) setSelected(null)
  }

  const exportMd = async (id: string) => {
    try {
      const res = await window.api.history.exportMarkdown(id)
      if (res.ok) setNotice({ text: `Exported to ${res.path}` })
      else if (!res.canceled) setNotice({ text: res.error ?? 'Export failed.', bad: true })
    } catch (err) {
      setNotice({ text: errorMessage(err), bad: true })
    }
  }

  return (
    <div className="flex h-full">
      <aside className="flex w-80 shrink-0 flex-col border-r border-line">
        <div className="flex items-center gap-2 border-b border-line px-4 py-3">
          <h1 className="flex-1 text-sm font-semibold">History</h1>
          <button onClick={() => void refresh()} className="rounded-md px-2 py-1 text-xs text-muted hover:bg-raised hover:text-fg">
            Refresh
          </button>
          {sessions && sessions.length > 0 && (
            <button onClick={() => void removeAll()} className="rounded-md px-2 py-1 text-xs text-muted hover:bg-bad/15 hover:text-bad">
              Delete all
            </button>
          )}
        </div>
        <div className="flex gap-1 border-b border-line px-3 py-2" role="tablist" aria-label="Filter by mode">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              role="tab"
              aria-selected={filter === f.id}
              onClick={() => setFilter(f.id)}
              className={`rounded-md px-2 py-0.5 text-xs ${filter === f.id ? 'bg-raised text-fg' : 'text-muted hover:text-fg'}`}
            >
              {f.label}
            </button>
          ))}
        </div>
        <ul className="min-h-0 flex-1 overflow-y-auto p-2">
          {shown === null ? (
            <li className="p-3 text-sm text-muted">Loading…</li>
          ) : shown.length === 0 ? (
            <li className="p-3 text-sm text-muted">
              {sessions?.length ? 'No sessions of this kind.' : "No sessions yet. Each session's transcript, questions and answers are saved here."}
            </li>
          ) : (
            shown.map((s) => (
              <li key={s.id}>
                <button
                  onClick={() => setSelected(s.id)}
                  className={`flex w-full flex-col gap-0.5 rounded-md px-3 py-2 text-left ${selected === s.id ? 'bg-raised' : 'hover:bg-raised/60'}`}
                >
                  <span className="flex items-center gap-2 text-sm">
                    {s.kind === 'practice' && (
                      <span className="shrink-0 rounded bg-me/15 px-1.5 py-px text-[10px] font-medium tracking-wide text-me uppercase">Practice</span>
                    )}
                    {s.kind === 'work' && (
                      <span className="shrink-0 rounded bg-ok/15 px-1.5 py-px text-[10px] font-medium tracking-wide text-ok uppercase">Work</span>
                    )}
                    <span className="truncate">{s.title}</span>
                    {s.averageScore !== null && <span className="ml-auto shrink-0 font-mono text-xs text-muted tabular-nums">{s.averageScore}/10</span>}
                  </span>
                  <span className="font-mono text-[11px] text-muted tabular-nums">
                    {dateTime(s.startedAt)}
                    {s.endedAt ? ` · ${duration(s.endedAt - s.startedAt)}` : ' · in progress'} · {s.questionCount} Q · ${s.costUsd.toFixed(2)}
                  </span>
                </button>
              </li>
            ))
          )}
        </ul>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        {notice && (
          <div className={`flex items-center gap-3 border-b px-6 py-2 text-sm ${notice.bad ? 'border-bad/30 bg-bad/10 text-bad' : 'border-line bg-raised text-muted'}`}>
            <span className="min-w-0 flex-1 truncate">{notice.text}</span>
            <button onClick={() => setNotice(null)} aria-label="Dismiss" className="opacity-70 hover:opacity-100">
              ✕
            </button>
          </div>
        )}
        {!selected ? (
          <p className="p-8 text-sm text-muted">Pick a session to review its questions, answers and transcript.</p>
        ) : !detail ? (
          <p className="p-8 text-sm text-muted">Loading…</p>
        ) : (
          <SessionDetail session={detail} onExport={() => void exportMd(detail.id)} onDelete={() => void remove(detail.id)} />
        )}
      </section>
    </div>
  )
}

function SessionDetail({ session: s, onExport, onDelete }: { session: HistorySession; onExport: () => void; onDelete: () => void }) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <header className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-line px-6 py-4">
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold">
            {s.kind === 'practice' ? `${s.title} · ` : ''}
            {dateTime(s.startedAt)}
          </h2>
          <p className="font-mono text-[11px] text-muted tabular-nums">
            {s.endedAt ? duration(s.endedAt - s.startedAt) : 'in progress'} · {s.questionCount} question{s.questionCount === 1 ? '' : 's'}
            {s.averageScore !== null ? ` · average ${s.averageScore}/10` : ''} · ${s.costUsd.toFixed(2)} · {Math.round(s.sttSeconds / 60)} min audio
          </p>
        </div>
        <button onClick={onExport} className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-bg hover:bg-accent/90">
          Export Markdown
        </button>
        <button onClick={onDelete} className="rounded-md border border-line px-3 py-1.5 text-sm text-muted hover:border-bad/50 hover:text-bad">
          Delete
        </button>
      </header>

      {s.kind === 'practice' ? (
        <PracticeDetail session={s} />
      ) : (
      <div className="mx-auto flex max-w-3xl flex-col gap-8 px-6 py-6">
        {s.qas.length > 0 && (
          <section>
            <h3 className="mb-3 text-xs font-medium tracking-wide text-muted uppercase">Questions and answers</h3>
            <ol className="flex flex-col gap-4">
              {s.qas.map((q, i) => (
                <QaCard key={q.id} qa={q} number={i + 1} />
              ))}
            </ol>
          </section>
        )}
        <section>
          <h3 className="mb-3 text-xs font-medium tracking-wide text-muted uppercase">Transcript</h3>
          {s.utterances.length === 0 ? (
            <p className="text-sm text-muted">No transcript (questions were typed or asked outside a listening session).</p>
          ) : (
            <ul className="flex flex-col gap-1.5 text-sm">
              {s.utterances.map((u, i) => (
                <li key={i} className="grid grid-cols-[72px_88px_1fr] gap-2">
                  <span className="font-mono text-[11px] leading-5 text-muted tabular-nums">{time(u.ts)}</span>
                  <span className={`text-xs leading-5 font-medium ${u.source === 'loopback' ? 'text-them' : 'text-me'}`}>
                    {u.source === 'mic' ? 'Me' : s.kind === 'work' ? 'Call' : 'Interviewer'}
                  </span>
                  <span className="leading-5">{u.text}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
      )}
    </div>
  )
}

/** A practice run: the debrief, then each question with the answer and its feedback (FR-P4). */
function PracticeDetail({ session: s }: { session: HistorySession }) {
  return (
    <div className="md-theme-dark mx-auto flex max-w-3xl flex-col gap-6 px-6 py-6">
      {s.summary && (
        <section className="rounded-xl border border-line bg-panel p-4 text-sm">
          <h3 className="mb-2 text-xs font-medium tracking-wide text-muted uppercase">Debrief</h3>
          <Markdown text={s.summary} />
        </section>
      )}
      <ol className="flex flex-col gap-4">
        {s.practice.map((p, i) => (
          <PracticeCard key={p.index} item={p} number={i + 1} />
        ))}
      </ol>
    </div>
  )
}

function PracticeCard({ item: p, number }: { item: HistoryPracticeItem; number: number }) {
  const tone = p.score === null ? 'text-muted' : p.score >= 7 ? 'text-ok' : p.score >= 5 ? 'text-warn' : 'text-bad'
  return (
    <li className="rounded-xl border border-line bg-panel p-4 text-sm">
      <div className="flex items-start gap-2">
        <span className="font-mono text-xs leading-5 text-muted tabular-nums">{number}.</span>
        <div className="min-w-0 flex-1">
          <p className="font-medium">{p.question}</p>
          <p className="mt-0.5 text-[11px] text-muted">{[TYPE_LABEL[p.type] ?? p.type, p.servedBy].filter(Boolean).join(' · ')}</p>
        </div>
        <span className={`font-mono text-sm tabular-nums ${tone}`}>{p.score !== null ? `${p.score}/10` : p.status === 'skipped' ? 'skipped' : '—'}</span>
      </div>
      {p.answer && (
        <div className="mt-3">
          <h4 className="text-[11px] font-medium tracking-wide text-muted uppercase">My answer</h4>
          <p className="mt-1 leading-relaxed whitespace-pre-wrap">{p.answer}</p>
        </div>
      )}
      {(p.strengths.length > 0 || p.gaps.length > 0) && (
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {p.strengths.length > 0 && (
            <div>
              <h4 className="text-[11px] font-medium tracking-wide text-ok uppercase">Strengths</h4>
              <ul className="mt-1 list-disc pl-4 leading-relaxed">{p.strengths.map((x, i) => <li key={i}>{x}</li>)}</ul>
            </div>
          )}
          {p.gaps.length > 0 && (
            <div>
              <h4 className="text-[11px] font-medium tracking-wide text-warn uppercase">To improve</h4>
              <ul className="mt-1 list-disc pl-4 leading-relaxed">{p.gaps.map((x, i) => <li key={i}>{x}</li>)}</ul>
            </div>
          )}
        </div>
      )}
      {p.improvedAnswer && (
        <div className="mt-3">
          <h4 className="text-[11px] font-medium tracking-wide text-muted uppercase">A stronger answer</h4>
          <div className="mt-1">
            <Markdown text={p.improvedAnswer} />
          </div>
        </div>
      )}
    </li>
  )
}

function QaCard({ qa, number }: { qa: HistoryQa; number: number }) {
  return (
    <li className="md-theme-dark rounded-xl border border-line bg-panel p-4">
      <div className="flex items-start gap-2 text-sm">
        <span className="font-mono text-xs leading-5 text-muted tabular-nums">{number}.</span>
        <div className="min-w-0 flex-1">
          <p className="font-medium">{qa.question}</p>
          <p className="mt-0.5 text-[11px] text-muted">
            {[TYPE_LABEL[qa.type] ?? qa.type, qa.project, qa.screenshotCount === 0 ? null : qa.screenshotCount === 1 ? 'with screenshot' : `with ${qa.screenshotCount} screenshots`, qa.servedBy, time(qa.ts)].filter(Boolean).join(' · ')}
          </p>
        </div>
      </div>
      {qa.screenshots.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {qa.screenshots.map((src, i) => (
            <img key={i} src={src} alt={`Screenshot ${i + 1} sent with this question`} className="max-h-64 max-w-full rounded-md border border-line" />
          ))}
        </div>
      )}
      <div className="mt-3 text-sm">{qa.answer ? <Markdown text={qa.answer} /> : <p className="text-muted">(no answer)</p>}</div>
      {qa.status === 'error' && qa.error && <p className={`mt-2 text-xs ${qa.answer ? 'text-warn' : 'text-bad'}`}>{qa.error}</p>}
    </li>
  )
}
