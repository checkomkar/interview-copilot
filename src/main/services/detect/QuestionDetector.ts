import { z } from 'zod'
import { QuestionTypeSchema, type QuestionType } from '@shared/ipc'

export type HeuristicVerdict = 'question' | 'not' | 'inconclusive'

export interface Detection {
  isQuestion: boolean
  type: QuestionType
  question: string
  via: 'heuristic' | 'classifier' | 'timeout' | 'fallback'
}

/** Leading filler stripped before checking for a question cue. */
const FILLER = /^(?:(?:so|okay|ok|alright|all right|and|um+|uh+|well|great|cool|right|now|next|perfect|got it|thanks|thank you)[\s,.!]+)+/i

const START_CUES =
  /^(?:what|what's|how|how's|why|when|where|which|who|tell me|walk me through|can you|could you|would you|will you|describe|explain|design|write|implement|have you|do you|did you|are you|is there|give me|talk me through|share)\b/i

/** Phrases that signal a question anywhere in the utterance (FR-Q2). */
const ANYWHERE_CUES =
  /\b(?:tell me about|walk me through|talk me through|can you (?:tell|describe|explain|walk|give|share|design|write|implement)|could you (?:tell|describe|explain|walk|give|share|design|write|implement)|how would you|what would you|how do you|how did you|why did you|have you ever|what is your|what's your|what are your|describe a time|give me an example)\b/i

/** Pleasantries and call logistics that look like questions but need no answer. */
const SMALLTALK =
  /^(?:how are you|how's it going|how is it going|how are things|how was your (?:day|weekend)|can you hear me|can you see my screen|is my screen|am i audible|are you there|any questions for (?:me|us))\b/i

/** Words a sentence rarely ends on: a pause after one usually means the speaker isn't done. */
const HANGING_WORDS = new Set(
  (
    'the a an your my our their his her its this that these those some any of to and or but nor so because ' +
    'about how what why which who whom whose when where if than then with without for in on at from by into ' +
    'onto over under between through during like as is are was were be been being am do does did can could ' +
    'would should will shall may might must have has had um uh er also just very really more most such'
  ).split(' ')
)

/**
 * True when an utterance looks cut off: speech-to-text adds closing punctuation when the speaker
 * finishes a sentence, so no `.?!` (or a sentence ending on "the", "your", "about"…) means they
 * probably paused mid-thought and will continue.
 */
export function looksIncomplete(text: string): boolean {
  const t = text.trim()
  if (!t) return false
  if (/[?!]["')\]]*$/.test(t)) return false
  const last = t.replace(/[.,;:…"')\]]+$/, '').split(/\s+/).at(-1)?.toLowerCase() ?? ''
  if (HANGING_WORDS.has(last)) return true
  return !/[.…]["')\]]*$/.test(t)
}

export function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length
}

/** Best-effort type from keywords, used when the classifier isn't consulted. */
export function guessType(text: string): QuestionType {
  const t = text.toLowerCase()
  if (/\b(design|architect)\b.*\b(system|service|platform|api|scal\w*|url shortener|feed|chat|cache)\b|\bsystem design\b|\bhigh[- ]level design\b/.test(t)) {
    return 'system_design'
  }
  if (/\b(write|implement|code|coding|function|algorithm|complexity|leetcode|array|linked list|binary tree|string|reverse|sort|big o)\b/.test(t)) {
    return 'coding'
  }
  if (/\b(tell me about a time|describe a time|give me an example|a situation where|conflict|disagree|mistake|failure|proud|challenge|weakness|strength|led a team|difficult)\b/.test(t)) {
    return 'behavioral'
  }
  if (/\b(what would you do if|how would you handle|imagine|suppose|if you were)\b/.test(t)) return 'situational'
  return 'technical'
}

/** Fast rule-based pass (FR-Q2). */
export function heuristic(text: string, minWords: number): HeuristicVerdict {
  const t = text.trim()
  if (!t) return 'not'
  const core = t.replace(FILLER, '')
  if (SMALLTALK.test(core)) return 'not'
  if (/\?\s*$/.test(t)) return 'question'
  if (START_CUES.test(core) || ANYWHERE_CUES.test(t)) return 'question'
  if (wordCount(t) < minWords) return 'not'
  return 'inconclusive'
}

const ClassifierSchema = z.object({
  is_question: z.boolean(),
  type: z.string(),
  clean_question: z.string().optional().default('')
})

export interface Classification {
  isQuestion: boolean
  type: QuestionType
  cleanQuestion: string
}

/** Strip code fences, parse, validate. Returns null on anything unexpected (PRD §6.2). */
export function parseClassifierOutput(raw: string): Classification | null {
  let text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  text = text.slice(start, end + 1)
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return null
  }
  const parsed = ClassifierSchema.safeParse(json)
  if (!parsed.success) return null
  const type = QuestionTypeSchema.safeParse(parsed.data.type)
  return {
    isQuestion: parsed.data.is_question,
    type: type.success ? type.data : 'other',
    cleanQuestion: parsed.data.clean_question.trim()
  }
}

export interface DetectorOptions {
  /** Calls the fast model; resolves to its raw text output. */
  classify: (utterance: string, context: string[], signal: AbortSignal) => Promise<string>
  minWords: () => number
  timeoutMs?: number
  /** On classifier timeout, treat as a question at or above this many words (FR-Q3). */
  timeoutQuestionWords?: number
}

export class QuestionDetector {
  private readonly timeoutMs: number
  private readonly timeoutQuestionWords: number

  constructor(private readonly opts: DetectorOptions) {
    this.timeoutMs = opts.timeoutMs ?? 1500
    this.timeoutQuestionWords = opts.timeoutQuestionWords ?? 8
  }

  /**
   * Decide whether `utterances` (interviewer text since the last answer, oldest first)
   * end in a question. `context` is earlier transcript for the classifier.
   */
  async detect(utterances: string[], context: string[]): Promise<Detection> {
    const text = utterances.join(' ').trim()
    const minWords = this.opts.minWords()
    const verdicts = utterances.map((u) => heuristic(u, minWords))
    const asked = verdicts.includes('question') || heuristic(text, minWords) === 'question'
    if (asked) return { isQuestion: true, type: guessType(text), question: text, via: 'heuristic' }

    const latest = utterances.at(-1) ?? ''
    // A trailing "okay" / "mm-hm" doesn't warrant a classifier call.
    if (wordCount(text) < minWords || wordCount(latest) < 3) {
      return { isQuestion: false, type: 'other', question: text, via: 'heuristic' }
    }

    const controller = new AbortController()
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), this.timeoutMs)
    })
    try {
      const raw = await Promise.race([this.opts.classify(text, context.slice(-3), controller.signal), timeout])
      if (raw === 'timeout') {
        controller.abort()
        return { isQuestion: wordCount(text) >= this.timeoutQuestionWords, type: guessType(text), question: text, via: 'timeout' }
      }
      const c = parseClassifierOutput(raw)
      if (!c) return this.fallback(text)
      // Pleasantries get no answer even when phrased as a question.
      const isQuestion = c.isQuestion && c.type !== 'smalltalk'
      return { isQuestion, type: c.type, question: c.cleanQuestion || text, via: 'classifier' }
    } catch {
      return this.fallback(text)
    } finally {
      clearTimeout(timer)
    }
  }

  /** Classifier failed: same rule as a timeout. */
  private fallback(text: string): Detection {
    return { isQuestion: wordCount(text) >= this.timeoutQuestionWords, type: guessType(text), question: text, via: 'fallback' }
  }
}
