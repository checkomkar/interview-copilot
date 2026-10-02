import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { AnswerUsage, AudioSource, QaSnapshot, QaStatus, QuestionType } from '@shared/ipc'
import type { HistoryKind, HistoryPracticeItem, HistoryQa, HistorySession, HistorySessionSummary } from '@shared/history'
import type { PracticeItem, PracticeItemStatus, PracticeQuestionType } from '@shared/practice'
import { createLogger } from '../../logger'
import { openDb } from '../../db/db'

const log = createLogger('history')

export interface HistoryDeps {
  /** Directory for data.db and saved screenshots. */
  dir: string
  now?: () => number
}

export interface HistoryEvents {
  /** A new history session began (the cost meter starts from zero). */
  opened: [string]
}

interface SessionRow {
  id: string
  started_at: number
  ended_at: number | null
  cost_usd: number
  stt_seconds: number
  title: string | null
  question_count: number
  kind: HistoryKind
  label: string | null
  summary: string | null
  average_score: number | null
}

interface PracticeRow {
  idx: number
  question: string
  type: string
  status: string
  answer: string
  score: number | null
  strengths: string | null
  gaps: string | null
  improved_answer: string | null
  served_by: string | null
  ts: number
}

/** Title and count for the list: the first question of a copilot session, the label of a practice run. */
const SUMMARY_COLUMNS = `s.*,
  (SELECT question FROM qa_pairs q WHERE q.session_id = s.id ORDER BY ts LIMIT 1) AS title,
  CASE WHEN s.kind = 'practice'
    THEN (SELECT COUNT(*) FROM practice_items p WHERE p.session_id = s.id)
    ELSE (SELECT COUNT(*) FROM qa_pairs q WHERE q.session_id = s.id) END AS question_count`

interface QaRow {
  id: string
  question: string
  type: string
  answer: string
  status: string
  error: string | null
  served_by: string | null
  ts: number
  screenshot_count: number
  /** JSON array of file paths. */
  screenshot_paths: string | null
  project: string | null
}

/**
 * Session history in SQLite (FR-D1/D2, U9): transcripts, Q&As, LLM usage and cost. A history
 * session opens with a listening session, or with the first question asked outside one.
 */
export class HistoryService extends EventEmitter {
  private readonly db: DatabaseSync
  private readonly shotsDir: string
  private current: string | null = null
  private seq = 0
  private readonly now: () => number

  constructor(deps: HistoryDeps) {
    super()
    this.now = deps.now ?? Date.now
    mkdirSync(deps.dir, { recursive: true })
    this.db = openDb(join(deps.dir, 'data.db'))
    this.shotsDir = join(deps.dir, 'screenshots')
    this.recoverOpenSessions()
  }

  override emit<E extends keyof HistoryEvents>(event: E, ...args: HistoryEvents[E]): boolean {
    return super.emit(event, ...args)
  }
  override on<E extends keyof HistoryEvents>(event: E, listener: (...args: HistoryEvents[E]) => void): this {
    return super.on(event, listener as (...a: unknown[]) => void)
  }

  currentId(): string | null {
    return this.current
  }

  /** Close any open session and start a new one. */
  open(kind: HistoryKind = 'copilot', label: string | null = null): string {
    this.close()
    const id = `${kind === 'practice' ? 'p' : 's'}-${this.now()}-${++this.seq}`
    this.db.prepare('INSERT INTO sessions (id, started_at, kind, label) VALUES (?, ?, ?, ?)').run(id, this.now(), kind, label)
    this.current = id
    this.emit('opened', id)
    return id
  }

  /** The open session, opening one of `kind` if needed. */
  ensure(kind: HistoryKind = 'copilot'): string {
    return this.current ?? this.open(kind)
  }

  /** End the open session; one with nothing in it is dropped. */
  close(): void {
    const id = this.current
    if (!id) return
    this.current = null
    if (this.isEmpty(id)) this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
    else this.db.prepare('UPDATE sessions SET ended_at = ? WHERE id = ?').run(this.now(), id)
  }

  recordUtterance(u: { source: AudioSource; text: string; ts: number }): void {
    const text = u.text.trim()
    if (!text) return
    this.db.prepare('INSERT INTO utterances (session_id, source, text, ts) VALUES (?, ?, ?, ?)').run(this.ensure(), u.source, text, u.ts)
  }

