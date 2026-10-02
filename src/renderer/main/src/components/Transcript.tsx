import { useEffect, useRef } from 'react'
import { useApp } from '../store'

/** Live transcript; Interviewer on the left, Me on the right. */
export function Transcript() {
  const utterances = useApp((s) => s.utterances)
  const scroller = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)

  useEffect(() => {
    const el = scroller.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [utterances])

  const onScroll = () => {
    const el = scroller.current
    if (el) pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
  }

  if (utterances.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted">
        Transcript appears here once someone speaks.
      </div>
    )
  }

  return (
    <div ref={scroller} onScroll={onScroll} className="h-full overflow-y-auto px-6 py-4">
      <ol className="flex flex-col gap-3">
        {utterances.map((u) => {
          const me = u.source === 'mic'
          return (
            <li key={u.id} className={`flex flex-col ${me ? 'items-end' : 'items-start'}`}>
              <span className={`mb-1 text-[11px] font-medium tracking-wide uppercase ${me ? 'text-me' : 'text-them'}`}>
                {me ? 'Me' : 'Interviewer'} · {new Date(u.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
              </span>
              <p
                className={`max-w-[80%] rounded-lg border px-3.5 py-2 text-[14px] leading-relaxed ${
                  me ? 'border-me/20 bg-me/5' : 'border-them/20 bg-them/5'
                } ${u.isFinal ? '' : 'text-fg/70'}`}
              >
                {u.text}
                {!u.isFinal && <span className="ml-1 inline-block animate-pulse text-muted">▍</span>}
              </p>
            </li>
          )
        })}
      </ol>
    </div>
  )
}
