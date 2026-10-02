import { globalShortcut } from 'electron'
import type { HotkeyAction, Settings } from '@shared/settings'
import { createLogger } from '../../logger'

const log = createLogger('hotkeys')

export type HotkeyHandlers = Partial<Record<HotkeyAction, () => void>>

/** Registers global shortcuts from settings; only actions with a handler are bound. */
export class HotkeyService {
  private failed: HotkeyAction[] = []

  constructor(private readonly handlers: HotkeyHandlers) {}

  apply(settings: Settings): HotkeyAction[] {
    globalShortcut.unregisterAll()
    this.failed = []
    for (const [action, handler] of Object.entries(this.handlers) as [HotkeyAction, () => void][]) {
      const accel = settings.hotkeys[action]
      if (!accel) continue
      let ok = false
      try {
        ok = globalShortcut.register(accel, handler)
      } catch (err) {
        log.warn(`invalid accelerator for ${action}: ${accel}`, err)
      }
      if (!ok) {
        this.failed.push(action)
        log.warn(`could not register ${action} (${accel}); it may be in use by another app`)
      }
    }
    return this.failed
  }

  dispose(): void {
    globalShortcut.unregisterAll()
  }
}
