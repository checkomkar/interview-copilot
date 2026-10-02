import { z } from 'zod'
import type { AudioSource, QaStatus, QuestionType } from './ipc'
import type { PracticeItemStatus, PracticeQuestionType } from './practice'

/**
 * `copilot`: an Interview Mode session (or questions asked outside one). `work`: a Work Mode call.
 * `practice`: a Practice Mode run.
 */
export type HistoryKind = 'copilot' | 'work' | 'practice'

/** One saved session in the History list (FR-D2, U9). */
export interface HistorySessionSummary {
  id: string
  kind: HistoryKind
  startedAt: number
  /** null while the session is still open. */
  endedAt: number | null
  /** First question, for the list. */
  title: string
  questionCount: number
  costUsd: number
  sttSeconds: number
  /** Practice: mean score of the reviewed answers. */
  averageScore: number | null
}

export interface HistoryUtterance {
  source: AudioSource
  text: string
  ts: number
}

export interface HistoryQa {
  id: string
  question: string
  type: QuestionType
  answer: string
  status: QaStatus
  error: string | null
  servedBy: string | null
  ts: number
  /** Data URLs of the saved screenshots, when screenshots are kept. */
  screenshots: string[]
  /** How many screenshots were sent with the question (even if they weren't kept). */
  screenshotCount: number
  /** Work Mode status update: the project's name. */
  project: string | null
}

/** One question of a practice run, with the user's answer and its feedback. */
export interface HistoryPracticeItem {
  index: number
  question: string
  type: PracticeQuestionType
  status: PracticeItemStatus
  answer: string
  score: number | null
  strengths: string[]
  gaps: string[]
  improvedAnswer: string
  servedBy: string | null
  ts: number
}

export interface HistorySession extends HistorySessionSummary {
  utterances: HistoryUtterance[]
  qas: HistoryQa[]
  /** Practice runs only. */
  practice: HistoryPracticeItem[]
  /** Practice runs: the end-of-practice debrief (Markdown). */
  summary: string | null
}

export const HistoryIdSchema = z.object({ id: z.string().min(1).max(100) })

export type HistoryExportResult = { ok: true; path: string } | { ok: false; canceled?: boolean; error?: string }
