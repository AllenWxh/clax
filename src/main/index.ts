import { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, dialog, safeStorage, shell, screen, nativeTheme, globalShortcut, powerMonitor, type IpcMainInvokeEvent } from 'electron'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { z } from 'zod'
import { MAX_CONTEXT_CHARS } from '../shared/context'
import { LocalStore, dataHome } from './storage'
import { AgentService } from './service'
import { bindTrayActions } from './tray'
import { SHORTCUTS, shortcutLabel } from '../shared/shortcuts'
import { REASONING_EFFORTS } from '../shared/models'
import { defaultActivity } from './activity-store'
import type { AppSettings, DesktopEvent, ProviderInput } from '../shared/types'

const dir = fileURLToPath(new URL('.', import.meta.url))
let window: BrowserWindow
let tray: Tray
let trayMenu: Menu
let registeredShortcut: string | undefined
let service: AgentService
let quitting = false
let expandedSize: [number, number] = [840, 700]
let nativeDialog = false
let blurTimer: ReturnType<typeof setTimeout> | undefined
let shortcutTimer: ReturnType<typeof setTimeout> | undefined
let configureNativeWindow: ((handle: Buffer) => void) | undefined
// Keep the original safeStorage namespace until its key is cached, preserving encrypted credentials.
app.setName('DeskAgent')
nativeTheme.themeSource = 'light'
if (!process.env.CLAX_TEST && !process.env.DESKAGENT_TEST && !app.requestSingleInstanceLock()) app.quit()

function send(event: DesktopEvent) {
  if (event.type === 'activity' && tray && !tray.isDestroyed()) {
    if (process.platform === 'darwin') tray.setTitle(event.status.enabled ? '●' : '')
    tray.setToolTip(`Clax · 活动记录${event.status.enabled ? '开启' : '暂停'} · ${shortcutLabel(service.store.settings.globalShortcut)}`)
    const toggle = trayMenu?.getMenuItemById('activity-toggle')
    if (toggle) toggle.label = event.status.enabled ? '暂停活动记录' : '开启活动记录'
  }
  if (window && !window.isDestroyed()) window.webContents.send('clax:event', event)
}
function dock(width: number, height: number) {
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
  window.setBounds({ x: Math.round(area.x + (area.width - width) / 2), y: area.y, width, height: Math.min(height, area.height) })
}
function show() {
  if (quitting || !window || window.isDestroyed()) return
  if (shortcutTimer) { clearTimeout(shortcutTimer); shortcutTimer = undefined }
  if (blurTimer) clearTimeout(blurTimer)
  service.windowMode = 'expanded'
  window.setResizable(true); window.setMinimumSize(650, 520)
  dock(...expandedSize); window.setAlwaysOnTop(true)
  send({ type: 'window_state', mode: 'expanded' })
  window.show()
  // A tray-only macOS app also needs activation before its window can accept typing.
  if (process.platform === 'darwin') app.focus({ steal: true })
  window.focus(); send({ type: 'focus' })
  // Chromium resets collection behavior when showing or changing window level.
  configureNativeWindow?.(window.getNativeWindowHandle())
}
function collapse() {
  if (quitting || !window || window.isDestroyed() || !window.isVisible() || nativeDialog || service.windowMode === 'collapsed') return
  const size = window.getSize(); expandedSize = [size[0] ?? 840, size[1] ?? 700]
  service.windowMode = 'collapsed'
  window.setMinimumSize(260, 44); window.setResizable(false)
  window.setAlwaysOnTop(false); dock(340, 46)
  configureNativeWindow?.(window.getNativeWindowHandle())
  send({ type: 'window_state', mode: 'collapsed' })
}
function toggle() {
  if (quitting || !window || window.isDestroyed()) return
  if (shortcutTimer) { clearTimeout(shortcutTimer); shortcutTimer = undefined; return }
  // Modifier-release events can undo both activation and hiding on macOS.
  const hide = window.isVisible() && service.windowMode === 'expanded' && window.isFocused()
  shortcutTimer = setTimeout(() => { shortcutTimer = undefined; if (hide) window.hide(); else show() }, process.platform === 'darwin' ? 150 : 0)
}

