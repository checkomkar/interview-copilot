import { useEffect, useRef, useState } from 'react'

interface Props {
  voiceOn: boolean
  /** What the mic is hearing right now (voice questions on). */
  heard: string
  onError: (message: string | null) => void
}

/** Type a question, or toggle the mic to ask by voice. */
export function AskBar({ voiceOn, heard, onError }: Props) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => window.api.answers.onFocusAsk(() => input.current?.focus()), [])

  const submit = async () => {
    if (!text.trim() || busy) return
    setBusy(true)
    try {
      const res = await window.api.answers.ask(text)
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

  return (
    <div className="ov-line border-t px-2 py-1.5">
      {voiceOn && (
        <p className="ov-muted mb-1 truncate px-1 text-[0.8em]" title={heard}>
          <span className="text-bad">●</span> {heard ? <span className="ov-fg">{heard}</span> : 'Listening — ask your question'}
        </p>
      )}
      <div className="flex items-center gap-1.5">
        <button
          onClick={() => void toggleVoice()}
          className={`flex size-7 shrink-0 items-center justify-center rounded-md ${voiceOn ? 'ov-mic-on' : 'ov-muted ov-btn'}`}
          title={voiceOn ? 'Stop voice questions (Ctrl+Shift+M)' : 'Ask by voice (Ctrl+Shift+M)'}
          aria-label={voiceOn ? 'Stop voice questions' : 'Ask by voice'}
          aria-pressed={voiceOn}
        >
          <MicIcon off={!voiceOn} />
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
          placeholder="Ask anything… (Enter)"
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

function cleanError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, '').replace(/^Invalid input: text: /, '')
}
