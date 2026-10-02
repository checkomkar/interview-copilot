import type { AudioSource, TranscriptUpdate } from '@shared/ipc'

/**
 * Groups streaming STT segments into utterances for one audio source.
 * An utterance stays open across finalized segments and closes on `utteranceEnd`.
 */
export class TranscriptAssembler {
  private seq = 0
  private currentId: string | null = null
  private finals: string[] = []
  private partial = ''

  constructor(
    private readonly source: AudioSource,
    private readonly now: () => number = Date.now
  ) {}

  onPartial(text: string): TranscriptUpdate | null {
    if (!text.trim()) return null
    this.partial = text
    return this.update(false)
  }

  onFinal(text: string): TranscriptUpdate | null {
    this.partial = ''
    if (text.trim()) this.finals.push(text.trim())
    if (this.finals.length === 0) return null
    return this.update(false)
  }

  /** Close the current utterance. Returns its final form, or null if nothing was said. */
  onUtteranceEnd(): TranscriptUpdate | null {
    if (this.partial.trim()) this.finals.push(this.partial.trim())
    this.partial = ''
    if (this.finals.length === 0) {
      this.currentId = null
      return null
    }
    const out = this.update(true)
    this.currentId = null
    this.finals = []
    return out
  }

  private update(isFinal: boolean): TranscriptUpdate {
    if (!this.currentId) this.currentId = `${this.source}-${this.now()}-${++this.seq}`
    const text = [...this.finals, this.partial].filter(Boolean).join(' ')
    return { id: this.currentId, source: this.source, text, isFinal, ts: this.now() }
  }
}
