import type { HistorySession } from '@shared/history'

const TYPE_LABEL: Record<string, string> = {
  behavioral: 'Behavioral',
  technical: 'Technical',
  coding: 'Coding',
  system_design: 'System design',
  situational: 'Situational',
  smalltalk: 'Small talk',
  other: 'Question',
  status: 'Status update',
  work: 'Work'
}

export interface MarkdownOptions {
  /** Injectable for tests (local time by default). */
  formatDateTime?: (ts: number) => string
  formatTime?: (ts: number) => string
}

/** A session as a Markdown study document (U9): Q&As first, then the full transcript. */
export function sessionToMarkdown(s: HistorySession, opts: MarkdownOptions = {}): string {
  const dateTime = opts.formatDateTime ?? ((ts) => new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }))
  const time = opts.formatTime ?? ((ts) => new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }))

  const facts = [
    s.endedAt ? `Duration ${formatDuration(s.endedAt - s.startedAt)}` : null,
    `${s.qas.length} question${s.qas.length === 1 ? '' : 's'}`,
    `Cost $${s.costUsd.toFixed(2)}`
  ].filter(Boolean)

  if (s.kind === 'practice') return practiceToMarkdown(s, dateTime)

  const work = s.kind === 'work'
  const out: string[] = [`# ${work ? 'Work call' : 'Interview session'} — ${dateTime(s.startedAt)}`, '', facts.join(' · '), '']

  if (s.qas.length) {
    out.push('## Questions and answers', '')
    s.qas.forEach((q, i) => {
      out.push(`### ${i + 1}. ${q.question.replace(/\s+/g, ' ').trim()}`, '')
      const meta = [TYPE_LABEL[q.type] ?? q.type, q.project, screenshotLabel(q.screenshotCount), q.servedBy].filter(Boolean)
      out.push(`*${meta.join(' · ')}*`, '')
      if (q.answer.trim()) out.push(q.answer.trim(), '')
      if (q.status === 'error' && q.error) out.push(`> ⚠ ${q.error}`, '')
    })
  }

  if (s.utterances.length) {
    out.push('## Transcript', '')
    for (const u of s.utterances) {
      out.push(`**${u.source === 'mic' ? 'Me' : work ? 'Call' : 'Interviewer'}** (${time(u.ts)}): ${u.text}`, '')
    }
  }

  return `${out.join('\n').trimEnd()}\n`
}

/** A practice run: debrief first, then each question with the answer and its feedback. */
function practiceToMarkdown(s: HistorySession, dateTime: (ts: number) => string): string {
  const reviewed = s.practice.filter((p) => p.score !== null).length
  const facts = [
    s.endedAt ? `Duration ${formatDuration(s.endedAt - s.startedAt)}` : null,
    `${reviewed} of ${s.practice.length} answered`,
    s.averageScore !== null ? `Average ${s.averageScore}/10` : null,
    `Cost $${s.costUsd.toFixed(2)}`
  ].filter(Boolean)
  const out: string[] = [`# ${s.title} — ${dateTime(s.startedAt)}`, '', facts.join(' · '), '']
  if (s.summary?.trim()) out.push('## Debrief', '', s.summary.trim(), '')
  s.practice.forEach((p, i) => {
    out.push(`## ${i + 1}. ${p.question}`, '')
    out.push(`*${[TYPE_LABEL[p.type] ?? p.type, p.score !== null ? `Score ${p.score}/10` : p.status === 'skipped' ? 'Skipped' : 'No feedback'].join(' · ')}*`, '')
    if (p.answer.trim()) out.push('**My answer**', '', p.answer.trim(), '')
    if (p.strengths.length) out.push('**Strengths**', '', ...p.strengths.map((x) => `- ${x}`), '')
    if (p.gaps.length) out.push('**To improve**', '', ...p.gaps.map((x) => `- ${x}`), '')
    if (p.improvedAnswer.trim()) out.push('**Stronger answer**', '', p.improvedAnswer.trim(), '')
  })
  return `${out.join('\n').trimEnd()}\n`
}

function screenshotLabel(count: number): string | null {
  return count === 0 ? null : count === 1 ? 'with screenshot' : `with ${count} screenshots`
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h) return `${h} h ${m} min`
  if (m) return `${m} min ${s} s`
  return `${s} s`
}

/** A safe default file name, e.g. "interview-2026-10-02-1708.md" ("work-…" for a Work call). */
export function exportFileName(startedAt: number, kind: 'copilot' | 'work' | 'practice' = 'copilot'): string {
  const d = new Date(startedAt)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${kind === 'work' ? 'work' : 'interview'}-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.md`
}
