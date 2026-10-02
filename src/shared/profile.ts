import { z } from 'zod'

/** Generous caps: a resume or JD is a few thousand characters. */
const MAX_DOC_CHARS = 60_000
const MAX_FIELD_CHARS = 200

/** Fields the user edits in the Profile tab. */
export const ProfileInputSchema = z.object({
  name: z.string().max(MAX_FIELD_CHARS).default(''),
  company: z.string().max(MAX_FIELD_CHARS).default(''),
  role: z.string().max(MAX_FIELD_CHARS).default(''),
  notes: z.string().max(10_000).default(''),
  resumeText: z.string().max(MAX_DOC_CHARS).default(''),
  resumeFileName: z.string().max(260).nullable().default(null),
  jdText: z.string().max(MAX_DOC_CHARS).default('')
})
export type ProfileInput = z.infer<typeof ProfileInputSchema>

export const ProfileSchema = ProfileInputSchema.extend({
  /** fastModel summaries (PRD §6.3); empty when the source text is empty or summarizing failed. */
  resumeSummary: z.string().default(''),
  jdSummary: z.string().default(''),
  /** Hashes of the texts the summaries were made from, to skip re-summarizing unchanged text. */
  resumeSummaryOf: z.string().nullable().default(null),
  jdSummaryOf: z.string().nullable().default(null),
  updatedAt: z.number().default(0)
})
export type Profile = z.infer<typeof ProfileSchema>

export const EMPTY_PROFILE: Profile = ProfileSchema.parse({})

export interface ProfileSaveResult {
  profile: Profile
  /** Set when the profile saved but a summary could not be generated. */
  summaryError?: string
}

export type ResumeImportResult =
  | { ok: true; fileName: string; text: string }
  | { ok: false; canceled: true }
  | { ok: false; canceled?: false; error: string }
