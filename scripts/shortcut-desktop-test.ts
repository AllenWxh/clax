import { _electron as electron, expect } from '@playwright/test'
import { createRequire } from 'node:module'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { createInterface } from 'node:readline'

if (process.platform !== 'darwin') throw new Error('This native desktop test requires macOS')
const home = resolve(`test-results/shortcut-desktop-${Date.now()}`), run = promisify(execFile)
await mkdir(home, { recursive: true })
const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), CLAX_HOME: home, CLAX_TEST: '1', CLAX_SHOW: '0' }
delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
const swift = async (source: string) => (await run('/usr/bin/swift', ['-e', source], { timeout: 30000 })).stdout.trim()
expect(await swift('import ApplicationServices; print(CGPreflightPostEventAccess())')).toBe('true')
expect(await swift('import AppKit; print(NSWorkspace.shared.frontmostApplication?.bundleIdentifier == "com.apple.loginwindow")')).toBe('false')
const fixturePath = join(home, 'fixture')
await run('/usr/bin/xcrun', ['swiftc', resolve('tests/activity-fixture.swift'), '-o', fixturePath], { timeout: 60000 })
const desktop = await electron.launch({ executablePath: createRequire(import.meta.url)('electron'), args: [`--user-data-dir=${join(home, 'chromium')}`, '.'], env, cwd: resolve('.') })
const page = await desktop.firstWindow(), checks: string[] = [], observations: unknown[] = [], errors: string[] = []
const fixture = spawn(fixturePath, [], { stdio: ['pipe', 'pipe', 'pipe'] }), reader = createInterface({ input: fixture.stdout })
const ready = new Promise<void>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('Fixture timeout')), 10000)
  reader.on('line', line => { if (line === 'ready') { clearTimeout(timer); resolve() } })
  fixture.on('error', error => { clearTimeout(timer); reject(error) })
})
const check = (name: string) => { checks.push(name); console.log(`PASS ${name}`) }
async function shortcut() {
  await swift(`import ApplicationServices
for (key,down,flags,modifier):(CGKeyCode,Bool,CGEventFlags,Bool) in [(58,true,.maskAlternate,true),(8,true,.maskAlternate,false),(8,false,.maskAlternate,false),(58,false,[],true)] {
let e=CGEvent(keyboardEventSource:nil,virtualKey:key,keyDown:down)!; if modifier {e.type = .flagsChanged}; e.flags=flags; e.post(tap:.cghidEventTap); usleep(35000)
}`)
}
async function nativeState() {
  const window = await desktop.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]!; return { pid: process.pid, visible: w.isVisible(), focused: w.isFocused(), bounds: w.getBounds(), top: w.isAlwaysOnTop() } })
  const native = JSON.parse(await swift(`import AppKit; import ApplicationServices; import Foundation
let windows=(CGWindowListCopyWindowInfo(.optionOnScreenOnly,kCGNullWindowID) as? [[String:Any]] ?? []).filter { ($0[kCGWindowOwnerPID as String] as? Int)==${window.pid} && ($0[kCGWindowAlpha as String] as? Double ?? 0)>0 }
let data:[String:Any] = ["frontPid":NSWorkspace.shared.frontmostApplication?.processIdentifier ?? -1,"windows":windows.map { ["bounds":$0[kCGWindowBounds as String] ?? [:],"layer":$0[kCGWindowLayer as String] ?? -1] }]
print(String(data:try! JSONSerialization.data(withJSONObject:data),encoding:.utf8)!)`))
  return { ...window, native }
}
async function assertPresented(label: string) {
  // Electron's bounds/focus alone pass even when Exposé has transformed the window offscreen.
  let state = await nativeState()
  await expect.poll(async () => {
    state = await nativeState()
    return state.native.windows.some((w: any) => Math.abs(w.bounds.X - state.bounds.x) < 2 && Math.abs(w.bounds.Y - state.bounds.y) < 2 && w.bounds.Width === state.bounds.width && w.bounds.Height === state.bounds.height)
  }, { timeout: 10000 }).toBe(true)
  observations.push({ label, ...state })
}
async function assertWake(label: string) {
  await shortcut()
  await expect.poll(() => desktop.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]!; return w.isVisible() && w.isFocused() })).toBe(true)
  await expect(page.getByTestId('composer')).toBeFocused()
  await assertPresented(label)
  await swift('import ApplicationServices; for down in [true,false] { let e=CGEvent(keyboardEventSource:nil,virtualKey:8,keyDown:down)!; e.flags=[]; e.post(tap:.cghidEventTap); usleep(35000) }')
  await expect(page.getByTestId('composer')).toHaveValue('c')
  await page.getByTestId('composer').fill('')
  await shortcut()
  await expect.poll(() => desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isVisible())).toBe(false)
  check(label + ': visible on screen, accepts native typing, then hides')
}
try {
  await page.waitForFunction(() => Boolean(window.clax)); await ready
  await page.evaluate(() => window.clax.enableShortcut())
  await assertWake('Other application')
  await swift('import AppKit; NSRunningApplication.runningApplications(withBundleIdentifier:"com.apple.finder").first!.activate(options:.activateIgnoringOtherApps)')
  await assertWake('Finder desktop')
  await page.evaluate(() => window.clax.expand())
  await run('/usr/bin/open', ['-a', '/System/Applications/Mission Control.app', '--args', '1'])
  await assertPresented('Expanded window during Show Desktop')
  check('Show Desktop leaves the expanded window at its actual screen bounds')
  await page.evaluate(() => window.clax.hide())
  await assertWake('Show Desktop with hidden Clax')
  await page.evaluate(() => window.clax.expand())
  fixture.stdin.write('normal\n')
  await expect.poll(() => page.evaluate(async () => (await window.clax.bootstrap()).windowMode)).toBe('collapsed')
  expect((await nativeState()).top).toBe(false)
  await assertPresented('Collapsed after outside focus')
  check('Outside focus still collapses Clax and removes always-on-top')
  await assertWake('Show Desktop with collapsed Clax')
} catch (error) { errors.push((error as Error).message); throw error }
finally {
  reader.close(); fixture.stdin.end(); fixture.kill()
  await writeFile('test-results/shortcut-desktop-validation.json', JSON.stringify({ date: new Date().toISOString(), home, checks, observations, errors, limitations: ['Native CGEvent simulation; physical keyboards were not pressed. Fullscreen and separate Spaces were not exercised.'] }, null, 2) + '\n')
  await desktop.close()
}
