import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { AgentService } from '../src/main/service'
import { LocalStore } from '../src/main/storage'
import { UsageStore } from '../src/main/usage'
import { citationMarkdown, mergeCitations, parseCitations } from '../src/shared/citations'
import { openRouterFixture } from './openrouter-fixture'

const codec = { available: () => false, encrypt: () => { throw new Error('Unavailable') }, decrypt: () => { throw new Error('Unavailable') } }
async function setup() {
  const fixture = await openRouterFixture(), root = await mkdtemp(join(tmpdir(), 'clax-search-')), workspace = join(root, 'workspace')
  await mkdir(workspace)
  const service = new AgentService(new LocalStore(join(root, 'data'), codec, workspace), () => {})
  service.saveSettings({ ...service.store.settings, search: { kind: 'openrouter', baseUrl: '' }, memory: { enabled: true, autoCapture: false } })
  const input = { name: 'Fixture', kind: 'openrouter' as const, baseUrl: fixture.url, apiKey: 'fixture-key', toolCalling: true }
  const models = await service.testProvider(input), provider = await service.saveProvider({ ...input, modelIds: models.map(m => m.id) })
  service.setModel(service.currentId, { provider: provider.id, model: models[0]!.id, reasoningEffort: 'low' })
  return { fixture, root, workspace, service, provider, cleanup: async () => { await service.shutdown(); await fixture.close(); await rm(root, { recursive: true, force: true }) } }
}
test('Citations accept HTTP metadata, reject unsafe URLs and preserve answer text at shared citation offsets', () => {
  const marker = 'citesource', text = `A verified sentence. ${marker} Tail.`
  const input = [{ type: 'url_citation', url_citation: { url: 'https://example.com/a', title: 'A', start_index: 21, end_index: 21 + marker.length } },
    { type: 'url_citation', url_citation: { url: 'https://example.com/b', title: 'B', start_index: 21, end_index: 21 + marker.length } },
    { type: 'url_citation', url_citation: { url: 'javascript:alert(1)' } },
    { type: 'url_citation', url_citation: { url: 'https://secret@example.com/' } }]
  const citations = parseCitations(input)
  assert.equal(citations.length, 2); assert.equal(mergeCitations(citations, citations).length, 2)
  const rendered = citationMarkdown(text, citations)
  assert.equal(rendered, 'A verified sentence. [1](<https://example.com/a>) [2](<https://example.com/b>) Tail.')
  const claim = citationMarkdown('Keep this claim.', [{ url: 'https://example.com/', title: 'Source', startIndex: 0, endIndex: 16 }])
  assert.match(claim, /^Keep this claim\./)
  assert.equal(citationMarkdown('No positional anchor.', [{ url: 'https://example.com/', title: 'Source', startIndex: 0, endIndex: 0 }]), 'No positional anchor.')
})
test('OpenRouter search coexists with local tools, preserves sources/usage across restart and stays out of memory extraction', async () => {
  const f = await setup(), { service, fixture } = f
  try {
    service.saveSettings({ ...service.store.settings, memory: { enabled: true, autoCapture: true } })
    const id = service.currentId
    service.send(id, 'search fixture'); await service.waitForIdle(id); await service.waitForMemory(id)
    const foreground = fixture.calls.filter(call => call.tools?.some((t: any) => t.type === 'openrouter:web_search'))
    assert.equal(foreground.length, 2)
    assert.ok(foreground.every(call => call.max_tool_calls === undefined && !call.plugins))
    assert.ok(foreground.every(call => call.tools.find((t: any) => t.type === 'openrouter:web_search').parameters.max_uses === undefined))
    assert.ok(foreground.every(call => call.tools.find((t: any) => t.type === 'openrouter:web_search').parameters.engine === 'native'))
    assert.ok(foreground.every(call => !call.tools.some((t: any) => t.function?.name === 'web_search')))
    assert.ok(fixture.calls.some(call => call.messages[0].content.startsWith('Extract durable user preferences') && !call.tools?.length))
    const state = await service.bootstrap(), reply = state.session.messages.at(-1)!
    assert.equal(reply.webSearchRequests, 1); assert.equal(reply.citations?.length, 1)
    assert.equal(reply.citations![0]!.url, 'https://docs.python.org/3/library/asyncio-task.html')
    assert.ok(state.session.messages.flatMap(m => m.activities ?? []).some(a => a.name === 'list_directory' && a.status === 'done'))
    assert.equal(service.usageSummary().total.webSearchRequests, 1)
    service.saveSettings({ ...service.store.settings, memory: { enabled: true, autoCapture: false } })
    service.send(id, 'follow-up'); await service.waitForIdle(id)
    const request = fixture.calls.findLast(call => call.messages.filter((m: any) => m.role === 'user').length === 2)
    assert.ok(request.messages.some((m: any) => m.annotations?.[0]?.url_citation.url.includes('docs.python.org')))
    const restored = new LocalStore(service.store.home, codec, f.workspace)
    try {
      assert.equal(restored.settings.search.kind, 'openrouter')
      assert.equal(restored.getSession(id)!.messages.at(-1)!.citations?.length, 1)
      assert.equal(restored.usage.summary().total.webSearchRequests, 2)
    } finally { restored.close() }
  } finally { await f.cleanup() }
})
test('Disabled search, non-OpenRouter providers and search failures never fabricate successful search', async () => {
  const f = await setup(), { service, fixture } = f
  try {
    const id = service.currentId
    service.send(id, 'search-error-fixture'); await service.waitForIdle(id)
    const failed = (await service.bootstrap()).session.messages.at(-1)!
    assert.equal(failed.status, 'error'); assert.equal(failed.citations, undefined); assert.equal(failed.webSearchRequests, undefined)
    assert.equal(service.usageSummary().total.webSearchRequests, 0)
    service.saveSettings({ ...service.store.settings, disabledTools: ['web_search'] })
    service.send(id, 'disabled'); await service.waitForIdle(id)
    assert.ok(fixture.calls.slice(-2).every(call => !call.tools?.some((t: any) => t.type === 'openrouter:web_search')))
    service.saveSettings({ ...service.store.settings, disabledTools: [] })
    const p = await service.saveProvider({ name: 'Compatible', kind: 'compatible', baseUrl: fixture.url, apiKey: 'fixture-key', toolCalling: true, modelIds: ['fixture-chat'] })
    service.setModel(id, { provider: p.id, model: 'fixture-chat' })
    service.send(id, 'not OpenRouter'); await service.waitForIdle(id)
    assert.ok(!fixture.calls.at(-1).tools.some((t: any) => t.type === 'openrouter:web_search'))
    assert.equal((await service.bootstrap()).tools.find(t => t.name === 'web_search')?.available, false)
  } finally { await f.cleanup() }
})
test('Search counters migrate existing usage without losing rows or treating old unknown counts as reported zero', () => {
  const db = new DatabaseSync(':memory:')
  try {
    db.exec(`CREATE TABLE usage_requests (id TEXT PRIMARY KEY, session TEXT, provider TEXT, model TEXT, created_at INTEGER,
      input INTEGER, output INTEGER, cached INTEGER, cache_write INTEGER, reasoning INTEGER, requests INTEGER,
      missing INTEGER, cache_known INTEGER, cost REAL, cost_kind TEXT);
      INSERT INTO usage_requests VALUES ('old','s','p','m',1,100,10,40,0,0,1,0,1,0.01,'reported');`)
    const usage = new UsageStore(db)
    assert.equal(usage.summary().total.webSearchReportedRequests, 0)
    usage.record('s', { provider: 'p', model: 'm' }, { inputTokens: 20, outputTokens: 5, cost: .03, webSearchRequests: 2 }, null)
    const total = new UsageStore(db).summary().total
    assert.equal(total.inputTokens, 120); assert.equal(total.reportedCost, .04)
    assert.equal(total.webSearchRequests, 2); assert.equal(total.webSearchReportedRequests, 1); assert.equal(total.requests, 2)
  } finally { db.close() }
})
