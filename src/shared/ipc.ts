import { z } from 'zod'
import { API_KEY_PROVIDERS } from './settings'

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
  /** Running session cost in USD (populated from Phase 3). */
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

export const QUESTION_TYPES = ['behavioral', 'technical', 'coding', 'system_design', 'situational', 'smalltalk', 'other'] as const
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

export type NavigateTarget = 'session' | 'profile' | 'history' | 'practice' | 'settings'

export type SessionStartResult = { ok: true } | { ok: false; error: string; navigate?: NavigateTarget }
