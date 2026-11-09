import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openAIFixture } from './openai-fixture'
import { OpenAIProvider, createProvider } from '../src/main/providers'
import { LocalStore } from '../src/main/storage'
import { AgentService } from '../src/main/service'
import { requestTokens } from '../src/main/context'
import { LocalAgentRuntime } from '../src/main/runtime'
import type { Message, ModelEvent, ModelProvider, ModelRequest, ProviderConfig } from '../src/shared/types'

const codec = { available: () => false, encrypt: Buffer.from, decrypt: (v: Buffer) => v.toString() }
const config = (baseUrl: string): ProviderConfig => ({ id: 'openai-fixture', name: 'OpenAI', kind: 'openai', baseUrl, models: [], toolCalling: true })
const message = (id: string, role: Message['role'], content: string): Message => ({ id, role, content, turnId: 'test', createdAt: Date.now() })
const request = (prompt: string): ModelRequest => ({ model: 'gpt-6.1-sol', system: 'Fixture system', messages: [message('user', 'user', prompt)], tools: [], signal: new AbortController().signal })
async function collect(stream: AsyncIterable<ModelEvent>) { const events: ModelEvent[] = []; for await (const event of stream) events.push(event); return events }

test('OpenAI uses its own model catalogue, supported reasoning levels and native capacities', async () => {
  const f = await openAIFixture()
  try {
    const provider = createProvider(config(f.url), 'fixture-key')
    assert.ok(provider instanceof OpenAIProvider)
    const models = await provider.listModels()
    assert.deepEqual(models.map(m => m.id), ['gpt-6.1-sol', 'gpt-5.4-mini'])
    assert.equal(models[0]!.contextWindow, 1050000); assert.equal(models[0]!.maxOutputTokens, 128000)
    assert.deepEqual(models[0]!.reasoningEfforts, ['low', 'medium', 'high', 'xhigh', 'max'])
    await assert.rejects(collect(provider.stream({ ...request('fixture'), reasoningEffort: 'none' })), /推理强度/)
    assert.equal(f.calls.length, 0)
    assert.equal(await provider.getUsage(), null)
    assert.deepEqual(f.paths, ['/models'])
  } finally { await f.close() }
})

test('Responses tool batches, encrypted reasoning, token usage and model switches persist without changing other protocols', async () => {
  const f = await openAIFixture(), root = await mkdtemp(join(tmpdir(), 'clax-openai-')), workspace = join(root, 'workspace')
  await mkdir(workspace); await writeFile(join(workspace, 'fixture.txt'), 'Observed local fixture content.')
  let service = new AgentService(new LocalStore(join(root, 'data'), codec, workspace), () => {})
  try {
    service.saveSettings({ ...service.store.settings, memory: { enabled: false, autoCapture: false } })
    const input = { name: 'OpenAI', kind: 'openai' as const, baseUrl: f.url, apiKey: 'fixture-key', toolCalling: true }
    const models = await service.testProvider(input), provider = await service.saveProvider({ ...input, modelIds: models.map(m => m.id) })
    const id = service.currentId
    service.setModel(id, { provider: provider.id, model: 'gpt-6.1-sol', reasoningEffort: 'high' })
    service.send(id, 'tool-fixture'); await service.waitForIdle(id)
    const state = await service.bootstrap()
    assert.equal(state.session.messages.at(-1)!.status, 'complete')
    assert.deepEqual(state.session.messages.flatMap(m => m.activities ?? []).map(a => a.status), ['done', 'done'])
    assert.ok(state.session.messages.some(m => m.role === 'tool' && m.content.includes('Observed local fixture')))
    assert.equal(f.calls.length, 2)
    for (const call of f.calls) {
      assert.equal(call.store, false); assert.equal(call.stream, true); assert.equal(call.instructions.includes('personal agent harness'), true)
      assert.deepEqual(call.reasoning, { effort: 'high' }); assert.deepEqual(call.include, ['reasoning.encrypted_content'])
      assert.ok(call.tools.every((t: any) => t.type === 'function' && t.function === undefined && t.strict === false))
      assert.equal(call.messages, undefined); assert.equal(call.previous_response_id, undefined); assert.equal(call.max_tool_calls, undefined)
    }
    assert.equal(f.calls[1].input.find((i: any) => i.type === 'reasoning').encrypted_content, 'fixture-encrypted-gpt-6.1-sol-1')
    assert.equal(f.calls[1].input.filter((i: any) => i.type === 'function_call_output').length, 2)
    const usage = service.usageSummary().total
    assert.equal(usage.inputTokens, 200); assert.equal(usage.outputTokens, 20); assert.equal(usage.cachedTokens, 80); assert.equal(usage.reasoningTokens, 6)
    assert.equal(usage.reportedCost, 0); assert.equal(usage.unpricedRequests, 2); assert.equal(usage.costReportedRequests, 0)
    await service.shutdown()
    service = new AgentService(new LocalStore(join(root, 'data'), codec, workspace), () => {})
    assert.ok((await service.bootstrap()).session.messages.some(m => m.responseItems?.some(i => i.encrypted_content)))
    service.setModel(id, { provider: provider.id, model: 'gpt-5.4-mini', reasoningEffort: 'low' })
    service.send(id, 'switch-fixture'); await service.waitForIdle(id)
    assert.ok(f.calls.at(-1).input.every((i: any) => !i.encrypted_content))
    assert.equal(f.calls.at(-1).input.filter((i: any) => i.type === 'function_call_output').length, 2)
    assert.equal((await service.bootstrap()).session.messages.at(-1)!.status, 'complete')
  } finally { await service.shutdown(); await f.close(); await rm(root, { recursive: true, force: true }) }
})

