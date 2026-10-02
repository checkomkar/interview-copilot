import { afterEach, describe, expect, it } from 'vitest'
import type { AddressInfo } from 'node:net'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import { DeepgramProvider } from '../src/main/services/stt/DeepgramProvider'

/** Minimal fake of Deepgram's streaming endpoint. */
async function fakeDeepgram(opts: { rejectWith?: number } = {}) {
  const http: Server = createServer()
  const wss = new WebSocketServer({ noServer: true })
  const sockets: WebSocket[] = []
  const requests: IncomingMessage[] = []
  const received: (Buffer | string)[] = []
  http.on('upgrade', (req, socket, head) => {
    requests.push(req)
    if (opts.rejectWith) {
      socket.end(`HTTP/1.1 ${opts.rejectWith} Unauthorized\r\n\r\n`)
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      sockets.push(ws)
      ws.on('message', (data, isBinary) => received.push(isBinary ? (data as Buffer) : data.toString()))
    })
  })
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r))
  const port = (http.address() as AddressInfo).port
  return {
    url: `ws://127.0.0.1:${port}/v1/listen`,
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

const opts = { apiKey: 'test-key-123456', model: 'nova-3', language: 'en', endpointingMs: 300, utteranceEndMs: 1000 }
const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

describe('DeepgramProvider (against a fake server)', () => {
  it('authenticates, streams audio, emits results and closes cleanly', async () => {
    const srv = await fakeDeepgram()
    cleanups.push(srv.close)
    const p = new DeepgramProvider({ ...opts, baseUrl: srv.url })
    const finals: string[] = []
    let ended = 0
    p.on('final', (r) => finals.push(r.text))
    p.on('utteranceEnd', () => ended++)
    p.on('error', () => {})
    p.start()
    await until(() => srv.sockets.length === 1)
    expect(srv.requests[0].headers.authorization).toBe('Token test-key-123456')

    p.sendAudio(Buffer.alloc(3200, 1))
    await until(() => srv.received.length === 1)
    expect((srv.received[0] as Buffer).length).toBe(3200)

    srv.sockets[0].send(JSON.stringify({ type: 'Results', is_final: true, start: 0, duration: 0.1, channel: { alternatives: [{ transcript: 'hello' }] } }))
    srv.sockets[0].send(JSON.stringify({ type: 'UtteranceEnd' }))
    await until(() => ended === 1)
    expect(finals).toEqual(['hello'])

    // Server closes once it receives CloseStream, like Deepgram does.
    srv.sockets[0].on('message', (d) => d.toString().includes('CloseStream') && srv.sockets[0].close())
    await p.stop()
    expect(srv.received.some((m) => typeof m === 'string' && m.includes('CloseStream'))).toBe(true)
  })

  it('reconnects after a drop and flushes audio buffered while offline', async () => {
    const srv = await fakeDeepgram()
    cleanups.push(srv.close)
    const p = new DeepgramProvider({ ...opts, baseUrl: srv.url })
    const states: string[] = []
    p.on('state', (s) => states.push(s))
    p.on('error', () => {})
    cleanups.push(() => p.stop())
    p.start()
    await until(() => srv.sockets.length === 1 && states.includes('open'))

    srv.sockets[0].terminate()
    await until(() => states.includes('reconnecting'))
    p.sendAudio(Buffer.alloc(100, 7)) // sent while disconnected -> buffered
    await until(() => srv.sockets.length === 2)
    await until(() => srv.received.some((m) => Buffer.isBuffer(m) && m.length === 100))
    expect(states.filter((s) => s === 'open').length).toBe(2)
  })

  it('treats a 401 handshake as fatal and does not retry', async () => {
    const srv = await fakeDeepgram({ rejectWith: 401 })
    cleanups.push(srv.close)
    const p = new DeepgramProvider({ ...opts, baseUrl: srv.url })
    const errors: [string, boolean][] = []
    p.on('error', (e, fatal) => errors.push([e.message, fatal]))
    p.start()
    await until(() => errors.length > 0)
    await new Promise((r) => setTimeout(r, 700))
    expect(errors).toEqual([['Deepgram API key was rejected', true]])
    expect(srv.requests).toHaveLength(1)
    await p.stop()
  })
})
