import { BrowserWindow, desktopCapturer } from 'electron'
import { createLogger } from '../logger'
import { loadRenderer, secureWebPreferences } from './load'

const log = createLogger('capture')

/**
 * Hidden window that owns audio capture (getDisplayMedia loopback + optional mic)
 * and runs the resampling AudioWorklet.
 */
export function createCaptureWindow(): BrowserWindow {
  const win = new BrowserWindow({
    show: false,
    width: 320,
    height: 200,
    skipTaskbar: true,
    webPreferences: secureWebPreferences({ backgroundThrottling: false })
  })

  // System audio via loopback (FR-A1): WASAPI on Windows, ScreenCaptureKit on macOS 13+. Chromium requires a video source
  // alongside it; the capture page stops the video track immediately.
  win.webContents.session.setDisplayMediaRequestHandler(
    async (request, callback) => {
      if (request.frame?.processId !== win.webContents.getProcessId()) {
        log.warn('denied display media request from unexpected frame')
        callback({})
        return
      }
      try {
        const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
        if (!sources[0]) throw new Error('no screen source available')
        callback({ video: sources[0], audio: 'loopback' })
      } catch (err) {
        log.error('display media request failed', err)
        callback({})
      }
    },
    { useSystemPicker: false }
  )

  void loadRenderer(win, 'capture')
  return win
}
