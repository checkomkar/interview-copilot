/** Keyboard shortcut text for the platform: "Ctrl + Shift + R" on Windows, "⌘⇧R" on macOS. */

const MAC_MODIFIERS: Record<string, string> = {
  CommandOrControl: '⌘',
  CmdOrCtrl: '⌘',
  Command: '⌘',
  Cmd: '⌘',
  Super: '⌘',
  Meta: '⌘',
  Control: '⌃',
  Ctrl: '⌃',
  Alt: '⌥',
  Option: '⌥',
  AltGr: '⌥',
  Shift: '⇧'
}

const MAC_KEYS: Record<string, string> = { Left: '←', Right: '→', Up: '↑', Down: '↓', Enter: '↩', Return: '↩' }

/** Display an Electron accelerator (e.g. "CommandOrControl+Shift+Enter") the way users of `platform` expect. */
export function formatAccelerator(accel: string, platform: string): string {
  if (platform !== 'darwin') return accel.replace(/CommandOrControl|CmdOrCtrl/g, 'Ctrl').replace(/\+/g, ' + ')
  return accel
    .split('+')
    .map((part) => MAC_MODIFIERS[part] ?? MAC_KEYS[part] ?? part)
    .join('')
}

/**
 * Rewrites Windows-style shortcuts written into UI text ("Hide overlay (Ctrl+Shift+H)") for macOS,
 * where the same CommandOrControl accelerators fire on ⌘. Leaves other platforms untouched.
 */
export function shortcutText(text: string, platform: string): string {
  if (platform !== 'darwin') return text
  return text.replace(/\b(?:(?:Ctrl|Shift|Alt)\+)+/g, (mods) =>
    mods
      .split('+')
      .filter(Boolean)
      .map((m) => (m === 'Ctrl' ? '⌘' : MAC_MODIFIERS[m]))
      .join('')
  )
}
