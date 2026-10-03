import { formatAccelerator, shortcutText } from '@shared/keys'

export const isMac = window.api.app.platform === 'darwin'

/** An Electron accelerator from settings, shown for this platform. */
export const formatHotkey = (accel: string): string => formatAccelerator(accel, window.api.app.platform)

/** UI text with Windows-style shortcuts ("Ctrl+Shift+H") rewritten for this platform. */
export const keys = (text: string): string => shortcutText(text, window.api.app.platform)