function trayImage() {
  const size = 20, bitmap = Buffer.alloc(size * size * 4)
  for (let y = 3; y < 17; y++) for (let x = 3; x < 17; x++) {
    const ink = x <= 5 || (y <= 5 || y >= 14) && x < 15
    if (ink) { const i = (y * size + x) * 4; bitmap[i] = 70; bitmap[i + 1] = 70; bitmap[i + 2] = 70; bitmap[i + 3] = 255 }
  }
  const image = nativeImage.createFromBitmap(bitmap, { width: size, height: size })
  if (process.platform === 'darwin') image.setTemplateImage(true)
  return image
}
function startShortcut(accelerator = service.store.settings.globalShortcut) {
  try {
    if (accelerator !== registeredShortcut || !globalShortcut.isRegistered(accelerator)) {
      // Register the replacement first: a conflict must leave the working shortcut intact.
      if (!globalShortcut.register(accelerator, toggle)) throw new Error('Shortcut unavailable')
      if (registeredShortcut && registeredShortcut !== accelerator) globalShortcut.unregister(registeredShortcut)
      registeredShortcut = accelerator
    }
  } catch {
    service.shortcutRegistered = Boolean(registeredShortcut && globalShortcut.isRegistered(registeredShortcut))
    service.shortcutStatus = `${shortcutLabel(accelerator)} 无法注册，可能已被系统或其他应用占用。${service.shortcutRegistered ? `仍可使用 ${shortcutLabel(registeredShortcut!)}。` : '请在设置里选择其他组合。'}`
    send({ type: 'refresh' }); throw new Error(service.shortcutStatus)
  }
  service.shortcutRegistered = true
  service.shortcutStatus = `${shortcutLabel(accelerator)} 已启用`
  tray.setToolTip(`Clax · ${shortcutLabel(accelerator)}`)
  send({ type: 'refresh' })
}

