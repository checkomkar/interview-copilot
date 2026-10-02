import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { QaSnapshot } from '@shared/ipc'
import type { HistorySession } from '@shared/history'
import { HistoryService } from '../src/main/services/history/HistoryService'
import { exportFileName, formatDuration, sessionToMarkdown } from '../src/main/services/history/markdown'
import { usage } from './mockLlm'

const qa = (over: Partial<QaSnapshot> = {}): QaSnapshot => ({
  id: 'qa-1',
  question: 'What is React?',
  type: 'technical',
  style: 'auto',
  answer: '- A UI library',
  status: 'done',
  servedBy: 'gpt-oss-120b · Groq',
  ...over
})

describe('HistoryService', () => {
  let dir: string
  let now: number
  let svc: HistoryService
  const make = () => new HistoryService({ dir, now: () => now })

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'history-'))
    now = 1_000
    svc = make()
  })
  afterEach(() => {
    svc.dispose()
    rmSync(dir, { recursive: true, force: true })
  })

  it('saves a session with its transcript, Q&As and totals', () => {
    const opened: string[] = []
    svc.on('opened', (id) => opened.push(id))
    const id = svc.open()
    expect(opened).toEqual([id])
    svc.recordUtterance({ source: 'loopback', text: 'What is React?', ts: 1_100 })
    svc.recordUtterance({ source: 'mic', text: '  ', ts: 1_150 })
    now = 1_200
    svc.saveQa(qa())
    svc.updateTotals(0.25, 90)
    now = 61_000
    svc.close()

    expect(svc.list()).toEqual([
      { id, kind: 'copilot', averageScore: null, startedAt: 1_000, endedAt: 61_000, title: 'What is React?', questionCount: 1, costUsd: 0.25, sttSeconds: 90 }
    ])
    const s = svc.get(id)!
    expect(s.utterances).toEqual([{ source: 'loopback', text: 'What is React?', ts: 1_100 }])
    expect(s.qas[0]).toMatchObject({ id: 'qa-1', answer: '- A UI library', servedBy: 'gpt-oss-120b · Groq', screenshotCount: 0, screenshots: [] })
  })

  it('drops sessions with nothing in them', () => {
    svc.open()
    svc.close()
    expect(svc.list()).toEqual([])
  })

  it('replaces a regenerated answer instead of adding a row', () => {
    svc.open()
    svc.saveQa(qa({ answer: 'first' }))
    svc.saveQa(qa({ answer: 'second', style: 'shorter' }))
    const [s] = svc.list()
    expect(s.questionCount).toBe(1)
    expect(svc.get(s.id)!.qas[0].answer).toBe('second')
  })

  it('opens a session for a question asked outside one, and files late answers under their own session', () => {
    svc.saveQa(qa({ id: 'typed' }))
    const first = svc.currentId()!
    expect(first).toBeTruthy()
    now = 5_000
    svc.open() // a listening session starts
    svc.saveQa(qa({ id: 'late', status: 'error', error: 'Interrupted' }), { sessionId: first })
    expect(svc.get(first)!.qas.map((q) => q.id)).toEqual(['typed', 'late'])
  })

  it('keeps screenshots on disk only when asked, and deletes them with the session', () => {
    const b64 = (s: string) => Buffer.from(s).toString('base64')
    svc.open()
    svc.saveQa(qa({ id: 'a' }), { screenshots: [b64('jpeg-a')], keep: false })
    svc.saveQa(qa({ id: 'b' }), { screenshots: [b64('jpeg-b1'), b64('jpeg-b2')], keep: true })
    const id = svc.currentId()!
    const s = svc.get(id)!
    expect(s.qas.map((q) => [q.id, q.screenshotCount, q.screenshots])).toEqual([
      ['a', 1, []],
      ['b', 2, [`data:image/jpeg;base64,${b64('jpeg-b1')}`, `data:image/jpeg;base64,${b64('jpeg-b2')}`]]
    ])
    expect(readdirSync(join(dir, 'screenshots')).sort()).toEqual(['b-1.jpg', 'b-2.jpg'])
    svc.delete(id)
    expect(readdirSync(join(dir, 'screenshots'))).toEqual([])
    expect(svc.list()).toEqual([])
    expect(svc.currentId()).toBeNull()
  })

  it('records usage only while a session is open', () => {
    svc.recordUsage(usage('m'), 'summary', 0.1)
    expect(svc.list()).toEqual([])
    svc.open()
    svc.recordUsage(usage('m'), 'answer', 0.1)
    svc.saveQa(qa())
    expect(svc.list()).toHaveLength(1)
  })

  it('deletes everything', () => {
    svc.open()
    svc.saveQa(qa(), { screenshots: ['AAAA'], keep: true })
    svc.close()
    svc.open()
    svc.saveQa(qa({ id: 'qa-2' }))
    svc.deleteAll()
    expect(svc.list()).toEqual([])
    expect(existsSync(join(dir, 'screenshots'))).toBe(false)
    expect(svc.currentId()).toBeNull()
  })

  it('closes sessions a crash left open, at their last activity', () => {
    const id = svc.open()
    now = 9_000
    svc.saveQa(qa())
    // Simulate a crash: reopen the database without closing the session.
    now = 99_000
    const again = make()
    expect(again.list()[0]).toMatchObject({ id, endedAt: 9_000 })
    again.dispose()
  })
})

