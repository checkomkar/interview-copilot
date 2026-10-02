import { z } from 'zod'
import { API_KEY_PROVIDERS, MAX_SCREENSHOTS } from './settings'

export { IPC } from './channels'

export const AudioSourceSchema = z.enum(['loopback', 'mic'])
export type AudioSource = z.infer<typeof AudioSourceSchema>

/** 16 kHz mono linear16 PCM, ~100 ms per chunk. */
export const AudioChunkSchema = z.object({
  source: AudioSourceSchema,
  pcm: z.custom<ArrayBuffer | Uint8Array>(
    (v) => v instanceof ArrayBuffer || v instanceof Uint8Array,
    'pcm must be an ArrayBuffer'
  ),
  ts: z.number()
})
export type AudioChunk = z.infer<typeof AudioChunkSchema>

export const AudioLevelSchema = z.object({
  source: AudioSourceSchema,
  rms: z.number().min(0).max(1)
})
export type AudioLevel = z.infer<typeof AudioLevelSchema>

export const CaptureStatusSchema = z.object({
  source: AudioSourceSchema,
  state: z.enum(['started', 'stopped', 'error']),
  message: z.string().optional()
})
export type CaptureStatus = z.infer<typeof CaptureStatusSchema>

export interface CaptureStartPayload {
  /** System audio; off for Practice Mode (mic only). */
  loopback: boolean
  mic: boolean
  micDeviceId: string | null
}

/** Start/stop just the mic mid-session (voice questions). */
export interface CaptureMicPayload {
  on: boolean
  deviceId: string | null
}

/**
 * Transcript update for one utterance. `id` is stable per utterance; renderers upsert by it.
 * `text` is the full utterance text so far; `isFinal` means the utterance has ended.
 */
export interface TranscriptUpdate {
  id: string
  source: AudioSource
  text: string
  isFinal: boolean
  ts: number
}

export type SessionStatus = 'idle' | 'starting' | 'listening' | 'reconnecting' | 'error'

export interface SessionState {
  status: SessionStatus
  /** Elapsed session time in ms. */
  elapsed: number
  /** Running session cost in USD (see CostUpdate for details). */
  cost: number
  message?: string
  /** Shown when the loopback stream has been silent too long. */
  hint?: string
  /** Voice questions: mic speech is answered directly (overlay mic toggle). */
  voiceAsk?: boolean
}

/**
 * - `stt`: audio streamed but not yet transcribed when a result arrived.
 * - `detect`: utterance end -> question detection finished.
 * - `firstToken`: utterance end (or hotkey) -> first answer token.
 */
export type LatencyStage = 'stt' | 'detect' | 'firstToken'

export interface LatencySample {
  stage: LatencyStage
  source: AudioSource
  ms: number
  ts: number
}

/** Interview types, then Work Mode's: `status` (a project status update) and `work` (any other question, or explaining the screen). */
export const QUESTION_TYPES = ['behavioral', 'technical', 'coding', 'system_design', 'situational', 'smalltalk', 'other', 'status', 'work'] as const
export const QuestionTypeSchema = z.enum(QUESTION_TYPES)
export type QuestionType = z.infer<typeof QuestionTypeSchema>

/** `auto` picks the style from the question type (FR-G6); `shorter` is the Ctrl+Shift+D variant. */
export type AnswerStyle = 'auto' | 'shorter'

/** Sent when an answer (re)starts. Re-sending an existing `id` resets that answer. */
export interface QuestionDetected {
  id: string
  question: string
  type: QuestionType
  style: AnswerStyle
  ts: number
  /** Thumbnails (data URLs) of the screenshots sent with this question, in order. */
  screenshots?: string[]
  /** Work Mode status update: the project's name. */
  project?: string
}

export interface AnswerToken {
  id: string
  delta: string
}

export interface AnswerUsage {
  model: string
  /** Upstream that served the request, when the API reports it (OpenRouter). */
  provider?: string
  /** Which configured LLM provider answered (after any failover). */
  service?: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  /** Cost the API reported for this request (OpenRouter), in USD. Otherwise priced from pricing.json. */
  costUsd?: number
}

/** "gpt-oss-120b · Groq": the model without its vendor prefix, and the service that answered. */
export function servedBy(usage: AnswerUsage): string {
  const model = usage.model.replace(/^[^/]+\//, '').replace(/:free$/, '')
  return [model, usage.service].filter(Boolean).join(' · ')
}

export interface AnswerDone {
  id: string
  usage: AnswerUsage
  /** Hit max_tokens. */
  truncated: boolean
}

export interface AnswerError {
  id: string
  message: string
  /** Some text was already streamed and is kept. */
  partial: boolean
}

export type QaStatus = 'thinking' | 'streaming' | 'done' | 'error'

/** One question/answer in the current session, as the overlay renders it. */
export interface QaSnapshot {
  id: string
  question: string
  type: QuestionType
  style: AnswerStyle
  answer: string
  status: QaStatus
  error?: string
  truncated?: boolean
  /** e.g. "gpt-oss-120b · Groq", shown under the answer. */
  servedBy?: string
  /** Thumbnails (data URLs) of the screenshots sent with the question, in order. */
  screenshots?: string[]
  /** Work Mode status update: which project, by id, and its name for display ("Mobile app · TOM approvals" for an item). */
  projectId?: string
  project?: string
  /** Work Mode: the item asked about (FR-W7a). */
  taskId?: string
}

/** Screenshots waiting to be sent with the next answer (FR-SC2/SC5), oldest first. */
export interface ScreenshotPending {
  thumbs: string[]
  /** How many can be attached to one question (Settings → Screen). */
  max: number
}

/** Remove one waiting screenshot (by position), or all of them. */
export const ScreenClearSchema = z.object({ index: z.number().int().min(0).max(MAX_SCREENSHOTS - 1).optional() }).optional()

export interface DisplayInfo {
  id: string
  label: string
  primary: boolean
}

export type CostStatus = 'ok' | 'warn' | 'capped'

/** Running cost of the current history session (FR-C1..C4). */
export interface CostUpdate {
  usd: number
  /** 0 = no cap. */
  capUsd: number
  /** `warn` at 80% of the cap; `capped` at 100% (answers use the fast models). */
  status: CostStatus
  sttSeconds: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  /** Models used this session with no price in pricing.json (counted as $0). */
  unpriced: string[]
}

export type OverlayNav = 'prev' | 'next'

/** A question typed into the overlay. */
export const AskSchema = z.object({ text: z.string().trim().min(1, 'Type a question first.').max(2000) })

export const VoiceAskSetSchema = z.object({ on: z.boolean() })

export type AnswerActionResult = { ok: true } | { ok: false; error: string }

export const SessionStartSchema = z.object({ profileId: z.string().nullable().optional() }).optional()

export const ApiKeySetSchema = z.object({
  provider: z.enum(API_KEY_PROVIDERS),
  key: z.string().max(500)
})

export type NavigateTarget = 'session' | 'profile' | 'projects' | 'history' | 'practice' | 'settings'

export type SessionStartResult = { ok: true } | { ok: false; error: string; navigate?: NavigateTarget }
