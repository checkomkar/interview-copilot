import { useEffect, useRef, useState } from 'react'
import { keys } from '../../shared/keys'

interface Props {
  mode: 'work' | 'interview'
  voiceOn: boolean
  /** What the mic is hearing right now (voice questions on). */
  heard: string
  /** Thumbnails of the screenshots waiting to be sent with the next answer, in order. */
  pendingShots: string[]
  /** Screenshots allowed per question. */
  maxShots: number
  onError: (message: string | null) => void
}

/** Type a question, or toggle the mic to ask by voice. */
export function AskBar({ mode, voiceOn, heard, pendingShots, maxShots, onError }: Props) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => window.api.answers.onFocusAsk(() => input.current?.focus()), [])

  const submit = async () => {
    if (busy) return
    // Empty input with screenshots waiting: answer from the screenshots alone.
    if (!text.trim() && pendingShots.length === 0) return
    setBusy(true)
    try {
      const res = text.trim() ? await window.api.answers.ask(text) : await window.api.screen.answer()
      if (res.ok) setText('')
      onError(res.ok ? null : res.error)
    } catch (err) {
      onError(cleanError(err))
    } finally {
      setBusy(false)
    }
  }

  const toggleVoice = async () => {
    try {
      const res = await window.api.answers.setVoiceAsk(!voiceOn)
      onError(res.ok ? null : res.error)
    } catch (err) {
      onError(cleanError(err))
    }
  }

  const run = async (fn: () => Promise<{ ok: boolean; error?: string }>) => {
    try {
      const res = await fn()
      onError(res.ok ? null : (res.error ?? null))
    } catch (err) {
      onError(cleanError(err))
    }
  }
  const full = pendingShots.length >= maxShots

  return (
    <div className="ov-line border-t px-2 py-1.5">
      {pendingShots.length > 0 && (
        <div className="mb-1.5 flex items-center gap-2 px-1">
          {pendingShots.map((thumb, i) => (
            <div key={`${i}-${thumb.length}`} className="relative shrink-0">
              <img src={thumb} alt={`Screenshot ${i + 1}`} className="ov-line h-10 rounded border object-cover" />
              <span className="absolute bottom-0 left-0 rounded-tr bg-black/60 px-1 font-mono text-[9px] text-white">{i + 1}</span>
              <button
                className="absolute -top-1.5 -right-1.5 flex size-4 items-center justify-center rounded-full bg-black/70 text-[9px] text-white hover:bg-bad"
                onClick={() => void window.api.screen.clear(i)}
                title={`Remove screenshot ${i + 1}`}
                aria-label={`Remove screenshot ${i + 1}`}
              >
                ✕
              </button>
            </div>
          ))}
          <span className="ov-muted min-w-0 flex-1 text-[0.75em] leading-tight">
            {full ? `${maxShots} max · ` : `Scroll and add more (up to ${maxShots}) · `}sent together with the next answer
          </span>
          <button
            className="ov-tag ov-fg ov-btn shrink-0 rounded px-2 py-0.5 text-[11px]"
            onClick={() => void run(window.api.screen.answer)}
            title="Answer from these screenshots"
          >
            Answer
          </button>
        </div>
      )}
      {voiceOn && (
        <p className="ov-muted mb-1 truncate px-1 text-[0.8em]" title={heard}>
          <span className="text-bad">●</span> {heard ? <span className="ov-fg">{heard}</span> : 'Listening — ask your question'}
        </p>
      )}
      <div className="flex items-center gap-1.5">
        <button
          onClick={() => void toggleVoice()}
          className={`flex size-7 shrink-0 items-center justify-center rounded-md ${voiceOn ? 'ov-mic-on' : 'ov-muted ov-btn'}`}
          title={keys(voiceOn ? 'Stop voice questions (Ctrl+Shift+M)' : 'Ask by voice (Ctrl+Shift+M)')}
          aria-label={voiceOn ? 'Stop voice questions' : 'Ask by voice'}
          aria-pressed={voiceOn}
        >
          <MicIcon off={!voiceOn} />
        </button>
        <button
          onClick={() => void run(window.api.screen.add)}
          disabled={full}
          className="ov-muted ov-btn flex size-7 shrink-0 items-center justify-center rounded-md disabled:opacity-30"
          title={
            full
              ? `Up to ${maxShots} screenshots per question (Settings → Screen)`
              : keys(`Add a screenshot (Ctrl+Shift+Alt+S) — add up to ${maxShots} while scrolling, then Answer. Ctrl+Shift+S captures and answers at once.`)
          }
          aria-label="Add screenshot"
        >
          <CameraIcon />
        </button>
        <input
          ref={input}
          className="ov-input min-w-0 flex-1 rounded-md px-2 py-1 text-[0.9em] outline-none"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit()
            if (e.key === 'Escape') input.current?.blur()
          }}
          placeholder={
            pendingShots.length
              ? mode === 'work'
                ? 'Ask about the screenshots, or Enter to explain'
                : 'Ask about the screenshots, or Enter to solve'
              : mode === 'work'
                ? 'Ask, "status <project>", or "update <project>: …"'
                : 'Ask anything… (Enter)'
          }
          maxLength={2000}
          spellCheck
          aria-label="Ask a question"
        />
      </div>
    </div>
  )
}

function MicIcon({ off }: { off: boolean }) {
  return (
    <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
      {off && <path d="M4 4l16 16" />}
    </svg>
  )
}

function CameraIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 8h3l2-3h6l2 3h3v11H4z" />
      <circle cx="12" cy="13" r="3.5" />
    </svg>
  )
}

function cleanError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, '').replace(/^Invalid input: text: /, '')
}
