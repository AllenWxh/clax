import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalStore } from '../src/main/storage'
import { ContextManager, estimateTokens } from '../src/main/context'
import { createTools, ProcessManager } from '../src/main/tools'
import { parseCitations, mergeCitations } from '../src/shared/citations'
import { defaultActivity } from '../src/main/activity-store'
import { parseDecision, recentActivity, ReminderScheduler, defaultReminder } from '../src/main/reminder'
import { localDate } from '../src/main/memory'
import { BACKGROUND_SEPARATOR } from '../src/shared/context'
import type { Message, ModelProvider, RunControl, ToolContext } from '../src/shared/types'

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'clax-unbounded-')), workspace = join(root, 'project')
  await mkdir(workspace)
  const store = new LocalStore(join(root, 'data'), { available: () => false, encrypt: Buffer.from, decrypt: value => value.toString() }, workspace)
  const session = store.createSession({ provider: 'fixture', model: 'fixture' }), processes = new ProcessManager()
  const context: ToolContext = { session, permission: 'full', signal: new AbortController().signal, progress() {}, approve: async () => { throw new Error('Unexpected full-access approval') } }
  return { root, workspace, store, session, context, processes, cleanup: async () => { await processes.shutdown(); store.close(); await rm(root, { recursive: true, force: true }) } }
}
const message = (id: string, role: Message['role'], content: string): Message => ({ id, role, content, turnId: id, createdAt: Date.now(), status: 'complete' })
const provider = (text: string): ModelProvider => ({ id: 'fixture', name: 'Fixture', capabilities: () => ({ tools: true }), listModels: async () => [], async *stream() { yield { type: 'text', text } } })
const control = (model: ModelProvider, f: Awaited<ReturnType<typeof setup>>, window = 1_000_000): RunControl => ({ provider: () => model, context: query => f.store.context(query, f.workspace), contextWindow: () => window, permission: () => 'full', takeSteering: () => [], approve: f.context.approve })

test('Skills and project instructions remain complete beyond old injection limits and can be rewritten by the agent', async () => {
  const f = await setup()
  try {
    const tools = createTools(f.store, f.processes), skills = tools.find(t => t.name === 'skill_manage')!
    const content = '# Reusable procedure\n' + 'Detailed procedure.\n'.repeat(1800) + 'SKILL-END-MARKER'
    await skills.execute({ action: 'write', id: 'long-procedure', content }, f.context)
    assert.equal(await skills.execute({ action: 'read', id: 'long-procedure' }, f.context), content)
    await assert.rejects(skills.execute({ action: 'write', id: '../escape', content }, f.context), /directory name/)
    await writeFile(join(f.workspace, 'AGENTS.md'), '# Project instructions\nPROJECT-INSTRUCTION-MARKER')
    f.store.saveMemory('USER.md', '# Profile\n' + 'User background.\n'.repeat(1200) + 'PROFILE-END-MARKER')
    f.session.messages = [message('u', 'user', 'Improve your own runtime in this source workspace.')]
    const manager = new ContextManager(() => 0)
    const first = await manager.prepare(f.session, f.session.currentModel!, tools, f.context.signal, control(provider(''), f), () => {})
    assert.ok(estimateTokens(first.system) > 2400)
    for (const marker of ['SKILL-END-MARKER', 'PROFILE-END-MARKER', 'PROJECT-INSTRUCTION-MARKER']) assert.ok(first.system.includes(marker))
    assert.match(first.system, /rewrite your own source/); assert.doesNotMatch(first.system, /Do not edit the core/)
    await skills.execute({ action: 'disable', id: 'long-procedure' }, f.context)
    assert.doesNotMatch(f.store.context('', f.workspace), /SKILL-END-MARKER/)
    assert.equal(await skills.execute({ action: 'read', id: 'long-procedure' }, f.context), content)
  } finally { await f.cleanup() }
})

