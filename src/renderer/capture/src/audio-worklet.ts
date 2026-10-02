/// <reference lib="webworker" />
import { Downsampler, downmix } from './downsampler'

// AudioWorkletGlobalScope globals (not in TS DOM lib).
declare const sampleRate: number
declare function registerProcessor(name: string, ctor: unknown): void
declare class AudioWorkletProcessor {
  readonly port: MessagePort
}

const OUT_RATE = 16000
const CHUNK_SAMPLES = OUT_RATE / 10 // 100 ms (FR-A4)

/**
 * Downmixes to mono, resamples to 16 kHz linear16 and posts 100 ms chunks:
 * `{ pcm: ArrayBuffer, rms: number }` (pcm is transferred).
 */
class PcmChunker extends AudioWorkletProcessor {
  private readonly ds = new Downsampler(sampleRate, OUT_RATE)
  private buf = new Int16Array(CHUNK_SAMPLES)
  private n = 0
  private sumSq = 0
  private mono = new Float32Array(128)

  process(inputs: Float32Array[][]): boolean {
    const channels = inputs[0]
    if (!channels || channels.length === 0 || channels[0].length === 0) return true
    if (this.mono.length !== channels[0].length) this.mono = new Float32Array(channels[0].length)
    downmix(channels, this.mono)
    this.ds.process(this.mono, (s) => {
      this.buf[this.n++] = s
      const f = s / 0x8000
      this.sumSq += f * f
      if (this.n === CHUNK_SAMPLES) this.flush()
    })
    return true
  }

  private flush(): void {
    const rms = Math.sqrt(this.sumSq / CHUNK_SAMPLES)
    const pcm = this.buf.buffer
    this.port.postMessage({ pcm, rms }, [pcm])
    this.buf = new Int16Array(CHUNK_SAMPLES)
    this.n = 0
    this.sumSq = 0
  }
}

registerProcessor('pcm-chunker', PcmChunker)
