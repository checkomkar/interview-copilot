import { describe, expect, it } from 'vitest'
import { formatAccelerator, shortcutText } from '@shared/keys'

describe('formatAccelerator', () => {
  it('keeps the Windows format', () => {
    expect(formatAccelerator('CommandOrControl+Shift+Enter', 'win32')).toBe('Ctrl + Shift + Enter')
  })

  it('uses macOS symbols', () => {
    expect(formatAccelerator('CommandOrControl+Shift+Enter', 'darwin')).toBe('⌘⇧↩')
    expect(formatAccelerator('CommandOrControl+Shift+Alt+S', 'darwin')).toBe('⌘⇧⌥S')
    expect(formatAccelerator('Control+Shift+Left', 'darwin')).toBe('⌃⇧←')
  })
})

describe('shortcutText', () => {
  it('leaves text alone off macOS', () => {
    expect(shortcutText('Hide overlay (Ctrl+Shift+H)', 'win32')).toBe('Hide overlay (Ctrl+Shift+H)')
  })

  it('rewrites Ctrl shortcuts to ⌘ on macOS', () => {
    expect(shortcutText('Hide overlay (Ctrl+Shift+H)', 'darwin')).toBe('Hide overlay (⌘⇧H)')
    expect(shortcutText('Previous answer (Ctrl+Shift+←)', 'darwin')).toBe('Previous answer (⌘⇧←)')
    expect(shortcutText('Add (Ctrl+Shift+Alt+S), or Ctrl+Shift+S at once', 'darwin')).toBe('Add (⌘⇧⌥S), or ⌘⇧S at once')
    expect(shortcutText('select them, Ctrl+C', 'darwin')).toBe('select them, ⌘C')
  })
})
