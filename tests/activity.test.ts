import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { LocalStore } from '../src/main/storage'
import { ActivityStore, defaultActivity, validActivityDate, type ActivitySample } from '../src/main/activity-store'
import { ActivityObserver } from '../src/main/activity'
import { localDate } from '../src/main/memory'
import { createTools, ProcessManager } from '../src/main/tools'
import { ContextManager } from '../src/main/context'

const codec = { available: () => false, encrypt: (v: string) => Buffer.from(v), decrypt: (v: Buffer) => v.toString() }
const config = { ...structuredClone(defaultActivity), enabled: true }
const sample = (time: number, patch: Partial<ActivitySample> = {}): ActivitySample => ({ time, app: 'Editor', bundleId: 'com.fixture.editor', window: 'Clax · 中文窗口', idleSeconds: 1, ...patch })
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'clax-activity-test-')), home = join(root, 'data'), workspace = join(root, 'project')
  await mkdir(workspace)
  const store = new LocalStore(home, codec, workspace)
  return { root, home, store, workspace, cleanup: async () => { store.close(); await rm(root, { recursive: true, force: true }) } }
}
class Source extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  commands: Record<string, any>[] = []
  stdin = new Writable({ write: (chunk, _encoding, callback) => { this.commands.push(JSON.parse(chunk.toString())); callback() } })
  kill() { this.emit('exit', 0); return true }
  frame(value: unknown) { this.stdout.write(`${JSON.stringify(value)}\n`) }
  asChild() { return this as unknown as ChildProcessWithoutNullStreams }
}

