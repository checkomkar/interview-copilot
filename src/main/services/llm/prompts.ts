import type { AnswerStyle, AudioSource, QuestionType } from '@shared/ipc'
import type { Profile } from '@shared/profile'
import type { Settings } from '@shared/settings'
import type { LlmImagePart, LlmMessage, LlmSystemBlock } from './LlmProvider'

/** ~2,000 tokens of transcript (FR-G3). */
const TRANSCRIPT_CHARS = 8000
/** Raw resume/JD text used when no summary exists yet. */
const RAW_DOC_CHARS = 8000
/** Each earlier answer sent as context is clipped to this (the start holds the problem restatement). */
const EARLIER_ANSWER_CHARS = 1500

/** An earlier question and answer of this session, sent so follow-ups have context. */
export interface EarlierQa {
  question: string
  answer: string
}

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
  unless the question is coding, system design, or a follow-up.
- Follow-ups — questions about an earlier question in <earlier_qa>
  ("this question", "why", "what if", "can you improve it") — get a
  detailed answer about that specific problem: explain the reasoning,
  refer to its actual inputs, constraints and code, ~150–300 words,
  code if it helps. Never answer a follow-up generically.
- Speak in first person as the candidate, using their real experience
  from the resume below. Never invent employers, titles, or metrics.
  If the resume has nothing relevant, give a strong general answer and
  mark it "(general)".
- Behavioral: STAR format, one bullet each for S, T, A, R.
${
    settings.llm.codingAnswer === 'stepwise'
      ? `- Coding: first explain the problem in my own words, then three
  versions in order — pseudocode, a brute-force solution with its
  (poor) time/space complexity, then the optimal solution with its
  complexity. Code in ${lang} with brief comments.`
      : `- Coding: 2-3 bullet approach, time/space complexity, then clean code
  in ${lang} with brief comments.`
  }
- System design: requirements → components → data flow → trade-offs.
${settings.llm.diagrams ? `${DIAGRAM_RULE}\n` : ''}- If a screenshot is attached, use it as the primary source for the
  problem statement.
- If the transcript is garbled, answer the most likely intended question
  and show your interpretation in one italic line at the top.
- Format as Markdown. Use fenced code blocks with a language tag for code.

<resume_summary>${resume || '(not provided)'}</resume_summary>
<job_description_summary>${jd || '(not provided)'}</job_description_summary>
<candidate_notes>${profile.notes.trim() || '(none)'}</candidate_notes>`

  return [{ text, cache: true }]
}

/** Mermaid diagrams, drawn by the overlay (FR-G12). */
const DIAGRAM_RULE = `- Diagrams: for system design, and whenever I'm asked to draw, sketch
  or diagram something, include ONE Mermaid diagram in a \`\`\`mermaid
  block — \`flowchart LR\` for architecture and data flow,
  \`sequenceDiagram\` for request/message flows, \`erDiagram\` for
  schemas, \`classDiagram\` or \`stateDiagram-v2\` when they fit. At most
  ~10 nodes, short labels (quote labels with punctuation, e.g.
  A["API Gateway (REST)"]), no styling, classDef, notes or HTML. It must
  be valid Mermaid: I redraw it from the overlay while talking.`

/** The interviewer asked to draw something (architecture, sequence, flow, schema). */
const DRAW_RE = /\b(draw|drawing|sketch|diagram|whiteboard|flow ?chart|uml|er model)\b/i

export function asksForDiagram(question: string): boolean {
  return DRAW_RE.test(question)
}

const DRAW_STYLE = 'They asked me to draw it: the Mermaid diagram first, then 3–5 bullets walking through it in the order I would draw it.'

const STYLE: Record<QuestionType, string> = {
  behavioral: 'STAR bullets: one each for **S**ituation, **T**ask, **A**ction, **R**esult.',
  situational: 'STAR-style bullets: how I would approach it, grounded in a similar real experience if the resume has one.',
  technical: '3–5 key bullets, then a one-line summary.',
  coding: 'Approach in 2–3 bullets, time/space complexity, then the code.',
  system_design: 'Bullets: requirements → components → data flow → trade-offs.',
  smalltalk: 'One or two natural, friendly sentences.',
  other: '3–5 key bullets, then a one-line summary.',
  // Work Mode types have their own prompts (workPrompts.ts); these only apply if one reaches the interview prompt.
  status: '3–5 natural spoken sentences.',
  work: '3–5 key bullets, then a one-line summary.'
}

const SHORTER = 'Give a much shorter version: at most 3 bullets or ~50 words. Keep code only if the question needs it.'

/**
 * Step-by-step coding answers: interviewers expect a candidate to reach the optimal solution in
 * stages, so the answer walks the same path (pseudocode → brute force → optimal).
 */