test('Rolling summaries can exceed 2200 tokens when the actual model window has room', async () => {
  const f = await setup()
  try {
    const summary = '## 目标与约束\n' + 'Keep this verified constraint.\n'.repeat(420) + '\n## 决策与关键标识\nKeep identifiers.\n## 已验证结果\nObserved checks passed.\n## 待办与风险\nContinue current work.'
    assert.ok(estimateTokens(summary) > 2200)
    f.session.messages = [message('old', 'user', 'historical detail '.repeat(4000)), message('answer', 'assistant', 'Recorded.'), message('u', 'user', 'LATEST-INSTRUCTION')]
    const original = structuredClone(f.session.messages)
    const prepared = await new ContextManager(() => 48000).prepare(f.session, f.session.currentModel!, [], f.context.signal, { ...control(provider(summary), f, 32768), context: () => 'Noncritical historical background. '.repeat(1000) }, () => {})
    assert.equal(f.session.summary, summary)
    assert.ok(prepared.estimatedTokens <= prepared.budgetTokens)
    assert.deepEqual(f.session.messages, original)
    assert.equal(prepared.messages.at(-1)!.content, 'LATEST-INSTRUCTION')
  } finally { await f.cleanup() }
})

test('A full model window retains current skills and independent memory sources without partial JSON', async () => {
  const f = await setup()
  try {
    const skill = '# Current procedure\n' + 'Detailed instruction.\n'.repeat(250) + 'CURRENT-SKILL-TAIL'
    f.store.saveSkill('current-procedure', skill)
    f.store.saveMemory('USER.md', 'Large historical profile.\n'.repeat(10000) + 'OVERSIZED-PROFILE-TAIL')
    f.store.memory.remember('Specific recall-marker from a short relevant source.', f.workspace)
    await writeFile(join(f.workspace, 'AGENTS.md'), 'CURRENT-PROJECT-INSTRUCTIONS')
    f.session.messages = [message('u', 'user', 'recall-marker')]
    const raw = f.store.context('recall-marker', f.workspace)
    for (const block of raw.split(BACKGROUND_SEPARATOR).filter(block => block.startsWith('{'))) assert.doesNotThrow(() => JSON.parse(block))
    const prepared = await new ContextManager(() => 0).prepare(f.session, f.session.currentModel!, createTools(f.store, f.processes), f.context.signal, control(provider(''), f, 32768), () => {})
    assert.ok(prepared.estimatedTokens <= prepared.budgetTokens)
    for (const value of [skill, 'CURRENT-PROJECT-INSTRUCTIONS', 'Specific recall-marker']) assert.ok(prepared.system.includes(value))
    assert.doesNotMatch(prepared.system, /OVERSIZED-PROFILE-TAIL/)
    assert.match(prepared.system, /Some local background cannot fit/)
    for (const line of prepared.system.split('\n').filter(line => line.startsWith('{'))) assert.doesNotThrow(() => JSON.parse(line))
  } finally { await f.cleanup() }
})

test('Large memory files, all matching candidates and late query terms remain searchable', async () => {
  const f = await setup()
  try {
    f.store.saveMemory('MEMORY.md', '# Memory\n' + 'ordinary background row.\n'.repeat(50000) + '\nLARGE-FILE-TAIL-MARKER\n')
    assert.ok(f.store.memory.search('LARGE-FILE-TAIL-MARKER', f.workspace).some(hit => hit.content.includes('LARGE-FILE-TAIL-MARKER')))
    for (let i = 0; i < 115; i++) f.store.memory.remember(`candidate-sentinel unique item ${i}`, f.workspace, { key: `candidate.${i}` })
    assert.equal(f.store.memory.search('candidate-sentinel', f.workspace).filter(hit => hit.path.startsWith('entries/')).length, 115)
    const query = Array.from({ length: 60 }, (_, i) => `unmatchedword${i}`).join(' ') + ' LARGE-FILE-TAIL-MARKER'
    assert.ok(f.store.memory.search(query, f.workspace).some(hit => hit.content.includes('LARGE-FILE-TAIL-MARKER')))
  } finally { await f.cleanup() }
})

