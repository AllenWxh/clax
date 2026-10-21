import type { Tray, Menu } from 'electron'

export function bindTrayActions(tray: Pick<Tray, 'on' | 'setContextMenu' | 'popUpContextMenu'>, menu: Menu, open: () => void, platform = process.platform) {
  // macOS opens a bound context menu on left-click, so show it only on right-click.
  if (platform === 'linux') tray.setContextMenu(menu)
  else tray.on('right-click', () => tray.popUpContextMenu(menu))
  tray.on('click', open)
}