  /**
   * Insert or update a Q&A (a regenerated answer replaces the earlier one). `screenshots` are the
   * base64 JPEGs sent with it, written to disk only when `keep` is set (FR-D4).
   */
  saveQa(qa: QaSnapshot, opts: { screenshots?: string[]; keep?: boolean; sessionId?: string } = {}): void {
    const session = opts.sessionId && this.exists(opts.sessionId) ? opts.sessionId : this.ensure()
    const shots = opts.screenshots ?? []
    let paths: string | null = null
    if (shots.length && opts.keep) {
      mkdirSync(this.shotsDir, { recursive: true })
      const base = qa.id.replace(/[^\w-]/g, '_')
      const files = shots.map((data, i) => {
        const path = join(this.shotsDir, `${base}-${i + 1}.jpg`)
        writeFileSync(path, Buffer.from(data, 'base64'))
        return path
      })
      paths = JSON.stringify(files)
    }
    this.db
      .prepare(
        `INSERT INTO qa_pairs (id, session_id, question, type, answer, status, error, served_by, ts, screenshot_count, screenshot_paths, project)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET question = excluded.question, type = excluded.type, answer = excluded.answer,
           status = excluded.status, error = excluded.error, served_by = excluded.served_by, project = excluded.project,
           screenshot_count = excluded.screenshot_count, screenshot_paths = COALESCE(excluded.screenshot_paths, qa_pairs.screenshot_paths)`
      )
      .run(
        qa.id,
        session,
        qa.question,
        qa.type,
        qa.answer,
        qa.status,
        qa.error ?? null,
        qa.servedBy ?? null,
        this.now(),
        shots.length || qa.screenshots?.length || 0,
        paths,
        qa.project ?? null
      )
  }

  /** A practice run gets its own history session (FR-P4). */
  openPractice(label: string): string {
    return this.open('practice', label)
  }

  /** Insert or update one question of a practice run. */
  savePracticeItem(sessionId: string, index: number, item: PracticeItem): void {
    if (!this.exists(sessionId)) return
    const f = item.feedback
    this.db
      .prepare(
        `INSERT INTO practice_items (session_id, idx, question, type, status, answer, score, strengths, gaps, improved_answer, served_by, ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id, idx) DO UPDATE SET status = excluded.status, answer = excluded.answer, score = excluded.score,
           strengths = excluded.strengths, gaps = excluded.gaps, improved_answer = excluded.improved_answer,
           served_by = excluded.served_by, ts = excluded.ts`
      )
      .run(
        sessionId,
        index,
        item.question,
        item.type,
        item.status,
        item.answer,
        f?.score ?? null,
        f ? JSON.stringify(f.strengths) : null,
        f ? JSON.stringify(f.gaps) : null,
        f?.improvedAnswer ?? null,
        item.servedBy ?? null,
        this.now()
      )
  }

  /** The end-of-practice summary and average score. */
  finishPractice(sessionId: string, summary: string, averageScore: number | null): void {
    this.db.prepare('UPDATE sessions SET summary = ?, average_score = ? WHERE id = ?').run(summary, averageScore, sessionId)
  }

  /** Records one LLM request against the open session; ignored when none is open (e.g. profile summaries). */
  recordUsage(usage: AnswerUsage, purpose: string | undefined, costUsd: number): void {
    if (!this.current) return
    this.db
      .prepare(
        `INSERT INTO usage (session_id, ts, purpose, service, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        this.current,
        this.now(),
        purpose ?? null,
        usage.service ?? null,
        usage.model,
        usage.inputTokens,
        usage.outputTokens,
        usage.cacheReadTokens,
        usage.cacheWriteTokens,
        costUsd
      )
  }

  /** Session totals from the cost tracker (LLM + STT). */
  updateTotals(costUsd: number, sttSeconds: number): void {
    if (!this.current) return
    this.db.prepare('UPDATE sessions SET cost_usd = ?, stt_seconds = ? WHERE id = ?').run(costUsd, sttSeconds, this.current)
  }

  list(): HistorySessionSummary[] {
    const rows = this.db
      .prepare(`SELECT ${SUMMARY_COLUMNS} FROM sessions s ORDER BY s.started_at DESC`)
      .all() as unknown as SessionRow[]
    return rows.map(toSummary)
  }

  get(id: string): HistorySession | null {
    const row = this.db
      .prepare(`SELECT ${SUMMARY_COLUMNS} FROM sessions s WHERE s.id = ?`)
      .get(id) as unknown as SessionRow | undefined
    if (!row) return null
    const utterances = this.db.prepare('SELECT source, text, ts FROM utterances WHERE session_id = ? ORDER BY ts, id').all(id) as unknown as {
      source: AudioSource
      text: string
      ts: number
    }[]
    const qas = (this.db.prepare('SELECT * FROM qa_pairs WHERE session_id = ? ORDER BY ts').all(id) as unknown as QaRow[]).map((q) =>
      this.toQa(q)
    )
    const practice = (this.db.prepare('SELECT * FROM practice_items WHERE session_id = ? ORDER BY idx').all(id) as unknown as PracticeRow[]).map(
      toPracticeItem
    )
    return { ...toSummary(row), utterances: utterances.map((u) => ({ ...u })), qas, practice, summary: row.summary }
  }

  delete(id: string): void {
    this.removeScreenshots(id)
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
    if (this.current === id) this.current = null
  }

  /** Deletes every saved session and screenshot (the open one included). */
  deleteAll(): void {
    this.db.exec('DELETE FROM sessions')
    rmSync(this.shotsDir, { recursive: true, force: true })
    this.current = null
  }

  dispose(): void {
    this.close()
    this.db.close()
  }

  private exists(id: string): boolean {
    return this.db.prepare('SELECT 1 FROM sessions WHERE id = ?').get(id) !== undefined
  }

  private isEmpty(id: string): boolean {
    const { n } = this.db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM utterances WHERE session_id = ?) + (SELECT COUNT(*) FROM qa_pairs WHERE session_id = ?)
           + (SELECT COUNT(*) FROM practice_items WHERE session_id = ?) AS n`
      )
      .get(id, id, id) as { n: number }
    return n === 0
  }