describe('sessionToMarkdown', () => {
  const session: HistorySession = {
    id: 's1',
    kind: 'copilot',
    averageScore: null,
    practice: [],
    summary: null,
    startedAt: 0,
    endedAt: 125_000,
    title: 'What is React?',
    questionCount: 2,
    costUsd: 0.034,
    sttSeconds: 120,
    utterances: [
      { source: 'loopback', text: 'What is React?', ts: 1_000 },
      { source: 'mic', text: 'Sure.', ts: 2_000 }
    ],
    qas: [
      {
        id: 'a',
        question: 'What is React?\nreally',
        type: 'technical',
        answer: '- A UI library',
        status: 'done',
        error: null,
        servedBy: 'gpt-oss-120b · Groq',
        ts: 1_500,
        screenshots: [],
        screenshotCount: 2,
        project: null
      },
      { id: 'b', question: 'And hooks?', type: 'technical', answer: '', status: 'error', error: 'Rate limited', servedBy: null, ts: 3_000, screenshots: [], screenshotCount: 0, project: null }
    ]
  }

  it('lists Q&As then the transcript', () => {
    const md = sessionToMarkdown(session, { formatDateTime: () => 'DATE', formatTime: (ts) => `T${ts}` })
    expect(md).toBe(
      [
        '# Interview session — DATE',
        '',
        'Duration 2 min 5 s · 2 questions · Cost $0.03',
        '',
        '## Questions and answers',
        '',
        '### 1. What is React? really',
        '',
        '*Technical · with 2 screenshots · gpt-oss-120b · Groq*',
        '',
        '- A UI library',
        '',
        '### 2. And hooks?',
        '',
        '*Technical*',
        '',
        '> ⚠ Rate limited',
        '',
        '## Transcript',
        '',
        '**Interviewer** (T1000): What is React?',
        '',
        '**Me** (T2000): Sure.',
        ''
      ].join('\n')
    )
  })

  it('formats durations and file names', () => {
    expect(formatDuration(42_000)).toBe('42 s')
    expect(formatDuration(3_725_000)).toBe('1 h 2 min')
    expect(exportFileName(new Date(2026, 9, 2, 17, 8).getTime())).toBe('interview-2026-10-02-1708.md')
  })
})

