import { shell, systemPreferences } from 'electron'
import type { AudioSource } from '@shared/ipc'

export const isMac = process.platform === 'darwin'

type Pane = 'screen' | 'microphone'

const SETTINGS_URL: Record<Pane, string> = {
  screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'
}

const PANE_LABEL: Record<Pane, string> = {
  screen: 'Screen & System Audio Recording',
  microphone: 'Microphone'
}

/** True when macOS has refused access; "not-determined" is fine — the first use prompts. */
function refused(pane: Pane): boolean {
  if (!isMac) return false
  const status = systemPreferences.getMediaAccessStatus(pane)
  return status === 'denied' || status === 'restricted'
}

function blocked(pane: Pane): string {
  void shell.openExternal(SETTINGS_URL[pane])
  return `macOS is blocking Cue: allow it in System Settings → Privacy & Security → ${PANE_LABEL[pane]}, then quit and reopen Cue.`
}

/**
 * macOS privacy check before opening audio lanes. System audio rides on screen capture, so the
 * loopback lane needs Screen Recording access. Returns a message (and opens the Settings pane)
 * when access was refused, or null when capture may proceed. Always null on Windows.
 */
export function audioAccessProblem(sources: AudioSource[]): string | null {
  if (sources.includes('loopback') && refused('screen')) return blocked('screen')
  if (sources.includes('mic') && refused('microphone')) return blocked('microphone')
  return null
}

/** Same check for screenshots. */
export function screenAccessProblem(): string | null {
  return refused('screen') ? blocked('screen') : null
}
