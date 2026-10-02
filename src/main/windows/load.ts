import { join } from 'node:path'
import { app, type BrowserWindow, type WebPreferences } from 'electron'
import { createLogger } from '../logger'

export type RendererName = 'main' | 'overlay' | 'capture'

export const isDev = !app.isPackaged && Boolean(process.env['ELECTRON_RENDERER_URL'])

export function secureWebPreferences(extra: WebPreferences = {}): WebPreferences {
  return {
    preload: join(__dirname, '../preload/index.js'),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true,
    ...extra
  }
}

export function loadRenderer(win: BrowserWindow, name: RendererName): Promise<void> {
  // Surface renderer warnings/errors in the main log (the capture window is hidden).
  const log = createLogger(`renderer:${name}`)
  win.webContents.on('console-message', (e) => {
    if (e.level === 'error') log.error(`${e.message} (${e.sourceId}:${e.lineNumber})`)
    else if (e.level === 'warning') log.warn(e.message)
  })
  win.webContents.on('render-process-gone', (_e, d) => log.error(`renderer gone: ${d.reason}`))
  if (isDev) return win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/${name}/index.html`)
  return win.loadFile(join(__dirname, `../renderer/${name}/index.html`))
}

/** True if a URL belongs to one of our own renderer pages. */
export function isAppUrl(url: string): boolean {
  if (isDev) return url.startsWith(process.env['ELECTRON_RENDERER_URL'] ?? '\u0000')
  return url.startsWith('file://')
}
