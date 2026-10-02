import { z } from 'zod'
import type { Profile } from '@shared/profile'
import {
  PRACTICE_QUESTION_TYPES,
  PRACTICE_ROUND_LABELS,
  PracticeFeedbackSchema,
  type PracticeFeedback,
  type PracticeItem,
  type PracticeQuestionType,
  type PracticeRound
} from '@shared/practice'
import type { LlmMessage, LlmSystemBlock } from '../llm/LlmProvider'

const DOC_CHARS = 6000

const ROUND_BRIEF: Record<PracticeRound, string> = {
  behavioral: 'behavioral questions (past experience: conflict, ownership, failure, leadership, impact)',
  technical: 'technical questions about concepts, trade-offs and the technologies in the resume and job description (answerable out loud — no writing code)',
  system_design: 'system design questions sized for a spoken answer of a few minutes (requirements, components, data flow, scaling, trade-offs)',
  mixed: 'a realistic mix: start with one warm-up, then behavioral, technical, situational and (for engineering roles) one system design question'
}

/** Interviewer context shared by every practice prompt. Stable for a run, so it is cacheable. */
export function buildPracticeSystem(profile: Profile): LlmSystemBlock[] {
  const role = profile.role.trim() || 'the role'
  const company = profile.company.trim() || 'the company'
  const resume = profile.resumeSummary || clip(profile.resumeText)
  const jd = profile.jdSummary || clip(profile.jdText)
  const text = `You are an experienced interviewer running a mock interview for ${role} at ${company}.
You know the candidate's resume and the job description below. Be specific, fair and direct.

<resume_summary>${resume || '(not provided)'}</resume_summary>
<job_description_summary>${jd || '(not provided)'}</job_description_summary>
<candidate_notes>${profile.notes.trim() || '(none)'}</candidate_notes>`
  return [{ text, cache: true }]
}

/** Practice questions for a round (FR-P2), personalised to the resume and JD. */
export function buildPracticeQuestionsMessages(round: PracticeRound, count: number): LlmMessage[] {
  return [
    {
      role: 'user',
      content: `Write ${count} interview questions for a ${PRACTICE_ROUND_LABELS[round].toLowerCase()} round: ${ROUND_BRIEF[round]}.

- Tailor them to this candidate: refer to their real projects, employers and skills, and to what the job needs.
- Each question is read aloud, so keep it to one or two spoken sentences, without lists or code.
- No duplicates; vary the topics; order them as a real interview would.

Return ONLY JSON:
{"questions": [{"question": "...", "type": "${PRACTICE_QUESTION_TYPES.join('|')}"}]}`
    }
  ]
}

/** Feedback on one answer (PRD §6.4, FR-P3). */
export function buildFeedbackMessages(question: string, type: PracticeQuestionType, answer: string): LlmMessage[] {
  return [
    {
      role: 'user',
      content: `Score the candidate's answer to this ${type.replace('_', ' ')} question. The answer was spoken and transcribed, so ignore filler words and transcription slips.

<question>${question}</question>
<answer>${answer}</answer>

Scoring: 1–3 off-topic or very weak, 4–6 partial (missing structure, specifics or results), 7–8 solid, 9–10 excellent and specific with measurable impact. Behavioral answers should follow STAR.

Return ONLY JSON:
{"score": 1-10,
 "strengths": ["short point", "..."],
 "gaps": ["what was missing or weak, and how to fix it", "..."],
 "improved_answer": "a stronger version in Markdown, first person, using only facts from the resume (mark anything assumed as [example]); under 200 words"}`
    }
  ]
}

/** End-of-practice summary (FR-P4). */
export function buildPracticeSummaryMessages(round: PracticeRound, items: PracticeItem[]): LlmMessage[] {
  const answered = items
    .map((it, i) => {
      if (!it.feedback) return `${i + 1}. ${it.question}\n   (${it.status === 'skipped' ? 'skipped' : 'not answered'})`
      return `${i + 1}. ${it.question}\n   Score ${it.feedback.score}/10. Strengths: ${it.feedback.strengths.join('; ') || '—'}. Gaps: ${it.feedback.gaps.join('; ') || '—'}`
    })
    .join('\n')
  return [
    {
      role: 'user',
      content: `The ${PRACTICE_ROUND_LABELS[round].toLowerCase()} mock interview is over. Per-question results:

${answered}

Write the debrief in Markdown, under 200 words, addressed to the candidate as "you":
**Overall** — one or two sentences on how it went.
**What worked** — 2–3 bullets.
**Work on next** — the 3 most important things to practise, as concrete bullets.
No heading above it and no per-question recap.`
    }
  ]
}

const QuestionsSchema = z.object({
  questions: z.array(z.object({ question: z.string().min(5), type: z.string().optional() })).min(1)
})

/** Strip code fences and surrounding prose, then parse the first JSON object. */
export function extractJson(raw: string): unknown {
  const text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  try {
    return JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
}

export function parsePracticeQuestions(raw: string, count: number): { question: string; type: PracticeQuestionType }[] | null {
  const parsed = QuestionsSchema.safeParse(extractJson(raw))
  if (!parsed.success) return null
  const seen = new Set<string>()
  const out: { question: string; type: PracticeQuestionType }[] = []
  for (const q of parsed.data.questions) {
    const question = q.question.replace(/\s+/g, ' ').trim()
    const key = question.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    const type = (PRACTICE_QUESTION_TYPES as readonly string[]).includes(q.type ?? '') ? (q.type as PracticeQuestionType) : 'behavioral'
    out.push({ question, type })
  }
  return out.slice(0, count)
}

export function parseFeedback(raw: string): PracticeFeedback | null {
  const parsed = PracticeFeedbackSchema.safeParse(extractJson(raw))
  if (!parsed.success) return null
  const clean = (list: string[]) => list.map((s) => s.trim()).filter(Boolean)
  return {
    score: parsed.data.score,
    strengths: clean(parsed.data.strengths),
    gaps: clean(parsed.data.gaps),
    improvedAnswer: parsed.data.improved_answer.trim()
  }
}

/** Used when the summary request fails: the numbers, without the prose. */
export function fallbackSummary(items: PracticeItem[], average: number | undefined): string {
  const reviewed = items.filter((i) => i.feedback)
  if (!reviewed.length) return 'No answers were reviewed in this run.'
  const gaps = reviewed.flatMap((i) => i.feedback!.gaps).slice(0, 3)
  return [
    `**Overall** — average ${average}/10 across ${reviewed.length} answer${reviewed.length === 1 ? '' : 's'}.`,
    gaps.length ? `\n**Work on next**\n${gaps.map((g) => `- ${g}`).join('\n')}` : ''
  ].join('\n')
}

function clip(text: string): string {
  const t = text.trim()
  return t.length > DOC_CHARS ? `${t.slice(0, DOC_CHARS)}…` : t
}
