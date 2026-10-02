import { describe, expect, it } from 'vitest'
import { TranscriptAssembler } from '../src/main/services/stt/TranscriptAssembler'

describe('TranscriptAssembler', () => {
  const make = () => {
    let t = 1000
    return new TranscriptAssembler('loopback', () => t++)
  }

  it('builds one utterance from partials and finals, then closes it', () => {
    const a = make()
    const p1 = a.onPartial('tell me')!
    expect(p1).toMatchObject({ text: 'tell me', isFinal: false, source: 'loopback' })
    const f1 = a.onFinal('Tell me about')!
    expect(f1.id).toBe(p1.id)
    expect(f1.text).toBe('Tell me about')
    expect(a.onPartial('yourself')!.text).toBe('Tell me about yourself')
    expect(a.onFinal('yourself.')!.text).toBe('Tell me about yourself.')
    expect(a.onUtteranceEnd()).toMatchObject({ id: p1.id, text: 'Tell me about yourself.', isFinal: true })
  })

  it('starts a new id after an utterance ends', () => {
    const a = make()
    const first = a.onFinal('one')!
    a.onUtteranceEnd()
    const second = a.onFinal('two')!
    expect(second.id).not.toBe(first.id)
    expect(second.text).toBe('two')
  })

  it('ignores empty results and empty utterance ends', () => {
    const a = make()
    expect(a.onPartial('  ')).toBeNull()
    expect(a.onFinal('')).toBeNull()
    expect(a.onUtteranceEnd()).toBeNull()
  })

  it('keeps a dangling partial when the utterance ends', () => {
    const a = make()
    a.onFinal('What is')
    a.onPartial('a closure')
    expect(a.onUtteranceEnd()!.text).toBe('What is a closure')
  })
})
