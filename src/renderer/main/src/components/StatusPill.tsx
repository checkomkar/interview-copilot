import type { SessionStatus } from '@shared/ipc'
import { useApp } from '../store'

const LABEL: Record<SessionStatus, string> = {
  idle: 'Idle',
  starting: 'Starting…',
  listening: 'Listening',
  reconnecting: 'Reconnecting',
  error: 'Error'
}
const DOT: Record<SessionStatus, string> = {
  idle: 'bg-muted',
  starting: 'bg-warn animate-pulse',
  listening: 'bg-ok',
  reconnecting: 'bg-warn animate-pulse',
  error: 'bg-bad'
}

export function StatusPill() {
  const status = useApp((s) => s.session.status)
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-line px-2.5 py-0.5 text-xs text-muted">
      <span className={`size-2 rounded-full ${DOT[status]}`} />
      {LABEL[status]}
    </span>
  )
}
