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
