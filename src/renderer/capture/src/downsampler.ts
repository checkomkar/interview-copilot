/**
 * Streaming float -> 16 kHz linear16 downsampler. Each output sample is the
 * mean of the input samples in its window (a box filter, cheap anti-aliasing).
 * Pure and allocation-light so it can run inside an AudioWorklet.
 */
export class Downsampler {
  private readonly ratio: number
  private pos = 0
  private sum = 0
  private count = 0

  constructor(inputRate: number, outputRate = 16000) {
    if (inputRate < outputRate) throw new Error(`input rate ${inputRate} is below ${outputRate}`)
    this.ratio = inputRate / outputRate
  }

  /** Feed mono float samples in [-1, 1]; calls `emit` with each 16-bit output sample. */
  process(input: Float32Array, emit: (sample: number) => void): void {
    for (let i = 0; i < input.length; i++) {
      this.sum += input[i]
      this.count++
      this.pos += 1
      if (this.pos >= this.ratio) {
        this.pos -= this.ratio
        const v = Math.max(-1, Math.min(1, this.sum / this.count))
        emit(v < 0 ? Math.round(v * 0x8000) : Math.round(v * 0x7fff))
        this.sum = 0
        this.count = 0
      }
    }
  }
}

/** Downmix planar channels to mono in-place into `out` (length of channel 0). */
export function downmix(channels: Float32Array[], out: Float32Array): Float32Array {
  const n = channels.length
  if (n === 1) {
    out.set(channels[0])
    return out
  }
  for (let i = 0; i < out.length; i++) {
    let s = 0
    for (let c = 0; c < n; c++) s += channels[c][i]
    out[i] = s / n
  }
  return out
}
