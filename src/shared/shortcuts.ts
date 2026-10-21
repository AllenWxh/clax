// Nearby letter keys support a left-hand shortcut without sharing the space-bar launchers.
export const SHORTCUTS = ['Alt+C', 'Alt+D', 'Alt+V', 'Control+Shift+Space', 'Alt+Shift+Space', 'Control+Alt+K'] as const
export const DEFAULT_SHORTCUT = SHORTCUTS[0]
export const shortcutLabel = (shortcut: string) => shortcut.split('+').map(key => key === 'Alt' ? 'Option / Alt' : key === 'Space' ? '空格' : key).join(' + ')
