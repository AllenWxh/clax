import { _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test'
import { createRequire } from 'node:module'
import { execFile, spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { promisify } from 'node:util'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { fixtureServer } from '../tests/fixture-server'
import type { AppSnapshot } from '../src/shared/types'
import { DEFAULT_SHORTCUT } from '../src/shared/shortcuts'

const require = createRequire(import.meta.url)
const server = await fixtureServer()
const project = resolve('.'), home = resolve(`test-results/desktop-${Date.now()}`), workspace = join(home, 'workspace')
await mkdir(workspace, { recursive: true })
await writeFile(join(workspace, 'package.json'), '{"name":"clax-desktop-fixture"}\n')
const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), CLAX_HOME: home, CLAX_TEST: '1', CLAX_SHOW: '1', CLAX_FIXTURE_API_KEY: 'fixture-env-secret' }
delete env.ELECTRON_RUN_AS_NODE
delete env.ELECTRON_RENDERER_URL
let desktop: ElectronApplication | undefined
let page!: Page
const errors: string[] = []
const checks: string[] = []
const limitations: string[] = []
let screenLocked = false
let uiChecksStarted = false
async function wakeForUI() {
  // UI actions reopen the compact window; the initial native blur checks run before this handler.
  await page.addLocatorHandler(page.getByRole('button', { name: 'Expand Clax' }), () => page.evaluate(() => window.clax.expand()))
}
async function launch(show = true) {
  // Isolate tool writes as well as app storage and Chromium's cache.
  desktop = await electron.launch({ executablePath: require('electron'), args: [`--user-data-dir=${join(home, 'electron-profile')}`, project], cwd: workspace, env: { ...env, CLAX_SHOW: show ? '1' : '0' }, timeout: 30000 })
  page = await desktop.firstWindow()
  page.on('pageerror', e => errors.push(e.message))
  await expect.poll(() => page.evaluate(() => Boolean(window.clax)), { timeout: 10000 }).toBe(true)
  screenLocked = process.platform === 'darwin' && (await promisify(execFile)('/usr/bin/swift', ['-e', 'import AppKit; print(NSWorkspace.shared.frontmostApplication?.bundleIdentifier == "com.apple.loginwindow")'])).stdout.trim() === 'true'
  if (!show) {
    expect(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isVisible())).toBe(false)
    check('Default startup keeps the large window hidden')
  }
  await page.evaluate(() => window.clax.expand())
  await expect(page.locator('.window')).toBeVisible()
  if (uiChecksStarted) await wakeForUI()
}
async function snapshot() { return await page.evaluate(() => window.clax.bootstrap()) }
async function idle() { await expect.poll(async () => (await snapshot()).runningSessions.length, { timeout: 15000 }).toBe(0) }
function check(name: string) { checks.push(name); console.log(`PASS ${name}`) }
async function nativeShortcut() {
  const source = `import Foundation
import ApplicationServices
let events: [(CGKeyCode, Bool, CGEventFlags, Bool)] = [(58, true, .maskAlternate, true), (8, true, .maskAlternate, false), (8, false, .maskAlternate, false), (58, false, [], true)]
for (key, down, flags, modifier) in events {
  let event = CGEvent(keyboardEventSource: nil, virtualKey: key, keyDown: down)!
  if modifier { event.type = .flagsChanged }
  event.flags = flags
  event.post(tap: .cghidEventTap)
  usleep(35000)
}`
  await promisify(execFile)('/usr/bin/swift', ['-e', source], { timeout: 30000 })
}

