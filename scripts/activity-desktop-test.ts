import { _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test'
import { createRequire } from 'node:module'
import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { promisify } from 'node:util'
import { createInterface } from 'node:readline'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { ActivityStore, defaultActivity } from '../src/main/activity-store'
import { localDate, redactSecrets } from '../src/main/memory'
import { fixtureServer } from '../tests/fixture-server'

if (process.platform !== 'darwin') throw new Error('Native activity validation requires macOS')
const require = createRequire(import.meta.url), home = resolve(`test-results/activity-${Date.now()}`)
await mkdir(home, { recursive: true })
const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), CLAX_HOME: home, CLAX_TEST: '1', CLAX_SHOW: '1' }
delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
const server = await fixtureServer(), checks: string[] = [], errors: string[] = [], limitations: string[] = []
let desktop: ElectronApplication | undefined, fixture: ChildProcessWithoutNullStreams | undefined, probe: ChildProcessWithoutNullStreams | undefined
let page!: Page, accessibility = false
const check = (name: string) => { checks.push(name); console.log(`PASS ${name}`) }
const snapshot = () => page.evaluate(() => window.clax.bootstrap())
async function launch() {
  desktop = await electron.launch({ executablePath: require('electron'), args: [`--user-data-dir=${join(home, 'profile')}`, '.'], cwd: resolve('.'), env: env as Record<string, string>, timeout: 30000 })
  page = await desktop.firstWindow(); page.on('pageerror', error => errors.push(error.message))
  await expect.poll(() => page.evaluate(() => Boolean(window.clax))).toBe(true)
  await page.evaluate(() => window.clax.expand())
}
try {
  await launch()
  expect((await snapshot()).settings.activity.enabled).toBe(false)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('button', { name: 'Activity', exact: true }).click()
  await expect(page.getByRole('switch', { name: '活动记录', exact: true })).toHaveAttribute('aria-checked', 'false')
  await expect(page.getByRole('button', { name: '记录选中文字', exact: true })).toBeDisabled()
  check('Collection defaults to paused, with disabled selection capture and visible controls')

  // A distinct native app avoids macOS activating another instance with Electron's shared bundle ID.
  const fixturePath = join(home, 'activity-fixture')
  await promisify(execFile)('/usr/bin/xcrun', ['swiftc', resolve('tests/activity-fixture.swift'), '-o', fixturePath], { timeout: 120000 })
  fixture = spawn(fixturePath, [], { stdio: 'pipe' }); fixture.stderr.resume()
  const fixturePid = fixture.pid
  probe = spawn(resolve('out/native/clax-activity'), [], { stdio: 'pipe' })
  const frames: any[] = [], reader = createInterface({ input: probe.stdout })
  reader.on('line', line => frames.push(JSON.parse(line)))
  probe.stdin.write(`${JSON.stringify({ type: 'configure', enabled: true, generation: 1, ownerPid: desktop!.process().pid, excludedApps: defaultActivity.excludedApps })}\n`)
  fixture.stdin.write('text\n')
  await expect.poll(() => frames.some(frame => frame.type === 'sample' && (frame.pid === fixturePid || frame.locked)), { timeout: 15000 }).toBe(true)
  const screenLocked = frames.some(frame => frame.type === 'sample' && frame.locked)
  if (screenLocked) {
    const locked = frames.find(frame => frame.type === 'sample' && frame.locked)
    accessibility = locked.trusted
    expect(locked).not.toHaveProperty('text'); expect(locked).not.toHaveProperty('window'); expect(locked).not.toHaveProperty('app')
    probe.stdin.write(`${JSON.stringify({ type: 'selection', id: 'locked-selection' })}\n`)
    await expect.poll(() => frames.some(frame => frame.type === 'selection' && frame.id === 'locked-selection')).toBe(true)
    const selection = frames.find(frame => frame.type === 'selection' && frame.id === 'locked-selection')
    expect(selection.error).toContain('锁定'); expect(selection).not.toHaveProperty('text')
    limitations.push('The device was locked. Native lock-screen exclusion verified; foreground-window, selected-text and secure-field success need an unlocked desktop rerun.')
    check('The actual macOS lock screen returns no app/window/text data and denies selection capture')
  } else {
  const nativeSample = frames.findLast(frame => frame.type === 'sample' && frame.pid === fixturePid)
  expect(Number.isFinite(nativeSample.idleSeconds)).toBe(true)
  expect(nativeSample).not.toHaveProperty('text'); expect(nativeSample).not.toHaveProperty('keyCode')
  accessibility = nativeSample.trusted
  check('Compiled macOS helper reads the real foreground fixture and idle time without input text')
  probe.stdin.write(`${JSON.stringify({ type: 'selection', id: 'fixture-selection' })}\n`)
  await expect.poll(() => frames.some(frame => frame.type === 'selection' && frame.id === 'fixture-selection'), { timeout: 10000 }).toBe(true)
  const selection = frames.find(frame => frame.type === 'selection' && frame.id === 'fixture-selection')
  if (accessibility) {
    expect(nativeSample.window).toContain('Clax 活动验证窗口')
    expect(selection.text).toContain('fixture-selected-text')
    check('Granted Accessibility permits the real fixture title and explicitly selected text')
    fixture.stdin.write('password\n')
    await expect.poll(() => frames.some(frame => frame.type === 'sample' && frame.blocked), { timeout: 10000 }).toBe(true)
    probe.stdin.write(`${JSON.stringify({ type: 'selection', id: 'secure-field' })}\n`)
    await expect.poll(() => frames.some(frame => frame.type === 'selection' && frame.id === 'secure-field')).toBe(true)
    const secured = frames.find(frame => frame.type === 'selection' && frame.id === 'secure-field')
    expect(secured.error).toBeTruthy(); expect(secured).not.toHaveProperty('text')
    fixture.stdin.write('text\n')
    check('A real macOS password field blocks both observation content and explicit selection capture')
  } else {
    expect(selection.error).toContain('辅助功能权限'); expect(nativeSample.window).toBe('')
    limitations.push('Accessibility is not granted on this device: native title/selected-text success needs user authorization; app and idle-time capture verified.')
    check('Denied Accessibility leaves titles empty and selection capture reports a permission requirement')
  }
  }
  probe.stdin.write(`${JSON.stringify({ type: 'configure', enabled: false, generation: 2, ownerPid: desktop!.process().pid, excludedApps: [] })}\n`)
  await expect.poll(() => frames.some(frame => frame.type === 'ready' && frame.generation === 2)).toBe(true)
  probe.stdin.end(); probe.kill(); probe = undefined; reader.close()

  await page.evaluate(() => window.clax.expand())
  await page.getByRole('switch', { name: '活动记录', exact: true }).click()
  fixture.stdin.write('text\n')
  await expect.poll(async () => (await snapshot()).activityStatus.lastSampleAt ?? 0, { timeout: 15000 }).toBeGreaterThan(0)
  const live = (await snapshot()).activityStatus
  expect(live.state).not.toBe('error'); expect(['granted', 'needed', 'unknown']).toContain(live.accessibility)
  if (screenLocked) expect(live.state).toBe('locked')
  check(screenLocked ? 'Electron starts the native collector and reports paused recording on the locked desktop' : 'Electron UI starts the real native collector and reflects its permission and sampling state')
  await page.evaluate(() => window.clax.expand())
  await page.getByRole('switch', { name: '活动记录', exact: true }).click()
  await expect.poll(async () => (await snapshot()).activityStatus.state).toBe('off')
  check('Pause stops native collection without disabling existing history')
  fixture.stdin.end(); fixture.kill(); fixture = undefined

  const date = localDate(), now = Date.now(), token = 'activity-fixture-grounded-note'
  const store = new ActivityStore(home, redactSecrets)
  store.record({ time: now - 9000, app: 'Fixture Editor', bundleId: 'com.fixture.editor', window: 'Clax 开发记录', idleSeconds: 1 }, { ...defaultActivity, enabled: true })
  store.record({ time: now - 6000, app: 'Fixture Editor', bundleId: 'com.fixture.editor', window: 'Clax 开发记录', idleSeconds: 1 }, { ...defaultActivity, enabled: true })
  store.selection({ time: now - 1000, app: 'Fixture Editor', bundleId: 'com.fixture.editor', window: 'Clax 开发记录', idleSeconds: 1 }, token, { ...defaultActivity, enabled: true })
  store.close()
  await page.getByRole('button', { name: '刷新活动', exact: true }).click()
  await expect(page.locator('.activity-entry').filter({ hasText: token })).toBeVisible()
  await page.getByRole('textbox', { name: '搜索活动', exact: true }).fill('开发记录')
  await expect(page.locator('.activity-entry').filter({ hasText: token })).toBeVisible()
  await page.screenshot({ path: resolve('test-results/activity.png') })
  const beforeRestart = await page.evaluate(date => window.clax.activityReport(date, '开发记录'), date)
  check('Activity UI displays dates, app durations, Chinese window search and saved selections')

  const provider = await page.evaluate(async url => {
    const state = await window.clax.bootstrap()
    await window.clax.saveSettings({ ...state.settings, memory: { enabled: true, autoCapture: false } })
    return window.clax.saveProvider({ name: 'Fixture', kind: 'compatible', baseUrl: url, modelIds: ['fixture-a'], toolCalling: true })
  }, server.url)
  const state = await snapshot()
  await page.evaluate(async ({ id, provider }) => { await window.clax.setModel(id, { provider, model: 'fixture-a' }); await window.clax.send(id, '今天做了什么？') }, { id: state.session.id, provider: provider.id })
  await expect.poll(async () => (await snapshot()).runningSessions.length).toBe(0)
  expect(server.requests.at(-1).messages[0].content).toContain(token)
  check('A daily-work question sends actual saved activity through the real HTTP adapter')
  await page.getByRole('switch', { name: '记忆检索使用活动', exact: true }).click()
  const next = await page.evaluate(() => window.clax.newSession())
  await page.evaluate(id => window.clax.send(id, '今天做了什么？'), next.session.id)
  await expect.poll(async () => (await snapshot()).runningSessions.length).toBe(0)
  expect(server.requests.at(-1).messages[0].content).not.toContain(token)
  check('The model-access switch removes desktop observations from subsequent request context')

  await desktop!.close(); desktop = undefined
  await launch()
  const restored = await page.evaluate(date => window.clax.activityReport(date, '开发记录'), date)
  expect(restored.items).toEqual(beforeRestart.items)
  expect((await snapshot()).settings.activity.useInMemory).toBe(false)
  expect((await snapshot()).activityStatus.state).toBe('off')
  check('Restart preserves activity records and the pause/model-access choices')
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('button', { name: 'Activity', exact: true }).click()
  await page.getByRole('button', { name: '删除这一天', exact: true }).click()
  await page.getByRole('button', { name: '确认删除这一天', exact: true }).click()
  await expect.poll(async () => (await page.evaluate(date => window.clax.activityReport(date), date)).items.length).toBe(0)
  check('The day-delete UI removes saved activity after a concrete confirmation')
  expect(errors).toEqual([])
} catch (error) {
  errors.push(error instanceof Error ? error.stack ?? error.message : String(error))
  if (page) await page.screenshot({ path: resolve('test-results/activity-failure.png') }).catch(() => {})
  throw error
} finally {
  probe?.stdin.end(); probe?.kill()
  fixture?.stdin.end(); fixture?.kill()
  await desktop?.close().catch(() => {})
  await server.close()
  await writeFile(resolve('test-results/activity-validation.json'), JSON.stringify({ home, checks, errors, accessibilityGranted: accessibility, limitations }, null, 2))
}
