import { z } from 'zod'

/** Practice Mode (FR-P1..P4): AI interviewer, spoken questions, feedback on the user's answers. */

export const PRACTICE_ROUNDS = ['behavioral', 'technical', 'system_design', 'mixed'] as const
export type PracticeRound = (typeof PRACTICE_ROUNDS)[number]

export const PRACTICE_ROUND_LABELS: Record<PracticeRound, string> = {
  behavioral: 'Behavioral',
  technical: 'Technical',
  system_design: 'System design',
  mixed: 'Mixed'
}

export const PRACTICE_COUNTS = [5, 10, 15] as const

export const PracticeStartSchema = z.object({
  round: z.enum(PRACTICE_ROUNDS),
  count: z.union([z.literal(5), z.literal(10), z.literal(15)])
})
export type PracticeStart = z.infer<typeof PracticeStartSchema>

/** A typed answer (instead of, or after, speaking). */
export const PracticeSubmitSchema = z.object({ text: z.string().trim().min(1, 'Type an answer first.').max(8000) })

/** Question types the interviewer asks; `system_design` and coding-style technical questions are spoken, not coded. */
export const PRACTICE_QUESTION_TYPES = ['behavioral', 'technical', 'system_design', 'situational'] as const
export type PracticeQuestionType = (typeof PRACTICE_QUESTION_TYPES)[number]

/** Feedback on one answer (§6.4). */
export const PracticeFeedbackSchema = z.object({
  score: z.coerce.number().min(1).max(10).transform((n) => Math.round(n)),
  strengths: z.array(z.string()).max(10).default([]),
  gaps: z.array(z.string()).max(10).default([]),
  improved_answer: z.string().default('')
})
export interface PracticeFeedback {
  score: number
  strengths: string[]
  gaps: string[]
  improvedAnswer: string
}

/**
 * - `pending`: not reached yet. `asking`: shown and read aloud. `recording`: mic answer in progress.
 * - `reviewing`: feedback being written. `reviewed`: feedback shown. `skipped`. `error`: feedback failed.
 */
export type PracticeItemStatus = 'pending' | 'asking' | 'recording' | 'reviewing' | 'reviewed' | 'skipped' | 'error'

export interface PracticeItem {
  question: string
  type: PracticeQuestionType
  status: PracticeItemStatus
  /** The user's answer (spoken and transcribed, or typed). */
  answer: string
  feedback?: PracticeFeedback
  error?: string
  /** Model that wrote the feedback, e.g. "gpt-oss-120b · Groq". */
  servedBy?: string
}

/**
 * - `idle`: nothing running. `generating`: writing the questions. `running`: going through them.
 * - `summarizing`: writing the end-of-practice summary. `done`: summary shown and saved. `error`: could not start.
 */
export type PracticeStatus = 'idle' | 'generating' | 'running' | 'summarizing' | 'done' | 'error'

export interface PracticeState {
  status: PracticeStatus
  round: PracticeRound
  items: PracticeItem[]
  /** Index of the current question. */
  current: number
  /** What the mic is hearing right now (not yet part of the answer). */
  live: string
  /** Markdown, when done. */
  summary?: string
  /** Mean score of the reviewed answers. */
  averageScore?: number
  error?: string
  /** History session the run is saved to. */
  sessionId?: string
}

export type PracticeResult = { ok: true } | { ok: false; error: string; navigate?: 'settings' | 'profile' }

export const IDLE_PRACTICE: PracticeState = { status: 'idle', round: 'mixed', items: [], current: 0, live: '' }

/** Mean of the scores, to one decimal; undefined with no reviewed answers. */
export function averageScore(items: PracticeItem[]): number | undefined {
  const scores = items.flatMap((i) => (i.feedback ? [i.feedback.score] : []))
  if (!scores.length) return undefined
  return Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10
}