try {
  await launch(false)
  await expect(page.getByRole('combobox', { name: 'Agent permissions' })).toHaveValue('full')
  // Control/protocol checks are isolated from optional background model requests.
  await page.evaluate(async () => { const state = await window.clax.bootstrap(); await window.clax.saveSettings({ ...state.settings, memory: { enabled: true, autoCapture: false } }) })
  await expect(page.getByText('No provider configured.', { exact: true })).toBeVisible()
  const style = await page.locator('.window').evaluate(el => { const s = getComputedStyle(el); return { background: s.backgroundColor, scheme: s.colorScheme, margin: s.margin, shadow: s.boxShadow } })
  expect(style.background).toBe('rgba(255, 255, 255, 0.97)'); expect(style.scheme).toBe('light')
  expect(style.margin).toBe('0px'); expect(style.shadow).toBe('none')
  const windowState = await desktop!.evaluate(({ BrowserWindow, screen }) => { const w = BrowserWindow.getAllWindows()[0]!; return { alwaysOnTop: w.isAlwaysOnTop(), bounds: w.getBounds(), area: screen.getDisplayMatching(w.getBounds()).workArea } })
  expect(windowState.alwaysOnTop).toBe(true)
  expect(windowState.bounds.y).toBe(windowState.area.y)
  const composer = await page.getByTestId('composer').elementHandle()
  if (screenLocked) {
    await page.evaluate(() => window.clax.collapse())
    limitations.push('The desktop was locked: collapse/expand IPC and native bounds verified; the physical OS blur event requires an unlocked rerun.')
  } else await desktop!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.blur())
  await expect(page.getByRole('button', { name: 'Expand Clax' })).toBeVisible()
  const collapsed = await desktop!.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]!; return { alwaysOnTop: w.isAlwaysOnTop(), bounds: w.getBounds() } })
  expect(collapsed.alwaysOnTop).toBe(false); expect(collapsed.bounds.width).toBe(340); expect(collapsed.bounds.height).toBe(46)
  expect(collapsed.bounds.y).toBe(windowState.area.y)
  expect(await composer!.evaluate(el => el.isConnected)).toBe(true)
  await expect(page.getByTestId('composer')).toBeHidden()
  await desktop!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.focus())
  expect((await snapshot()).windowMode).toBe('collapsed')
  await page.screenshot({ path: resolve('test-results/collapsed.png') })
  await page.evaluate(() => window.clax.expand())
  await expect(page.getByTestId('composer')).toBeVisible()
  expect(await desktop!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getSize())).toEqual([windowState.bounds.width, windowState.bounds.height])
  check(screenLocked ? 'Collapse/expand IPC updates native bounds and always-on-top; OS blur awaits an unlocked desktop' : 'Native blur collapses to the screen top, relinquishes always-on-top and restores the window')
  check('Electron loads the frameless, white translucent React UI without a provider')
  await page.evaluate(() => window.clax.enableShortcut())
  expect((await snapshot()).shortcutRegistered).toBe(true)
  expect(await desktop!.evaluate(({ globalShortcut }, shortcut) => globalShortcut.isRegistered(shortcut), DEFAULT_SHORTCUT)).toBe(true)
  check('Default two-key Option / Alt + C is registered with the operating system')
  const canPost = process.platform === 'darwin' && !screenLocked && (await promisify(execFile)('/usr/bin/swift', ['-e', 'import ApplicationServices; print(CGPreflightPostEventAccess())'])).stdout.trim() === 'true'
  if (canPost) {
    // Use a separate app: activating a second window in Clax can itself trigger its app activation handler.
    const main = await desktop!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.id)
    const fixturePath = join(home, 'shortcut-fixture')
    await promisify(execFile)('/usr/bin/xcrun', ['swiftc', resolve('tests/activity-fixture.swift'), '-o', fixturePath], { timeout: 60000 })
    await page.evaluate(() => window.clax.hide())
    const fixture = spawn(fixturePath, [], { stdio: ['pipe', 'pipe', 'pipe'] })
    const reader = createInterface({ input: fixture.stdout })
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Native shortcut fixture did not become ready')), 10000)
        reader.on('line', line => { if (line === 'ready') { clearTimeout(timer); resolve() } })
        fixture.on('error', error => { clearTimeout(timer); reject(error) })
      })
      await expect.poll(async () => (await promisify(execFile)('/usr/bin/swift', ['-e', `import AppKit; print(NSWorkspace.shared.frontmostApplication?.processIdentifier == ${fixture.pid})`])).stdout.trim()).toBe('true')
      await nativeShortcut()
      await expect.poll(() => desktop!.evaluate(({ BrowserWindow }, id) => { const w = BrowserWindow.fromId(id)!; return w.isVisible() && w.isFocused() }, main)).toBe(true)
      await expect(page.getByTestId('composer')).toBeFocused()
      await nativeShortcut()
      await expect.poll(() => desktop!.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)!.isVisible(), main)).toBe(false)
      check('Native macOS Option+C opens and focuses Clax from another window, then hides it')
    } finally {
      reader.close(); fixture.stdin.end(); fixture.kill()
      await page.evaluate(() => window.clax.expand())
    }
  } else limitations.push('Native Option+C dispatch requires an unlocked Mac with event-posting permission; physical keyboards were not pressed by this test.')
  uiChecksStarted = true
  await wakeForUI()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const contextSelect = page.getByRole('combobox', { name: 'Context budget', exact: true })
  await expect(contextSelect).toHaveValue('0')
  await expect(contextSelect.locator('option[value="0"]')).toHaveText('模型最大容量（默认）')
  await contextSelect.selectOption('96000')
  await expect.poll(async () => (await snapshot()).settings.maxContextChars).toBe(96000)
  await contextSelect.selectOption('0')
  await expect.poll(async () => (await snapshot()).settings.maxContextChars).toBe(0)
  await expect(page.getByTestId('context-budget-effective')).toContainText('21,299 tokens')
  check('Unlimited model capacity is the default, explicit smaller budgets remain available and unknown models stay within capacity')
  const shortcutSelect = page.getByRole('combobox', { name: 'Global shortcut', exact: true })
  await expect(shortcutSelect).toHaveValue(DEFAULT_SHORTCUT)
  await shortcutSelect.selectOption('Alt+D')
  await expect.poll(async () => (await snapshot()).settings.globalShortcut).toBe('Alt+D')
  expect(await desktop!.evaluate(({ globalShortcut }, shortcut) => ({ old: globalShortcut.isRegistered(shortcut), next: globalShortcut.isRegistered('Alt+D') }), DEFAULT_SHORTCUT)).toEqual({ old: false, next: true })
  await expect(page.locator('.footer-note')).toContainText('Option / Alt + D')
  check('Settings switch the native shortcut and update the visible hint')
  // Occupy another combination to exercise a real registration failure.
  expect(await desktop!.evaluate(({ globalShortcut }) => globalShortcut.register('Alt+V', () => {}))).toBe(true)
  await shortcutSelect.selectOption('Alt+V')
  await expect(page.getByRole('alert')).toContainText('无法注册')
  await expect(shortcutSelect).toHaveValue('Alt+D')
  expect((await snapshot()).settings.globalShortcut).toBe('Alt+D')
  expect((await snapshot()).shortcutRegistered).toBe(true)
  expect(await desktop!.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('Alt+D'))).toBe(true)
  expect(JSON.parse(await readFile(join(home, 'settings.json'), 'utf8')).globalShortcut).toBe('Alt+D')
  await desktop!.evaluate(({ globalShortcut }) => globalShortcut.unregister('Alt+V'))
  await page.getByRole('button', { name: 'Close settings' }).click()
  check('A shortcut conflict reports an error and preserves the previous shortcut and saved setting')
  const input = { name: 'Fixture A', kind: 'compatible' as const, baseUrl: server.url, apiKey: 'fixture-ui-key', toolCalling: true, modelIds: ['fixture-a', 'fixture-b'] }
  const p = await page.evaluate(async input => { const models = await window.clax.testProvider(input); if (models.length !== 2) throw new Error('Catalogue failed'); return window.clax.saveProvider(input) }, input)
  let state = await snapshot(), id = state.session.id
  await page.evaluate(async ({ id, provider }) => { await window.clax.setModel(id, { provider, model: 'fixture-a' }); await window.clax.send(id, 'files-fixture') }, { id, provider: p.id })
  await idle(); await expect(page.locator('.tool-activity')).toHaveCount(1)
  state = await snapshot(); expect(state.session.messages.find(m => m.role === 'tool')?.content).toContain('package.json')
  check('Provider discovery, streaming tool call, IPC, activity UI and real directory listing')
  await page.evaluate(id => window.clax.send(id, 'shell-fixture'), id); await idle()
  state = await snapshot(); expect(state.session.messages.filter(m => m.role === 'tool').at(-1)?.content).toMatch(/v\d+\./)
  check('Shell executes locally, retains stdout and exit code')
  const second = await page.evaluate(input => window.clax.saveProvider({ ...input, name: 'Fixture B', apiKey: undefined, apiKeyEnv: 'CLAX_FIXTURE_API_KEY' }), input)
  await page.evaluate(async ({ id, provider }) => { await window.clax.setModel(id, { provider, model: 'fixture-b' }); await window.clax.send(id, 'Switch fixture') }, { id, provider: second.id })
  await idle(); state = await snapshot(); expect(state.session.messages.filter(m => m.role === 'user')).toHaveLength(3)
  expect(server.requests.at(-1).model).toBe('fixture-b'); expect(server.requests.at(-1).messages.filter((m: any) => m.role === 'user')).toHaveLength(3)
  const providerJSON = await readFile(join(home, 'providers.json'), 'utf8'), credentials = await readFile(join(home, 'credentials.json'), 'utf8')
  expect(providerJSON).not.toContain('fixture-ui-key'); expect(credentials).not.toContain('fixture-ui-key'); expect(providerJSON).toContain('CLAX_FIXTURE_API_KEY'); expect(credentials).not.toContain('fixture-env-secret')
  check('Same-session cross-provider switching and encrypted / environment-reference keys')
  await page.evaluate(id => window.clax.send(id, 'slow-fixture'), id)
  const liveText = page.locator('.assistant-message').last().locator('.markdown')
  await expect(liveText).toBeVisible()
  const firstLength = (await liveText.innerText()).length
  await expect.poll(async () => (await liveText.innerText()).length).toBeGreaterThan(firstLength)
  expect((await snapshot()).runningSessions).toContain(id)
  check('Chat text visibly grows before the HTTP stream finishes')
  await page.getByTestId('pause').click(); await idle()
  const pausedProgress = (await snapshot()).session.messages.at(-1)!.content
  expect(pausedProgress.length).toBeGreaterThan(0)
  expect((await snapshot()).session.paused).toBe(true)
  await expect(page.getByTestId('resume')).toBeVisible()
  await page.getByTestId('resume').click(); await idle()
  expect((await snapshot()).session.paused).toBe(false)
  expect(server.requests.at(-1).messages.some((m: any) => m.role === 'assistant' && m.content === pausedProgress)).toBe(true)
  check('Pause / Resume buttons preserve partial output and continue from retained context')
  await page.evaluate(id => window.clax.send(id, 'slow-fixture'), id)
  await expect.poll(async () => (await snapshot()).session.messages.at(-1)?.content.length ?? 0).toBeGreaterThan(0)
  await page.getByTestId('composer').fill('改方向，只回复已经收到新指令。')
  await page.getByRole('button', { name: 'Steer agent', exact: true }).click(); await idle()
  expect((await snapshot()).session.messages.some(m => m.status === 'interrupted')).toBe(true)
  expect((await snapshot()).session.messages.at(-1)!.content).toContain('已经收到新指令')
  check('Visible Steer control interrupts live output and sends the new direction')
  await page.evaluate(id => window.clax.send(id, 'slow-fixture'), id)
  await expect.poll(async () => (await snapshot()).session.messages.at(-1)?.content.length ?? 0).toBeGreaterThan(0)
  await page.evaluate(() => window.clax.hide())
  expect(await desktop!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isVisible())).toBe(false)
  expect((await snapshot()).runningSessions).toContain(id)
  await page.evaluate(id => window.clax.stop(id), id); await idle()
  await page.evaluate(() => window.clax.expand())
  expect((await snapshot()).session.messages.at(-1)?.status).toBe('stopped')
  check('Hide keeps the agent alive; Stop aborts an in-flight network stream')
  await page.evaluate(async id => { const s = await window.clax.bootstrap(); await window.clax.saveSettings({ ...s.settings, permissionMode: 'ask' }); await window.clax.send(id, 'shell-fixture') }, id)
  await expect(page.getByTestId('approval')).toBeVisible()
  const approval = (await snapshot()).approvals[0]!
  await page.evaluate(id => window.clax.approve(id, false), approval.id); await idle()
  expect((await snapshot()).session.messages.flatMap(m => m.activities ?? []).at(-1)?.status).toBe('denied')
  check('Ask mode reaches the approval UI and Reject prevents execution')
  await page.evaluate(id => window.clax.send(id, 'permissions-fixture'), id)
  await expect(page.getByTestId('approval')).toBeVisible()
  await page.getByRole('button', { name: '全权授权并继续', exact: true }).click(); await idle()
  await expect(page.getByTestId('approval')).toHaveCount(0)
  await expect(page.getByRole('combobox', { name: 'Agent permissions' })).toHaveValue('full')
  expect((await snapshot()).session.messages.flatMap(m => m.activities ?? []).slice(-2).map(a => a.status)).toEqual(['done', 'done'])
  expect(await readFile(join((await snapshot()).session.workspace, 'approved.txt'), 'utf8')).toBe('Full access continued the tool batch.')
  check('Grant full access continues the waiting shell and subsequent file write without more prompts')
  await page.evaluate(async () => { await window.clax.saveMemory('PREFERENCES.md', 'Desktop persistence marker'); const s = await window.clax.bootstrap(); await window.clax.saveSettings({ ...s.settings, enabledSkills: { coding: false } }) })
  await page.evaluate(id => window.clax.send(id, 'slow-fixture'), id)
  await expect.poll(async () => (await snapshot()).session.messages.at(-1)?.content.length ?? 0).toBeGreaterThan(0)
  await page.getByTestId('pause').click(); await idle()
  const before = await snapshot()
  await page.screenshot({ path: resolve('test-results/desktop.png') })
  await desktop!.close(); desktop = undefined
  await launch(); const restored = await snapshot()
  expect(restored.settings.permissionMode).toBe('full')
  expect(restored.settings.maxContextChars).toBe(0)
  expect(restored.session.id).toBe(before.session.id); expect(restored.session.messages).toHaveLength(before.session.messages.length)
  expect(restored.memory['PREFERENCES.md']).toBe('Desktop persistence marker'); expect(restored.skills.find(s => s.id === 'coding')?.enabled).toBe(false)
  expect(restored.providers.find(p => p.id === second.id)?.apiKeyEnv).toBe('CLAX_FIXTURE_API_KEY')
  expect(restored.providers.find(provider => provider.id === p.id)?.hasKey).toBe(true)
  expect(restored.session.paused).toBe(true)
  await expect(page.getByTestId('resume')).toBeVisible()
  await page.getByTestId('resume').click(); await idle()
  expect((await snapshot()).session.paused).toBe(false)
  check('A paused task survives application restart and remains resumable')
  expect(restored.settings.globalShortcut).toBe('Alt+D')
  await page.evaluate(() => window.clax.enableShortcut())
  expect(await desktop!.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('Alt+D'))).toBe(true)
  check('Restart restores SQLite messages, selected model, memory, skills and providers')
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('button', { name: 'Memory', exact: true }).click()
  await expect(page.getByRole('switch', { name: 'Use memory' })).toHaveAttribute('aria-checked', 'true')
  await page.getByRole('switch', { name: 'Automatically capture memory' }).click()
  await expect.poll(async () => (await snapshot()).settings.memory.autoCapture).toBe(true)
  await page.getByRole('button', { name: 'Close settings' }).click()
  await page.getByTestId('composer').fill('这是长期的通用偏好：我的所有回答都用中文。')
  await page.getByTestId('composer').press('Enter'); await idle()
  await expect.poll(async () => (await snapshot()).memoryStatus.learned, { timeout: 15000 }).toBeGreaterThan(0)
  const learned = (await page.evaluate(() => window.clax.searchMemory('回答 中文'))).find(h => h.kind === 'preference')!
  expect(learned.sourceSession).toBe(id); expect(learned.sourceMessages!.length).toBeGreaterThan(0)
  expect((await snapshot()).memoryStatus.daily).toBeGreaterThan(0)
  check('Real HTTP extraction saves grounded preferences and dated activity after the reply')
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('button', { name: 'Memory', exact: true }).click()
  await page.getByRole('textbox', { name: 'Search memory' }).fill('回答 中文')
  await page.getByRole('button', { name: 'Search memory', exact: true }).click()
  const entry = page.locator('.memory-result').filter({ hasText: learned.path })
  await expect(entry).toBeVisible()
  await entry.getByRole('button', { name: '查看来源' }).click()
  await expect(page.locator('.summary-detail').filter({ hasText: 'Memory source' })).toContainText('clax-memory')
  await page.screenshot({ path: resolve('test-results/memory.png') })
  await page.getByRole('button', { name: 'Close settings' }).click()
  check('Memory settings expose switches, Chinese search and source inspection')
  await page.evaluate(() => window.clax.newSession())
  const newId = (await snapshot()).session.id
  await page.evaluate(id => window.clax.send(id, '按照之前的沟通偏好简短回答。'), newId); await idle()
  expect(server.requests.filter(r => r.tools?.length).at(-1).messages[0].content).toContain('用户希望回答使用中文')
  check('A new session receives durable personal preferences without replaying old chat')
  await desktop!.close(); desktop = undefined; await launch()
  expect((await page.evaluate(() => window.clax.searchMemory('回答 中文'))).some(h => h.path === learned.path)).toBe(true)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('button', { name: 'Memory', exact: true }).click()
  await page.getByRole('textbox', { name: 'Search memory' }).fill('回答 中文')
  await page.getByRole('button', { name: 'Search memory', exact: true }).click()
  await expect(page.locator('.memory-result').filter({ hasText: learned.path })).toBeVisible()
  await page.locator('.memory-result').filter({ hasText: learned.path }).getByRole('button', { name: '忘记这条' }).click()
  await expect.poll(async () => (await page.evaluate(() => window.clax.searchMemory('回答 中文'))).some(h => h.path === learned.path)).toBe(false)
  check('Learned memory survives Electron restart and Forget removes the active entry')
  await page.getByRole('button', { name: 'Close settings' }).click()
  await page.evaluate(async () => { const s = await window.clax.bootstrap(); await window.clax.send(s.session.id, 'long-task-fixture') }); await idle()
  const longState = await snapshot(), longTurn = longState.session.messages.findLast(m => m.role === 'user' && m.content === 'long-task-fixture')!.turnId
  const longActivities = longState.session.messages.filter(m => m.turnId === longTurn).flatMap(m => m.activities ?? [])
  expect(longActivities).toHaveLength(60)
  expect(longActivities.every(a => a.status === 'done')).toBe(true)
  expect(longState.session.messages.at(-1)?.status).toBe('complete')
  check('One HTTP task executes 60 tool steps and completes without a step-budget failure or forced continuation')
  expect(errors).toEqual([])
  await desktop!.evaluate(({ BrowserWindow, app, screen }) => {
    BrowserWindow.getAllWindows()[0]!.destroy()
    app.emit('activate'); app.emit('second-instance'); screen.emit('display-metrics-changed')
  })
  check('Wake and display events safely ignore a destroyed window during shutdown')
  await writeFile(resolve('test-results/desktop-validation.json'), JSON.stringify({ checks, errors, limitations, home, style, sessionId: id }, null, 2))
  console.log(`Desktop verification complete: ${checks.length} checks.`)
} catch (error) {
  if (desktop && !page.isClosed()) {
    await page.screenshot({ path: resolve('test-results/desktop-failure.png') }).catch(() => {})
    const ui = await page.evaluate(() => ({ query: (document.querySelector('#memory-query') as HTMLInputElement | null)?.value,
      results: document.querySelectorAll('.memory-result').length, text: document.querySelector('.settings-content')?.textContent?.slice(0, 4000) })).catch(() => ({}))
    await writeFile(resolve('test-results/desktop-failure.json'), JSON.stringify({ ui, errors, checks }, null, 2))
  }
  throw error
} finally { await desktop?.close(); await server.close() }
