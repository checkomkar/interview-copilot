import { Menu, Tray, nativeImage, type NativeImage } from 'electron'

export interface TrayHandlers {
  showMain: () => void
  toggleOverlay: () => void
  startStop: () => void
  quit: () => void
}

export interface TrayState {
  /** A listening session is running. */
  active: boolean
  overlayVisible: boolean
}

/**
 * The app keeps running in the system tray when the main window is closed; only Quit (here)
 * exits, so hotkeys, the overlay and a running session keep working.
 */
export class AppTray {
  private readonly tray: Tray
  private state: TrayState = { active: false, overlayVisible: true }

  constructor(private readonly handlers: TrayHandlers) {
    this.tray = new Tray(trayIcon())
    this.tray.on('click', () => handlers.showMain())
    this.render()
  }

  update(state: Partial<TrayState>): void {
    const next = { ...this.state, ...state }
    if (next.active === this.state.active && next.overlayVisible === this.state.overlayVisible) return
    this.state = next
    this.render()
  }

  /** One-off Windows notification from the tray icon. */
  notify(title: string, content: string): void {
    this.tray.displayBalloon({ title, content, iconType: 'info' })
  }

  dispose(): void {
    this.tray.destroy()
  }

  private render(): void {
    const { active, overlayVisible } = this.state
    this.tray.setToolTip(`Cue — ${active ? 'listening' : 'idle'}`)
    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Open Cue', click: () => this.handlers.showMain() },
        { label: active ? 'Stop session' : 'Start session', click: () => this.handlers.startStop() },
        { label: overlayVisible ? 'Hide overlay' : 'Show overlay', click: () => this.handlers.toggleOverlay() },
        { type: 'separator' },
        { label: 'Quit Cue', click: () => this.handlers.quit() }
      ])
    )
  }
}

/** Accent-blue disc with a white centre, drawn at runtime so no image asset is needed. 32 px at 2× = 16 DIP. */
export function trayIcon(): NativeImage {
  const size = 32
  const buf = Buffer.alloc(size * size * 4)
  const c = (size - 1) / 2
  const accent = { r: 0x6e, g: 0xa8, b: 0xfe }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c, y - c)
      const outer = clamp(15 - d + 0.5)
      const inner = clamp(5.5 - d + 0.5)
      const r = accent.r + (255 - accent.r) * inner
      const g = accent.g + (255 - accent.g) * inner
      const b = accent.b + (255 - accent.b) * inner
      const i = (y * size + x) * 4
      // BGRA, premultiplied alpha.
      buf[i] = Math.round(b * outer)
      buf[i + 1] = Math.round(g * outer)
      buf[i + 2] = Math.round(r * outer)
      buf[i + 3] = Math.round(255 * outer)
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size, scaleFactor: 2 })
}

function clamp(v: number): number {
  return Math.min(1, Math.max(0, v))
}
