import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ReminderScheduler, defaultReminder, inQuietHours, parseDecision, recentActivity } from '../src/main/reminder'

const at = (h: number, m = 0) => new Date(2026, 9, 21, h, m)

test('quiet hours handle same-day, overnight and disabled ranges', () => {
  assert.equal(inQuietHours(at(23), '22:00', '08:00'), true)
  assert.equal(inQuietHours(at(7, 59), '22:00', '08:00'), true)
  assert.equal(inQuietHours(at(8), '22:00', '08:00'), false)
  assert.equal(inQuietHours(at(13), '12:00', '14:00'), true)
  assert.equal(inQuietHours(at(13), '09:00', '09:00'), false)
})

test('decision parsing only accepts explicit, non-empty reminders', () => {
  assert.equal(parseDecision('{"remind":true,"text":"休息一下"}'), '休息一下')
  assert.equal(parseDecision('```json\n{"remind":true,"text":" 喝水 "}\n```'), '喝水')
  assert.equal(parseDecision('{"remind":false}'), null)
  assert.equal(parseDecision('{"remind":true,"text":""}'), null)
  assert.equal(parseDecision('sure, take a break'), null)
})

test('recent activity keeps only entries inside the window', () => {
  const base = { id: 'x', date: '2026-10-21', kind: 'focus' as const, bundleId: 'b', text: '' }
  const items = [{ ...base, app: 'Old', window: 'w', startedAt: 0, endedAt: 1000, activeMs: 1000 },
    { ...base, app: 'Code', window: 'x'.repeat(300), startedAt: 5000, endedAt: 9000, activeMs: 3_600_000 }]
  const result = recentActivity(items, 2000)
  assert.equal(result.length, 1); assert.equal(result[0]!.app, 'Code'); assert.equal(result[0]!.minutes, 60); assert.equal(result[0]!.window.length, 120)
})

test('scheduler respects enabled flag, quiet hours and failures', async () => {
  let config = { ...defaultReminder }, hour = 10, calls = 0
  const shown: string[] = []
  const scheduler = new ReminderScheduler(() => config, async () => { calls++; if (hour === 11) throw new Error('model down'); return '起来活动一下' }, t => shown.push(t), () => at(hour))
  assert.equal(await scheduler.tick(), null); assert.equal(calls, 0) // disabled by default
  config = { ...config, enabled: true }
  assert.equal(await scheduler.tick(), '起来活动一下'); assert.deepEqual(shown, ['起来活动一下'])
  hour = 23; assert.equal(await scheduler.tick(), null); assert.equal(calls, 1) // quiet hours skip the model
  hour = 11; assert.equal(await scheduler.tick(), null); assert.equal(shown.length, 1) // failures stay silent
  scheduler.configure(); scheduler.close()
})

test('loop exhaustion after an overflow retry still closes the turn', async () => {
  const { LocalAgentRuntime, MAX_STEPS } = await import('../src/main/runtime')
  const { createTools, ProcessManager } = await import('../src/main/tools')
  const { LocalStore } = await import('../src/main/storage')
  const { mkdtemp, mkdir, rm } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const root = await mkdtemp(join(tmpdir(), 'clax-steps-test-')), workspace = join(root, 'project')
  await mkdir(workspace)
  const store = new LocalStore(join(root, 'data'), { available: () => false, encrypt: (v: string) => Buffer.from(v), decrypt: (b: Buffer) => b.toString() }, workspace)
  const processes = new ProcessManager()
  try {
    const session = store.createSession()
    session.messages.push({ id: 'u', turnId: 't', role: 'user', content: 'long task', createdAt: Date.now(), status: 'complete' })
    session.currentModel = { provider: 'loop', model: 'test' }
    let n = 0
    const provider: any = { id: 'loop', name: 'Loop', listModels: async () => [], capabilities: () => ({ tools: true }),
      async *stream(): AsyncIterable<any> {
        if (++n === MAX_STEPS) throw new Error('context_length_exceeded: maximum context length is 8192 tokens') // last step exits via retry
        yield { type: 'text', text: `step ${n}` }
        yield { type: 'tool_call', call: { id: `c${n}`, name: 'list_directory', arguments: { path: '.' } } }
      } }
    const events: any[] = []
    for await (const event of new LocalAgentRuntime(() => 64000).runTurn(session, session.currentModel, createTools(store, processes), new AbortController().signal,
      { provider: () => provider, context: () => store.context(), takeSteering: () => [], permission: () => 'auto', approve: async () => true })) events.push(event)
    assert.equal(events.filter(e => e.type === 'turn_finished').length, 1)
    assert.equal(events.at(-1)!.status, 'complete')
    assert.equal(n, MAX_STEPS) // the final step's retry is the last model call
  } finally { await processes.shutdown(); store.close(); await rm(root, { recursive: true, force: true }) }
})