const STEPWISE_CODING = `Four sections, in this order, each under its own heading:
### 1. Understanding the problem
What is being asked, in my own words (1–2 sentences); inputs → output with their types and constraints; a quick walk-through of the example; edge cases and any assumptions I'd confirm with the interviewer.
### 2. Pseudocode
Numbered plain-language steps of the simplest correct idea (no real code).
### 3. Brute force — O(…) time, O(…) space
Complete working code for the straightforward approach, then one line on why its complexity is poor.
### 4. Optimal — O(…) time, O(…) space
The key insight in 1–2 bullets, then complete working code, then edge cases in one line.
Fill in the real complexities in the headings. If the brute force is already optimal, say so in section 4 instead of repeating the code.`

/** Shorter on a step-by-step coding answer: just the final solution. */
const SHORTER_CODING = 'Give only the optimal solution: the key idea in one line, the code, and its time/space complexity. No pseudocode or brute force.'

/** Asked when the screenshot hotkey is pressed with no question pending (FR-SC2). */
export const SCREEN_QUESTION = "Solve / answer what's shown on screen."

function codingFromScreen(stepwise: boolean): string {
  return stepwise
    ? `If it shows a coding problem, answer it like this:\n${STEPWISE_CODING}`
    : 'If it shows a coding problem, give the approach (2–3 bullets), time/space complexity, then complete working code.'
}

/** `coding`: how to answer if the screenshot shows a coding problem ('' when the style already says). */
function screenshotNote(count: number, coding: string): string {
  if (count === 1) return `A screenshot of my screen is attached; treat it as the primary source for the problem.${coding ? ` ${coding}` : ''}`
  return `${count} screenshots of my screen are attached, in order — parts of the same screen captured while scrolling, so they may overlap. Combine them into one problem statement and treat it as the primary source; give one answer.${coding ? ` ${coding}` : ''}`
}

/** `them`: the label for the other side of the call ("Interviewer", or "Them" in Work Mode). */
export function formatTranscript(lines: TranscriptLine[], maxChars = TRANSCRIPT_CHARS, them = 'Interviewer'): string {
  const out: string[] = []
  let used = 0
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = `${lines[i].source === 'loopback' ? them : 'Me'}: ${lines[i].text}`
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
  images?: LlmImagePart[]
  /** Coding answers as understanding → pseudocode → brute force → optimal (settings.llm.codingAnswer). Default on. */
  stepwise?: boolean
  /** Earlier Q&As of this session, oldest first, so follow-ups have context. */
  earlier?: EarlierQa[]
  /** Mermaid diagrams on (settings.llm.diagrams). Default on. */
  diagrams?: boolean
}): LlmMessage[] {
  const images = opts.images ?? []
  const stepwise = opts.stepwise ?? true
  const shorter = opts.style === 'shorter'
  // Step-by-step applies to coding questions, and to screenshots that turn out to be coding problems.
  const codingSteps = stepwise && opts.type === 'coding'
  const draw = (opts.diagrams ?? true) && !codingSteps && asksForDiagram(opts.question)
  const style = codingSteps ? (shorter ? SHORTER_CODING : STEPWISE_CODING) : draw ? DRAW_STYLE : STYLE[opts.type]
  const shorterNote = shorter && !codingSteps ? `\n${SHORTER}` : ''
  const screenNote = images.length ? `\n${screenshotNote(images.length, codingSteps ? '' : codingFromScreen(stepwise && !shorter))}` : ''
  const transcript = formatTranscript(opts.transcript)
  const earlier = opts.earlier ?? []
  const earlierBlock = earlier.length
    ? `<earlier_qa>
${earlier.map((q, i) => `<qa n="${i + 1}">\n<question>${q.question}</question>\n<answer>\n${clip(q.answer, EARLIER_ANSWER_CHARS)}\n</answer>\n</qa>`).join('\n')}
</earlier_qa>

`
    : ''
  const followUpNote = earlier.length
    ? '\nIf this question follows up on an earlier one above, it is a follow-up: ignore the style above and the ~120-word limit, and answer in detail (150–300 words) about that specific problem — walk through the reasoning using its actual inputs, constraints, example and code; short paragraphs or bullets, code if it helps.'
    : ''
  const text = `${earlierBlock}<transcript>
${transcript || '(no transcript yet)'}
</transcript>

<question type="${opts.type}">${opts.question}</question>

Answer style: ${style}${screenNote}${followUpNote}${shorterNote}`
  if (!images.length) return [{ role: 'user', content: text }]
  return [{ role: 'user', content: [...images, { type: 'text', text }] }]
}

/**
 * Screenshots are usually coding problems or diagrams, and follow-ups (`withEarlier`: there are
 * earlier Q&As) need detailed answers, so both get the long budget.
 */
export function answerMaxTokens(type: QuestionType, style: AnswerStyle, settings: Settings, withImage = false, withEarlier = false, question = ''): number {
  const diagram = settings.llm.diagrams && asksForDiagram(question)
  const long = withImage || withEarlier || diagram || type === 'coding' || type === 'system_design'
  const base = long ? settings.llm.maxTokensCoding : settings.llm.maxTokens
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

export function clip(text: string, max: number): string {
  const t = text.trim()
  return t.length > max ? `${t.slice(0, max)}…` : t
}