test('Memory extraction retains many long, evidenced facts and complete daily sources', async () => {
  const f = await setup()
  try {
    const quote = 'A durable project preference with supporting detail. '.repeat(55)
    f.session.messages = [message('u', 'user', quote), message('tool', 'tool', 'OBSERVED '.repeat(1000) + 'JOURNAL-TAIL-MARKER')]
    const memories = Array.from({ length: 12 }, (_, i) => ({ kind: 'preference', scope: 'project', key: `preference.${i}`, text: `Preference ${i}: ${quote}`, evidence: Array.from({ length: 6 }, () => ({ messageId: 'u', quote })) }))
    const result = JSON.stringify({ memories }); assert.ok(result.length > 24000)
    await f.store.memory.capture(f.session, f.session.messages.length, provider(result), f.session.currentModel!, f.context.signal, () => {}, 1_000_000)
    assert.equal(f.store.memory.status(true, true).learned, 12)
    const daily = await readdir(join(f.store.home, 'memory', 'daily'))
    assert.match(await readFile(join(f.store.home, 'memory', 'daily', daily[0]!), 'utf8'), /JOURNAL-TAIL-MARKER/)
  } finally { await f.cleanup() }
})

test('Citation counts and metadata retain complete valid sources', () => {
  const input = Array.from({ length: 75 }, (_, i) => ({ type: 'url_citation', url_citation: { url: `https://example.com/${i}`, title: 'Title '.repeat(200), content: 'Source detail '.repeat(600) } }))
  const parsed = parseCitations(input)
  assert.equal(parsed.length, 75); assert.ok(parsed[0]!.title.length > 500); assert.ok(parsed[0]!.content!.length > 4000)
  assert.equal(mergeCitations([], parsed).length, 75)
})

test('Activity and reminders keep complete observations without expiry or record quotas', async () => {
  const f = await setup()
  try {
    const settings = { ...defaultActivity, enabled: true }, now = Date.now(), old = now - 100 * 86_400_000
    assert.equal(defaultActivity.retentionDays, 0)
    f.store.activity.record({ time: old, app: 'Archive', bundleId: 'fixture', window: 'old window', idleSeconds: 0 }, settings)
    f.store.activity.prune(0, now); assert.equal(f.store.activity.report(localDate(old)).items.length, 1)
    for (let i = 0; i < 85; i++) f.store.activity.record({ time: now + i, app: `App ${i}`, bundleId: 'fixture', window: 'window '.repeat(100), idleSeconds: 0 }, settings)
    const report = f.store.activity.report(localDate(now)); assert.equal(report.items.length, 85)
    assert.equal(recentActivity(report.items, now).length, 85)
    const text = 'A useful reminder. '.repeat(50)
    assert.equal(parseDecision(JSON.stringify({ remind: true, text })), text.trim())
  } finally { await f.cleanup() }
})

test('Disabling reminders cancels a pending decision without an execution deadline', async () => {
  let signal!: AbortSignal, started!: () => void
  const ready = new Promise<void>(resolve => { started = resolve })
  const shown: string[] = []
  const scheduler = new ReminderScheduler(() => ({ ...defaultReminder, enabled: true, quietStart: '00:00', quietEnd: '00:00' }), async (_, active) => {
    signal = active; started()
    await new Promise<void>((_, reject) => active.addEventListener('abort', () => reject(active.reason), { once: true }))
    return 'Cancelled'
  }, text => shown.push(text))
  const pending = scheduler.tick(); await ready; assert.equal(signal.aborted, false)
  scheduler.close(); assert.equal(signal.aborted, true); await pending; assert.deepEqual(shown, [])
})

test('Fractional reminder intervals yield to the event loop and remain cancellable', async () => {
  let decided!: () => void
  const decision = new Promise<void>(resolve => { decided = resolve })
  const scheduler = new ReminderScheduler(() => ({ ...defaultReminder, enabled: true, intervalMinutes: Number.MIN_VALUE, quietStart: '00:00', quietEnd: '00:00' }), async () => { decided(); return null }, () => {})
  try { scheduler.configure(); await decision } finally { scheduler.close() }
})