const providerSchema = z.object({
  id: z.string().max(100).optional(), name: z.string().min(1).max(100),
  kind: z.enum(['openrouter', 'openai', 'compatible', 'anthropic', 'gemini', 'ollama']),
  baseUrl: z.url().refine(value => /^https?:\/\//.test(value), 'Use http:// or https://'),
  apiKey: z.string().max(8192).optional(), apiKeyEnv: z.string().max(120).optional(),
  modelIds: z.array(z.string().min(1).max(250)).max(1000).optional(), toolCalling: z.boolean(),
  contextWindow: z.number().int().min(1000).max(10000000).optional(),
  pricing: z.object({ input: z.number().min(0), output: z.number().min(0), cache: z.number().min(0).optional() }).optional(),
})
const settingsSchema = z.object({
  globalShortcut: z.enum(SHORTCUTS),
  permissionMode: z.enum(['ask', 'auto', 'full']), demoEnabled: z.boolean(), disabledTools: z.array(z.string()).max(30),
  enabledSkills: z.record(z.string(), z.boolean()), maxContextChars: z.number().int().min(4000).max(MAX_CONTEXT_CHARS),
  memory: z.object({ enabled: z.boolean(), autoCapture: z.boolean() }),
  activity: z.object({ enabled: z.boolean(), useInMemory: z.boolean(), retentionDays: z.number().int().min(1).max(365),
    excludedApps: z.array(z.string().trim().min(1).max(200)).max(100) }).default(defaultActivity),
  search: z.object({ kind: z.enum(['none', 'openrouter', 'tavily', 'searxng']), baseUrl: z.string().max(2048) }),
})
function registerIPC() {
  function handle(name: string, handler: (...args: any[]) => unknown) {
    ipcMain.handle(`clax:${name}`, async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      // The renderer has no Node access; only the expected top-level window can invoke these methods.
      if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('Untrusted IPC sender')
      return await handler(...args)
    })
  }
  const id = (value: unknown) => z.string().min(1).max(100).parse(value)
  handle('bootstrap', () => service.bootstrap())
  handle('importOpenRouter', () => service.importOpenRouter())
  handle('usageSummary', () => service.usageSummary())
  handle('providerCredits', providerId => service.providerCredits(id(providerId)))
  handle('provisionOpenRouter', providerId => service.provisionOpenRouter(id(providerId)))
  handle('send', (sessionId, text) => service.send(id(sessionId), z.string().min(1).max(32000).parse(text)))
  handle('stop', sessionId => service.stop(id(sessionId)))
  handle('pause', sessionId => service.pause(id(sessionId)))
  handle('resume', sessionId => service.resume(id(sessionId)))
  handle('retry', (sessionId, messageId) => service.retry(id(sessionId), id(messageId)))
  handle('newSession', () => service.newSession())
  handle('openSession', sessionId => service.openSession(id(sessionId)))
  handle('setModel', (sessionId, ref) => service.setModel(id(sessionId), z.object({ provider: z.string().max(100), model: z.string().max(250), reasoningEffort: z.enum(REASONING_EFFORTS).optional() }).parse(ref)))
  handle('chooseWorkspace', async sessionId => {
    nativeDialog = true
    try {
      const result = await dialog.showOpenDialog(window, { title: 'Choose workspace', properties: ['openDirectory'] })
      if (result.canceled || !result.filePaths[0]) return null
      await service.setWorkspace(id(sessionId), result.filePaths[0]); return result.filePaths[0]
    } finally { nativeDialog = false; if (window.isVisible()) show() }
  })
  handle('saveProvider', input => service.saveProvider(providerSchema.parse(input) as ProviderInput))
  handle('testProvider', input => service.testProvider(providerSchema.parse(input) as ProviderInput))
  handle('refreshProvider', providerId => service.refreshProvider(id(providerId)))
  handle('deleteProvider', providerId => service.deleteProvider(id(providerId)))
  handle('saveSettings', settings => {
    const parsed = settingsSchema.parse(settings) as AppSettings
    if (parsed.globalShortcut !== service.store.settings.globalShortcut) startShortcut(parsed.globalShortcut)
    service.saveSettings(parsed)
  })
  handle('saveMemory', (file, content) => service.saveMemory(z.enum(['USER.md', 'PREFERENCES.md', 'MEMORY.md']).parse(file), z.string().max(100000).parse(content)))
  handle('searchMemory', query => service.searchMemory(z.string().max(2000).parse(query)))
  handle('readMemory', (path, start, lines) => service.readMemory(z.string().max(250).parse(path), z.number().int().min(1).max(100000).optional().parse(start), z.number().int().min(1).max(160).optional().parse(lines)))
  handle('forgetMemory', path => service.forgetMemory(z.string().max(250).parse(path)))
  handle('activityReport', (date, query, before) => service.activityReport(z.string().max(10).parse(date), z.string().max(2000).optional().parse(query), z.string().uuid().optional().parse(before)))
  handle('deleteActivity', date => service.deleteActivity(z.string().max(10).parse(date)))
  handle('captureSelection', () => service.captureSelection())
  handle('requestActivityPermission', () => service.requestActivityPermission())
  handle('saveSearchKey', key => { service.store.setSecret('web-search', z.string().max(8192).parse(key)); send({ type: 'refresh' }) })
  handle('approve', (approvalId, allow) => service.approve(id(approvalId), z.boolean().parse(allow)))
  handle('hide', () => window.hide())
  handle('openDataFolder', () => shell.openPath(service.store.home))
  handle('openExternal', url => {
    const parsed = z.url().parse(url)
    if (!/^https?:\/\//.test(parsed)) throw new Error('Only HTTP(S) links can be opened')
    return shell.openExternal(parsed)
  })
  handle('enableShortcut', () => startShortcut())
  handle('extensionAction', async (extensionId, action) => {
    const name = id(extensionId), selected = z.enum(['test', 'install', 'enable', 'disable', 'rollback']).parse(action)
    if (selected === 'test') await service.store.extensions.test(name, AbortSignal.timeout(120000))
    else if (selected === 'install') await service.store.extensions.install(name, AbortSignal.timeout(120000))
    else if (selected === 'rollback') service.store.extensions.rollback(name)
    else service.store.extensions.setEnabled(name, selected === 'enable')
  })
  handle('connectExtension', (extensionId, input) => service.store.extensions.connect(id(extensionId), z.object({ apiKey: z.string().max(8192).optional(), clientId: z.string().max(250).optional(), clientSecret: z.string().max(2000).optional() }).strict().parse(input), url => shell.openExternal(url)))
  handle('disconnectExtension', extensionId => service.store.extensions.disconnect(id(extensionId)))
  handle('openExtensionsFolder', () => shell.openPath(join(service.store.home, 'extensions')))
  handle('expand', show)
  handle('collapse', collapse)
}

app.whenReady().then(async () => {
  safeStorage.isEncryptionAvailable()
  app.setName('Clax')
  const home = dataHome()
  const store = new LocalStore(home, {
    available: () => safeStorage.isEncryptionAvailable() && (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text'),
    encrypt: value => safeStorage.encryptString(value), decrypt: value => safeStorage.decryptString(value),
  }, process.cwd())
  service = new AgentService(store, send)
  window = new BrowserWindow({
    width: 840, height: 700, minWidth: 650, minHeight: 520, show: false, frame: false,
    transparent: true, backgroundColor: '#00000000', alwaysOnTop: true, skipTaskbar: true, roundedCorners: true,
    ...(process.platform === 'darwin' ? { vibrancy: 'under-window' as const, visualEffectState: 'active' as const } : {}),
    title: 'Clax', hasShadow: true, movable: false,
    webPreferences: { preload: join(dir, '../preload/index.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true },
  })
  window.on('close', event => { if (!quitting) { event.preventDefault(); window.hide() } })
  window.on('blur', () => { blurTimer = setTimeout(() => { if (!window.isFocused()) collapse() }, 160) })
  // Expand on the compact button's completed click, so mouse-up cannot hit the new UI underneath.
  window.on('focus', () => { if (blurTimer) clearTimeout(blurTimer) })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', event => event.preventDefault())
  window.webContents.on('before-input-event', (event, input) => { if (input.key === 'Escape' && input.type === 'keyDown') { event.preventDefault(); window.hide() } })
  registerIPC()
  tray = new Tray(trayImage())
  tray.setToolTip(`Clax · ${shortcutLabel(store.settings.globalShortcut)}`)
  trayMenu = Menu.buildFromTemplate([
    { label: 'Open Clax', click: show },
    { label: 'New Session', click: () => { void service.newSession(); show() } },
    { label: 'Settings', click: () => { show(); send({ type: 'settings' }) } },
    { type: 'separator' },
    { id: 'activity-toggle', label: store.settings.activity.enabled ? '暂停活动记录' : '开启活动记录', click: () => {
      service.saveSettings({ ...store.settings, activity: { ...store.settings.activity, enabled: !store.settings.activity.enabled } })
    } },
    { label: '查看今天的活动', click: () => { show(); send({ type: 'settings', tab: 'Activity' }) } },
    { label: '记录选中文字', click: () => { void service.captureSelection().then(() => { show(); send({ type: 'settings', tab: 'Activity' }) })
      .catch(error => dialog.showErrorBox('选中文字未保存', error instanceof Error ? error.message : String(error))) } },
    { type: 'separator' }, { label: 'Quit', click: () => app.quit() },
  ])
  bindTrayActions(tray, trayMenu, show)
  service.startActivity(join(dir, '../native/clax-activity'))
  const suspended = new Set<string>()
  const suspend = (reason: string, active: boolean) => { if (quitting) return; if (active) suspended.add(reason); else suspended.delete(reason); service.suspendActivity(suspended.size > 0) }
  powerMonitor.on('lock-screen', () => suspend('lock', true)); powerMonitor.on('unlock-screen', () => suspend('lock', false))
  powerMonitor.on('suspend', () => suspend('sleep', true)); powerMonitor.on('resume', () => suspend('sleep', false))
  if (process.platform === 'darwin') {
    app.dock?.hide()
    // Keep the tray window out of desktop/Space window-management transitions.
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
    configureNativeWindow = createRequire(import.meta.url)(join(dir, '../native/clax-window.node')).configure
    configureNativeWindow?.(window.getNativeWindowHandle())
  }
  Menu.setApplicationMenu(null)
  if (process.env.ELECTRON_RENDERER_URL) await window.loadURL(process.env.ELECTRON_RENDERER_URL)
  else await window.loadFile(join(dir, '../renderer/index.html'))
  if ((process.env.CLAX_SHOW ?? process.env.DESKAGENT_SHOW) === '1') show()
  if (!process.env.CLAX_TEST && !process.env.DESKAGENT_TEST) {
    try { startShortcut() } catch { /* Keep the tray available so a conflicting shortcut can be changed. */ }
    // A temporary catalogue/network failure must not prevent the tray/UI from starting.
    void service.importOpenRouter().catch(() => {}).finally(() => service.startMemory())
  }
  screen.on('display-metrics-changed', () => { if (!quitting && !window.isDestroyed() && window.isVisible()) { const size = window.getSize(); dock(size[0] ?? 840, size[1] ?? 700) } })
}).catch(error => { dialog.showErrorBox('Clax could not start', error instanceof Error ? error.message : String(error)); quitting = true; app.quit() })

app.on('second-instance', () => { if (window) show() })
app.on('activate', () => { if (window && !window.isDestroyed() && !window.isVisible()) show() })
app.on('window-all-closed', () => { /* tray lifetime is independent of the floating window */ })
app.on('before-quit', event => {
  if (quitting) return
  event.preventDefault(); quitting = true
  if (blurTimer) clearTimeout(blurTimer)
  if (shortcutTimer) clearTimeout(shortcutTimer)
  globalShortcut.unregisterAll(); tray?.destroy()
  void (service?.shutdown() ?? Promise.resolve()).finally(() => app.quit())
})