describe('openDb migrations', () => {
  it('upgrades a v1 database to several screenshots per Q&A, keeping old screenshots', async () => {
    const { DatabaseSync } = await import('node:sqlite')
    const { MIGRATIONS, openDb } = await import('../src/main/db/db')
    const dir = mkdtempSync(join(tmpdir(), 'migrate-'))
    const path = join(dir, 'data.db')
    const v1 = new DatabaseSync(path)
    v1.exec(MIGRATIONS[0])
    v1.exec('PRAGMA user_version = 1')
    v1.exec(`INSERT INTO sessions (id, started_at) VALUES ('s', 1)`)
    v1.exec(`INSERT INTO qa_pairs (id, session_id, question, type, answer, status, ts, had_screenshot, screenshot_path)
             VALUES ('a', 's', 'q', 'coding', '', 'done', 1, 1, '/shots/a.jpg'), ('b', 's', 'q', 'coding', '', 'done', 2, 0, NULL)`)
    v1.close()
    const db = openDb(path)
    expect(db.prepare('SELECT id, screenshot_count, screenshot_paths FROM qa_pairs ORDER BY id').all().map((r) => ({ ...r }))).toEqual([
      { id: 'a', screenshot_count: 1, screenshot_paths: '["/shots/a.jpg"]' },
      { id: 'b', screenshot_count: 0, screenshot_paths: null }
    ])
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(MIGRATIONS.length)
    // v3: existing sessions become copilot sessions.
    expect({ ...(db.prepare('SELECT kind, label, summary FROM sessions').get() as object) }).toEqual({ kind: 'copilot', label: null, summary: null })
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('practice history (FR-P4)', () => {
  it('saves a practice run with its items, summary and score, and exports it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'practice-'))
    let now = 5_000
    const svc = new HistoryService({ dir, now: () => now })
    const id = svc.openPractice('Practice · Behavioral')
    expect(id).toMatch(/^p-/)
    svc.savePracticeItem(id, 0, {
      question: 'Tell me about a conflict.',
      type: 'behavioral',
      status: 'reviewed',
      answer: 'I disagreed with my lead about…',
      servedBy: 'gpt-oss-120b · Groq',
      feedback: { score: 6, strengths: ['Honest'], gaps: ['No result'], improvedAnswer: '- **S**: …' }
    })
    svc.savePracticeItem(id, 1, { question: 'Why us?', type: 'behavioral', status: 'skipped', answer: '' })
    // Re-saving an index updates it.
    svc.savePracticeItem(id, 1, { question: 'Why us?', type: 'behavioral', status: 'skipped', answer: '' })
    svc.finishPractice(id, '**Overall** — solid start.', 6)
    now = 65_000
    svc.close()

    expect(svc.list()).toEqual([
      { id, kind: 'practice', startedAt: 5_000, endedAt: 65_000, title: 'Practice · Behavioral', questionCount: 2, costUsd: 0, sttSeconds: 0, averageScore: 6 }
    ])
    const s = svc.get(id)!
    expect(s.summary).toBe('**Overall** — solid start.')
    expect(s.practice).toEqual([
      expect.objectContaining({ index: 0, score: 6, strengths: ['Honest'], gaps: ['No result'], improvedAnswer: '- **S**: …', servedBy: 'gpt-oss-120b · Groq' }),
      expect.objectContaining({ index: 1, status: 'skipped', score: null, strengths: [], gaps: [] })
    ])

    const md = sessionToMarkdown(s, { formatDateTime: () => 'Oct 2', formatTime: () => '' })
    expect(md).toContain('# Practice · Behavioral — Oct 2')
    expect(md).toContain('1 of 2 answered · Average 6/10')
    expect(md).toContain('## Debrief')
    expect(md).toContain('*Behavioral · Score 6/10*')
    expect(md).toContain('**My answer**')
    expect(md).toContain('*Behavioral · Skipped*')

    // A practice run with nothing saved is dropped like an empty session.
    svc.openPractice('Practice · Mixed')
    svc.close()
    expect(svc.list()).toHaveLength(1)
    svc.dispose()
    rmSync(dir, { recursive: true, force: true })
  })
})
