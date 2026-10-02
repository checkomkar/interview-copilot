import { desktopCapturer, screen, type Display } from 'electron'
import type { DisplayInfo } from '@shared/ipc'
import { createLogger } from '../../logger'

const log = createLogger('screen')

const JPEG_QUALITY = 80
const THUMB_WIDTH = 240

export interface Screenshot {
  /** Base64 JPEG sent to the model. */
  data: string
  mediaType: 'image/jpeg'
  /** Small JPEG data URL for the overlay and history thumbnails. */
  thumb: string
  width: number
  height: number
  ts: number
}

/** Scale `width`×`height` down so the long edge is at most `maxEdge` (never up). */
export function fitWithin(width: number, height: number, maxEdge: number): { width: number; height: number } {
  const scale = Math.min(1, maxEdge / Math.max(width, height))
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

/** Screen capture via desktopCapturer (FR-SC1): one display, downscaled, JPEG 80. */
export class ScreenService {
  listDisplays(): DisplayInfo[] {
    const primary = screen.getPrimaryDisplay().id
    return screen.getAllDisplays().map((d, i) => ({
      id: String(d.id),
      label: `${d.label || `Display ${i + 1}`} (${d.size.width}×${d.size.height})`,
      primary: d.id === primary
    }))
  }

  async capture(opts: { displayId: string | null; maxEdgePx: number }): Promise<Screenshot> {
    const display = this.display(opts.displayId)
    // Physical pixels, so text stays as sharp as the cap allows on scaled (HiDPI) displays.
    const physical = {
      width: Math.round(display.size.width * display.scaleFactor),
      height: Math.round(display.size.height * display.scaleFactor)
    }
    const size = fitWithin(physical.width, physical.height, opts.maxEdgePx)
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size })
    const source = sources.find((s) => s.display_id === String(display.id)) ?? sources[0]
    if (!source || source.thumbnail.isEmpty()) throw new Error('Could not capture the screen.')
    const image = source.thumbnail
    const { width, height } = image.getSize()
    const thumb = image.resize({ width: Math.min(THUMB_WIDTH, width), quality: 'good' })
    log.info(`captured display ${display.id} at ${width}×${height}`)
    return {
      data: image.toJPEG(JPEG_QUALITY).toString('base64'),
      mediaType: 'image/jpeg',
      thumb: `data:image/jpeg;base64,${thumb.toJPEG(70).toString('base64')}`,
      width,
      height,
      ts: Date.now()
    }
  }

  private display(id: string | null): Display {
    if (id) {
      const match = screen.getAllDisplays().find((d) => String(d.id) === id)
      if (match) return match
      log.warn(`display ${id} not found; using the primary display`)
    }
    return screen.getPrimaryDisplay()
  }
}
