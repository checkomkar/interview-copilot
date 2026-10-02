import { useEffect, useReducer, useRef, useState } from 'react'
import { servedBy } from '@shared/ipc'
import type { OverlayNav, QaSnapshot, QuestionType, SessionState, SessionStatus, TranscriptUpdate } from '@shared/ipc'
import type { Settings } from '@shared/settings'
import { Markdown } from './Markdown'
import { AskBar } from './AskBar'

const DOT: Record<SessionStatus | 'thinking', { cls: string; label: string }> = {
  idle: { cls: 'bg-muted', label: 'Idle' },
  starting: { cls: 'bg-warn animate-pulse', label: 'Starting' },
  listening: { cls: 'bg-ok', label: 'Listening' },
  reconnecting: { cls: 'bg-warn animate-pulse', label: 'Reconnecting' },
  error: { cls: 'bg-bad', label: 'Error' },
  thinking: { cls: 'bg-accent animate-pulse', label: 'Thinking' }
}

const TYPE_LABEL: Record<QuestionType, string> = {
  behavioral: 'Behavioral',
  technical: 'Technical',
  coding: 'Coding',
  system_design: 'System design',
  situational: 'Situational',
  smalltalk: 'Small talk',
  other: 'Question'
}

interface QaState {
  qas: QaSnapshot[]
  /** Index being viewed; null follows the latest answer. */
  index: number | null
}

type QaAction =
  | { type: 'load'; qas: QaSnapshot[] }
  | { type: 'reset' }
  | { type: 'question'; qa: Pick<QaSnapshot, 'id' | 'question' | 'type' | 'style'> }
  | { type: 'token'; id: string; delta: string }
  | { type: 'done'; id: string; truncated: boolean; servedBy?: string }
  | { type: 'error'; id: string; message: string }
  | { type: 'nav'; dir: OverlayNav }

function patch(qas: QaSnapshot[], id: string, fn: (q: QaSnapshot) => QaSnapshot): QaSnapshot[] {
  const i = qas.findIndex((q) => q.id === id)
  if (i === -1) return qas
  const next = qas.slice()
  next[i] = fn(qas[i])
  return next
}

function reducer(state: QaState, a: QaAction): QaState {
  switch (a.type) {
    case 'load':
      return { qas: a.qas, index: null }
    case 'reset':
      return { qas: [], index: null }
    case 'question': {
      const fresh: QaSnapshot = { ...a.qa, answer: '', status: 'thinking' }
      const exists = state.qas.some((q) => q.id === a.qa.id)
      const qas = exists ? patch(state.qas, a.qa.id, () => fresh) : [...state.qas, fresh]
      // Jump to the answer that just (re)started.
      const i = qas.findIndex((q) => q.id === a.qa.id)
      return { qas, index: i === qas.length - 1 ? null : i }
    }
    case 'token':
      return { ...state, qas: patch(state.qas, a.id, (q) => ({ ...q, status: 'streaming', answer: q.answer + a.delta })) }
    case 'done':
      return { ...state, qas: patch(state.qas, a.id, (q) => ({ ...q, status: 'done', truncated: a.truncated, servedBy: a.servedBy })) }
    case 'error':
      return { ...state, qas: patch(state.qas, a.id, (q) => ({ ...q, status: 'error', error: a.message })) }
    case 'nav': {
      if (state.qas.length === 0) return state
      const last = state.qas.length - 1
      const cur = state.index ?? last
      const next = Math.min(last, Math.max(0, cur + (a.dir === 'prev' ? -1 : 1)))
      return { ...state, index: next === last ? null : next }
    }
  }
}

