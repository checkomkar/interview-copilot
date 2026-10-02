// Draws the app icon (the tray's accent disc, larger) as build/icon.png for electron-builder.
// Run: node scripts/make-icon.mjs
import { mkdirSync, writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'

const SIZE = 256
const accent = [0x6e, 0xa8, 0xfe]
const bg = [0x12, 0x15, 0x1c]
const clamp = (v) => Math.min(1, Math.max(0, v))

const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE)
const c = (SIZE - 1) / 2
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0 // filter: none
  for (let x = 0; x < SIZE; x++) {
    // Rounded square background, accent ring, white centre dot.
    const dx = Math.max(Math.abs(x - c) - 88, 0)
    const dy = Math.max(Math.abs(y - c) - 88, 0)
    const square = clamp(40 - Math.hypot(dx, dy) + 0.5)
    const d = Math.hypot(x - c, y - c)
    const ring = clamp(92 - d + 0.5) * clamp(d - 62 + 0.5)
    const dot = clamp(34 - d + 0.5)
    const mix = (i) => {
      let v = bg[i]
      v = v + (accent[i] - v) * ring
      v = v + (255 - v) * dot
      return Math.round(v)
    }
    const o = y * (SIZE * 4 + 1) + 1 + x * 4
    raw[o] = mix(0)
    raw[o + 1] = mix(1)
    raw[o + 2] = mix(2)
    raw[o + 3] = Math.round(255 * square)
  }
}

function crc32(buf) {
  let crc = ~0
  for (const b of buf) {
    crc ^= b
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return ~crc >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}
const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(SIZE, 0)
ihdr.writeUInt32BE(SIZE, 4)
ihdr[8] = 8 // bit depth
ihdr[9] = 6 // RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw)),
  chunk('IEND', Buffer.alloc(0))
])
mkdirSync('build', { recursive: true })
writeFileSync('build/icon.png', png)
console.log('wrote build/icon.png')
