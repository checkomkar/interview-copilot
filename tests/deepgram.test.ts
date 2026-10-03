import { describe, expect, it } from 'vitest'
import { buildDeepgramUrl, parseDeepgramMessage } from '../src/main/services/stt/DeepgramProvider'

describe('parseDeepgramMessage', () => {
  it('parses an interim Results message', () => {
    const ev = parseDeepgramMessage(
      JSON.stringify({
        type: 'Results',
        start: 1.5,
        duration: 0.75,
        is_final: false,
        speech_final: false,
        channel: { alternatives: [{ transcript: 'tell me about', confidence: 0.9 }] }
      })
    )
    expect(ev).toEqual({ type: 'transcript', text: 'tell me about', isFinal: false, speechFinal: false, start: 1.5, end: 2.25 })
  })

  it('parses a final, speech_final Results message', () => {
    const ev = parseDeepgramMessage(
      JSON.stringify({ type: 'Results', start: 0, duration: 2, is_final: true, speech_final: true, channel: { alternatives: [{ transcript: 'Hi.' }] } })
    )
    expect(ev).toMatchObject({ type: 'transcript', isFinal: true, speechFinal: true, text: 'Hi.' })
  })

  it('handles UtteranceEnd, Error, unknown and garbage', () => {
    expect(parseDeepgramMessage('{"type":"UtteranceEnd","last_word_end":2.1}')).toEqual({ type: 'utteranceEnd' })
    expect(parseDeepgramMessage('{"type":"Error","description":"bad model"}')).toEqual({ type: 'error', message: 'bad model' })
    expect(parseDeepgramMessage('{"type":"Metadata"}')).toEqual({ type: 'ignored' })
    expect(parseDeepgramMessage('not json').type).toBe('error')
  })

  it('tolerates missing alternatives', () => {
    expect(parseDeepgramMessage('{"type":"Results","channel":{}}')).toMatchObject({ type: 'transcript', text: '' })
  })
})

describe('buildDeepgramUrl', () => {
  it('includes the streaming parameters from settings and never the key', () => {
    const url = new URL(
      buildDeepgramUrl({ apiKey: 'SECRET_KEY_123', model: 'nova-3', language: 'en', endpointingMs: 300, utteranceEndMs: 1000 })
    )
    expect(url.origin + url.pathname).toBe('wss://api.deepgram.com/v1/listen')
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      model: 'nova-3',
      encoding: 'linear16',
      sample_rate: '16000',
      channels: '1',
      interim_results: 'true',
      smart_format: 'true',
      endpointing: '300',
      utterance_end_ms: '1000'
    })
    expect(url.toString()).not.toContain('SECRET_KEY_123')
  })

  it('uses the EU endpoint when that region is picked', () => {
    const url = new URL(buildDeepgramUrl({ apiKey: 'k', model: 'nova-3', language: 'en', endpointingMs: 300, utteranceEndMs: 1000, region: 'eu' }))
    expect(url.origin + url.pathname).toBe('wss://api.eu.deepgram.com/v1/listen')
  })
})
