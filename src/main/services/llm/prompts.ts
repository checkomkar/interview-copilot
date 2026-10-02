import type { AnswerStyle, AudioSource, QuestionType } from '@shared/ipc'
import type { Profile } from '@shared/profile'
import type { Settings } from '@shared/settings'
import type { LlmMessage, LlmSystemBlock } from './LlmProvider'

/** ~2,000 tokens of transcript (FR-G3). */
const TRANSCRIPT_CHARS = 8000
/** Raw resume/JD text used when no summary exists yet. */
const RAW_DOC_CHARS = 8000

export interface TranscriptLine {
  source: AudioSource
  text: string
}

/**
 * Answer system prompt (PRD §6.1). Everything here is stable for a session so the
 * whole block is one cacheable prefix (FR-G5); per-question content goes in the user turn.
 */
export function buildAnswerSystem(profile: Profile, settings: Settings): LlmSystemBlock[] {
  const name = profile.name.trim() || 'the candidate'
  const role = profile.role.trim() ? `a ${profile.role.trim()} role` : 'a role'
  const company = profile.company.trim() || 'the company'
  const lang = settings.preferredLanguage
  const resume = profile.resumeSummary || clip(profile.resumeText, RAW_DOC_CHARS)
  const jd = profile.jdSummary || clip(profile.jdText, RAW_DOC_CHARS)

  const text = `You are a real-time interview assistant helping ${name} answer questions
for ${role} at ${company}. Answers are read at a glance during a
live conversation.

Rules:
- Lead with the answer. No preamble, no restating the question.
- Keep it scannable: short bullets, bold key terms, max ~120 words
  unless the question is coding or system design.
- Speak in first person as the candidate, using their real experience
  from the resume below. Never invent employers, titles, or metrics.
  If the resume has nothing relevant, give a strong general answer and
  mark it "(general)".
- Behavioral: STAR format, one bullet each for S, T, A, R.
- Coding: 2-3 bullet approach, time/space complexity, then clean code
  in ${lang} with brief comments.
- System design: requirements → components → data flow → trade-offs.
- If a screenshot is attached, use it as the primary source for the
  problem statement.
- If the transcript is garbled, answer the most likely intended question
  and show your interpretation in one italic line at the top.
- Format as Markdown. Use fenced code blocks with a language tag for code.

<resume_summary>${resume || '(not provided)'}</resume_summary>
<job_description_summary>${jd || '(not provided)'}</job_description_summary>
<candidate_notes>${profile.notes.trim() || '(none)'}</candidate_notes>`

  return [{ text, cache: true }]
}

const STYLE: Record<QuestionType, string> = {
  behavioral: 'STAR bullets: one each for **S**ituation, **T**ask, **A**ction, **R**esult.',
  situational: 'STAR-style bullets: how I would approach it, grounded in a similar real experience if the resume has one.',
  technical: '3–5 key bullets, then a one-line summary.',
  coding: 'Approach in 2–3 bullets, time/space complexity, then the code.',
  system_design: 'Bullets: requirements → components → data flow → trade-offs.',
  smalltalk: 'One or two natural, friendly sentences.',
  other: '3–5 key bullets, then a one-line summary.'
}

const SHORTER = 'Give a much shorter version: at most 3 bullets or ~50 words. Keep code only if the question needs it.'

export function formatTranscript(lines: TranscriptLine[], maxChars = TRANSCRIPT_CHARS): string {
  const out: string[] = []
  let used = 0
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = `${lines[i].source === 'loopback' ? 'Interviewer' : 'Me'}: ${lines[i].text}`
    if (used + line.length > maxChars && out.length > 0) break
    out.unshift(line)
    used += line.length + 1
  }
  return out.join('\n')
}

export function buildAnswerMessages(opts: {
  question: string
  type: QuestionType
  style: AnswerStyle
  transcript: TranscriptLine[]
}): LlmMessage[] {
  const transcript = formatTranscript(opts.transcript)
  const content = `<transcript>
${transcript || '(no transcript yet)'}
</transcript>

<question type="${opts.type}">${opts.question}</question>

Answer style: ${STYLE[opts.type]}${opts.style === 'shorter' ? `\n${SHORTER}` : ''}`
  return [{ role: 'user', content }]
}

export function answerMaxTokens(type: QuestionType, style: AnswerStyle, settings: Settings): number {
  const base = type === 'coding' || type === 'system_design' ? settings.llm.maxTokensCoding : settings.llm.maxTokens
  return style === 'shorter' ? Math.max(100, Math.ceil(base / 2)) : base
}

/** Question classifier prompt (PRD §6.2). */
export function buildClassifierMessages(utterance: string, context: string[]): LlmMessage[] {
  const content = `Classify the interviewer's latest utterance. Return ONLY JSON:
{"is_question": boolean,
 "type": "behavioral|technical|coding|system_design|situational|smalltalk|other",
 "clean_question": "the question rewritten clearly, fixing transcription errors"}

Recent context: ${context.length ? context.map((c) => `"${c}"`).join(' ') : '(none)'}
Latest utterance: "${utterance}"`
  return [{ role: 'user', content }]
}

/** Profile summary prompts (PRD §6.3). */
export function buildResumeSummaryMessages(resumeText: string): LlmMessage[] {
  return [
    {
      role: 'user',
      content: `Summarize this resume in at most 400 tokens for an interview assistant. Include:
- Roles with company names and dates
- Top 5 projects with tech stack and measurable outcomes
- Core skills
Use terse bullets. Only include facts stated in the resume. Return just the summary.

<resume>
${resumeText}
</resume>`
    }
  ]
}

export function buildJdSummaryMessages(jdText: string): LlmMessage[] {
  return [
    {
      role: 'user',
      content: `Summarize this job description in at most 200 tokens for an interview assistant. Include:
- Must-have skills
- Key responsibilities
- Company / product context
Use terse bullets. Return just the summary.

<job_description>
${jdText}
</job_description>`
    }
  ]
}

function clip(text: string, max: number): string {
  const t = text.trim()
  return t.length > max ? `${t.slice(0, max)}…` : t
}
