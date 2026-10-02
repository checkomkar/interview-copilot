import { describe, expect, it } from 'vitest'
import { Downsampler, downmix } from '../src/renderer/capture/src/downsampler'

function run(rate: number, input: Float32Array): number[] {
  const out: number[] = []
  new Downsampler(rate).process(input, (s) => out.push(s))
  return out
}

describe('Downsampler', () => {
  it('produces 16 kHz output from 48 kHz input', () => {
    expect(run(48000, new Float32Array(48000)).length).toBe(16000)
  })

  it('handles non-integer ratios (44.1 kHz) without drift', () => {
    const ds = new Downsampler(44100)
    let n = 0
    // Feed 128-sample render quanta, as an AudioWorklet does.
    const total = 44100 * 2
    for (let i = 0; i < total; i += 128) ds.process(new Float32Array(Math.min(128, total - i)), () => n++)
    expect(Math.abs(n - 32000)).toBeLessThanOrEqual(1)
  })

  it('maps full-scale float to int16 range and clamps', () => {
    expect(run(16000, new Float32Array([1, -1, 2, -2, 0]))).toEqual([32767, -32768, 32767, -32768, 0])
  })

  it('averages within each output window', () => {
    expect(run(32000, new Float32Array([0.5, 0.5, -0.5, -0.5]))).toEqual([16384, -16384])
  })

  it('rejects upsampling', () => {
    expect(() => new Downsampler(8000)).toThrow()
  })
})

describe('downmix', () => {
  it('averages stereo to mono', () => {
    const out = new Float32Array(2)
    downmix([new Float32Array([1, 0]), new Float32Array([0, 0.5])], out)
    expect(Array.from(out)).toEqual([0.5, 0.25])
  })
})
