// Draws the app icon (the tray's accent disc, larger) for electron-builder: build/icon.png (256 px,
// Windows) and build/icon-mac.png (1024 px with the macOS icon grid's margin; converted to .icns).
// Run: node scripts/make-icon.mjs
import { mkdirSync, writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'

const accent = [0x6e, 0xa8, 0xfe]
const bg = [0x12, 0x15, 0x1c]
const clamp = (v) => Math.min(1, Math.max(0, v))

/** Raw RGBA scanlines; shapes are laid out on a 256 grid, scaled by `size` and shrunk by `inset`. */
function draw(SIZE, inset = 1) {
  const k = (SIZE / 256) * inset
  const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE)
  const c = (SIZE - 1) / 2
  for (let y = 0; y < SIZE; y++) {
    raw[y * (SIZE * 4 + 1)] = 0 // filter: none
    for (let x = 0; x < SIZE; x++) {
      // Rounded square background, accent ring, white centre dot.
      const dx = Math.max(Math.abs(x - c) - 88 * k, 0)
      const dy = Math.max(Math.abs(y - c) - 88 * k, 0)
      const square = clamp(40 * k - Math.hypot(dx, dy) + 0.5)
      const d = Math.hypot(x - c, y - c)
      const ring = clamp(92 * k - d + 0.5) * clamp(d - 62 * k + 0.5)
      const dot = clamp(34 * k - d + 0.5)
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
  return raw
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
function png(size, inset) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(draw(size, inset))),
    chunk('IEND', Buffer.alloc(0))
  ])
}

mkdirSync('build', { recursive: true })
writeFileSync('build/icon.png', png(256))
console.log('wrote build/icon.png')
// macOS icons keep ~10% clear margin (824 of 1024 px is artwork).
writeFileSync('build/icon-mac.png', png(1024, 824 / 1024))
console.log('wrote build/icon-mac.png')