export function Overlay() {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [session, setSession] = useState<SessionState>({ status: 'idle', elapsed: 0, cost: 0 })
  const [lastHeard, setLastHeard] = useState<TranscriptUpdate | null>(null)
  const [micHeard, setMicHeard] = useState('')
  const [notice, setNotice] = useState<string | null>(null)
  const [{ qas, index }, dispatch] = useReducer(reducer, { qas: [], index: null })
  const scroller = useRef<HTMLElement>(null)
  /** List view: keep following new text while the user is at the bottom; stop once they scroll up to read. */
  const atBottom = useRef(true)

  useEffect(() => {
    const { api } = window
    void api.settings.get().then(setSettings)
    void api.session.getState().then(setSession)
    void api.answers.list().then((list) => dispatch({ type: 'load', qas: list }))
    const offs = [
      api.settings.onChanged(setSettings),
      api.session.onState(setSession),
      api.session.onTranscript((u) => {
        if (u.source === 'loopback') setLastHeard(u)
        // Live line for voice questions; cleared once the utterance is sent as a question.
        else setMicHeard(u.isFinal ? '' : u.text)
      }),
      api.answers.onReset(() => dispatch({ type: 'reset' })),
      api.answers.onQuestion((q) => {
        setNotice(null)
        dispatch({ type: 'question', qa: q })
      }),
      api.answers.onToken((t) => dispatch({ type: 'token', id: t.id, delta: t.delta })),
      api.answers.onDone((d) => dispatch({ type: 'done', id: d.id, truncated: d.truncated, servedBy: servedBy(d.usage) })),
      api.answers.onError((e) => dispatch({ type: 'error', id: e.id, message: e.message })),
      api.answers.onNav((dir) => dispatch({ type: 'nav', dir }))
    ]
    return () => offs.forEach((off) => off())
  }, [])

  const viewIndex = index ?? qas.length - 1
  const qa = qas[viewIndex] as QaSnapshot | undefined
  const view = settings?.overlay.view ?? 'single'
  const latest = qas.at(-1)

  // Single view: start each newly viewed answer at the top.
  useEffect(() => {
    if (view === 'single') scroller.current?.scrollTo({ top: 0 })
  }, [qa?.id, view])

  // List view, prev/next: bring that Q&A to the top.
  useEffect(() => {
    if (view !== 'list' || index === null) return
    scroller.current?.querySelector(`[data-qa="${index}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }, [index, view])

  // List view: a new (or regenerated) question jumps into view; streaming text is followed only from the bottom.
  useEffect(() => {
    if (view !== 'list' || index !== null || !latest) return
    scroller.current?.querySelector(`[data-qa="${qas.length - 1}"]`)?.scrollIntoView({ block: 'start' })
    atBottom.current = true
  }, [latest?.id, latest?.status === 'thinking', view])
  useEffect(() => {
    const el = scroller.current
    if (view !== 'list' || index !== null || !el || !atBottom.current) return
    el.scrollTo({ top: el.scrollHeight })
  }, [latest?.answer.length, view])

  const setView = (next: 'single' | 'list') => void window.api.settings.set({ overlay: { view: next } })

  const act = async (fn: () => Promise<{ ok: boolean; error?: string }>) => {
    const res = await fn()
    setNotice(res.ok ? null : (res.error ?? null))
  }

  const theme = settings?.overlay.theme ?? 'dark'
  const fontSize = settings?.overlay.fontSize ?? 15
  const busy = latest?.status === 'thinking' || latest?.status === 'streaming'
  const dot = DOT[busy ? 'thinking' : session.status]
  const autoAnswer = settings?.detection.autoAnswer ?? true

  return (
    <div data-theme={theme} className="ov flex h-screen flex-col overflow-hidden rounded-xl" style={{ fontSize }}>
      <header className="drag ov-line flex items-center gap-2 border-b px-3 py-1.5 text-xs">
        <span className={`size-2 rounded-full ${dot.cls}`} title={dot.label} />
        <span className="ov-muted font-medium">{dot.label}</span>

        {qas.length > 0 && (
          <div className="no-drag ml-2 flex items-center gap-0.5">
            <IconButton label="Previous answer (Ctrl+Shift+←)" disabled={viewIndex <= 0} onClick={() => dispatch({ type: 'nav', dir: 'prev' })}>
              ‹
            </IconButton>
            <span className="ov-muted min-w-9 text-center font-mono text-[11px] tabular-nums">
              {viewIndex + 1}/{qas.length}
            </span>
            <IconButton
              label="Next answer (Ctrl+Shift+→)"
              disabled={viewIndex >= qas.length - 1}
              onClick={() => dispatch({ type: 'nav', dir: 'next' })}
            >
              ›
            </IconButton>
            <IconButton
              label={view === 'list' ? 'Show one answer at a time' : 'Show all questions and answers'}
              onClick={() => setView(view === 'list' ? 'single' : 'list')}
              pressed={view === 'list'}
            >
              {view === 'list' ? '▭' : '☰'}
            </IconButton>
          </div>
        )}

        <div className="no-drag ml-auto flex items-center gap-0.5">
          <TextButton label="Answer the last thing heard now (Ctrl+Shift+Space)" onClick={() => void act(window.api.answers.now)}>
            Answer
          </TextButton>
          {qas.length > 0 && (
            <>
              <TextButton label="Regenerate (Ctrl+Shift+R)" onClick={() => void act(window.api.answers.regenerate)}>
                Retry
              </TextButton>
              <TextButton label="Shorter (Ctrl+Shift+D)" onClick={() => void act(window.api.answers.shorter)}>
                Shorter
              </TextButton>
            </>
          )}
          <IconButton label="Hide overlay (Ctrl+Shift+H)" onClick={() => void window.api.ui.toggleOverlay()}>
            ✕
          </IconButton>
        </div>
      </header>

      <main
        ref={scroller}
        className="min-h-0 flex-1 overflow-y-auto px-4 py-3"
        onScroll={(e) => {
          const el = e.currentTarget
          atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
        }}
      >
        {qa && view === 'list' ? (
          <ol className="flex flex-col">
            {qas.map((q, i) => (
              <li
                key={q.id}
                data-qa={i}
                className={`ov-line scroll-mt-2 border-b py-3 first:pt-0 last:border-b-0 ${index === i ? 'ov-focus' : ''}`}
              >
                <QaView qa={q} number={i + 1} full />
              </li>
            ))}
          </ol>
        ) : qa ? (
          <QaView qa={qa} />
        ) : lastHeard ? (
          <>
            <div className="ov-muted text-[0.75em] tracking-wide uppercase">Heard</div>
            <p className="ov-muted mt-1 line-clamp-3 leading-snug">{lastHeard.text}</p>
          </>
        ) : (
          <p className="ov-muted">
            {session.status === 'listening'
              ? 'Listening… answers will appear here.'
              : 'Start a session from the main window, or type / speak a question below.'}
          </p>
        )}
        {notice && <p className="mt-3 text-[0.85em] text-warn">{notice}</p>}
        {session.status === 'error' && session.message && <p className="mt-3 text-[0.9em] text-bad">{session.message}</p>}
      </main>

      <AskBar voiceOn={Boolean(session.voiceAsk)} heard={session.voiceAsk ? micHeard : ''} onError={setNotice} />

      <footer className="ov-line ov-muted flex items-center gap-3 border-t px-3 py-1 font-mono text-[11px] tabular-nums">
        <span className="min-w-0 flex-1 truncate">{session.hint ?? ''}</span>
        {!autoAnswer && <span title="Auto-answer is off (Ctrl+Shift+A)">auto off</span>}
        <span>${session.cost.toFixed(2)}</span>
      </footer>
    </div>
  )
}

/** `number` + `full` for the list view: numbered, and the whole question instead of two lines. */
function QaView({ qa, number, full }: { qa: QaSnapshot; number?: number; full?: boolean }) {
  return (
    <article>
      <div className="ov-muted flex items-baseline gap-2 text-[0.85em] leading-snug">
        {number !== undefined && <span className="shrink-0 font-mono text-[0.85em] tabular-nums">{number}.</span>}
        <span className="ov-tag shrink-0 rounded px-1.5 py-px text-[0.8em] font-medium tracking-wide uppercase">
          {TYPE_LABEL[qa.type]}
          {qa.style === 'shorter' ? ' · short' : ''}
        </span>
        <p className={full ? '' : 'line-clamp-2'} title={qa.question}>
          {qa.question}
        </p>
      </div>

      <div className="mt-2.5">
        {qa.status === 'thinking' ? (
          <p className="ov-muted animate-pulse">Thinking…</p>
        ) : (
          qa.answer && <Markdown text={qa.answer} />
        )}
        {qa.status === 'error' && <p className={`mt-2 text-[0.85em] ${qa.answer ? 'text-warn' : 'text-bad'}`}>{qa.error}</p>}
        {qa.status === 'done' && qa.truncated && (
          <p className="ov-muted mt-2 text-[0.8em]">— cut off at the token limit (raise Max tokens in Settings)</p>
        )}
        {qa.status === 'done' && qa.servedBy && <p className="ov-muted mt-2 text-right font-mono text-[10px] opacity-70">{qa.servedBy}</p>}
      </div>
    </article>
  )
}

function IconButton({
  label,
  disabled,
  pressed,
  onClick,
  children
}: {
  label: string
  disabled?: boolean
  pressed?: boolean
  onClick: () => void
  children: string
}) {
  return (
    <button
      className={`ov-btn rounded px-1.5 text-sm leading-5 disabled:opacity-30 ${pressed ? 'ov-fg ov-tag' : 'ov-muted'}`}
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      aria-pressed={pressed}
    >
      {children}
    </button>
  )
}

function TextButton({ label, onClick, children }: { label: string; onClick: () => void; children: string }) {
  return (
    <button className="ov-muted ov-btn rounded px-1.5 py-0.5 text-[11px]" onClick={onClick} title={label}>
      {children}
    </button>
  )
}

