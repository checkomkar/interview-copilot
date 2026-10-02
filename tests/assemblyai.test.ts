import { afterEach, describe, expect, it } from 'vitest'
import type { AddressInfo } from 'node:net'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import { AssemblyAIProvider, buildAssemblyAIUrl, parseAssemblyAIMessage } from '../src/main/services/stt/AssemblyAIProvider'

const opts = {
  apiKey: 'aai-test-key-123456',
  model: 'universal-streaming-english',
  language: 'en',
  minTurnSilenceMs: 300,
  maxTurnSilenceMs: 1000
}

const turn = (over: Record<string, unknown>) =>
  JSON.stringify({ type: 'Turn', turn_order: 0, end_of_turn: false, turn_is_formatted: false, transcript: '', words: [], ...over })
const words = (...w: string[]) => w.map((text, i) => ({ text, start: i * 200, end: i * 200 + 150, word_is_final: true }))

describe('parseAssemblyAIMessage', () => {
  it('reads partial turns from the word list (transcript only has finalized words)', () => {
    const ev = parseAssemblyAIMessage(turn({ transcript: 'tell', words: words('tell', 'me', 'about') }))
    expect(ev).toEqual({ type: 'turn', order: 0, text: 'tell me about', endOfTurn: false, formatted: false, endSec: 0.55 })
  })

  it('reads finished turns from the utterance', () => {
    const ev = parseAssemblyAIMessage(turn({ end_of_turn: true, turn_is_formatted: true, transcript: 'Tell me about yourself.', utterance: 'Tell me about yourself.' }))
    expect(ev).toMatchObject({ type: 'turn', text: 'Tell me about yourself.', endOfTurn: true, formatted: true })
  })

  it('handles other messages', () => {
    expect(parseAssemblyAIMessage('{"type":"Begin","id":"x"}')).toEqual({ type: 'ignored' })
    expect(parseAssemblyAIMessage('{"type":"Termination"}')).toEqual({ type: 'ignored' })
    expect(parseAssemblyAIMessage('{"error":"bad sample rate"}')).toEqual({ type: 'error', message: 'bad sample rate' })
    expect(parseAssemblyAIMessage('nope').type).toBe('error')
  })
})

describe('buildAssemblyAIUrl', () => {
  it('sends the model, audio format and turn silences, never the key', () => {
    const url = new URL(buildAssemblyAIUrl(opts))
    expect(url.origin + url.pathname).toBe('wss://streaming.assemblyai.com/v3/ws')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      speech_model: 'universal-streaming-english',
      encoding: 'pcm_s16le',
      sample_rate: '16000',
      min_turn_silence: '300',
      max_turn_silence: '1000',
      format_turns: 'true'
    })
    expect(url.toString()).not.toContain('aai-test-key')
  })

  it('Universal-3 Pro formats on its own; other languages are steered with language_codes', () => {
    const url = new URL(buildAssemblyAIUrl({ ...opts, model: 'universal-3-6-pro', language: 'hi' }))
    expect(url.searchParams.has('format_turns')).toBe(false)
    expect(url.searchParams.get('language_codes')).toBe('["hi"]')
  })
})

async function fakeAssemblyAI() {
  const http: Server = createServer()
  const wss = new WebSocketServer({ noServer: true })
  const sockets: WebSocket[] = []
  const requests: IncomingMessage[] = []
  const received: (Buffer | string)[] = []
  http.on('upgrade', (req, socket, head) => {
    requests.push(req)
    wss.handleUpgrade(req, socket, head, (ws) => {
      sockets.push(ws)
      ws.on('message', (data, isBinary) => received.push(isBinary ? (data as Buffer) : data.toString()))
    })
  })
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r))
  const port = (http.address() as AddressInfo).port
  return {
    url: `ws://127.0.0.1:${port}/v3/ws`,
    sockets,
    requests,
    received,
    close: async () => {
      for (const s of sockets) s.terminate()
      wss.close()
      await new Promise((r) => http.close(r))
    }
  }
}

