import { test } from 'node:test'
import { openRouterFixture as fixture, catalogue } from './openrouter-fixture'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { CompatibleProvider } from '../src/main/providers'
import { LocalStore } from '../src/main/storage'
import { AgentService } from '../src/main/service'
import { UsageStore } from '../src/main/usage'
import { commonModels, mergeReasoning } from '../src/shared/models'
import type { AgentSession, ModelRequest, ProviderConfig } from '../src/shared/types'

const config = (url: string): ProviderConfig => ({ id: 'router', name: 'OpenRouter', kind: 'openrouter', baseUrl: url, models: [], toolCalling: true })
const codec = { available: () => false, encrypt: () => { throw new Error('unavailable') }, decrypt: () => { throw new Error('unavailable') } }
test('OpenRouter discovers actual tool/reasoning capabilities, filters batch/image and selects common families', async () => {
  const f = await fixture()
  try {
    const models = await new CompatibleProvider(config(f.url), 'fake-key').listModels()
    assert.equal(models.length, 4)
    assert.deepEqual(models[0]!.reasoningEfforts, ['high', 'low'])
    assert.equal(models[3]!.tools, false)
    assert.deepEqual(commonModels(models).map(m => m.id), catalogue.slice(0, 3).map(m => m.id))
  } finally { await f.close() }
})
test('OpenRouter reads account balance and preserves key limits when credits access is denied', async () => {
  const f = await fixture(), p = new CompatibleProvider(config(f.url), 'fake-key')
  try {
    const a = await p.getUsage(); assert.equal(a!.balance, 13); assert.equal(a!.keyLimit, null); assert.equal(a!.keyUsage, 2)
    f.forbidCredits(); const b = await p.getUsage(); assert.equal(b!.balance, null); assert.equal(b!.keyUsage, 2); assert.ok(b!.error)
    assert.equal(JSON.stringify([a, b]).includes('fake-key'), false)
    assert.ok(f.auth.every(value => value === 'Bearer fake-key'))
  } finally { await f.close() }
})
test('OpenRouter reasoning/tool continuation, same-provider model switch and cumulative usage survive restart', async () => {
  const f = await fixture(), root = await mkdtemp(join(tmpdir(), 'clax-openrouter-'))
  let service = new AgentService(new LocalStore(root, codec, process.cwd()), () => {})
  try {
    service.saveSettings({ ...service.store.settings, memory: { enabled: false, autoCapture: false } })
    const input = { name: 'OpenRouter fixture', kind: 'openrouter' as const, baseUrl: f.url, apiKey: 'fake-key', toolCalling: true }
    const models = await service.testProvider(input), p = await service.saveProvider({ ...input, modelIds: models.map(m => m.id) })
    const id = service.currentId
    assert.throws(() => service.setModel(id, { provider: p.id, model: models[0]!.id, reasoningEffort: 'none' }), /推理强度/)
    service.setModel(id, { provider: p.id, model: models[0]!.id, reasoningEffort: 'low' })
    service.send(id, 'fixture'); await service.waitForIdle(id)
    assert.deepEqual(f.calls[0].reasoning, { effort: 'low' })
    assert.equal(f.calls[1].messages.find((m: any) => m.role === 'assistant').reasoning_details[0].data, 'opaque-block')
    assert.equal((await service.bootstrap()).session.messages.find(m => m.toolCalls?.length)?.reasoningDetails?.[0]?.data, 'opaque-block')
    let totals = service.usageSummary().total
    assert.equal(totals.inputTokens, 200); assert.equal(totals.cachedTokens, 80); assert.equal(totals.outputTokens, 20); assert.equal(totals.reportedCost, .002)
    service.setModel(id, { provider: p.id, model: models[1]!.id })
    service.send(id, 'switch'); await service.waitForIdle(id)
    assert.equal(f.calls[2].reasoning, undefined)
    assert.ok(f.calls[2].messages.every((m: any) => m.reasoning_details === undefined))
    await service.shutdown()
    service = new AgentService(new LocalStore(root, codec, process.cwd()), () => {})
    assert.equal(service.usageSummary().total.inputTokens, 400)
    const second = service.newSession(); await second
    assert.equal(service.usageSummary().models.length, 2)
    assert.equal((await service.bootstrap()).session.currentModel?.model, models[1]!.id)
    await service.shutdown()
    service = new AgentService(new LocalStore(root, codec, process.cwd()), () => {})
    assert.equal(service.usageSummary().total.inputTokens, 400, 'reopening does not replay totals')
  } finally { await service.shutdown(); await f.close(); await rm(root, { recursive: true, force: true }) }
})
test('Usage ledger imports legacy totals once and exposes missing usage without inventing free requests', () => {
  const db = new DatabaseSync(':memory:'), ledger = new UsageStore(db)
  try {
    const session = { id: 'old', updatedAt: 1, usage: { inputTokens: 100, outputTokens: 20, cachedTokens: 60, cacheAvailable: true, reportedRequests: 2, unreportedRequests: 1, estimatedCost: null } } as AgentSession
    ledger.importLegacy([session]); ledger.importLegacy([session])
    ledger.record('new', { provider: 'router', model: 'a' }, null, null)
    ledger.record('new', { provider: 'router', model: 'b' }, { inputTokens: 10, outputTokens: 5, cachedTokens: 0, cost: 0 }, null)
    const summary = ledger.summary()
    assert.equal(summary.total.inputTokens, 110); assert.equal(summary.total.outputTokens, 25)
    assert.equal(summary.total.cachedTokens, 60); assert.equal(summary.total.unreportedRequests, 2)
    assert.equal(summary.total.unpricedRequests, 4); assert.equal(summary.models.length, 3)
  } finally { db.close() }
})
test('Reasoning deltas preserve encrypted data and do not mix distinct indexes', () => {
  const value = mergeReasoning([{ type: 'reasoning.encrypted', index: 0, data: 'abc' }], [{ type: 'reasoning.encrypted', index: 0, data: 'def' }, { type: 'reasoning.text', index: 1, text: 'x' }])
  assert.equal(value[0]!.data, 'abcdef'); assert.equal(value[1]!.text, 'x')
})
for (const limit of [15, null]) test(`Authorized key provisioning honors ${limit === null ? 'no specified limit' : 'a chosen budget'} and separates management credentials`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'clax-router-key-')), previous = process.env.CLAX_MANAGEMENT_TEST_KEY, fetch = globalThis.fetch
  process.env.CLAX_MANAGEMENT_TEST_KEY = 'fixture-management'
  let created = 0
  const headers: { path: string; key: string }[] = []
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init), path = new URL(request.url).pathname, key = request.headers.get('Authorization')!
    headers.push({ path, key })
    if (path.endsWith('/key')) return Response.json({ data: { is_management_key: key.includes('fixture-management'), limit: key.includes('fixture-management') ? null : 15, limit_remaining: 15, usage: 0 } })
    if (path.endsWith('/credits')) return Response.json({ data: { total_credits: 15, total_usage: 0 } })
    if (path.endsWith('/keys') && request.method === 'POST') {
      created++; assert.deepEqual(await request.json(), { name: 'Clax', ...(limit === null ? {} : { limit }), limit_reset: null, include_byok_in_limit: true })
      return Response.json({ key: 'sk-or-fixture-private', data: { hash: 'fixture-hash' } }, { status: 201 })
    }
    throw new Error('Unexpected test request')
  }
  // A deterministic test codec checks routing/persistence; production uses Electron safeStorage.
  const testCodec = { available: () => true, encrypt: (value: string) => Buffer.from(Buffer.from(value).map(b => b ^ 55)), decrypt: (value: Buffer) => Buffer.from(value).map(b => b ^ 55).toString() }
  const service = new AgentService(new LocalStore(root, testCodec, root), () => {})
  try {
    const p = await service.saveProvider({ name: 'OpenRouter', kind: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', apiKeyEnv: 'CLAX_MANAGEMENT_TEST_KEY', toolCalling: true })
    await Promise.all([service.provisionOpenRouter(p.id, limit), service.provisionOpenRouter(p.id, limit)])
    await service.provisionOpenRouter(p.id, limit)
    assert.equal(created, 1)
    const stored = (await service.bootstrap()).providers[0]!
    assert.equal(stored.apiKeyEnv, undefined); assert.equal(stored.creditsKeyEnv, 'CLAX_MANAGEMENT_TEST_KEY')
    assert.equal(stored.hasKey, true)
    assert.equal((await service.providerCredits(p.id))!.balance, 15)
    assert.ok(headers.some(h => h.path.endsWith('/credits') && h.key === 'Bearer fixture-management'))
    assert.ok(headers.some(h => h.path.endsWith('/key') && h.key === 'Bearer sk-or-fixture-private'))
    assert.equal((await readFile(join(root, 'credentials.json'), 'utf8')).includes('sk-or-fixture-private'), false)
    assert.equal(JSON.stringify(stored).includes('fixture-management'), false)
  } finally {
    globalThis.fetch = fetch
    if (previous === undefined) delete process.env.CLAX_MANAGEMENT_TEST_KEY; else process.env.CLAX_MANAGEMENT_TEST_KEY = previous
    await service.shutdown(); await rm(root, { recursive: true, force: true })
  }
})

test('OpenRouter uses explicit session affinity without imposing it on compatible endpoints', async () => {
  const f = await fixture()
  try {
    const request: ModelRequest = { sessionId: 'stable-session', model: 'fixture', system: 'Stable system', messages: [], tools: [], signal: new AbortController().signal }
    for await (const _ of new CompatibleProvider(config(f.url), 'fake-key').stream(request)) { /* real HTTP fixture */ }
    assert.equal(f.calls.at(-1).session_id, 'stable-session')
    for await (const _ of new CompatibleProvider({ ...config(f.url), kind: 'compatible' }, 'fake-key').stream(request)) { /* same adapter, ordinary endpoint */ }
    assert.equal(f.calls.at(-1).session_id, undefined)
  } finally { await f.close() }
})