test('Activity is opt-in, and legacy settings retain their values without starting collection', async () => {
  const f = await setup()
  try {
    assert.equal(f.store.settings.activity.enabled, false)
    f.store.saveSettings({ ...f.store.settings, maxContextChars: 96000, activity: { ...config, enabled: false } })
    const saved: any = JSON.parse(await readFile(join(f.home, 'settings.json'), 'utf8')); delete saved.activity
    await writeFile(join(f.home, 'settings.json'), JSON.stringify(saved))
    let launches = 0
    const observer = new ActivityObserver(f.store.activity, f.store.settings.activity, '', () => {}, () => { launches++; return new Source().asChild() })
    observer.configure(f.store.settings.activity); assert.equal(launches, 0); observer.close()
    f.store.close()
    const reopened = new LocalStore(f.home, codec, f.workspace)
    assert.equal(reopened.settings.maxContextChars, 96000); assert.equal(reopened.settings.activity.enabled, false)
    reopened.close()
  } finally { await rm(f.root, { recursive: true, force: true }) }
})
test('Focus intervals merge while active and split across idle, application changes and long gaps', async () => {
  const f = await setup(), t = Date.now(), date = localDate(t)
  try {
    f.store.activity.record(sample(t), config); f.store.activity.record(sample(t + 3000), config)
    f.store.activity.record(sample(t + 6000), config)
    f.store.activity.record(sample(t + 9000, { idleSeconds: 70 }), config)
    f.store.activity.record(sample(t + 12000), config)
    f.store.activity.record(sample(t + 15000, { app: 'Browser', bundleId: 'com.fixture.browser' }), config)
    f.store.activity.record(sample(t + 18000, { app: 'Browser', bundleId: 'com.fixture.browser' }), config)
    f.store.activity.record(sample(t + 90000, { app: 'Browser', bundleId: 'com.fixture.browser' }), config)
    const report = f.store.activity.report(date)
    assert.equal(report.totalActiveMs, 9000)
    assert.equal(report.items.length, 4)
    assert.ok(report.apps.some(app => app.app === 'Editor' && app.activeMs === 6000))
  } finally { await f.cleanup() }
})
test('Excluded apps, privacy windows and disabled recording produce no stored content', async () => {
  const f = await setup(), t = Date.now()
  try {
    for (const s of [sample(t, { bundleId: 'com.apple.Passwords' }), sample(t, { bundleId: 'com.apple.loginwindow' }), sample(t, { window: '无痕窗口 · private-sentinel' }), sample(t, { app: 'Private App' })]) {
      assert.equal(f.store.activity.record(s, { ...config, excludedApps: [...config.excludedApps, 'Private App'] }), false)
      assert.throws(() => f.store.activity.selection(s, 'private-sentinel', { ...config, excludedApps: [...config.excludedApps, 'Private App'] }), /排除/)
    }
    assert.equal(f.store.activity.record(sample(t), { ...config, enabled: false }), false)
    assert.equal(f.store.activity.report(localDate(t)).items.length, 0)
  } finally { await f.cleanup() }
})
test('Explicit selections are complete, sanitized and durably restored without a chat or model call', async () => {
  const f = await setup(), t = Date.now(), key = 'activity-private-key-123456789'
  try {
    f.store.memory.setSecrets([key])
    f.store.activity.selection(sample(t), `今天完成了图表。${key} password=secret-value ${'内容'.repeat(3000)}`, config)
    f.store.activity.close(); f.store.activity = new ActivityStore(f.home, f.store.memory.sanitize)
    const report = f.store.activity.report(localDate(t), '图表')
    assert.equal(report.selections, 1); assert.equal(report.items.length, 1)
    assert.ok(report.items[0]!.text.length > 4000)
    assert.match(report.items[0]!.text, /REDACTED/)
    assert.doesNotMatch(report.items[0]!.text, /activity-private-key|secret-value/)
    assert.equal(f.store.listSessions().length, 0)
  } finally { await f.cleanup() }
})
test('Pagination preserves equal timestamps, and date deletion removes physical data and recall', async () => {
  const f = await setup(), t = Date.now(), date = localDate(t), sentinel = 'physical-deletion-sentinel-8a7206'
  try {
    for (let i = 0; i < 7; i++) f.store.activity.selection(sample(t), `${sentinel} ${i}`, config)
    const ids: string[] = []; let before: string | undefined
    do { const page = f.store.activity.report(date, '', before, 2); ids.push(...page.items.map(row => row.id)); before = page.nextBefore } while (before)
    assert.equal(new Set(ids).size, 7)
    assert.match(f.store.activity.context('今天做了什么'), /physical-deletion-sentinel/)
    f.store.activity.delete(date)
    assert.equal(f.store.activity.report(date).items.length, 0)
    assert.doesNotMatch(f.store.activity.context('今天做了什么'), /physical-deletion-sentinel/)
    assert.equal((await readFile(join(f.home, 'activity.db'))).includes(Buffer.from(sentinel)), false)
    assert.equal(validActivityDate('2026-02-31'), false); assert.throws(() => f.store.activity.report('2026-02-31'), /有效日期/)
  } finally { await f.cleanup() }
})
test('Retention removes older days, while desktop context and tools obey the model-access switch', async () => {
  const f = await setup(), t = Date.now(), old = t - 40 * 86400000
  try {
    f.store.activity.selection(sample(old), 'expired-activity-unique', config)
    f.store.activity.selection(sample(t), '今天阅读活动文档 current-activity-unique', config)
    f.store.activity.prune(30, t)
    assert.equal(f.store.activity.report(localDate(old)).items.length, 0)
    assert.match(f.store.context('今天做了什么'), /current-activity-unique/)
    assert.doesNotMatch(f.store.context('今天天气怎么样'), /current-activity-unique/)
    f.store.saveMemory('USER.md', `# 背景\n${'较长的用户背景记录。'.repeat(800)}`)
    const session = f.store.createSession({ provider: 'test', model: 'test' })
    session.messages.push({ id: 'today', turnId: 'today', role: 'user', content: '今天做了什么？', createdAt: t })
    const prepared = await new ContextManager(() => 16000).prepare(session, session.currentModel!, [], new AbortController().signal,
      { provider: () => { throw new Error('Recall must not request a model') }, context: query => f.store.context(query), permission: () => 'auto', takeSteering: () => [], approve: async () => true }, () => {})
    assert.match(prepared.system, /current-activity-unique/, 'Bounded context retains the relevant desktop evidence ahead of a long profile')
    f.store.saveSettings({ ...f.store.settings, activity: { ...config, useInMemory: false } })
    assert.doesNotMatch(f.store.context('今天做了什么'), /current-activity-unique/)
    const processes = new ProcessManager(), tool = createTools(f.store, processes).find(tool => tool.name === 'activity_search')!
    assert.equal(tool.available, false)
    await assert.rejects(() => tool.execute({}, { session, signal: new AbortController().signal, permission: 'auto', approve: async () => true, progress: () => {} }), /已关闭/)
    await processes.shutdown()
  } finally { await f.cleanup() }
})
test('Pause and lock reject in-flight selections and discard stale native samples', { skip: process.platform !== 'darwin' }, async () => {
  const f = await setup(), sources: Source[] = [], t = Date.now()
  const observer = new ActivityObserver(f.store.activity, config, '', () => {}, () => { const source = new Source(); sources.push(source); return source.asChild() })
  try {
    observer.configure(config)
    const source = sources[0]!, generation = source.commands[0]!.generation
    source.frame({ type: 'sample', generation, trusted: false, ...sample(t) })
    const pending = observer.captureSelection(), rejected = assert.rejects(pending, /已暂停/)
    const id = source.commands.at(-1)!.id
    observer.suspend(true); await rejected
    source.frame({ type: 'selection', generation, id, ...sample(t), text: 'late-secret-selection' })
    source.frame({ type: 'sample', generation, trusted: false, ...sample(t + 3000) })
    assert.equal(observer.status().state, 'locked')
    assert.equal(f.store.activity.report(localDate(t)).selections, 0)
    observer.suspend(false); assert.equal(sources.length, 2)
    observer.configure({ ...config, enabled: false })
    assert.equal(observer.status().state, 'off')
    assert.equal(f.store.activity.report(localDate(t)).totalActiveMs, 0)
  } finally { observer.close(); await f.cleanup() }
})
test('Clearing a date cancels an outstanding capture before a stale reply can recreate it', { skip: process.platform !== 'darwin' }, async () => {
  const f = await setup(), source = new Source(), t = Date.now(), date = localDate(t)
  const observer = new ActivityObserver(f.store.activity, config, '', () => {}, () => source.asChild())
  try {
    observer.configure(config)
    const generation = source.commands[0]!.generation
    source.frame({ type: 'sample', generation, trusted: true, ...sample(t) })
    const pending = observer.captureSelection(), rejected = assert.rejects(pending, /已暂停|更改/), id = source.commands.at(-1)!.id
    observer.clear(date); await rejected
    source.frame({ type: 'selection', generation, id, ...sample(t), text: 'deleted-selection-must-not-return' })
    assert.equal(f.store.activity.report(date).items.length, 0)
    source.frame({ type: 'sample', generation: source.commands.at(-1)!.generation, trusted: false, blocked: true })
    assert.equal(observer.status().state, 'excluded')
    source.frame({ type: 'sample', generation: source.commands.at(-1)!.generation, trusted: true, blocked: true, locked: true })
    assert.equal(observer.status().state, 'locked')
  } finally { observer.close(); await f.cleanup() }
})