const until = async (cond: () => boolean, ms = 3000) => {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

function listen(p: AssemblyAIProvider) {
  const partials: string[] = []
  const finals: string[] = []
  const errors: [string, boolean][] = []
  let ended = 0
  p.on('partial', (r) => partials.push(r.text))
  p.on('final', (r) => finals.push(r.text))
  p.on('utteranceEnd', () => ended++)
  p.on('error', (e, fatal) => errors.push([e.message, fatal]))
  return { partials, finals, errors, ended: () => ended }
}

describe('AssemblyAIProvider (against a fake server)', () => {
  it('authenticates with the raw key, keeps the formatted turn, and terminates on stop', async () => {
    const srv = await fakeAssemblyAI()
    cleanups.push(srv.close)
    const p = new AssemblyAIProvider({ ...opts, baseUrl: srv.url })
    const ev = listen(p)
    p.start()
    await until(() => srv.sockets.length === 1)
    expect(srv.requests[0].headers.authorization).toBe('aai-test-key-123456')

    p.sendAudio(Buffer.alloc(3200, 1))
    await until(() => srv.received.length === 1)

    const ws = srv.sockets[0]
    ws.send(turn({ words: words('tell', 'me') }))
    ws.send(turn({ end_of_turn: true, transcript: 'tell me about yourself', words: words('tell', 'me', 'about', 'yourself') }))
    ws.send(turn({ end_of_turn: true, turn_is_formatted: true, transcript: 'Tell me about yourself.', utterance: 'Tell me about yourself.' }))
    await until(() => ev.ended() === 1)
    expect(ev.partials).toEqual(['tell me', 'tell me about yourself'])
    expect(ev.finals).toEqual(['Tell me about yourself.'])

    // A late duplicate of the same turn is ignored.
    ws.send(turn({ end_of_turn: true, turn_is_formatted: true, utterance: 'Tell me about yourself.' }))
    ws.send(turn({ turn_order: 1, end_of_turn: true, turn_is_formatted: true, utterance: 'Next one?' }))
    await until(() => ev.ended() === 2)
    expect(ev.finals).toEqual(['Tell me about yourself.', 'Next one?'])

    ws.on('message', (d) => d.toString().includes('Terminate') && ws.close())
    await p.stop()
    expect(srv.received.some((m) => typeof m === 'string' && m.includes('"Terminate"'))).toBe(true)
  })

  it('uses the unformatted turn when no formatted copy arrives', async () => {
    const srv = await fakeAssemblyAI()
    cleanups.push(srv.close)
    const p = new AssemblyAIProvider({ ...opts, baseUrl: srv.url })
    const ev = listen(p)
    p.start()
    await until(() => srv.sockets.length === 1)
    srv.sockets[0].send(turn({ end_of_turn: true, transcript: 'what is a closure', words: words('what', 'is', 'a', 'closure') }))
    await until(() => ev.ended() === 1, 4000)
    expect(ev.finals).toEqual(['what is a closure'])
    await p.stop()
  })

  it('turn numbers restart after a reconnect', async () => {
    const srv = await fakeAssemblyAI()
    cleanups.push(srv.close)
    const p = new AssemblyAIProvider({ ...opts, baseUrl: srv.url })
    const ev = listen(p)
    p.start()
    await until(() => srv.sockets.length === 1)
    srv.sockets[0].send(turn({ end_of_turn: true, turn_is_formatted: true, utterance: 'First.' }))
    await until(() => ev.ended() === 1)
    srv.sockets[0].terminate()
    await until(() => srv.sockets.length === 2)
    await until(() => srv.sockets[1].readyState === 1)
    srv.sockets[1].send(turn({ end_of_turn: true, turn_is_formatted: true, utterance: 'Second.' }))
    await until(() => ev.ended() === 2)
    expect(ev.finals).toEqual(['First.', 'Second.'])
    expect(ev.errors[0]).toEqual([expect.stringContaining('AssemblyAI disconnected; retry 1/8'), false])
    await p.stop()
  })

  it('treats a policy close (bad key, no balance) as fatal', async () => {
    const srv = await fakeAssemblyAI()
    cleanups.push(srv.close)
    const p = new AssemblyAIProvider({ ...opts, baseUrl: srv.url })
    const ev = listen(p)
    p.start()
    await until(() => srv.sockets.length === 1)
    srv.sockets[0].close(1008, 'Unauthorized connection')
    await until(() => ev.errors.length === 1)
    expect(ev.errors[0]).toEqual([expect.stringContaining('Unauthorized connection'), true])
    await new Promise((r) => setTimeout(r, 700))
    expect(srv.sockets).toHaveLength(1)
    await p.stop()
  })
})
