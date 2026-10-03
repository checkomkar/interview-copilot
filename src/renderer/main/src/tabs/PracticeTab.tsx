import { useEffect, useRef, useState } from 'react'
import {
  IDLE_PRACTICE,
  PRACTICE_COUNTS,
  PRACTICE_ROUND_LABELS,
  PRACTICE_ROUNDS,
  type PracticeItem,
  type PracticeResult,
  type PracticeRound,
  type PracticeState
} from '@shared/practice'
import { STT_PROVIDER_LABELS, type Settings } from '@shared/settings'
import { Markdown } from '../../../shared/Markdown'
import { useApp } from '../store'
import { keys } from '../../../shared/keys'
import { LevelMeter } from '../components/LevelMeter'

const ROUND_HINT: Record<PracticeRound, string> = {
  behavioral: 'Past experience — STAR answers',
  technical: 'Concepts and trade-offs, out loud',
  system_design: 'Design a system in a few minutes',
  mixed: 'A realistic mix of all of them'
}

const TYPE_LABEL: Record<string, string> = {
  behavioral: 'Behavioral',
  technical: 'Technical',
  system_design: 'System design',
  situational: 'Situational'
}

function errorMessage(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

/** Practice Mode (FR-P1..P4): the AI interviewer reads questions aloud and scores your answers. */
export function PracticeTab() {
  const settings = useApp((s) => s.settings)
  const [state, setState] = useState<PracticeState>(IDLE_PRACTICE)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void window.api.practice.getState().then(setState)
    let lastError: string | undefined
    return window.api.practice.onState((s) => {
      setState(s)
      // Mid-run problems (mic or speech service failed) show once as a notice.
      if (s.status === 'running' && s.error && s.error !== lastError) setNotice(s.error)
      lastError = s.error
    })
  }, [])

  /** Run a practice action; failures show as a notice. */
  const act = async (fn: () => Promise<PracticeResult | void>) => {
    setBusy(true)
    setNotice(null)
    try {
      const res = await fn()
      if (res && !res.ok) setNotice(res.error)
    } catch (err) {
      setNotice(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  if (!settings) return <div className="p-8 text-sm text-muted">Loading…</div>

  return (
    <div className="flex h-full flex-col">
      {notice && (
        <div className="flex items-center gap-3 border-b border-warn/30 bg-warn/10 px-6 py-2 text-sm text-warn">
          <span className="flex-1">{notice}</span>
          <button onClick={() => setNotice(null)} aria-label="Dismiss" className="opacity-70 hover:opacity-100">
            ✕
          </button>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {state.status === 'idle' || state.status === 'error' ? (
          <StartScreen settings={settings} error={state.error} busy={busy} act={act} />
        ) : state.status === 'generating' ? (
          <Waiting text="Writing questions from your resume and the job description…" onCancel={() => void act(() => window.api.practice.finish())} />
        ) : state.status === 'running' ? (
          <RunScreen state={state} settings={settings} busy={busy} act={act} />
        ) : state.status === 'summarizing' ? (
          <Waiting text="Writing your debrief…" />
        ) : (
          <DoneScreen state={state} act={act} />
        )}
      </div>
    </div>
  )
}

type Act = (fn: () => Promise<PracticeResult | void>) => Promise<void>

function StartScreen({ settings, error, busy, act }: { settings: Settings; error?: string; busy: boolean; act: Act }) {
  const update = useApp((s) => s.updateSettings)
  const keys = useApp((s) => s.keys)
  const p = settings.practice
  const [round, setRound] = useState<PracticeRound>(p.round)
  const [count, setCount] = useState<5 | 10 | 15>(p.count)
  const voices = useVoices()
  const sttKey = keys?.[settings.stt.provider] ?? false

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 px-8 py-8">
      <div>
        <h1 className="text-xl font-semibold">Practice</h1>
        <p className="mt-1 text-sm text-muted">
          A mock interview: questions written from your resume and job description are read aloud, you answer out loud (or type), and each answer gets a
          score, feedback and a stronger version. The run is saved to History.
        </p>
      </div>

      {error && <p className="rounded-lg border border-bad/30 bg-bad/10 px-4 py-2.5 text-sm text-bad">{error}</p>}

      <section className="flex flex-col gap-2">
        <h2 className="text-xs font-medium tracking-wide text-muted uppercase">Round</h2>
        <div className="grid grid-cols-2 gap-2">
          {PRACTICE_ROUNDS.map((r) => (
            <button
              key={r}
              onClick={() => setRound(r)}
              className={`rounded-lg border px-4 py-3 text-left transition-colors ${round === r ? 'border-accent bg-accent/10' : 'border-line hover:bg-raised'}`}
            >
              <span className="block text-sm font-medium">{PRACTICE_ROUND_LABELS[r]}</span>
              <span className="block text-xs text-muted">{ROUND_HINT[r]}</span>
            </button>
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-xs font-medium tracking-wide text-muted uppercase">Questions</h2>
        <div className="flex gap-2">
          {PRACTICE_COUNTS.map((c) => (
            <button
              key={c}
              onClick={() => setCount(c)}
              className={`w-16 rounded-lg border py-2 text-sm ${count === c ? 'border-accent bg-accent/10' : 'border-line hover:bg-raised'}`}
            >
              {c}
            </button>
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-3 rounded-xl border border-line bg-panel p-4 text-sm">
        <label className="flex cursor-pointer items-center gap-2 select-none">
          <input type="checkbox" className="size-4 accent-accent" checked={p.speak} onChange={(e) => void update({ practice: { speak: e.target.checked } })} />
          Read questions aloud
        </label>
        <div className={`grid grid-cols-[110px_1fr] items-center gap-3 ${p.speak ? '' : 'opacity-50'}`}>
          <span className="text-muted">Voice</span>
          <select
            className="rounded-md border border-line bg-raised px-2.5 py-1.5"
            disabled={!p.speak}
            value={p.voice ?? ''}
            onChange={(e) => void update({ practice: { voice: e.target.value || null } })}
          >
            <option value="">System default</option>
            {voices.map((v) => (
              <option key={v.name} value={v.name}>
                {v.name}
              </option>
            ))}
          </select>
          <span className="text-muted">Speed</span>
          <div className="flex items-center gap-3">
            <input
              type="range"
              min={0.7}
              max={1.5}
              step={0.1}
              disabled={!p.speak}
              value={p.rate}
              onChange={(e) => void update({ practice: { rate: Number(e.target.value) } })}
              className="flex-1 accent-accent"
            />
            <span className="w-10 font-mono text-xs tabular-nums">{p.rate.toFixed(1)}×</span>
          </div>
        </div>
        <label className="flex cursor-pointer items-center gap-2 select-none">
          <input
            type="checkbox"
            className="size-4 accent-accent"
            checked={p.autoRecord}
            onChange={(e) => void update({ practice: { autoRecord: e.target.checked } })}
          />
          Start recording when the question has been read
        </label>
        {!sttKey && (
          <p className="text-xs text-warn">
            Add a {STT_PROVIDER_LABELS[settings.stt.provider]} API key in Settings to answer out loud — until then you can type your answers.
          </p>
        )}
      </section>

      <div className="flex items-center gap-3">
        <button
          disabled={busy}
          onClick={() => void act(() => window.api.practice.start({ round, count }))}
          className="rounded-lg bg-accent px-5 py-2 text-sm font-semibold text-bg hover:bg-accent/90 disabled:opacity-50"
        >
          Start practice
        </button>
        <span className="text-xs text-muted">Uses your microphone and the answer models in Settings.</span>
      </div>
    </div>
  )
}

function Waiting({ text, onCancel }: { text: string; onCancel?: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-sm text-muted">
      <span className="size-6 animate-spin rounded-full border-2 border-line border-t-accent" />
      <p>{text}</p>
      {onCancel && (
        <button onClick={onCancel} className="rounded-md border border-line px-3 py-1.5 text-xs hover:text-fg">
          Cancel
        </button>
      )}
    </div>
  )
}

function RunScreen({ state, settings, busy, act }: { state: PracticeState; settings: Settings; busy: boolean; act: Act }) {
  const item = state.items[state.current]
  const total = state.items.length
  const isLast = state.current === total - 1
  const [typing, setTyping] = useState(false)
  const [draft, setDraft] = useState('')
  const speech = useSpeech(settings)
  const micLevel = useApp((s) => s.levels.mic)
  const api = window.api.practice

  // Read each question aloud once, then start recording (if set).
  const spokenKey = useRef<string | null>(null)
  useEffect(() => {
    const key = `${state.sessionId}:${state.current}`
    if (item?.status !== 'asking' || spokenKey.current === key) return
    spokenKey.current = key
    setTyping(false)
    setDraft('')
    if (!settings.practice.speak) return
    speech.speak(item.question, () => {
      if (settings.practice.autoRecord) void act(() => api.record())
    })
  }, [state.current, item?.status, state.sessionId])
  // Stop reading when leaving the run.
  const { cancel } = speech
  useEffect(() => cancel, [cancel])

  if (!item) return null
  const record = () => {
    speech.cancel()
    void act(() => api.record())
  }
  const submitTyped = () => {
    speech.cancel()
    void act(() => api.submit(draft)).then(() => setTyping(false))
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-5 px-8 py-8">
      <header className="flex items-center gap-4">
        <div className="flex-1">
          <p className="text-xs tracking-wide text-muted uppercase">
            {PRACTICE_ROUND_LABELS[state.round]} · question {state.current + 1} of {total}
          </p>
          <Progress items={state.items} current={state.current} />
        </div>
        <button
          disabled={busy && item.status === 'reviewing'}
          onClick={() => {
            speech.cancel()
            void act(() => api.finish())
          }}
          className="rounded-md border border-line px-3 py-1.5 text-sm text-muted hover:text-fg"
        >
          End practice
        </button>
      </header>

      <section className="rounded-xl border border-line bg-panel p-5">
        <p className="mb-2 text-[11px] font-medium tracking-wide text-accent uppercase">{TYPE_LABEL[item.type] ?? item.type}</p>
        <p className="text-lg leading-relaxed">{item.question}</p>
        <div className="mt-3 flex gap-3 text-xs text-muted">
          <button onClick={() => speech.speak(item.question)} className="hover:text-fg">
            {speech.speaking ? '🔊 Reading…' : '🔊 Read again'}
          </button>
          {speech.speaking && (
            <button onClick={speech.cancel} className="hover:text-fg">
              Stop reading
            </button>
          )}
        </div>
      </section>

      {item.status === 'asking' && !typing && (
        <div className="flex flex-wrap items-center gap-3">
          <button onClick={record} disabled={busy} className="rounded-lg bg-accent px-5 py-2 text-sm font-semibold text-bg hover:bg-accent/90 disabled:opacity-50">
            🎙 Answer out loud
          </button>
          <button onClick={() => setTyping(true)} className="rounded-lg border border-line px-4 py-2 text-sm text-muted hover:text-fg">
            Type instead
          </button>
          <button onClick={() => void act(() => api.skip())} disabled={busy} className="ml-auto text-sm text-muted hover:text-fg">
            Skip question
          </button>
        </div>
      )}

      {item.status === 'recording' && !typing && (
        <section className="flex flex-col gap-3 rounded-xl border border-bad/30 bg-bad/5 p-4">
          <p className="flex items-center gap-2 text-sm font-medium text-bad">
            <span className="size-2.5 animate-pulse rounded-full bg-bad" /> Recording — answer as you would in the interview
          </p>
          <LevelMeter label="Mic" level={micLevel} active color="var(--color-me)" />
          <p className="min-h-12 text-sm leading-relaxed">
            {item.answer}
            {state.live && <span className="text-fg/60"> {state.live}</span>}
            {!item.answer && !state.live && <span className="text-muted">Listening…</span>}
          </p>
          <div className="flex gap-3">
            <button
              onClick={() => void act(() => api.finishAnswer())}
              disabled={busy}
              className="rounded-lg bg-accent px-5 py-2 text-sm font-semibold text-bg hover:bg-accent/90 disabled:opacity-50"
            >
              Done answering
            </button>
            <button
              onClick={() => {
                setDraft([item.answer, state.live].filter(Boolean).join(' '))
                setTyping(true)
              }}
              className="rounded-lg border border-line px-4 py-2 text-sm text-muted hover:text-fg"
            >
              Edit as text
            </button>
          </div>
        </section>
      )}

      {typing && ['asking', 'recording', 'error'].includes(item.status) && (
        <section className="flex flex-col gap-2">
          <textarea
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && (e.ctrlKey || e.metaKey) && draft.trim() && submitTyped()}
            rows={7}
            placeholder={keys('Type your answer… (Ctrl+Enter to submit)')}
            className="rounded-lg border border-line bg-raised px-3.5 py-2.5 text-sm leading-relaxed"
          />
          <div className="flex gap-3">
            <button
              onClick={submitTyped}
              disabled={busy || !draft.trim()}
              className="rounded-lg bg-accent px-5 py-2 text-sm font-semibold text-bg hover:bg-accent/90 disabled:opacity-50"
            >
              Get feedback
            </button>
            <button onClick={() => setTyping(false)} className="text-sm text-muted hover:text-fg">
              Cancel
            </button>
          </div>
        </section>
      )}

      {item.status === 'reviewing' && (
        <section className="flex flex-col gap-3">
          <YourAnswer text={item.answer} open />
          <p className="flex items-center gap-2 text-sm text-muted">
            <span className="size-4 animate-spin rounded-full border-2 border-line border-t-accent" /> Reviewing your answer…
          </p>
        </section>
      )}

      {item.status === 'error' && !typing && (
        <section className="flex flex-col gap-3">
          {item.answer && <YourAnswer text={item.answer} open />}
          <p className="text-sm text-bad">{item.error}</p>
          <div className="flex gap-3">
            <button onClick={() => void act(() => api.retry())} disabled={busy} className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-bg disabled:opacity-50">
              Retry feedback
            </button>
            <button onClick={() => void act(() => api.redo())} className="rounded-lg border border-line px-4 py-2 text-sm text-muted hover:text-fg">
              Answer again
            </button>
            <button onClick={() => void act(() => api.next())} className="ml-auto text-sm text-muted hover:text-fg">
              {isLast ? 'Finish' : 'Next question'}
            </button>
          </div>
        </section>
      )}

      {item.status === 'reviewed' && item.feedback && (
        <section className="flex flex-col gap-4">
          <Feedback item={item} />
          <div className="flex gap-3">
            <button
              onClick={() => void act(() => api.next())}
              disabled={busy}
              className="rounded-lg bg-accent px-5 py-2 text-sm font-semibold text-bg hover:bg-accent/90 disabled:opacity-50"
            >
              {isLast ? 'Finish and see debrief' : 'Next question →'}
            </button>
            <button onClick={() => void act(() => api.redo())} className="rounded-lg border border-line px-4 py-2 text-sm text-muted hover:text-fg">
              Try this one again
            </button>
          </div>
        </section>
      )}
    </div>
  )
}

function Progress({ items, current }: { items: PracticeItem[]; current: number }) {
  return (
    <div className="mt-2 flex gap-1">
      {items.map((it, i) => (
        <span
          key={i}
          title={it.feedback ? `${it.feedback.score}/10` : it.status}
          className={`h-1.5 flex-1 rounded-full ${
            i === current ? 'bg-accent' : it.feedback ? scoreBg(it.feedback.score) : it.status === 'skipped' ? 'bg-line' : 'bg-raised'
          }`}
        />
      ))}
    </div>
  )
}

function scoreBg(score: number): string {
  return score >= 7 ? 'bg-ok' : score >= 5 ? 'bg-warn' : 'bg-bad'
}
function scoreText(score: number): string {
  return score >= 7 ? 'text-ok' : score >= 5 ? 'text-warn' : 'text-bad'
}

function YourAnswer({ text, open = false }: { text: string; open?: boolean }) {
  return (
    <details open={open} className="rounded-lg border border-line px-4 py-2.5 text-sm">
      <summary className="cursor-pointer text-xs tracking-wide text-muted uppercase select-none">Your answer</summary>
      <p className="mt-2 leading-relaxed whitespace-pre-wrap">{text}</p>
    </details>
  )
}

function Feedback({ item }: { item: PracticeItem }) {
  const f = item.feedback!
  return (
    <div className="md-theme-dark flex flex-col gap-4">
      <div className="flex items-baseline gap-3">
        <span className={`font-mono text-3xl font-semibold tabular-nums ${scoreText(f.score)}`}>{f.score}</span>
        <span className="text-sm text-muted">/ 10</span>
        {item.servedBy && <span className="ml-auto text-[11px] text-muted">{item.servedBy}</span>}
      </div>
      <YourAnswer text={item.answer} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Points title="Strengths" tone="text-ok" points={f.strengths} empty="—" />
        <Points title="To improve" tone="text-warn" points={f.gaps} empty="Nothing major." />
      </div>
      {f.improvedAnswer && (
        <section className="rounded-xl border border-line bg-panel p-4 text-sm">
          <h3 className="mb-2 text-xs font-medium tracking-wide text-muted uppercase">A stronger answer</h3>
          <Markdown text={f.improvedAnswer} />
        </section>
      )}
    </div>
  )
}

function Points({ title, tone, points, empty }: { title: string; tone: string; points: string[]; empty: string }) {
  return (
    <section className="rounded-xl border border-line p-4 text-sm">
      <h3 className={`mb-2 text-xs font-medium tracking-wide uppercase ${tone}`}>{title}</h3>
      {points.length ? (
        <ul className="flex list-disc flex-col gap-1 pl-4 leading-relaxed">
          {points.map((p, i) => (
            <li key={i}>{p}</li>
          ))}
        </ul>
      ) : (
        <p className="text-muted">{empty}</p>
      )}
    </section>
  )
}

function DoneScreen({ state, act }: { state: PracticeState; act: Act }) {
  const setTab = useApp((s) => s.setTab)
  const reviewed = state.items.filter((i) => i.feedback)
  return (
    <div className="md-theme-dark mx-auto flex max-w-3xl flex-col gap-6 px-8 py-8">
      <header className="flex items-end gap-4">
        <div className="flex-1">
          <p className="text-xs tracking-wide text-muted uppercase">{PRACTICE_ROUND_LABELS[state.round]} practice · done</p>
          <h1 className="mt-1 text-xl font-semibold">
            {state.averageScore !== undefined ? (
              <>
                Average <span className={scoreText(state.averageScore)}>{state.averageScore}</span> / 10
              </>
            ) : (
              'Practice finished'
            )}
          </h1>
          <p className="text-sm text-muted">
            {reviewed.length} of {state.items.length} answered
          </p>
        </div>
        <button onClick={() => setTab('history')} className="rounded-md border border-line px-3 py-1.5 text-sm text-muted hover:text-fg">
          Open in History
        </button>
        <button onClick={() => void act(() => window.api.practice.reset())} className="rounded-md bg-accent px-4 py-1.5 text-sm font-semibold text-bg hover:bg-accent/90">
          Practice again
        </button>
      </header>

      {state.summary && (
        <section className="rounded-xl border border-line bg-panel p-5 text-sm">
          <Markdown text={state.summary} />
        </section>
      )}

      <ol className="flex flex-col gap-2">
        {state.items.map((it, i) => (
          <li key={i}>
            <details className="rounded-lg border border-line px-4 py-3">
              <summary className="flex cursor-pointer items-center gap-3 text-sm select-none">
                <span className={`w-10 font-mono tabular-nums ${it.feedback ? scoreText(it.feedback.score) : 'text-muted'}`}>
                  {it.feedback ? `${it.feedback.score}/10` : '—'}
                </span>
                <span className="flex-1">{it.question}</span>
                {!it.feedback && <span className="text-xs text-muted">{it.status === 'skipped' ? 'skipped' : 'no feedback'}</span>}
              </summary>
              {it.feedback && (
                <div className="mt-4">
                  <Feedback item={it} />
                </div>
              )}
            </details>
          </li>
        ))}
      </ol>
    </div>
  )
}

function useVoices(): SpeechSynthesisVoice[] {
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([])
  useEffect(() => {
    const load = () => setVoices(window.speechSynthesis.getVoices().filter((v) => v.lang.toLowerCase().startsWith('en')))
    load()
    window.speechSynthesis.addEventListener('voiceschanged', load)
    return () => window.speechSynthesis.removeEventListener('voiceschanged', load)
  }, [])
  return voices
}

/** Reads text aloud with the Web Speech API (FR-P2). */
function useSpeech(settings: Settings) {
  const [speaking, setSpeaking] = useState(false)
  const voices = useVoices()
  const ref = useRef({ voices, settings })
  ref.current = { voices, settings }

  const [api] = useState(() => ({
    speak(text: string, onEnd?: () => void) {
      const synth = window.speechSynthesis
      synth.cancel()
      const u = new SpeechSynthesisUtterance(text)
      const { voices: vs, settings: s } = ref.current
      const voice = s.practice.voice ? vs.find((v) => v.name === s.practice.voice) : undefined
      if (voice) u.voice = voice
      u.rate = s.practice.rate
      let done = false
      const finish = (completed: boolean) => {
        if (done) return
        done = true
        setSpeaking(false)
        if (completed) onEnd?.()
      }
      u.onend = () => finish(true)
      // Cancelled (another question, "Stop reading", recording started): don't start recording.
      u.onerror = (e) => finish(e.error !== 'interrupted' && e.error !== 'canceled')
      setSpeaking(true)
      synth.speak(u)
    },
    cancel() {
      window.speechSynthesis.cancel()
      setSpeaking(false)
    }
  }))
  return { ...api, speaking }
}
