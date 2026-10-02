import type { AudioSource, CaptureMicPayload, CaptureStartPayload } from '@shared/ipc'
import workletUrl from './audio-worklet.ts?worker&url'

const api = window.api.capture

interface Pipeline {
  stream: MediaStream
  node: AudioWorkletNode
  source: MediaStreamAudioSourceNode
}

let ctx: AudioContext | null = null
let sink: GainNode | null = null
const pipelines = new Map<AudioSource, Pipeline>()

async function ensureContext(): Promise<AudioContext> {
  if (ctx) return ctx
  ctx = new AudioContext({ latencyHint: 'interactive' })
  await ctx.audioWorklet.addModule(workletUrl)
  // Worklets only run when pulled by the destination; route through a muted gain.
  sink = ctx.createGain()
  sink.gain.value = 0
  sink.connect(ctx.destination)
  return ctx
}

async function openLoopback(): Promise<MediaStream> {
  // Main process answers with { video: screen, audio: 'loopback' }.
  const stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true })
  // We only want audio; drop the video track right away.
  for (const t of stream.getVideoTracks()) {
    t.stop()
    stream.removeTrack(t)
  }
  if (stream.getAudioTracks().length === 0) throw new Error('no system audio track was returned')
  return stream
}

function openMic(deviceId: string | null): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: deviceId ? { exact: deviceId } : undefined,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    },
    video: false
  })
}

async function startSource(source: AudioSource, open: () => Promise<MediaStream>): Promise<void> {
  try {
    const audio = await ensureContext()
    const stream = await open()
    const node = new AudioWorkletNode(audio, 'pcm-chunker', { numberOfInputs: 1, numberOfOutputs: 1 })
    node.port.onmessage = (e: MessageEvent<{ pcm: ArrayBuffer; rms: number }>) => {
      api.sendChunk(source, e.data.pcm)
      api.sendLevel(source, Math.min(1, e.data.rms))
    }
    const src = audio.createMediaStreamSource(stream)
    src.connect(node)
    node.connect(sink!)
    for (const t of stream.getAudioTracks()) {
      t.addEventListener('ended', () => {
        if (pipelines.get(source)?.stream === stream) {
          stopSource(source)
          api.sendStatus({ source, state: 'error', message: 'audio track ended' })
        }
      })
    }
    pipelines.set(source, { stream, node, source: src })
    if (audio.state === 'suspended') await audio.resume()
    api.sendStatus({ source, state: 'started' })
  } catch (err) {
    stopSource(source)
    api.sendStatus({ source, state: 'error', message: err instanceof Error ? err.message : String(err) })
  }
}

function stopSource(source: AudioSource): void {
  const p = pipelines.get(source)
  if (!p) return
  pipelines.delete(source)
  p.node.port.onmessage = null
  p.source.disconnect()
  p.node.disconnect()
  for (const t of p.stream.getTracks()) t.stop()
}

async function stopAll(): Promise<void> {
  for (const s of [...pipelines.keys()]) {
    stopSource(s)
    api.sendStatus({ source: s, state: 'stopped' })
  }
  if (ctx) {
    const c = ctx
    ctx = null
    sink = null
    await c.close()
  }
}

api.onStart(async (p: CaptureStartPayload) => {
  await stopAll()
  if (p.loopback) await startSource('loopback', openLoopback)
  if (p.mic) await startSource('mic', () => openMic(p.micDeviceId))
})

api.onStop(() => void stopAll())

// Mic on/off mid-session (voice questions); loopback keeps running.
api.onMic(async (p: CaptureMicPayload) => {
  if (p.on) {
    if (!pipelines.has('mic')) await startSource('mic', () => openMic(p.deviceId))
  } else if (pipelines.has('mic')) {
    stopSource('mic')
    api.sendStatus({ source: 'mic', state: 'stopped' })
  }
})