  /** Sessions left open by a crash: end them at their last activity, drop empty ones. */
  private recoverOpenSessions(): void {
    const open = this.db.prepare('SELECT id, started_at FROM sessions WHERE ended_at IS NULL').all() as { id: string; started_at: number }[]
    for (const s of open) {
      if (this.isEmpty(s.id)) {
        this.db.prepare('DELETE FROM sessions WHERE id = ?').run(s.id)
        continue
      }
      const { last } = this.db
        .prepare(
          `SELECT MAX(ts) AS last FROM (SELECT ts FROM utterances WHERE session_id = ? UNION ALL SELECT ts FROM qa_pairs WHERE session_id = ?
             UNION ALL SELECT ts FROM practice_items WHERE session_id = ?)`
        )
        .get(s.id, s.id, s.id) as { last: number | null }
      this.db.prepare('UPDATE sessions SET ended_at = ? WHERE id = ?').run(last ?? s.started_at, s.id)
    }
    if (open.length) log.info(`closed ${open.length} session(s) left open by the last run`)
  }

  private toQa(q: QaRow): HistoryQa {
    const screenshots: string[] = []
    for (const path of parsePaths(q.screenshot_paths)) {
      if (!existsSync(path)) continue
      try {
        screenshots.push(`data:image/jpeg;base64,${readFileSync(path).toString('base64')}`)
      } catch (err) {
        log.warn(`could not read a screenshot for ${q.id}`, err)
      }
    }
    return {
      id: q.id,
      question: q.question,
      type: q.type as QuestionType,
      answer: q.answer,
      status: q.status as QaStatus,
      error: q.error,
      servedBy: q.served_by,
      ts: q.ts,
      screenshots,
      screenshotCount: q.screenshot_count,
      project: q.project ?? null
    }
  }

  private removeScreenshots(sessionId: string): void {
    const rows = this.db.prepare('SELECT screenshot_paths FROM qa_pairs WHERE session_id = ? AND screenshot_paths IS NOT NULL').all(sessionId) as {
      screenshot_paths: string
    }[]
    for (const r of rows) for (const path of parsePaths(r.screenshot_paths)) rmSync(path, { force: true })
  }
}

/** A JSON array of strings (file paths, feedback points); anything else is empty. */
function parsePaths(json: string | null): string[] {
  if (!json) return []
  try {
    const v = JSON.parse(json) as unknown
    return Array.isArray(v) ? v.filter((p): p is string => typeof p === 'string') : []
  } catch {
    return []
  }
}

function toPracticeItem(r: PracticeRow): HistoryPracticeItem {
  return {
    index: r.idx,
    question: r.question,
    type: r.type as PracticeQuestionType,
    status: r.status as PracticeItemStatus,
    answer: r.answer,
    score: r.score,
    strengths: parsePaths(r.strengths),
    gaps: parsePaths(r.gaps),
    improvedAnswer: r.improved_answer ?? '',
    servedBy: r.served_by,
    ts: r.ts
  }
}

function toSummary(r: SessionRow): HistorySessionSummary {
  return {
    id: r.id,
    kind: r.kind ?? 'copilot',
    startedAt: r.started_at,
    endedAt: r.ended_at,
    title: r.kind === 'practice' ? (r.label ?? 'Practice') : (r.title ?? 'Transcript only'),
    averageScore: r.average_score ?? null,
    questionCount: r.question_count,
    costUsd: r.cost_usd,
    sttSeconds: r.stt_seconds
  }
}