test('Incomplete, failed and truncated Responses never execute a partial tool plan', async () => {
  const f = await openAIFixture(), provider = new OpenAIProvider(config(f.url), 'fixture-key')
  try {
    for (const mode of ['truncated', 'incomplete', 'error']) {
      const events: ModelEvent[] = []
      await assert.rejects(async () => { for await (const event of provider.stream(request(`failure-${mode}`))) events.push(event) }, /提前结束|未完成/)
      assert.ok(events.every(e => e.type !== 'tool_call' && e.type !== 'response_output'))
    }
  } finally { await f.close() }
})

test('Responses search returns validated sources and actual completed tool calls while memory requests omit search', async () => {
  const f = await openAIFixture(), provider = new OpenAIProvider(config(f.url), 'fixture-key')
  try {
    const events = await collect(provider.stream({ ...request('search-fixture'), webSearch: true }))
    assert.deepEqual(f.calls[0].tools, [{ type: 'web_search' }])
    const cited = events.find(e => e.type === 'citations'); assert.equal(cited?.type === 'citations' && cited.citations[0]!.url, 'https://docs.python.org/3/library/asyncio-task.html')
    assert.equal(events.find(e => e.type === 'usage')?.usage.webSearchRequests, 1)
    await collect(provider.stream(request('memory-fixture')))
    assert.equal(f.calls[1].tools, undefined)
    assert.ok(f.calls[1].input.every((i: any) => !i.encrypted_content))
    const plain = message('m', 'assistant', 'text'), native = { ...plain, responseItems: [{ type: 'reasoning', encrypted_content: 'opaque'.repeat(1000) }] }
    assert.ok(requestTokens('', [native], []) > requestTokens('', [plain], []))
    const long = message('long', 'assistant', 'A complete answer. '.repeat(1000))
    const mirrored = { ...long, responseItems: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: long.content }] }] }
    assert.ok(requestTokens('', [mirrored], []) < requestTokens('', [long], []) * 1.2, 'Native and plain copies must not consume the context twice')
  } finally { await f.close() }
})

test('Steering after a native envelope discards its unexecuted plan before the next request', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clax-openai-steer-')), store = new LocalStore(root, codec, root)
  let listener = () => {}, queued: string[] = [], step = 0, executed = 0
  try {
    const session = store.createSession({ provider: 'test', model: 'gpt-6.1-sol' })
    session.messages = [message('u', 'user', 'original-fixture')]
    const provider: ModelProvider = { id: 'test', name: 'test', capabilities: () => ({ tools: true }), listModels: async () => [],
      async *stream(request) {
        if (++step === 1) {
          yield { type: 'response_output', items: [{ type: 'function_call', call_id: 'stale', name: 'probe', arguments: '{}' }] }
          queued = ['new direction']; listener()
          yield { type: 'tool_call', call: { id: 'stale', name: 'probe', arguments: {} } }
        } else {
          assert.ok(request.messages.every(m => !m.responseItems))
          assert.equal(request.messages.at(-1)!.content, 'new direction')
          yield { type: 'text', text: 'Followed steering.' }
        }
      } }
    const tools = [{ name: 'probe', description: 'Fixture', inputSchema: { type: 'object', properties: {} }, execute: async () => { executed++; return 'Unexpected' } }]
    for await (const _ of new LocalAgentRuntime(() => 0).runTurn(session, session.currentModel!, tools, new AbortController().signal, {
      provider: () => provider, context: () => '', permission: () => 'full', approve: async () => true,
      takeSteering: () => { const result = queued; queued = []; return result }, onSteering: callback => { listener = callback; return () => { listener = () => {} } },
    })) { /* Drain the actual runtime. */ }
    assert.equal(executed, 0); assert.equal(step, 2)
    assert.equal(session.messages.at(-1)!.content, 'Followed steering.')
  } finally { store.close(); await rm(root, { recursive: true, force: true }) }
})

test('An empty installation prefers the available OpenAI key and stores only its variable name', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clax-openai-import-')), service = new AgentService(new LocalStore(root, codec, root), () => {})
  const fetch = globalThis.fetch, previous = process.env.OPENAI_API_KEY, routerKey = process.env.OPENROUTER_API_KEY
  let requests = 0
  try {
    process.env.OPENAI_API_KEY = 'fixture-openai-environment-key'; delete process.env.OPENROUTER_API_KEY
    globalThis.fetch = async (url, init) => {
      assert.equal(String(url), 'https://api.openai.com/v1/models'); requests++
      assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer fixture-openai-environment-key')
      return new Response(JSON.stringify({ data: [{ id: 'gpt-5.4-mini' }, { id: 'gpt-6.1-sol' }] }))
    }
    await service.importDefaultProvider()
    const state = await service.bootstrap()
    assert.equal(state.providers[0]!.kind, 'openai'); assert.equal(state.providers[0]!.apiKeyEnv, 'OPENAI_API_KEY')
    assert.equal(state.session.currentModel?.model, 'gpt-6.1-sol')
    service.setModel(service.currentId, { provider: state.providers[0]!.id, model: 'gpt-5.4-mini' })
    await service.importDefaultProvider()
    assert.equal((await service.bootstrap()).session.currentModel?.model, 'gpt-5.4-mini')
    assert.equal(requests, 1)
    for (const file of ['providers.json', 'credentials.json']) assert.ok(!(await readFile(join(root, file), 'utf8')).includes('fixture-openai-environment-key'))
  } finally {
    globalThis.fetch = fetch
    if (previous === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous
    if (routerKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = routerKey
    await service.shutdown(); await rm(root, { recursive: true, force: true })
  }
})
